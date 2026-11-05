// @vitest-environment node

/**
 * REAL-SQL test for auto-prefill-premarket's write path.
 *
 * auto-prefill-premarket.test.ts mocks the DB and can only match SQL text.
 * The guard here is jsonb semantics (`pre_market_data->>'autoFilled'` is the
 * text 'true' only when the cron wrote it; a hand save has no such key), and
 * the target-row choice is an ORDER BY over a boolean, so this file runs the
 * handler's ACTUAL statements against pglite (real Postgres in WASM).
 *
 * market_snapshots is created by initDb, not by a migration, so
 * applyMigration cannot build it. The table below models only the columns
 * this cron and GET /api/pre-market touch. futures_bars is migration #42
 * minus its es_bars copy, which needs a table that no longer exists.
 *
 * Only the DB handle and cronGuard (which supplies `today`) are replaced.
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

import { mockRequest, mockResponse } from './helpers';
import { neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => neonOverPglite(holder.pg),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  // 2026-07-15 is a Wednesday in EDT: the overnight window is
  // 2026-07-14T22:00Z to 2026-07-15T13:30Z.
  cronGuard: () => ({ today: '2026-07-15', apiKey: '' }),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/auto-prefill-premarket.js';

const TRADE_DATE = '2026-07-15';

/** What a hand save through POST /api/pre-market stores: no autoFilled key. */
const HAND_SAVED = {
  globexHigh: 5800,
  globexLow: 5750,
  globexClose: 5790,
  globexVwap: 5780,
  savedAt: '2026-07-15T13:45:00.000Z',
};

/** What an earlier run of this cron stores. */
const AUTO_FILLED = {
  globexHigh: 1,
  globexLow: 1,
  globexClose: 1,
  globexVwap: 1,
  savedAt: '2026-07-15T13:30:00.000Z',
  autoFilled: true,
};

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.pg = pg;
  await pg.query(`
    CREATE TABLE market_snapshots (
      id              SERIAL PRIMARY KEY,
      date            DATE NOT NULL,
      entry_time      TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      pre_market_data JSONB
    )
  `);
  await pg.query(`
    CREATE TABLE futures_bars (
      id      BIGSERIAL PRIMARY KEY,
      symbol  TEXT NOT NULL,
      ts      TIMESTAMPTZ NOT NULL,
      open    NUMERIC(12,4) NOT NULL,
      high    NUMERIC(12,4) NOT NULL,
      low     NUMERIC(12,4) NOT NULL,
      close   NUMERIC(12,4) NOT NULL,
      volume  BIGINT NOT NULL DEFAULT 0,
      UNIQUE(symbol, ts)
    )
  `);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  process.env.CRON_SECRET = 'test-secret';
  await pg.query('TRUNCATE market_snapshots, futures_bars RESTART IDENTITY');
  // Two overnight ES bars inside the window: H 5710, L 5690, last close 5700.
  await pg.query(`
    INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume) VALUES
      ('ES', '2026-07-15T03:00:00Z', 5695, 5710, 5690, 5700, 100),
      ('ES', '2026-07-15T13:00:00Z', 5700, 5705, 5698, 5700, 300)
  `);
});

async function insertSnapshot(
  createdAt: string,
  preMarketData: object | null,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO market_snapshots (date, entry_time, created_at, pre_market_data)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [
      TRADE_DATE,
      `t${createdAt}`,
      createdAt,
      preMarketData === null ? null : JSON.stringify(preMarketData),
    ],
  );
  return rows[0]!.id;
}

async function stored(id: number): Promise<Record<string, unknown> | null> {
  const { rows } = await pg.query<{ pre_market_data: unknown }>(
    'SELECT pre_market_data FROM market_snapshots WHERE id = $1',
    [id],
  );
  return rows[0]!.pre_market_data as Record<string, unknown> | null;
}

async function run() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

describe('auto-prefill-premarket real SQL', () => {
  it('leaves a hand-saved row untouched', async () => {
    const id = await insertSnapshot('2026-07-15T13:45:00Z', HAND_SAVED);

    const res = await run();

    expect(await stored(id)).toEqual(HAND_SAVED);
    expect(res._json).toMatchObject({
      status: 'skipped',
      reason: 'manual_pre_market_data',
    });
  });

  it('treats an explicit autoFilled:false as hand-saved', async () => {
    const saved = { ...HAND_SAVED, autoFilled: false };
    const id = await insertSnapshot('2026-07-15T13:45:00Z', saved);

    await run();

    expect(await stored(id)).toEqual(saved);
  });

  it('refreshes a row an earlier run auto-filled', async () => {
    const id = await insertSnapshot('2026-07-15T13:30:00Z', AUTO_FILLED);

    const res = await run();

    expect(await stored(id)).toMatchObject({
      globexHigh: 5710,
      globexLow: 5690,
      globexClose: 5700,
      autoFilled: true,
    });
    expect(res._json).toMatchObject({ status: 'success', stored: true });
  });

  it('fills a snapshot row that has no pre-market data yet', async () => {
    const id = await insertSnapshot('2026-07-15T14:00:00Z', null);

    await run();

    expect(await stored(id)).toMatchObject({
      globexHigh: 5710,
      autoFilled: true,
    });
  });

  it('inserts a pre-market row when the date has none', async () => {
    const res = await run();

    const { rows } = await pg.query<{
      entry_time: string;
      pre_market_data: Record<string, unknown>;
    }>('SELECT entry_time, pre_market_data FROM market_snapshots');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry_time).toBe('pre-market');
    expect(rows[0]!.pre_market_data).toMatchObject({
      globexHigh: 5710,
      autoFilled: true,
    });
    expect(res._json).toMatchObject({ status: 'success' });
  });

  it('keeps an older hand save visible when a newer snapshot has none', async () => {
    // GET /api/pre-market returns the newest row WITH pre_market_data. If the
    // cron wrote auto data into the newer empty row it would shadow the hand
    // save, so it must target the row the reader would return instead.
    const saved = await insertSnapshot('2026-07-15T13:45:00Z', HAND_SAVED);
    const newer = await insertSnapshot('2026-07-15T14:20:00Z', null);

    await run();

    expect(await stored(saved)).toEqual(HAND_SAVED);
    expect(await stored(newer)).toBeNull();
  });

  it('a second run updates the same row instead of adding one', async () => {
    await run();
    const first = await pg.query<{ id: number }>(
      'SELECT id FROM market_snapshots',
    );
    await run();
    const second = await pg.query<{ id: number }>(
      'SELECT id FROM market_snapshots',
    );
    expect(second.rows).toEqual(first.rows);
  });
});
