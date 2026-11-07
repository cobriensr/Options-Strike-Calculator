// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

import handler from '../cron/fetch-etf-tide.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// 2026-03-24 is on EDT (UTC-4): 09:30 ET is 13:30Z, 16:00 ET is 20:00Z.
// Fixed "market hours" date: Tuesday 10:12 AM ET, a cron minute (:12). The
// 10:00-10:05 and 10:05-10:10 buckets have closed; 10:10-10:15 is open.
const MARKET_TIME = new Date('2026-03-24T14:12:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const MINUTE = 60_000;
const at = (hhmmZ: string, day = '2026-03-24'): Date =>
  new Date(`${day}T${hhmmZ}:00Z`);

/**
 * One minute row. The default is the last minute (14:04Z = 10:04 ET) of the
 * 10:00-10:05 bucket, which is closed at MARKET_TIME.
 */
function makeEtfTideRow(overrides = {}) {
  return {
    net_call_premium: '1000000',
    net_put_premium: '-500000',
    net_volume: 12345,
    timestamp: '2026-03-24T14:04:00.000Z',
    ...overrides,
  };
}

/**
 * UW's prefilled session grid: one row per minute from the 09:30 ET open to
 * the 16:00 ET close of `day`. Minutes that start at or after `filledUntil`
 * have not happened yet, so UW sends them with null values. The cumulative
 * ncp is the minute-of-session, so a bucket's value names its last minute.
 */
function sessionGrid(day: string, filledUntil: Date) {
  const open = at('13:30', day).getTime();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 390; i++) {
    const start = new Date(open + i * MINUTE);
    rows.push(
      start < filledUntil
        ? makeEtfTideRow({
            timestamp: start.toISOString(),
            net_call_premium: String(1000 + i),
            net_put_premium: String(-500 - i),
            net_volume: 10 + i,
          })
        : {
            timestamp: start.toISOString(),
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
          },
    );
  }
  return rows;
}

/**
 * Replace the batch transaction with a recorder: each INSERT's bound values
 * (date, timestamp, source, ncp, npp, net_volume) are pushed to the returned
 * array, per source. Every INSERT reports a stored row.
 */
function recordInserts() {
  const bySource: Record<string, unknown[][]> = {};
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      const queries = fn((_strings: unknown, ...values: unknown[]) => {
        bound.push(values);
        return {};
      });
      for (const values of bound) {
        const source = String(values[2]);
        bySource[source] = [...(bySource[source] ?? []), values];
      }
      return queries.map(() => [{ id: 1 }]);
    },
  );
  return bySource;
}

function stubUw(payload: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: payload }),
    }),
  );
}

async function runCron() {
  const req = mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
  const res = mockResponse();
  await handler(req, res);
  return res;
}

