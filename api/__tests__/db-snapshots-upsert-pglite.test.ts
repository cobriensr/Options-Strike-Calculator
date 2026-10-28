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

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await db.query(text, values)).rows;
  };
}

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await initDb();
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
