// @vitest-environment node

/**
 * REAL-SQL test for fetch-spot-gex's batched insert.
 *
 * fetch-spot-gex.test.ts mocks the db and can only match the SQL text. This
 * file runs the cron's ACTUAL unnest INSERT against pglite (real Postgres in
 * WASM), with spot_exposures from the real migration #7: the arrays are cast
 * and zipped right, values and NULLs round-trip, each row lands on its own ET
 * date, the unique key makes a repeat a no-op, and `stored` counts the rows
 * that went in.
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

vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return { getDb: () => holder.sql, withDbRetry: actual.withDbRetry };
});

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { increment: vi.fn(), uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));

import handler from '../cron/fetch-spot-gex.js';
import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations.js';

let pg: PGlite;
const originalEnv = { ...process.env };

function uwRow(startTime: string, overrides: Record<string, unknown> = {}) {
  return {
    start_time: startTime,
    time: startTime,
    price: '5750.25',
    gamma_per_one_percent_move_oi: '1234567.8912',
    gamma_per_one_percent_move_vol: '-500000',
    gamma_per_one_percent_move_dir: '300000',
    charm_per_one_percent_move_oi: '200000',
    charm_per_one_percent_move_vol: '100000',
    charm_per_one_percent_move_dir: null,
    vanna_per_one_percent_move_oi: '50000',
    vanna_per_one_percent_move_vol: '25000',
    vanna_per_one_percent_move_dir: '15000',
    ...overrides,
  };
}

async function runCron(rows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rows }) }),
  );
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  expect(res._status).toBe(200);
  return res._json as {
    status: string;
    message?: string;
    stored: number;
    submitted: number;
  };
}

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = neonOverPglite(pg);
  await applyMigration(pg, 7);
  process.env.CRON_SECRET = 'test-secret';
  process.env.UW_API_KEY = 'uwkey';
});

afterAll(async () => {
  await pg.close();
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM spot_exposures');
  // 10:00 ET on Tuesday 2026-03-24 (EDT).
  vi.setSystemTime(new Date('2026-03-24T14:00:00.000Z'));
});

describe('fetch-spot-gex against real Postgres', () => {
  it('inserts a batch in one statement with the right columns, dates and NULLs', async () => {
    const out = await runCron([
      // 22:00 ET on the 23rd: a row of the previous ET day (the replay).
      uwRow('2026-03-24T02:00:00.000Z'),
      uwRow('2026-03-24T13:31:00.000Z', { price: '5751.10' }),
      uwRow('2026-03-24T13:32:00.000Z'),
    ]);

    expect(out).toMatchObject({ status: 'success', stored: 3, submitted: 3 });
    const { rows } = await pg.query<{
      date: Date;
      timestamp: Date;
      ticker: string;
      price: string;
      gamma_oi: string;
      gamma_vol: string;
      charm_dir: string | null;
    }>(
      `SELECT date, timestamp, ticker, price::text, gamma_oi::text,
              gamma_vol::text, charm_dir::text
         FROM spot_exposures ORDER BY timestamp`,
    );
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2026-03-23',
      '2026-03-24',
      '2026-03-24',
    ]);
    expect(rows.map((r) => r.timestamp.toISOString())).toEqual([
      '2026-03-24T02:00:00.000Z',
      '2026-03-24T13:31:00.000Z',
      '2026-03-24T13:32:00.000Z',
    ]);
    expect(rows.every((r) => r.ticker === 'SPX')).toBe(true);
    expect(rows[1]!.price).toBe('5751.10');
    expect(rows[0]!.gamma_oi).toBe('1234567.8912');
    expect(rows[0]!.gamma_vol).toBe('-500000.0000');
    // A null column stays NULL, it is not turned into 0.
    expect(rows[0]!.charm_dir).toBeNull();
  });

  it('puts each of the nine value columns in its own column (no arrays swapped)', async () => {
    await runCron([uwRow('2026-03-24T13:31:00.000Z')]);

    // uwRow gives every column a distinct value, so a swap of any two unnest
    // arguments shows here. charm_dir is NULL and must stay NULL.
    const { rows } = await pg.query<Record<string, string | null>>(
      `SELECT price::text, gamma_oi::text, gamma_vol::text, gamma_dir::text,
              charm_oi::text, charm_vol::text, charm_dir::text,
              vanna_oi::text, vanna_vol::text, vanna_dir::text
         FROM spot_exposures`,
    );
    expect(rows).toEqual([
      {
        price: '5750.25',
        gamma_oi: '1234567.8912',
        gamma_vol: '-500000.0000',
        gamma_dir: '300000.0000',
        charm_oi: '200000.0000',
        charm_vol: '100000.0000',
        charm_dir: null,
        vanna_oi: '50000.0000',
        vanna_vol: '25000.0000',
        vanna_dir: '15000.0000',
      },
    ]);
  });

  it('writes nothing for a repeat of the same rows and counts none as stored', async () => {
    const rows = [
      uwRow('2026-03-24T13:31:00.000Z'),
      uwRow('2026-03-24T13:32:00.000Z'),
    ];
    expect(await runCron(rows)).toMatchObject({ stored: 2 });

    // The mark is now 13:32, so a repeat sends nothing.
    expect(await runCron(rows)).toMatchObject({ stored: 0, submitted: 0 });
    const { rows: stored } = await pg.query('SELECT 1 FROM spot_exposures');
    expect(stored).toHaveLength(2);
  });

  it('counts conflict no-ops as not stored when the mark is null (the pre-rollover replay)', async () => {
    // Yesterday's session is already in the table, on yesterday's date.
    await pg.exec(
      `INSERT INTO spot_exposures (date, timestamp, ticker, price)
       VALUES ('2026-03-23', '2026-03-23T19:58:00Z', 'SPX', 5700),
              ('2026-03-23', '2026-03-23T19:59:00Z', 'SPX', 5701)`,
    );

    // Today has no row yet (the mark is null), so UW's replay of yesterday is
    // sent in full, and conflicts on (date, timestamp, ticker).
    const out = await runCron([
      uwRow('2026-03-23T19:58:00.000Z'),
      uwRow('2026-03-23T19:59:00.000Z'),
    ]);

    expect(out).toMatchObject({ stored: 0, submitted: 2 });
    const { rows } = await pg.query('SELECT 1 FROM spot_exposures');
    expect(rows).toHaveLength(2);
  });

  it('reports success, not skipped, when the pre-rollover replay conflicts and also holds an all-zero opening minute', async () => {
    // Yesterday's session is already stored; today has no row (mark is null).
    await pg.exec(
      `INSERT INTO spot_exposures (date, timestamp, ticker, price)
       VALUES ('2026-03-23', '2026-03-23T19:58:00Z', 'SPX', 5700),
              ('2026-03-23', '2026-03-23T19:59:00Z', 'SPX', 5701)`,
    );
    const zero = {
      gamma_per_one_percent_move_oi: '0',
      gamma_per_one_percent_move_vol: '0',
      gamma_per_one_percent_move_dir: '0',
      charm_per_one_percent_move_oi: '0',
      charm_per_one_percent_move_vol: '0',
      charm_per_one_percent_move_dir: null,
      vanna_per_one_percent_move_oi: '0',
      vanna_per_one_percent_move_vol: '0',
      vanna_per_one_percent_move_dir: '0',
    };

    // UW replays yesterday: the opening minute was all-zero, the two real
    // rows already exist, so all of them conflict (stored 0) but two were
    // submitted. Not "only all-zero rows": a success.
    const out = await runCron([
      uwRow('2026-03-23T13:30:00.000Z', zero),
      uwRow('2026-03-23T19:58:00.000Z'),
      uwRow('2026-03-23T19:59:00.000Z'),
    ]);

    expect(out).toMatchObject({
      status: 'success',
      stored: 0,
      submitted: 2,
    });
    expect(out.message).toBeUndefined();
    const { rows } = await pg.query('SELECT 1 FROM spot_exposures');
    expect(rows).toHaveLength(2);
  });

  it('does not store an all-zero row and reports skipped', async () => {
    const zero = {
      gamma_per_one_percent_move_oi: '0',
      gamma_per_one_percent_move_vol: '0',
      gamma_per_one_percent_move_dir: '0',
      charm_per_one_percent_move_oi: '0',
      charm_per_one_percent_move_vol: '0',
      charm_per_one_percent_move_dir: null,
      vanna_per_one_percent_move_oi: '0',
      vanna_per_one_percent_move_vol: '0',
      vanna_per_one_percent_move_dir: '0',
    };
    const out = await runCron([uwRow('2026-03-24T13:31:00.000Z', zero)]);

    expect(out).toMatchObject({ status: 'skipped', stored: 0 });
    const { rows } = await pg.query('SELECT 1 FROM spot_exposures');
    expect(rows).toHaveLength(0);
  });
});
