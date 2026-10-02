// @vitest-environment node

/**
 * REAL-SQL test for the ws_option_trades retention purge.
 *
 * cleanup-ws-option-trades.test.ts mocks `db.query` and only matches the SQL
 * text. This file runs the handler's ACTUAL statements against pglite: the
 * oldest-first ctid DELETE, its frontier bound and the ET-midnight cutoff.
 * pglite is real Postgres in WASM with tzdata, so `AT TIME ZONE
 * 'America/New_York'` resolves exactly as on Neon.
 *
 * Only the DB handle and cronGuard are replaced. cronGuard supplies the ET
 * `today` the real guard derives from the clock (computed here with the same
 * getETDateStr). The clock itself is not faked, so pglite's timers run
 * normally.
 *
 * The expected cutoffs are hard-coded UTC instants, independent of the SQL
 * under test:
 *   - 2026-06-09 (EDT weekday) → 2026-06-07 00:00 EDT = 04:00Z
 *   - 2026-11-03 → 2026-11-01 00:00 ET. DST ends at 02:00 that day, so
 *     midnight is still EDT → 04:00Z (a fixed EST offset would say 05:00Z).
 *   - 2027-03-16 → 2027-03-14 00:00 ET. DST starts at 02:00 that day, so
 *     midnight is still EST → 05:00Z (a fixed EDT offset would say 04:00Z).
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

const holder = vi.hoisted(() => ({
  pg: null as unknown as {
    query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  today: '',
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => ({
    query: async (text: string, params: unknown[] = []) =>
      (await holder.pg.query(text, params)).rows,
  }),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: () => ({ today: holder.today, apiKey: '' }),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (_name: string, fn: unknown) => fn,
}));

import handler from '../cron/cleanup-ws-option-trades.js';
import { Sentry } from '../_lib/sentry.js';
import { getETDateStr } from '../../src/utils/timezone.js';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.pg = pg;
  // The columns the purge touches, with the production index it relies on.
  await pg.query(`
    CREATE TABLE ws_option_trades (
      id          BIGSERIAL PRIMARY KEY,
      ticker      TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pg.query(
    'CREATE INDEX ws_option_trades_executed_idx ON ws_option_trades (executed_at)',
  );
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.mocked(Sentry.captureException).mockClear();
  await pg.query('TRUNCATE ws_option_trades');
});

async function seed(timestamps: string[]): Promise<void> {
  await pg.query(
    `INSERT INTO ws_option_trades (ticker, executed_at)
     SELECT 'SPY', t FROM unnest($1::timestamptz[]) AS t`,
    [timestamps],
  );
}

async function survivors(): Promise<string[]> {
  const res = await pg.query<{ executed_at: Date }>(
    'SELECT executed_at FROM ws_option_trades ORDER BY executed_at, id',
  );
  return res.rows.map((r) => r.executed_at.toISOString());
}

/** Run the real handler as of `runAtIso` (ET date derived like cronGuard). */
async function purge(runAtIso: string) {
  holder.today = getETDateStr(new Date(runAtIso));
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

describe('cleanup-ws-option-trades against Postgres (pglite)', () => {
  it.each([
    // [label, run instant, expected cutoff, trap row and whether it survives]
    [
      '22:05 UTC on an EDT weekday',
      '2026-06-09T22:05:00.000Z',
      '2026-06-07T04:00:00.000Z',
      null,
    ],
    [
      'the Tuesday after DST ends (cutoff midnight is still EDT)',
      '2026-11-03T22:05:00.000Z',
      '2026-11-01T04:00:00.000Z',
      // Between the true cutoff (04:00Z) and a naive EST one (05:00Z): kept.
      { at: '2026-11-01T04:30:00.000Z', survives: true },
    ],
    [
      'the Tuesday after DST starts (cutoff midnight is still EST)',
      '2027-03-16T22:05:00.000Z',
      '2027-03-14T05:00:00.000Z',
      // Between a naive EDT cutoff (04:00Z) and the true one (05:00Z): purged.
      { at: '2027-03-14T04:30:00.000Z', survives: false },
    ],
  ])(
    'keeps exactly the rows at or after the ET-midnight cutoff — %s',
    async (_label, runAt, cutoff, trap) => {
      const before = shift(cutoff, -1);
      const after = shift(cutoff, 1);
      const old = shift(cutoff, -3 * 86_400_000);
      await seed([old, before, cutoff, after, ...(trap ? [trap.at] : [])]);

      const res = await purge(runAt);

      expect(res._status).toBe(200);
      const expectedSurvivors = [
        cutoff,
        after,
        ...(trap?.survives ? [trap.at] : []),
      ].sort();
      expect(await survivors()).toEqual(expectedSurvivors);
      expect(res._json).toMatchObject({
        totalDeleted: 2 + (trap && !trap.survives ? 1 : 0),
        stopReason: 'drained',
      });

      // Idempotent: a second run finds nothing older than the cutoff.
      const again = await purge(runAt);
      expect(again._json).toMatchObject({ totalDeleted: 0, batches: 1 });
      expect(await survivors()).toEqual(expectedSurvivors);
      expect(Sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it('drains more than one 50k batch when a timestamp tie spans the batch boundary', async () => {
    const runAt = '2026-06-09T22:05:00.000Z';
    const cutoff = '2026-06-07T04:00:00.000Z';
    // 49,990 expired rows at distinct 1 ms steps, then 60 expired rows that
    // all share one later timestamp T. Batch 1 (LIMIT 50,000) takes the
    // 49,990 plus 10 of the tie; its frontier is T, and batch 2's
    // `executed_at >= T` bound must still find the other 50.
    const tieAt = shift(cutoff, -3_600_000);
    await pg.query(
      `INSERT INTO ws_option_trades (ticker, executed_at)
       SELECT 'SPY', $1::timestamptz + g * INTERVAL '1 millisecond'
       FROM generate_series(0, 49989) AS g`,
      [shift(cutoff, -86_400_000)],
    );
    await pg.query(
      `INSERT INTO ws_option_trades (ticker, executed_at)
       SELECT 'QQQ', $1::timestamptz FROM generate_series(1, 60)`,
      [tieAt],
    );
    const kept = [cutoff, shift(cutoff, 1), shift(cutoff, 60_000)];
    await seed(kept);

    const res = await purge(runAt);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalDeleted: 50_050,
      batches: 2,
      stopReason: 'drained',
    });
    expect(await survivors()).toEqual(kept);

    const again = await purge(runAt);
    expect(again._json).toMatchObject({ totalDeleted: 0, batches: 1 });
    expect(await survivors()).toEqual(kept);
  }, 120_000);
});
