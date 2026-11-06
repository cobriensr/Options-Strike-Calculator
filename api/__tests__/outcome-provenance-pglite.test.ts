// @vitest-environment node

/**
 * REAL-SQL test for the outcome-provenance migration (#201): the tag and
 * version columns that record how a fire's outcomes (and, on lottery fires,
 * its flow inversion) were made, and the CHECKs that keep the tag vocabulary
 * closed. The CHECKs are the behavior, so this runs the real migrations on
 * pglite (Postgres in WASM) instead of matching SQL text.
 *
 * The two tables come from their real CREATE TABLE migrations (#110 and
 * #134). Rows are seeded BEFORE #201 runs, to stand for the fires written
 * before provenance existed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

const LOTTERY_CREATE_ID = 110;
const SILENT_BOOM_CREATE_ID = 134;
const PROVENANCE_ID = 201;

const CHECK_VIOLATION = '23514';

interface Target {
  table: 'lottery_finder_fires' | 'silent_boom_alerts';
  prefix: 'outcome' | 'inversion';
  /** Tags a writer uses on this column pair. */
  allowed: string[];
  /** Tags that look plausible but no writer uses on this column pair. */
  unused: string[];
  constraint: string;
}

const TARGETS: Target[] = [
  {
    table: 'lottery_finder_fires',
    prefix: 'outcome',
    allowed: ['fulltape', 'bot_eod', 'ws_cron'],
    unused: ['tape', 'uw_intraday'],
    constraint: 'lottery_finder_fires_outcome_source_chk',
  },
  {
    table: 'lottery_finder_fires',
    prefix: 'inversion',
    allowed: ['fulltape', 'bot_eod'],
    unused: ['ws_cron', 'uw_intraday', 'tape'],
    constraint: 'lottery_finder_fires_inversion_source_chk',
  },
  {
    table: 'silent_boom_alerts',
    prefix: 'outcome',
    allowed: ['fulltape', 'bot_eod', 'ws_cron'],
    unused: ['tape', 'uw_intraday'],
    constraint: 'silent_boom_alerts_outcome_source_chk',
  },
];

const TARGET_LABELS = TARGETS.map(
  (t) => [`${t.table}.${t.prefix}_*`, t] as const,
);

let pg: PGlite;
let chainSeq = 0;
const seeded: Record<Target['table'], number> = {
  lottery_finder_fires: 0,
  silent_boom_alerts: 0,
};

/** Insert a fire the way an earlier writer left it: no provenance. */
async function insertRow(table: Target['table']): Promise<number> {
  chainSeq += 1;
  const chain = `SPXW261106C0${5900 + chainSeq}000`;
  const { rows } =
    table === 'lottery_finder_fires'
      ? await pg.query<{ id: number }>(
          `INSERT INTO lottery_finder_fires (
             date, trigger_time_ct, entry_time_ct, option_chain_id,
             underlying_symbol, option_type, strike, expiry, dte,
             trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
             trigger_delta, trigger_ask_pct, trigger_window_size,
             trigger_window_prints, entry_price, open_interest, spot_at_first,
             alert_seq, flow_quad, tod, mode, reload_tagged,
             cheap_call_pm_tagged
           ) VALUES (
             '2026-11-05', '2026-11-05T15:00:00Z', '2026-11-05T15:01:00Z', $1,
             'SPXW', 'C', 5900, '2026-11-05', 0,
             1.5, 3.0, 0.25,
             0.10, 0.90, 40,
             12, 0.50, 1000, 5890,
             1, 'call_ask', 'MID', 'A_intraday_0DTE', FALSE,
             FALSE
           ) RETURNING id`,
          [chain],
        )
      : await pg.query<{ id: number }>(
          `INSERT INTO silent_boom_alerts (
             date, bucket_ct, option_chain_id, underlying_symbol, option_type,
             strike, expiry, dte, spike_volume, baseline_volume, spike_ratio,
             ask_pct, vol_oi, entry_price, open_interest
           ) VALUES (
             '2026-11-05', '2026-11-05T15:00:00Z', $1, 'SPXW', 'C',
             5900, '2026-11-05', 0, 500, 20, 25,
             0.90, 0.5, 0.50, 1000
           ) RETURNING id`,
          [chain],
        );
  return Number(rows[0]!.id);
}

/** Set a source/version pair on one row; the pair may be invalid on purpose. */
async function tag(
  { table, prefix }: Target,
  id: number,
  source: string | null,
  version: number | null,
) {
  await pg.query(
    `UPDATE ${table}
        SET ${prefix}_source = $1, ${prefix}_version = $2
      WHERE id = $3`,
    [source, version, id],
  );
}

