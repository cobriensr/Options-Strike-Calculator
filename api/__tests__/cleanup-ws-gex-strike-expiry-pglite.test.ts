// @vitest-environment node

/**
 * REAL-SQL test for the ws_gex_strike_expiry retention sweep.
 *
 * cleanup-ws-gex-strike-expiry.test.ts mocks `db.query` and only matches
 * SQL text. This file runs the handler's ACTUAL two-pass DELETE against
 * pglite (real Postgres in WASM, with tzdata), on the table built by the
 * real migration #111, with the session in UTC as on Neon.
 *
 * Pass 2's cutoff must be ET midnight of `today`. Written as
 * `$1::date AT TIME ZONE 'America/New_York'` it resolves through
 * date → timestamptz in the SESSION zone, which under UTC puts it 8 h
 * (EDT) or 10 h (EST) early, so the previous ET evening's rows survived
 * (on production Neon the oldest surviving row sat exactly at that early
 * cutoff). `::timestamp` anchors it to ET midnight.
 *
 * Expected cutoffs are hard-coded UTC instants, independent of the SQL:
 *   - 2026-10-23 (EDT): ET midnight 04:00Z; the uncast form gave
 *     2026-10-22T20:00Z.
 *   - 2026-12-04 (EST): ET midnight 05:00Z; the uncast form gave
 *     2026-12-03T19:00Z.
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
import { applyMigration } from './pglite-migrations';

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
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

import handler from '../cron/cleanup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.pg = pg;
  await applyMigration(pg, 111);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.mocked(Sentry.captureException).mockClear();
  await pg.query('TRUNCATE ws_gex_strike_expiry RESTART IDENTITY');
});

interface Row {
  expiry: string;
  ts: string;
}

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function seed(rows: Row[]): Promise<void> {
  await pg.query(
    `INSERT INTO ws_gex_strike_expiry (ticker, expiry, strike, ts_minute)
     SELECT 'SPY', t.expiry, 100 + t.n, t.ts
       FROM unnest($1::date[], $2::timestamptz[])
              WITH ORDINALITY AS t(expiry, ts, n)`,
    [rows.map((r) => r.expiry), rows.map((r) => r.ts)],
  );
}

async function survivors(): Promise<Row[]> {
  const res = await pg.query<{ expiry: string; ts_minute: Date }>(
    `SELECT expiry::text AS expiry, ts_minute
       FROM ws_gex_strike_expiry
      ORDER BY ts_minute, expiry`,
  );
  return res.rows.map((r) => ({
    expiry: r.expiry,
    ts: r.ts_minute.toISOString(),
  }));
}

async function sweep(today: string) {
  holder.today = today;
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

function byTime(a: Row, b: Row): number {
  return a.ts.localeCompare(b.ts) || a.expiry.localeCompare(b.expiry);
}

describe('cleanup-ws-gex-strike-expiry against Postgres (pglite, UTC session)', () => {
  it.each([
    {
      label: 'an EDT day',
      today: '2026-10-23',
      etMidnight: '2026-10-23T04:00:00.000Z',
      uncastCutoff: '2026-10-22T20:00:00.000Z',
    },
    {
      label: 'an EST day',
      today: '2026-12-04',
      etMidnight: '2026-12-04T05:00:00.000Z',
      uncastCutoff: '2026-12-03T19:00:00.000Z',
    },
  ])(
    "deletes the previous ET evening's rows and keeps today's session — $label",
    async ({ today, etMidnight, uncastCutoff }) => {
      const tomorrow = addDays(today, 1);
      const deleted: Row[] = [
        // Past expiry: pass 1.
        { expiry: addDays(today, -1), ts: shift(etMidnight, -10 * HOUR) },
        // Before both cutoffs.
        { expiry: today, ts: shift(uncastCutoff, -HOUR) },
        // The previous ET evening, between the early cutoff and ET
        // midnight: the rows the uncast form kept.
        { expiry: today, ts: shift(uncastCutoff, 30 * MINUTE) },
        { expiry: today, ts: shift(etMidnight, -MINUTE) },
        { expiry: tomorrow, ts: shift(uncastCutoff, 2 * HOUR) },
      ];
      const kept: Row[] = [
        { expiry: today, ts: etMidnight },
        { expiry: today, ts: shift(etMidnight, 9.5 * HOUR) },
        { expiry: tomorrow, ts: shift(etMidnight, 10 * HOUR) },
      ];
      await seed([...deleted, ...kept]);

      const res = await sweep(today);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        today,
        totalDeleted: deleted.length,
        stopReason: 'drained',
      });
      expect(await survivors()).toEqual([...kept].sort(byTime));
      expect(Sentry.captureException).not.toHaveBeenCalled();

      // Idempotent: a second sweep finds nothing before the cutoff.
      const again = await sweep(today);
      expect(again._json).toMatchObject({ totalDeleted: 0 });
      expect(await survivors()).toEqual([...kept].sort(byTime));
    },
  );
});
