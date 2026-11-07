// @vitest-environment node

/**
 * REAL-SQL test for saveSnapshot's upsert on market_snapshots
 * UNIQUE(date, entry_time).
 *
 * db.test.ts mocks the driver and only counts calls. This file runs the
 * real statement against pglite (real Postgres in WASM), on the table the
 * real initDb() builds, to pin which save may replace an existing row: a
 * backtest save (replayed from 5-minute candles) never replaces a live
 * capture, which is the source of truth for its date and time. A live save
 * replaces either kind.
 *
 * Only the Neon driver is replaced: getDb() gets a Neon-shaped tagged
 * template over pglite, so initDb, withDbRetry and saveSnapshot all run
 * as in production.
 *
 * The seven regime columns (vix_term_shape .. iv_accel_mult) are not in
 * initDb(): production got them from the retired pre-migration migrateDb
 * (7194ddff^:api/_lib/db.ts) and MIGRATIONS #203 creates them for every
 * other database. The table here gets them from #203's own statements, so
 * the INSERT is proved against the DDL a fresh database would run.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@neondatabase/serverless', () => ({ neon: () => holder.sql }));

import { _resetDb, initDb, saveSnapshot } from '../_lib/db.js';
import { applyMigration } from './pglite-migrations';

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await db.query(text, values)).rows;
  };
}

/** The migration that adds the seven regime columns. */
const REGIME_COLUMNS_ID = 203;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await initDb();
  await applyMigration(pg, REGIME_COLUMNS_ID);
});

afterAll(async () => {
  await pg.close();
  _resetDb();
  process.env.DATABASE_URL = originalUrl;
});

beforeEach(async () => {
  await pg.query('TRUNCATE market_snapshots RESTART IDENTITY CASCADE');
});

const KEY = { date: '2026-03-09', entryTime: '10:30 AM CT' };

/** The stored row for KEY. */
async function stored(): Promise<{ spx: number; is_backtest: boolean }> {
  const res = await pg.query<{ spx: string; is_backtest: boolean }>(
    'SELECT spx::text AS spx, is_backtest FROM market_snapshots WHERE date = $1 AND entry_time = $2',
    [KEY.date, KEY.entryTime],
  );
  expect(res.rows).toHaveLength(1);
  const row = res.rows[0]!;
  return { spx: Number(row.spx), is_backtest: row.is_backtest };
}