async function readTag({ table, prefix }: Target, id: number) {
  const { rows } = await pg.query<{
    source: string | null;
    version: number | null;
  }>(
    `SELECT ${prefix}_source AS source, ${prefix}_version AS version
       FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  pg = new PGlite();
  await applyMigration(pg, LOTTERY_CREATE_ID);
  await applyMigration(pg, SILENT_BOOM_CREATE_ID);
  seeded.lottery_finder_fires = await insertRow('lottery_finder_fires');
  seeded.silent_boom_alerts = await insertRow('silent_boom_alerts');
  await applyMigration(pg, PROVENANCE_ID);
});

afterAll(async () => {
  await pg.close();
});

describe('migration #201 on pglite', () => {
  it('adds nullable provenance columns with no default', async () => {
    const { rows } = await pg.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name IN ('lottery_finder_fires', 'silent_boom_alerts')
          AND column_name ~ '^(outcome|inversion)_(source|version)$'
        ORDER BY table_name, column_name`,
    );

    expect(rows).toEqual([
      ...[
        ['inversion_source', 'text'],
        ['inversion_version', 'smallint'],
        ['outcome_source', 'text'],
        ['outcome_version', 'smallint'],
      ].map(([column_name, data_type]) => ({
        table_name: 'lottery_finder_fires',
        column_name,
        data_type,
        is_nullable: 'YES',
        column_default: null,
      })),
      ...[
        ['outcome_source', 'text'],
        ['outcome_version', 'smallint'],
      ].map(([column_name, data_type]) => ({
        table_name: 'silent_boom_alerts',
        column_name,
        data_type,
        is_nullable: 'YES',
        column_default: null,
      })),
    ]);
  });

  describe.each(TARGET_LABELS)('%s', (_label, target) => {
    it('accepts every writer tag with version 1, and a reset to NULL', async () => {
      const id = await insertRow(target.table);

      for (const source of target.allowed) {
        await tag(target, id, source, 1);
        expect(await readTag(target, id)).toEqual({ source, version: 1 });
      }

      await tag(target, id, null, null);
      expect(await readTag(target, id)).toEqual({
        source: null,
        version: null,
      });
    });

    it.each([
      ['an unknown tag', 'tape', 1],
      ['a tag with no version', 'fulltape', null],
      ['a version with no tag', null, 1],
      ['a zero version', 'fulltape', 0],
      ['a negative version', 'fulltape', -1],
    ] as const)('rejects %s', async (_name, source, version) => {
      const id = await insertRow(target.table);

      await expect(tag(target, id, source, version)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: target.constraint,
      });
      expect(await readTag(target, id)).toEqual({
        source: null,
        version: null,
      });
    });

    it('rejects every tag that no writer uses on this pair', async () => {
      const id = await insertRow(target.table);

      for (const source of target.unused) {
        await expect(tag(target, id, source, 1)).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint: target.constraint,
        });
      }
    });
  });

  it('keeps the rows written before the migration NULL, and a re-run is a no-op', async () => {
    const count = async (sql: string) =>
      Number((await pg.query<{ n: number }>(sql)).rows[0]!.n);
    const columns = `SELECT count(*)::int AS n FROM information_schema.columns
                      WHERE column_name ~ '^(outcome|inversion)_(source|version)$'`;
    const checks = `SELECT count(*)::int AS n FROM pg_constraint
                     WHERE conname ~ '_source_chk$'`;
    expect([await count(columns), await count(checks)]).toEqual([6, 3]);

    // Runs again without error: every ADD COLUMN is IF NOT EXISTS, and every
    // constraint is dropped before it is added.
    await applyMigration(pg, PROVENANCE_ID);

    expect([await count(columns), await count(checks)]).toEqual([6, 3]);
    for (const target of TARGETS) {
      expect(await readTag(target, seeded[target.table])).toEqual({
        source: null,
        version: null,
      });
    }
  });

  it('adds the checks NOT VALID, so existing rows are not scanned', async () => {
    const { rows } = await pg.query<{
      conname: string;
      table_name: string;
      convalidated: boolean;
    }>(
      `SELECT conname, conrelid::regclass::text AS table_name, convalidated
         FROM pg_constraint
        WHERE conname IN (
          'lottery_finder_fires_outcome_source_chk',
          'lottery_finder_fires_inversion_source_chk',
          'silent_boom_alerts_outcome_source_chk'
        )
        ORDER BY conname`,
    );

    expect(rows).toEqual([
      {
        conname: 'lottery_finder_fires_inversion_source_chk',
        table_name: 'lottery_finder_fires',
        convalidated: false,
      },
      {
        conname: 'lottery_finder_fires_outcome_source_chk',
        table_name: 'lottery_finder_fires',
        convalidated: false,
      },
      {
        conname: 'silent_boom_alerts_outcome_source_chk',
        table_name: 'silent_boom_alerts',
        convalidated: false,
      },
    ]);
  });
});
