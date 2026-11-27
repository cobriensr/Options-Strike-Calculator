// @vitest-environment node

/**
 * REAL-SQL test for the session bound on `/api/gex-landscape`'s panel reads.
 * After the close the handler reads each panel up to the SPX anchor, and a
 * `?at=` scrub reads up to `at`; both stay inside one session, between ET
 * midnight of the session date and the upper bound. Three things live in SQL
 * and a mocked `sql` cannot see them:
 *
 * - `captured_at` is `now()` and keeps microseconds, while the anchor and `at`
 *   travel as millisecond ISO strings. The upper end is `< upper + 1 ms`, so
 *   the row an anchor names is kept; a plain `<= upper` would drop it.
 * - The lower bound keeps the previous session's last row out of the first
 *   minute of the next one.
 * - The anchor itself comes from `getClosedAnchors`, read here from the same
 *   rows the panels are.
 *
 * The session is 2026-11-20 (a Friday, EST, so ET midnight is 05:00Z); the next
 * one opens Monday 2026-11-23. Tables come from migration #156.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations';

const { holder, mockSpot } = vi.hoisted(() => ({
  holder: { sql: null as unknown },
  mockSpot: vi.fn<(date: string, asOf?: string) => Promise<number | null>>(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError: class TransientDbError extends Error {},
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn(async () => false),
}));

vi.mock('../_lib/api-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(() => false),
}));

vi.mock('../_lib/periscope-query.js', () => ({ fetchSpxSpot: mockSpot }));

import handler from '../gex-landscape.js';

let pg: PGlite;

/** Saturday 10:00 ET: closed, and the session is Friday's. */
const SATURDAY = new Date('2026-11-21T15:00:00.000Z');

/** A GEXBot `mini_contracts` row: strike, value at position 3. */
const payload = (strike: number, value: number) => ({
  mini_contracts: [[strike, 0, 0, value, [value, value, value], 0, null]],
});

/** One `state` capture of SPX; `at` keeps whatever precision it is given. */
async function state(category: string, at: string, strike: number) {
  await pg.query(
    `INSERT INTO gexbot_api_capture
       (ticker, endpoint, category, captured_at, source_timestamp, raw_response)
     VALUES ('SPX', 'state', $1, $2::timestamptz, $3, $4::jsonb)`,
    [
      category,
      at,
      Math.floor(Date.parse(at) / 1000),
      JSON.stringify(payload(strike, 1)),
    ],
  );
}

/** The three panels at one capture time. */
async function allPanels(at: string, strike: number) {
  for (const category of ['gamma_zero', 'charm_zero', 'vanna_zero']) {
    await state(category, at, strike);
  }
}

async function call(query: Record<string, string> = {}) {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query,
    }),
    res,
  );
  return res._json as {
    asOf: string | null;
    data: { strikes: Array<{ strike: number }> } | null;
    reason?: string;
    availableMinutes: string[];
  };
}

