// @vitest-environment node

/**
 * HTTP-level tests for GET /api/regime-0dte.
 *
 * The endpoint runs through the REAL `regime-0dte-queries` helpers, the REAL
 * `withDbRetry` / `TransientDbError` and the REAL `withDbReader` envelope. The
 * only seams are the module boundaries underneath them: `getDb` (a recording
 * `sql` tag whose awaited queries are answered by `execute`, keyed on the
 * table the SQL text names), the guard, Sentry and the logger. That way a Neon
 * blip travels the whole path (query → retry → TransientDbError → 503), which
 * mocking the helpers directly would skip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse, isolationScopeStub } from './helpers';

const { execute, done } = vi.hoisted(() => ({
  execute: vi.fn<(text: string) => Promise<unknown[]>>(),
  done: vi.fn(),
}));

// The guard runs inside withDbReader, which imports it from guest-auth.js
// directly — so that is the module to mock (it includes the botid check).
vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

function expand(v: unknown): string {
  if (v && typeof v === 'object' && '__text' in v)
    return (v as { __text: string }).__text;
  return '$p';
}

// Only `getDb` is replaced. Fragments built with sql`` / sql.unsafe are inert
// text; only an AWAITED query reaches `execute`, like the real driver's lazy
// NeonQueryPromise.
vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      let text = strings[0] ?? '';
      for (let i = 0; i < values.length; i++)
        text += expand(values[i]) + (strings[i + 1] ?? '');
      return {
        __text: text,
        then: (res: (r: unknown[]) => void, rej: (e: unknown) => void) =>
          execute(text).then(res, rej),
      };
    },
    { unsafe: (s: string) => ({ __text: s }) },
  );
  return { ...actual, getDb: () => sql };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb(isolationScopeStub())),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => done), increment: vi.fn() },
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../regime-0dte.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { REGIME_0DTE } from '../_lib/regime-0dte.js';

type Table = 'gex' | 'iv' | 'candles';

// Which of the three source tables an awaited query reads.
function tableOf(text: string): Table {
  if (text.includes('strike_iv_snapshots')) return 'iv';
  if (text.includes('index_candles_1m')) return 'candles';
  return 'gex';
}

const executedFor = (table: Table) =>
  execute.mock.calls.filter(([text]) => tableOf(text) === table).length;

// Raw rows as Neon returns them (NUMERIC as strings). A deep-negative-gamma
// fixture (live units, ~1e10 magnitudes): five strikes tightly around spot
// 7460, each strongly net-negative → gexNear well below GATE_DEEP_NEG
// (−1.5e10) → gate 'lean_down'. net GEX = call_gamma_oi + put_gamma_oi.
const ROWS: Record<Table, unknown[]> = {
  gex: [7440, 7450, 7460, 7470, 7480].map((strike) => ({
    strike: String(strike),
    call_gamma_oi: '0',
    put_gamma_oi: '-6000000000',
    price: '7460',
  })),
  iv: [
    { ct_min: 520, iv_mid: '0.2' },
    { ct_min: 650, iv_mid: '0.27' },
  ],
  candles: [
    { ct_min: 510, bopen: '7530', bclose: '7520' },
    { ct_min: 540, bopen: '7520', bclose: '7510' },
    { ct_min: 570, bopen: '7510', bclose: '7500' },
    { ct_min: 600, bopen: '7500', bclose: '7480' },
    { ct_min: 630, bopen: '7480', bclose: '7470' },
  ],
};

// A table named here rejects every awaited query with this error.
let failing: Partial<Record<Table, Error>> = {};

const TABLES: Table[] = ['gex', 'iv', 'candles'];
// withDbRetry makes DB_RETRY_ATTEMPTS + 1 = 3 attempts per helper call, and
// getGexStrikes is called three times (open / midday / latest).
const ATTEMPTS = 3;
const CALLS_PER_TABLE: Record<Table, number> = { gex: 3, iv: 1, candles: 1 };

describe('GET /api/regime-0dte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failing = {};
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false); // false = passed
    execute.mockImplementation(async (text) => {
      const table = tableOf(text);
      const err = failing[table];
      if (err) throw err;
      return ROWS[table];
    });
    vi.useFakeTimers();
    // 12:00 ET / 11:00 CT — inside the session, after the persistence window.
    vi.setSystemTime(new Date('2026-06-06T16:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy path', () => {
    it('returns 200 with the gate, triggers and the raw series the panel renders', async () => {
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: {} }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        date: '2026-06-06',
        gate: 'lean_down',
        // Viz series come from the CURRENT ('latest') profile.
        spot: 7460,
        gexStrikes: [
          { strike: 7440, netGex: -6e9 },
          { strike: 7450, netGex: -6e9 },
          { strike: 7460, netGex: -6e9 },
          { strike: 7470, netGex: -6e9 },
          { strike: 7480, netGex: -6e9 },
        ],
        putIv: [
          { ctMin: 520, iv: 0.2 },
          { ctMin: 650, iv: 0.27 },
        ],
        candles30: [
          { ctMin: 510, open: 7530, close: 7520 },
          { ctMin: 540, open: 7520, close: 7510 },
          { ctMin: 570, open: 7510, close: 7500 },
          { ctMin: 600, open: 7500, close: 7480 },
          { ctMin: 630, open: 7480, close: 7470 },
        ],
        bandPct: REGIME_0DTE.GATE_BAND_PCT,
        persistEndCtMin: REGIME_0DTE.PERSIST_END_MIN,
      });
      expect(res._json).toHaveProperty('triggers');
      expect(res._json).toHaveProperty('asOfCtMin', 660);
    });

    it('reads three GEX anchors (open / midday / latest), the put IV and the candles', async () => {
      await handler(mockRequest({ method: 'GET', query: {} }), mockResponse());

      expect(executedFor('gex')).toBe(3);
      expect(executedFor('iv')).toBe(1);
      expect(executedFor('candles')).toBe(1);
    });

    it('keeps the 30 s edge cache', async () => {
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: {} }), res);

      expect(res._headers['Cache-Control']).toBe(
        's-maxage=30, stale-while-revalidate=30',
      );
      expect(res._headers['Vary']).toBe('Cookie');
    });

    it('records the request as a 200 exactly once', async () => {
      await handler(mockRequest({ method: 'GET', query: {} }), mockResponse());

      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith({ status: 200 });
    });

    it('evaluates a replayed PAST date as-of the cash close (15:00 CT)', async () => {
      // 11:00 CT TODAY (2026-06-06) — but we request a PAST date (2026-06-05).
      // The triggers must be graded as-of the close (900), not the live 11:00
      // (660) clock, so every time-window gate has seen the full session.
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { date: '2026-06-05' } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ date: '2026-06-05', asOfCtMin: 900 });
    });
  });

  describe('request gates', () => {
    it('answers a non-GET with 405 before touching the guard or Neon', async () => {
      const res = mockResponse();
      await handler(mockRequest({ method: 'POST', query: {} }), res);

      expect(res._status).toBe(405);
      expect(res._json).toEqual({ error: 'GET only' });
      expect(done).toHaveBeenCalledWith({ status: 405 });
      expect(guardOwnerOrGuestEndpoint).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns 401 and runs no query when the owner/guest guard rejects', async () => {
      vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
        async (_req, res) => {
          res.status(401).json({ error: 'Not authenticated' });
          return true; // the guard already responded
        },
      );
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: {} }), res);

      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Not authenticated' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a malformed date query with 400 and runs no query', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
        res,
      );

      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({
        error: 'invalid query',
        issues: [{ path: 'date', message: 'date must be YYYY-MM-DD' }],
      });
      expect(done).toHaveBeenCalledWith({ status: 400 });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('a Neon read fails', () => {
    it.each(TABLES)(
      'retries a transient %s error, then answers 503 + Retry-After with no Sentry event',
      async (table) => {
        failing[table] = new Error('fetch failed');
        const res = mockResponse();

        const pending = handler(mockRequest({ method: 'GET', query: {} }), res);
        await vi.runAllTimersAsync(); // the 1 s + 2 s retry backoffs
        await pending;

        expect(res._status).toBe(503);
        expect(res._headers['Retry-After']).toBe('5');
        expect(res._json).toEqual({
          error: 'temporarily unavailable',
          transient: true,
        });
        // Retried: every call to the failing table made all its attempts.
        expect(executedFor(table)).toBe(CALLS_PER_TABLE[table] * ATTEMPTS);
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(metrics.increment).toHaveBeenCalledWith(
          'regime_0dte.db_timeout',
        );
        expect(done).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith({ status: 503 });
      },
    );

    it.each(TABLES)(
      'answers a genuine %s error with 500, the generic body and exactly one Sentry capture',
      async (table) => {
        const boom = new Error('column "x" does not exist');
        failing[table] = boom;
        const res = mockResponse();

        await handler(mockRequest({ method: 'GET', query: {} }), res);

        expect(res._status).toBe(500);
        // Never the raw exception text (DB internals).
        expect(res._json).toEqual({ error: 'Internal server error' });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(Sentry.captureException).toHaveBeenCalledWith(boom);
        expect(logger.error).toHaveBeenCalledTimes(1);
        // Not retried: a genuine error is rethrown on the first attempt.
        expect(executedFor(table)).toBe(CALLS_PER_TABLE[table]);
        expect(done).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith({ status: 500 });
      },
    );
  });
});