describe('fetch-etf-tide handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockSql.transaction = mockTransaction;
    // Default: every INSERT in the batch stores a row (RETURNING id non-empty).
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ id: 1 }]);
      },
    );
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is set and header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
    vi.unstubAllGlobals();
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours (early morning)', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('stores the latest candle from each ticker and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow();
    // Default mockTransaction returns [{ id: 1 }] per query → stored.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      results: {
        spy_etf_tide: { stored: 1 },
        qqq_etf_tide: { stored: 1 },
      },
    });
    // Two INSERT batches (one transaction per ticker)
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('returns stored: false for empty API responses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      results: {
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 0 },
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns stored: false when API response has no data field', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 0 },
      },
    });
    vi.unstubAllGlobals();
  });

  // ── Error handling ────────────────────────────────────────

  it('partial: one ticker fails → status partial, healthy ticker still stored (BE-CRON-H4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow();
    // QQQ succeeds; default mockTransaction returns [{ id: 1 }] → stored.
    // SPY 500s on EVERY attempt: withRetry retries a one-off 500, so the
    // failure must persist through the retries to demote the run. Fake
    // setTimeout so the 1 s + 2 s backoff doesn't burn wall time; Date is
    // faked too so the market-hours clock can be re-pinned on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(MARKET_TIME);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/market/SPY/')) {
        return { ok: false, status: 500, text: async () => 'Server error' };
      }
      return { ok: true, json: async () => ({ data: [row] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      // Demoted to partial because SPY failed...
      status: 'partial',
      failureCount: 1,
      results: {
        // ...but QQQ's healthy data still landed.
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 1 },
      },
    });
    // The healthy QQQ leg still wrote one row.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalled();
    // SPY: initial attempt + 2 withRetry retries; QQQ: one clean fetch.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('error: all tickers fail → status error (not success), no green monitor', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Per-ticker failures are caught (HTTP stays 200), but the cron status
    // is now 'error' instead of an unconditional 'success' so the monitor
    // no longer stays green on a full UW outage.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      failureCount: 2,
      results: {
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 0 },
      },
    });
    vi.unstubAllGlobals();
  });

  it('error: a payload whose data is not a list fails both legs by name, nothing stored (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { not: 'a list' } }),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.fetch_error',
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('partial: one ticker batch INSERT rejects → status partial, captured once, not success (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeEtfTideRow()] }),
      }),
    );

    // Reject the batch INSERT for one source only. The txn stub records the
    // bound values so the failing leg is chosen by its `source`, not by call
    // order (the two tickers run concurrently).
    const dbError = new Error('connection lost');
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const bound: unknown[][] = [];
        const queries = fn((_strings: unknown, ...values: unknown[]) => {
          bound.push(values);
          return {};
        });
        if (bound.some((values) => values.includes('spy_etf_tide')))
          throw dbError;
        return queries.map(() => [{ id: 1 }]);
      },
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      results: {
        spy_etf_tide: { stored: 0 },
        // The healthy QQQ leg still landed its row.
        qqq_etf_tide: { stored: 1 },
      },
    });
    // One capture for the one failed write, not two.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    vi.unstubAllGlobals();
  });

  it('error: every ticker batch INSERT rejects → status error, one capture each (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeEtfTideRow()] }),
      }),
    );
    const dbError = new Error('connection lost');
    mockTransaction.mockRejectedValue(dbError);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    vi.unstubAllGlobals();
  });

  it('success: all tickers succeed → status success', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow();
    // Default mockTransaction returns [{ id: 1 }] per query → stored.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      failureCount: 0,
    });
    vi.unstubAllGlobals();
  });

  // ── Duplicate / skip counting ─────────────────────────────

  it('counts skipped candles when INSERT conflicts', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow();
    // ON CONFLICT DO NOTHING → each query in the batch returns an empty array.
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      results: {
        spy_etf_tide: { stored: 0, skipped: 1 },
        qqq_etf_tide: { stored: 0, skipped: 1 },
      },
    });
    vi.unstubAllGlobals();
  });

  // ── sampleTo5Min edge cases ───────────────────────────────

  it('stores a closed bucket whose values are real zeros (net_volume 0)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw([
      makeEtfTideRow({
        net_call_premium: '0',
        net_put_premium: '0',
        net_volume: 0,
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 1, candles: 1, unusable: 0 },
        qqq_etf_tide: { stored: 1, candles: 1, unusable: 0 },
      },
    });
    expect(inserts.spy_etf_tide).toEqual([
      ['2026-03-24', '2026-03-24T14:05:00.000Z', 'spy_etf_tide', 0, 0, 0],
    ]);
    vi.unstubAllGlobals();
  });

  it('never stores a NaN premium in a past minute as 0 (R-null)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw([
      makeEtfTideRow({
        net_call_premium: 'not-a-number',
        net_put_premium: 'also-bad',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    // The bucket is left out, not stored with fallback zeros, and the bad
    // minute is counted once per leg.
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 0, candles: 0, unusable: 1 },
        qqq_etf_tide: { stored: 0, candles: 0, unusable: 1 },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(inserts).toEqual({});
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.invalid_candle',
    );
    vi.unstubAllGlobals();
  });

  it('keeps only the last minute of a bucket, whichever order UW sends them in', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // Three minutes of the 10:00-10:05 bucket, out of order. The 14:04 row is
    // the bucket's last minute, so its values are the ones stored.
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T14:04:00.000Z',
        net_call_premium: '300',
      }),
      makeEtfTideRow({
        timestamp: '2026-03-24T14:01:00.000Z',
        net_call_premium: '100',
      }),
      makeEtfTideRow({
        timestamp: '2026-03-24T14:03:00.000Z',
        net_call_premium: '200',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: { spy_etf_tide: { candles: 1 }, qqq_etf_tide: { candles: 1 } },
    });
    expect(inserts.spy_etf_tide).toHaveLength(1);
    expect(inserts.spy_etf_tide?.[0]?.[3]).toBe(300);
    vi.unstubAllGlobals();
  });

  it('stores one row per closed bucket, oldest first, under the bucket end', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // 14:09 closes the 10:05-10:10 bucket, 14:04 the 10:00-10:05 one.
    stubUw([
      makeEtfTideRow({ timestamp: '2026-03-24T14:09:00.000Z' }),
      makeEtfTideRow({ timestamp: '2026-03-24T14:04:00.000Z' }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 2, candles: 2 },
        qqq_etf_tide: { stored: 2, candles: 2 },
      },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).toEqual([
      '2026-03-24T14:05:00.000Z',
      '2026-03-24T14:10:00.000Z',
    ]);
    vi.unstubAllGlobals();
  });

  // ── Frozen grid and pre-open session (F1, F2) ─────────────

  it("09:27 ET: a payload of yesterday's rows stores nothing, logs and counts it, and is not an error (R-day)", async () => {
    vi.setSystemTime(at('13:27'));
    process.env.UW_API_KEY = 'uwkey';
    stubUw(sessionGrid('2026-03-23', at('20:00', '2026-03-23')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      failureCount: 0,
      results: {
        spy_etf_tide: { stored: 0, candles: 0, reason: 'no_rows_today' },
        qqq_etf_tide: { stored: 0, candles: 0, reason: 'no_rows_today' },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.no_rows_today',
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'spy_etf_tide', payloadRows: 390 }),
      expect.stringContaining('no rows for today'),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('09:32 ET: the prefilled grid with null future minutes stores nothing and counts no bad candle (F1)', async () => {
    vi.setSystemTime(at('13:32'));
    process.env.UW_API_KEY = 'uwkey';
    stubUw(sessionGrid('2026-03-24', at('13:32')));

    const res = await runCron();

    expect(res._status).toBe(200);
    // 390 rows, 388 of them null future minutes: before the fix this was
    // 78 buckets stored as 0 and 78 invalid_candle hits per ticker.
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 0, candles: 0, unusable: 0 },
        qqq_etf_tide: { stored: 0, candles: 0, unusable: 0 },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('10:02 ET: stores only the closed, non-null buckets, at bucket-end labels (R-closed, label rule)', async () => {
    vi.setSystemTime(at('14:02'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(sessionGrid('2026-03-24', at('14:02')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 6, candles: 6, unusable: 0 },
        qqq_etf_tide: { stored: 6, candles: 6, unusable: 0 },
      },
    });
    // 09:30-09:35 is stored at 09:35 (13:35Z) ... 09:55-10:00 at 10:00 (14:00Z).
    // The value of each is its last minute's: 13:34 is minute 4 of the session.
    expect(inserts.spy_etf_tide).toEqual([
      [
        '2026-03-24',
        '2026-03-24T13:35:00.000Z',
        'spy_etf_tide',
        1004,
        -504,
        14,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:40:00.000Z',
        'spy_etf_tide',
        1009,
        -509,
        19,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:45:00.000Z',
        'spy_etf_tide',
        1014,
        -514,
        24,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:50:00.000Z',
        'spy_etf_tide',
        1019,
        -519,
        29,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:55:00.000Z',
        'spy_etf_tide',
        1024,
        -524,
        34,
      ],
      [
        '2026-03-24',
        '2026-03-24T14:00:00.000Z',
        'spy_etf_tide',
        1029,
        -529,
        39,
      ],
    ]);
    // The open 10:00-10:05 bucket has values for 14:00 and 14:01 but a null
    // last minute: it waits for a later run and is not counted as bad.
    expect(metrics.increment).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('leaves out a closed bucket whose last minute is null and counts it (R-null)', async () => {
    vi.setSystemTime(at('14:02'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    const grid = sessionGrid('2026-03-24', at('14:02')).map((row) =>
      row.timestamp === '2026-03-24T13:44:00.000Z'
        ? {
            ...row,
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
          }
        : row,
    );
    stubUw(grid);

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 5, candles: 5, unusable: 1 },
        qqq_etf_tide: { stored: 5, candles: 5, unusable: 1 },
      },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.invalid_candle',
    );
    vi.unstubAllGlobals();
  });

  it('16:02 ET: stores the last bucket of the day (15:55-16:00) at 16:00 on the first run after it closes', async () => {
    vi.setSystemTime(at('20:02'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    mockSql.mockResolvedValue([{ total: 78, nonzero: 78 }]);
    stubUw(sessionGrid('2026-03-24', at('20:00')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 78, candles: 78 },
        qqq_etf_tide: { stored: 78, candles: 78 },
      },
    });
    expect(inserts.spy_etf_tide?.at(-1)).toEqual([
      '2026-03-24',
      '2026-03-24T20:00:00.000Z',
      'spy_etf_tide',
      // The last minute, 15:59 ET, is minute 389 of the session.
      1389,
      -889,
      399,
    ]);
    vi.unstubAllGlobals();
  });

  it('15:57 ET: the last bucket is still open and is not stored yet', async () => {
    vi.setSystemTime(at('19:57'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    mockSql.mockResolvedValue([{ total: 77, nonzero: 77 }]);
    stubUw(sessionGrid('2026-03-24', at('19:57')));

    await runCron();

    expect(inserts.spy_etf_tide).toHaveLength(77);
    expect(inserts.spy_etf_tide?.at(-1)?.[1]).toBe('2026-03-24T19:55:00.000Z');
    vi.unstubAllGlobals();
  });

  // ── Data quality check ────────────────────────────────────

  /** Rows for the last minute of the first `count` buckets of the session. */
  function closedBucketRows(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeEtfTideRow({
        timestamp: new Date(
          at('13:34').getTime() + i * 5 * MINUTE,
        ).toISOString(),
      }),
    );
  }

  it('runs data quality check when all candles are new and > 10', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 10:27 ET: 11 buckets (09:30-10:25) have closed
    vi.setSystemTime(at('14:27'));
    const rows = closedBucketRows(11);

    // INSERTs run through the batched transaction (default → all 11 stored).
    // The only direct mockSql call is the SELECT COUNT data-quality query.
    mockSql.mockResolvedValue([{ total: 11, nonzero: 0 }]);
    stubUw(rows);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 11, candles: 11 },
        qqq_etf_tide: { stored: 11, candles: 11 },
      },
    });

    // checkDataQuality should have been called, which triggers
    // Sentry.captureMessage when nonzero === 0
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
    vi.unstubAllGlobals();
  });

  it("counts only today's session rows in the data quality query, so yesterday's rows cannot mask a dead day (R-quality)", async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));
    mockSql.mockResolvedValue([{ total: 11, nonzero: 11 }]);
    stubUw(closedBucketRows(11));

    await runCron();

    // One SELECT per ticker. Its text bounds `timestamp` and binds the
    // 09:30 ET open and 16:00 ET close of today (EDT: 13:30Z and 20:00Z).
    expect(mockSql).toHaveBeenCalledTimes(2);
    for (const call of mockSql.mock.calls) {
      const [strings, ...values] = call as [string[], ...unknown[]];
      const text = strings.join('?');
      expect(text).toMatch(/timestamp >= \?::timestamptz/);
      expect(text).toMatch(/timestamp <= \?::timestamptz/);
      expect(values).toContain('2026-03-24T13:30:00.000Z');
      expect(values).toContain('2026-03-24T20:00:00.000Z');
      expect(values).toContain('2026-03-24');
    }
    vi.unstubAllGlobals();
  });

  it('skips data quality check when candles <= 10', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));
    // Exactly 10 closed buckets (threshold is > 10, so 10 should NOT trigger)
    stubUw(closedBucketRows(10));

    // Default mockTransaction stores all 10; no SELECT COUNT expected.
    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 10, candles: 10 },
      },
    });

    // No SELECT COUNT query should have been made
    const selectCalls = mockSql.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'object' &&
        Array.isArray(args[0]) &&
        (args[0] as string[]).join('').includes('SELECT COUNT'),
    );
    expect(selectCalls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('skips data quality check when some candles are duplicates', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));

    // First insert in the batch stores (RETURNING id), the rest conflict
    // (empty) → stored !== candles, so the data-quality check is skipped.
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map((_, i) => (i === 0 ? [{ id: 1 }] : []));
      },
    );
    stubUw(closedBucketRows(11));

    const res = await runCron();

    expect(res._status).toBe(200);
    // stored !== candles, so data quality check should be skipped
    const result = res._json as Record<string, unknown>;
    const results = result.results as Record<
      string,
      { stored: number; candles: number }
    >;
    for (const r of Object.values(results)) {
      expect(r.stored).not.toBe(r.candles);
    }
    expect(mockSql).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // ── Outer catch block ─────────────────────────────────────

  it('returns 500 when data quality check throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));

    // INSERTs succeed via the batched transaction (default → all 11 stored),
    // but the SELECT COUNT data-quality query (the only direct mockSql call)
    // throws, landing in the handler's outer catch block.
    mockSql.mockRejectedValue(new Error('DB connection lost'));
    stubUw(closedBucketRows(11));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
