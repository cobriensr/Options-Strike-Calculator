// @vitest-environment node

/**
 * REAL-SQL test for migration #212: interval_ba_alerts.source, and the
 * tables interval_ba_live_settings and interval_ba_tape_days (spec:
 * docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, 6.2).
 *
 * interval_ba_alerts comes from the REAL migrations #144 and #147, so the
 * ALTER, the CHECK and the UPDATE run against the production shape. #212
 * runs in one transaction, as migrateDb() runs it. Each test gets a fresh
 * PGlite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations.js';

async function runInTransaction(pg: PGlite): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, 212);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

async function insertAlert(
  pg: PGlite,
  chain: string,
  expiry: string,
): Promise<void> {
  await pg.query(
    `INSERT INTO interval_ba_alerts
       (option_chain, ticker, option_type, strike, expiry, bucket_start,
        bucket_end, ratio_pct, ask_premium, total_premium, trade_count)
     VALUES ($1, 'SPXW', 'C', 5700, $2::date, '2026-11-24 15:00:00+00',
        '2026-11-24 15:05:00+00', 80, 300000, 375000, 12)`,
    [chain, expiry],
  );
}

async function sourceOf(pg: PGlite): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ option_chain: string; source: string }>(
    'SELECT option_chain, source FROM interval_ba_alerts ORDER BY option_chain',
  );
  return Object.fromEntries(rows.map((r) => [r.option_chain, r.source]));
}

async function columns(
  pg: PGlite,
  table: string,
): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const { rows } = await pg.query<{
    column_name: string;
    data_type: string;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, numeric_precision, numeric_scale,
            is_nullable
       FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => ({
    name: r.column_name,
    type:
      r.data_type === 'numeric'
        ? `numeric(${r.numeric_precision},${r.numeric_scale})`
        : r.data_type,
    nullable: r.is_nullable === 'YES',
  }));
}

describe('migration #212 (interval_ba source, live settings, tape days)', () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigration(pg, 144);
    await applyMigration(pg, 147);
  });

  afterEach(async () => {
    await pg.close();
  });

  describe('interval_ba_alerts.source', () => {
    it('marks rows with an expiry before 2026-05-13 replay and the rest live', async () => {
      await insertAlert(pg, 'old-a', '2026-01-02');
      await insertAlert(pg, 'old-b', '2026-05-12');
      // 05-13 is the first live day: the cut is strictly before it.
      await insertAlert(pg, 'edge', '2026-05-13');
      await insertAlert(pg, 'new', '2026-11-24');

      await runInTransaction(pg);

      expect(await sourceOf(pg)).toEqual({
        'old-a': 'replay',
        'old-b': 'replay',
        edge: 'live',
        new: 'live',
      });
    });

    it('defaults to live, so the uw-stream alert INSERT needs no change', async () => {
      await runInTransaction(pg);
      await insertAlert(pg, 'streamed', '2026-11-24');

      expect(await sourceOf(pg)).toEqual({ streamed: 'live' });
    });

    it('is NOT NULL and accepts only live and replay', async () => {
      await runInTransaction(pg);
      await insertAlert(pg, 'x', '2026-11-24');

      await pg.query(
        `UPDATE interval_ba_alerts SET source = 'replay' WHERE option_chain = 'x'`,
      );
      await expect(
        pg.query(
          `UPDATE interval_ba_alerts SET source = 'tape' WHERE option_chain = 'x'`,
        ),
      ).rejects.toThrow(/interval_ba_alerts_source_check/);
      await expect(
        pg.query(
          `UPDATE interval_ba_alerts SET source = NULL WHERE option_chain = 'x'`,
        ),
      ).rejects.toThrow(/not-null constraint/);
    });
  });

  describe('interval_ba_live_settings', () => {
    it('has the spec columns, types and nullability', async () => {
      await runInTransaction(pg);

      expect(await columns(pg, 'interval_ba_live_settings')).toEqual([
        {
          name: 'booted_at',
          type: 'timestamp with time zone',
          nullable: false,
        },
        { name: 'enabled', type: 'boolean', nullable: false },
        { name: 'tickers', type: 'ARRAY', nullable: false },
        { name: 'ratio_threshold', type: 'numeric(6,4)', nullable: false },
        { name: 'premium_floor', type: 'numeric(14,2)', nullable: false },
        { name: 'window_sec', type: 'integer', nullable: false },
        { name: 'multi_leg_share_max', type: 'numeric(6,4)', nullable: false },
        { name: 'multi_leg_codes', type: 'ARRAY', nullable: false },
        { name: 'confluence_window_sec', type: 'integer', nullable: false },
      ]);
    });

    it('keeps one row per boot: a retried write with the same booted_at is a no-op', async () => {
      await runInTransaction(pg);
      const insert = `INSERT INTO interval_ba_live_settings
          (booted_at, enabled, tickers, ratio_threshold, premium_floor,
           window_sec, multi_leg_share_max, multi_leg_codes,
           confluence_window_sec)
        VALUES ('2026-11-25 14:00:00+00', $1, ARRAY['SPY','SPXW','QQQ'],
                0.7, 250000, 300, 0.5, ARRAY['mlat','mlet'], 90)
        ON CONFLICT (booted_at) DO NOTHING`;

      await pg.query(insert, [true]);
      await pg.query(insert, [false]);

      const { rows } = await pg.query<{ enabled: boolean; n: number }>(
        `SELECT enabled, count(*) OVER ()::int AS n
           FROM interval_ba_live_settings`,
      );
      expect(rows).toEqual([{ enabled: true, n: 1 }]);
    });
  });

  describe('interval_ba_tape_days', () => {
    it('has the spec columns, types and nullability', async () => {
      await runInTransaction(pg);

      const count = (name: string) => ({
        name,
        type: 'integer',
        nullable: false,
      });
      expect(await columns(pg, 'interval_ba_tape_days')).toEqual([
        { name: 'day', type: 'date', nullable: false },
        { name: 'done_at', type: 'timestamp with time zone', nullable: false },
        count('tape_alerts'),
        count('live_rows'),
        count('live_missed'),
        count('live_only'),
        count('value_mismatched'),
        count('inserted'),
        { name: 'inserts_held', type: 'text', nullable: true },
        count('removed'),
        count('flags_changed'),
        count('flags_unmatched'),
        count('spot_filled'),
      ]);
    });

    it('stamps done_at itself, leaves inserts_held NULL, and keys on day', async () => {
      await runInTransaction(pg);
      const insert = `INSERT INTO interval_ba_tape_days
          (day, tape_alerts, live_rows, live_missed, live_only,
           value_mismatched, inserted, removed, flags_changed,
           flags_unmatched, spot_filled)
        VALUES ('2026-11-24', 40, 38, 2, 0, 0, 2, 0, 1, 0, 40)`;

      await pg.query(insert);
      const { rows } = await pg.query<{
        stamped: boolean;
        inserts_held: string | null;
      }>(
        `SELECT done_at IS NOT NULL AS stamped, inserts_held
           FROM interval_ba_tape_days`,
      );
      expect(rows).toEqual([{ stamped: true, inserts_held: null }]);

      await expect(pg.query(insert)).rejects.toThrow(
        /interval_ba_tape_days_pkey/,
      );
    });

    it('rejects a row that leaves a count out', async () => {
      await runInTransaction(pg);

      await expect(
        pg.query(
          `INSERT INTO interval_ba_tape_days (day) VALUES ('2026-11-24')`,
        ),
      ).rejects.toThrow(/not-null constraint/);
    });
  });

  describe('atomicity', () => {
    it('rolls the column, the CHECK and the UPDATE back when a table already exists', async () => {
      await insertAlert(pg, 'old', '2026-01-02');
      // The last statement fails, so the three before it must not stick.
      await pg.exec('CREATE TABLE interval_ba_tape_days (day DATE)');

      await expect(runInTransaction(pg)).rejects.toThrow(
        /interval_ba_tape_days.*already exists/,
      );

      const { rows } = await pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'interval_ba_alerts' AND column_name = 'source'`,
      );
      expect(rows).toEqual([]);
      const live = await pg.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_name = 'interval_ba_live_settings'`,
      );
      expect(live.rows).toEqual([]);
    });
  });
});