describe('saveSnapshot upsert against Postgres (pglite)', () => {
  it.each([
    ['a live save', false],
    ['a backtest save', true],
  ])(
    '%s inserts a new (date, entry_time) and returns its id',
    async (_l, b) => {
      const id = await saveSnapshot({ ...KEY, spx: 6800, isBacktest: b });

      expect(id).toEqual(expect.any(Number));
      expect(await stored()).toEqual({ spx: 6800, is_backtest: b });
    },
  );

  it('a backtest save over a live row leaves the live row and returns null', async () => {
    const liveId = await saveSnapshot({ ...KEY, spx: 6800, isBacktest: false });
    expect(liveId).toEqual(expect.any(Number));

    const id = await saveSnapshot({ ...KEY, spx: 6750.25, isBacktest: true });

    // RETURNING yields no row when the conflict update is skipped.
    expect(id).toBeNull();
    expect(await stored()).toEqual({ spx: 6800, is_backtest: false });
  });

  it('a live save over a live row updates it', async () => {
    const first = await saveSnapshot({ ...KEY, spx: 6800, isBacktest: false });

    const id = await saveSnapshot({ ...KEY, spx: 6801.5, isBacktest: false });

    expect(id).toBe(first);
    expect(await stored()).toEqual({ spx: 6801.5, is_backtest: false });
  });

  it('a live save over a backtest row upgrades it to live', async () => {
    const first = await saveSnapshot({ ...KEY, spx: 6750, isBacktest: true });

    const id = await saveSnapshot({ ...KEY, spx: 6800, isBacktest: false });

    expect(id).toBe(first);
    expect(await stored()).toEqual({ spx: 6800, is_backtest: false });
  });

  it('a backtest save over a backtest row updates it', async () => {
    const first = await saveSnapshot({ ...KEY, spx: 6750, isBacktest: true });

    const id = await saveSnapshot({ ...KEY, spx: 6752, isBacktest: true });

    expect(id).toBe(first);
    expect(await stored()).toEqual({ spx: 6752, is_backtest: true });
  });

  it('a save without the flag counts as live', async () => {
    // isBacktest is optional in SnapshotInput and defaults to false.
    await saveSnapshot({ ...KEY, spx: 6800, isBacktest: false });

    const id = await saveSnapshot({ ...KEY, spx: 6805 });

    expect(id).toEqual(expect.any(Number));
    expect(await stored()).toEqual({ spx: 6805, is_backtest: false });
  });

  // ── The seven regime columns ────────────────────────────────
  // The client posts them with every save. They were dropped from the INSERT
  // in 7194ddff (2026-03-16), so every row since holds NULL in all seven.

  const LIVE_SEVEN = {
    vixTermShape: 'contango',
    clusterPutMult: 1.3125,
    clusterCallMult: 1.1,
    rvIvRatio: 0.85,
    rvIvLabel: 'Fair Value',
    rvAnnualized: 0.123456,
    ivAccelMult: 1.21,
  };
  const BACKTEST_SEVEN = {
    vixTermShape: 'fear-spike',
    clusterPutMult: 1.39,
    clusterCallMult: 1.11,
    rvIvRatio: 1.25,
    rvIvLabel: 'IV Cheap',
    rvAnnualized: 0.0987,
    ivAccelMult: 1.8,
  };

  interface SevenRow {
    vixTermShape: string | null;
    clusterPutMult: number | null;
    clusterCallMult: number | null;
    rvIvRatio: number | null;
    rvIvLabel: string | null;
    rvAnnualized: number | null;
    ivAccelMult: number | null;
  }

  /** The stored seven for KEY; NUMERIC comes back as text, so it is cast. */
  async function storedSeven(): Promise<SevenRow> {
    const res = await pg.query<{
      vix_term_shape: string | null;
      cluster_put_mult: string | null;
      cluster_call_mult: string | null;
      rv_iv_ratio: string | null;
      rv_iv_label: string | null;
      rv_annualized: string | null;
      iv_accel_mult: string | null;
    }>(
      `SELECT vix_term_shape,
              cluster_put_mult::text  AS cluster_put_mult,
              cluster_call_mult::text AS cluster_call_mult,
              rv_iv_ratio::text       AS rv_iv_ratio,
              rv_iv_label,
              rv_annualized::text     AS rv_annualized,
              iv_accel_mult::text     AS iv_accel_mult
       FROM market_snapshots WHERE date = $1 AND entry_time = $2`,
      [KEY.date, KEY.entryTime],
    );
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0]!;
    const n = (v: string | null) => (v == null ? null : Number(v));
    return {
      vixTermShape: r.vix_term_shape,
      clusterPutMult: n(r.cluster_put_mult),
      clusterCallMult: n(r.cluster_call_mult),
      rvIvRatio: n(r.rv_iv_ratio),
      rvIvLabel: r.rv_iv_label,
      rvAnnualized: n(r.rv_annualized),
      ivAccelMult: n(r.iv_accel_mult),
    };
  }

  const ALL_NULL: SevenRow = {
    vixTermShape: null,
    clusterPutMult: null,
    clusterCallMult: null,
    rvIvRatio: null,
    rvIvLabel: null,
    rvAnnualized: null,
    ivAccelMult: null,
  };

  it('an insert stores all seven', async () => {
    await saveSnapshot({ ...KEY, spx: 6800, ...LIVE_SEVEN });

    expect(await storedSeven()).toEqual(LIVE_SEVEN);
  });

  it('an insert with null or absent values stores NULL', async () => {
    await saveSnapshot({
      ...KEY,
      spx: 6800,
      vixTermShape: null,
      clusterPutMult: null,
      // the other five are absent
    });

    expect(await storedSeven()).toEqual(ALL_NULL);
  });

  it('stores the top of each realistic range within the column precision', async () => {
    // DECIMAL(6,4) holds 99.9999 and DECIMAL(8,6) holds 99.999999; the
    // client's values sit far below: mults 0.3-3, rv/iv 0.1-5, accel
    // capped at 1.8, rv as a decimal 0.03-1.5.
    const top = {
      vixTermShape: 'backwardation',
      clusterPutMult: 3,
      clusterCallMult: 3,
      rvIvRatio: 5,
      rvIvLabel: 'IV Cheap',
      rvAnnualized: 1.5,
      ivAccelMult: 1.8,
    };
    await saveSnapshot({ ...KEY, spx: 6800, ...top });
    expect(await storedSeven()).toEqual(top);

    const bottom = {
      vixTermShape: 'contango',
      clusterPutMult: 0.3,
      clusterCallMult: 0.3,
      rvIvRatio: 0.1,
      rvIvLabel: 'IV Rich',
      rvAnnualized: 0.03,
      ivAccelMult: 0.5,
    };
    await saveSnapshot({ ...KEY, spx: 6801, ...bottom });
    expect(await storedSeven()).toEqual(bottom);
  });

  it('a live save over a live row replaces the seven', async () => {
    await saveSnapshot({ ...KEY, spx: 6800, ...LIVE_SEVEN });

    await saveSnapshot({ ...KEY, spx: 6801, ...BACKTEST_SEVEN });

    expect(await storedSeven()).toEqual(BACKTEST_SEVEN);
  });

  it('a backtest save over a backtest row overwrites the seven', async () => {
    await saveSnapshot({
      ...KEY,
      spx: 6750,
      isBacktest: true,
      ...LIVE_SEVEN,
    });

    const id = await saveSnapshot({
      ...KEY,
      spx: 6752,
      isBacktest: true,
      ...BACKTEST_SEVEN,
    });

    expect(id).toEqual(expect.any(Number));
    expect(await storedSeven()).toEqual(BACKTEST_SEVEN);
    expect(await stored()).toEqual({ spx: 6752, is_backtest: true });
  });

  it('a live save over a backtest row replaces the seven', async () => {
    await saveSnapshot({
      ...KEY,
      spx: 6750,
      isBacktest: true,
      ...BACKTEST_SEVEN,
    });

    await saveSnapshot({ ...KEY, spx: 6800, ...LIVE_SEVEN });

    expect(await storedSeven()).toEqual(LIVE_SEVEN);
  });

  it('a backtest save over a live row leaves the live row’s seven untouched', async () => {
    await saveSnapshot({ ...KEY, spx: 6800, ...LIVE_SEVEN });

    const id = await saveSnapshot({
      ...KEY,
      spx: 6750.25,
      isBacktest: true,
      ...BACKTEST_SEVEN,
    });

    expect(id).toBeNull();
    expect(await storedSeven()).toEqual(LIVE_SEVEN);
    expect(await stored()).toEqual({ spx: 6800, is_backtest: false });
  });

  it('a backtest save over a NULL-flag row leaves its seven untouched', async () => {
    await pg.query(
      `INSERT INTO market_snapshots (date, entry_time, spx, is_backtest, vix_term_shape, rv_iv_ratio)
       VALUES ($1, $2, 6800, NULL, 'flat', 0.9)`,
      [KEY.date, KEY.entryTime],
    );

    const id = await saveSnapshot({
      ...KEY,
      spx: 6750,
      isBacktest: true,
      ...BACKTEST_SEVEN,
    });

    expect(id).toBeNull();
    expect(await storedSeven()).toEqual({
      ...ALL_NULL,
      vixTermShape: 'flat',
      rvIvRatio: 0.9,
    });
  });

  // ── Migration #203 ──────────────────────────────────────────
  // Production already has the columns, from the old migrateDb; every other
  // database gets them from #203. The types are those of 7194ddff^.

  it('migration #203 creates the seven columns with the production types', async () => {
    const res = await pg.query<{
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_name = 'market_snapshots'
         AND column_name = ANY($1)
       ORDER BY column_name`,
      [
        [
          'vix_term_shape',
          'cluster_put_mult',
          'cluster_call_mult',
          'rv_iv_ratio',
          'rv_iv_label',
          'rv_annualized',
          'iv_accel_mult',
        ],
      ],
    );

    expect(res.rows).toEqual([
      {
        column_name: 'cluster_call_mult',
        data_type: 'numeric',
        numeric_precision: 6,
        numeric_scale: 4,
      },
      {
        column_name: 'cluster_put_mult',
        data_type: 'numeric',
        numeric_precision: 6,
        numeric_scale: 4,
      },
      {
        column_name: 'iv_accel_mult',
        data_type: 'numeric',
        numeric_precision: 6,
        numeric_scale: 4,
      },
      {
        column_name: 'rv_annualized',
        data_type: 'numeric',
        numeric_precision: 8,
        numeric_scale: 6,
      },
      {
        column_name: 'rv_iv_label',
        data_type: 'text',
        numeric_precision: null,
        numeric_scale: null,
      },
      {
        column_name: 'rv_iv_ratio',
        data_type: 'numeric',
        numeric_precision: 6,
        numeric_scale: 4,
      },
      {
        column_name: 'vix_term_shape',
        data_type: 'text',
        numeric_precision: null,
        numeric_scale: null,
      },
    ]);
  });

  it('migration #203 is a no-op over a table that already has the columns', async () => {
    // Production's situation: the columns exist, and rows from before
    // 7194ddff hold values in them.
    await saveSnapshot({ ...KEY, spx: 6800, ...LIVE_SEVEN });

    await applyMigration(pg, REGIME_COLUMNS_ID);

    expect(await storedSeven()).toEqual(LIVE_SEVEN);
  });

  it('a backtest save leaves a row whose flag is NULL', async () => {
    // The column is nullable. A row of unknown kind is kept as if live.
    await pg.query(
      'INSERT INTO market_snapshots (date, entry_time, spx, is_backtest) VALUES ($1, $2, 6800, NULL)',
      [KEY.date, KEY.entryTime],
    );

    const id = await saveSnapshot({ ...KEY, spx: 6750, isBacktest: true });

    expect(id).toBeNull();
    const res = await pg.query<{ spx: string; is_backtest: boolean | null }>(
      'SELECT spx::text AS spx, is_backtest FROM market_snapshots',
    );
    expect(res.rows).toEqual([{ spx: '6800.00', is_backtest: null }]);
  });
});