describe('gex-landscape session bounds against real SQL', () => {
  beforeAll(async () => {
    pg = new PGlite();
    holder.sql = neonOverPglite(pg);
    await applyMigration(pg, 156);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.query('DELETE FROM gexbot_api_capture');
    mockSpot.mockReset();
    mockSpot.mockResolvedValue(5947.12);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SATURDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('closed market, live read', () => {
    it("serves the anchor row even when its capture time has microseconds, and reads the session's spot", async () => {
      // The anchor travels as '…49.123Z'; the stored row is '…49.123456Z'.
      await allPanels('2026-11-20T21:00:49.123456Z', 5950);
      // Another ticker's later row is the table's newest; SPX's anchor is
      // still inside the 15 minutes before it.
      await pg.query(
        `INSERT INTO gexbot_api_capture
           (ticker, endpoint, category, captured_at, source_timestamp, raw_response)
         VALUES ('NDX', 'classic', 'gex_full', '2026-11-20T21:00:55Z', 1, '{}'::jsonb)`,
      );

      const body = await call();

      expect(body.reason).toBeUndefined();
      expect(body.asOf).toBe('2026-11-20T21:00:49.123Z');
      expect(body.data!.strikes.map((s) => s.strike)).toEqual([5950]);
      expect(mockSpot).toHaveBeenCalledExactlyOnceWith(
        '2026-11-20',
        '2026-11-20T21:00:49.123Z',
      );
      expect(body.availableMinutes).toEqual(['2026-11-20T21:00:00.000Z']);
    });

    it("reads no_slot when a panel has no row on the session, never the previous session's row", async () => {
      // Friday has gamma and charm; its vanna panel never captured. Thursday
      // has all three, and its vanna row is the newest vanna row stored.
      await allPanels('2026-11-19T20:59:49.5Z', 5900);
      await state('gamma_zero', '2026-11-20T21:00:49.123456Z', 5950);
      await state('charm_zero', '2026-11-20T21:00:49.123456Z', 5950);

      const body = await call();

      expect(body).toMatchObject({
        asOf: null,
        data: null,
        reason: 'no_slot',
      });
      // Friday's own minutes are still listed, so the panel can step back.
      expect(body.availableMinutes).toEqual(['2026-11-20T21:00:00.000Z']);
      expect(mockSpot).not.toHaveBeenCalled();
    });

    it('reads no_slot when the table is empty', async () => {
      const body = await call();
      expect(body).toMatchObject({
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableMinutes: [],
      });
    });
  });

  describe('?at= scrub', () => {
    it("reads no_slot at a session's first minute, never the previous session's last row", async () => {
      // Friday's last capture. Monday's first option is 09:30 ET (14:30Z)
      // and its first capture lands about 49 s later, so at the minute itself
      // the newest row at or before `at` is Friday's.
      await allPanels('2026-11-20T21:00:49.123456Z', 5950);

      const body = await call({ at: '2026-11-23T14:30:00.000Z' });

      expect(body).toMatchObject({
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableMinutes: [],
      });
      expect(mockSpot).not.toHaveBeenCalled();
    });

    it("serves the session's own row once it exists, with the spot on that date", async () => {
      await allPanels('2026-11-20T21:00:49.123456Z', 5950);
      await allPanels('2026-11-23T14:30:49.5Z', 6000);

      const body = await call({ at: '2026-11-23T14:31:00.000Z' });

      expect(body.asOf).toBe('2026-11-23T14:30:49.500Z');
      expect(body.data!.strikes.map((s) => s.strike)).toEqual([6000]);
      expect(mockSpot).toHaveBeenCalledExactlyOnceWith(
        '2026-11-23',
        '2026-11-23T14:30:49.500Z',
      );
    });

    it("keeps a capture at the scrub's own millisecond, whatever its microseconds", async () => {
      await allPanels('2026-11-23T14:30:49.123456Z', 6000);

      const body = await call({ at: '2026-11-23T14:30:49.123Z' });

      expect(body.asOf).toBe('2026-11-23T14:30:49.123Z');
      expect(body.data).not.toBeNull();
    });

    it('keeps a late-evening ET scrub on its own ET date, not the next UTC date', async () => {
      // 20:30 ET Monday is 01:30Z Tuesday. The session is still Monday's.
      await allPanels('2026-11-24T01:00:49.5Z', 6100);
      // Tuesday 00:30 ET, after `at`: out of range.
      await allPanels('2026-11-24T05:30:00Z', 6200);

      const body = await call({ at: '2026-11-24T01:30:00.000Z' });

      expect(body.asOf).toBe('2026-11-24T01:00:49.500Z');
      expect(body.data!.strikes.map((s) => s.strike)).toEqual([6100]);
      expect(mockSpot).toHaveBeenCalledWith(
        '2026-11-23',
        '2026-11-24T01:00:49.500Z',
      );
    });
  });
});
