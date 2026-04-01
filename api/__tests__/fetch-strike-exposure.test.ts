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
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import handler from '../cron/fetch-strike-exposure.js';
import logger from '../_lib/logger.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    date: '2026-03-24',
    expiry: '2026-03-24',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_ask: '200000',
    call_gamma_bid: '150000',
    put_gamma_ask: '-100000',
    put_gamma_bid: '-80000',
    call_charm_oi: '50000',
    put_charm_oi: '-40000',
    call_charm_ask: '20000',
    call_charm_bid: '15000',
    put_charm_ask: '-10000',
    put_charm_bid: '-8000',
    call_delta_oi: '100000',
    put_delta_oi: '-75000',
    call_vanna_oi: '25000',
    put_vanna_oi: '-15000',
    ...overrides,
  };
}

/** Stub fetch to return the same strike exposure data for all calls */
function stubFetch(data: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

/**
 * Stub fetch to return different data per sequential call.
 * Each entry maps to one fetch invocation in order.
 */
function stubFetchSequential(responses: unknown[][]) {
  const mockFetch = vi.fn();
  for (const data of responses) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data }),
    });
  }
  vi.stubGlobal('fetch', mockFetch);
}

describe('fetch-strike-exposure handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-attach transaction after resetAllMocks clears mock state
    mockSql.transaction = mockTransaction;
    // Default: all rows inserted (returns [{id:1}] per query)
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
    vi.unstubAllGlobals();
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
    stubFetch();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
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

  it('fetches strikes, filters to ATM range, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      price: 5800.5,
      totalStored: 2,
      totalSkipped: 0,
      dte0: { stored: 1, skipped: 0 },
      dte1: { stored: 1, skipped: 0 },
    });
    // 2 transactions: one for 0DTE, one for 1DTE
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it('returns correct response for empty API data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: false,
      reason: 'No strike data',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Override: all rows conflict (DO NOTHING returns empty) for both 0DTE and 1DTE
    const conflictImpl = async (
      fn: (txn: (...args: unknown[]) => unknown) => unknown[],
    ) => {
      const txnFn = () => ({});
      const queries = fn(txnFn);
      return queries.map(() => []);
    };
    mockTransaction
      .mockImplementationOnce(conflictImpl)
      .mockImplementationOnce(conflictImpl);
    stubFetch([makeStrikeRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalStored: 0,
      totalSkipped: 2,
    });
  });

  it('handles 1DTE returning empty data gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 0DTE has data, 1DTE returns empty
    stubFetchSequential([[makeStrikeRow()], []]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      dte0: { stored: 1, skipped: 0 },
      dte1: { stored: 0, skipped: 0 },
      totalStored: 1,
      totalSkipped: 0,
    });
    // Only 1 transaction: 0DTE only
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('handles 0DTE empty but 1DTE has data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchSequential([[], [makeStrikeRow()]]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      dte0: { stored: 0, skipped: 0 },
      dte1: { stored: 1, skipped: 0 },
      totalStored: 1,
      totalSkipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('filters out strikes beyond ±200 pts from ATM', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const nearStrike = makeStrikeRow({ strike: '5800', price: '5800.5' });
    const farStrike = makeStrikeRow({ strike: '6100', price: '5800.5' });
    stubFetch([nearStrike, farStrike]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Only the near strike (5800) should be stored; 6100 is >200 pts away
    expect(res._json).toMatchObject({
      success: true,
      totalStored: 2,
      totalSkipped: 0,
    });
    // 2 transactions: one per expiry
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails (non-ok response)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
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
  });

  it('returns 500 when fetch throws (network error)', async () => {
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

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('handles batch insert errors gracefully and logs warning', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Both 0DTE and 1DTE transactions fail
    mockTransaction
      .mockRejectedValueOnce(new Error('DB batch insert failed'))
      .mockRejectedValueOnce(new Error('DB batch insert failed'));
    stubFetch([makeStrikeRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      totalStored: 0,
      totalSkipped: 2,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Batch strike exposure insert failed',
    );
  });
});
