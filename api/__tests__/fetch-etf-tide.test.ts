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
import { Sentry } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeEtfTideRow(overrides = {}) {
  return {
    net_call_premium: '1000000',
    net_put_premium: '-500000',
    net_volume: 12345,
    timestamp: '2026-03-24T14:00:00.000Z',
    ...overrides,
  };
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
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callCount++;
        // First ticker (SPY) fails, second (QQQ) succeeds
        if (callCount === 1) {
          return { ok: false, status: 500, text: async () => 'Server error' };
        }
        return { ok: true, json: async () => ({ data: [row] }) };
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

  it('handles NaN net_call_premium and zero net_volume', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow({
      net_call_premium: 'not-a-number',
      net_put_premium: 'also-bad',
      net_volume: 0,
    });
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
    // Should still store 1 candle per ticker with fallback 0 values
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 1, candles: 1 },
        qqq_etf_tide: { stored: 1, candles: 1 },
      },
    });
    vi.unstubAllGlobals();
  });

  it('deduplicates rows in the same 5-min bucket', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Two rows within the same 5-min window (both round to 14:00)
    const row1 = makeEtfTideRow({
      timestamp: '2026-03-24T14:01:00.000Z',
      net_call_premium: '100',
    });
    const row2 = makeEtfTideRow({
      timestamp: '2026-03-24T14:03:00.000Z',
      net_call_premium: '200',
    });
    // Default mockTransaction returns [{ id: 1 }] per query → stored.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [row1, row2] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both rows map to same 5-min bucket → only 1 candle
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { candles: 1 },
        qqq_etf_tide: { candles: 1 },
      },
    });
    vi.unstubAllGlobals();
  });

  it('sorts sampled candles by timestamp', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Rows in different 5-min buckets, provided out of order
    const rowLate = makeEtfTideRow({
      timestamp: '2026-03-24T14:10:00.000Z',
    });
    const rowEarly = makeEtfTideRow({
      timestamp: '2026-03-24T14:00:00.000Z',
    });
    // Default mockTransaction returns [{ id: 1 }] per query → stored.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [rowLate, rowEarly] }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // 2 distinct 5-min buckets → 2 candles
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 2, candles: 2 },
        qqq_etf_tide: { stored: 2, candles: 2 },
      },
    });
    vi.unstubAllGlobals();
  });

  // ── Data quality check ────────────────────────────────────

  it('runs data quality check when all candles are new and > 10', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Generate 11 rows in distinct 5-min buckets
    const rows = Array.from({ length: 11 }, (_, i) => {
      const minutes = i * 5;
      const hour = 14 + Math.floor(minutes / 60);
      const min = minutes % 60;
      const ts = `2026-03-24T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`;
      return makeEtfTideRow({ timestamp: ts });
    });

    // INSERTs run through the batched transaction (default → all 11 stored).
    // The only direct mockSql call is the SELECT COUNT data-quality query.
    mockSql.mockResolvedValue([{ total: 11, nonzero: 0 }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
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

  it('skips data quality check when candles <= 10', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Generate exactly 10 rows (threshold is > 10, so 10 should NOT trigger)
    const rows = Array.from({ length: 10 }, (_, i) => {
      const minutes = i * 5;
      const hour = 14 + Math.floor(minutes / 60);
      const min = minutes % 60;
      const ts = `2026-03-24T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`;
      return makeEtfTideRow({ timestamp: ts });
    });

    // Default mockTransaction stores all 10; no SELECT COUNT expected.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
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
    // Generate 11 rows
    const rows = Array.from({ length: 11 }, (_, i) => {
      const minutes = i * 5;
      const hour = 14 + Math.floor(minutes / 60);
      const min = minutes % 60;
      const ts = `2026-03-24T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`;
      return makeEtfTideRow({ timestamp: ts });
    });

    // First insert in the batch stores (RETURNING id), the rest conflict
    // (empty) → stored !== candles, so the data-quality check is skipped.
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map((_, i) => (i === 0 ? [{ id: 1 }] : []));
      },
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

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
    vi.unstubAllGlobals();
  });

  // ── Outer catch block ─────────────────────────────────────

  it('returns 500 when data quality check throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Generate 11 rows to trigger the data quality check path
    const rows = Array.from({ length: 11 }, (_, i) => {
      const minutes = i * 5;
      const hour = 14 + Math.floor(minutes / 60);
      const min = minutes % 60;
      const ts = `2026-03-24T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`;
      return makeEtfTideRow({ timestamp: ts });
    });

    // INSERTs succeed via the batched transaction (default → all 11 stored),
    // but the SELECT COUNT data-quality query (the only direct mockSql call)
    // throws, landing in the handler's outer catch block.
    mockSql.mockRejectedValue(new Error('DB connection lost'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: rows }),
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
