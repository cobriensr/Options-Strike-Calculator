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

// Fixed market-hours time: Tuesday 10:00 AM ET (2026-03-24).
// Tuesday matters: NDX has no Tue expiration, so front expiry should be Wed.
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

// 5 (ticker, expiry) tasks per cron invocation:
//   SPX × 2 (today + tomorrow), NDX × 1 (front Mon/Wed/Fri), SPY × 1, QQQ × 1
const EXPECTED_TASKS = 5;

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

/** Stub fetch to return the same strike data for every call. */
function stubFetch(data: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

describe('fetch-strike-exposure handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
    // Default: every queued INSERT returns [{id:1}] (one stored row each).
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

  it('fetches all 4 tickers, stores per-ticker rows, and returns 200', async () => {
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
      totalStored: EXPECTED_TASKS,
      totalSkipped: 0,
    });
    // 5 transactions: SPX × 2, NDX × 1, SPY × 1, QQQ × 1
    expect(mockTransaction).toHaveBeenCalledTimes(EXPECTED_TASKS);

    // Per-ticker bucket sanity
    const json = res._json as { perTicker: Record<string, unknown> };
    expect(json.perTicker.SPX).toMatchObject({ totalStored: 2 });
    expect(json.perTicker.NDX).toMatchObject({ totalStored: 1 });
    expect(json.perTicker.SPY).toMatchObject({ totalStored: 1 });
    expect(json.perTicker.QQQ).toMatchObject({ totalStored: 1 });
  });

  it('fans out to per-ticker UW URLs', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeStrikeRow()] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const urls = (fetchSpy.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/stock/SPX/spot-exposures'))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes('/stock/NDX/spot-exposures'))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes('/stock/SPY/spot-exposures'))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes('/stock/QQQ/spot-exposures'))).toBe(
      true,
    );
  });

  it('uses Wed 2026-03-25 as the NDX front expiry on a Tuesday', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeStrikeRow()] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const ndxCall = (fetchSpy.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes('/stock/NDX/spot-exposures'),
    );
    expect(ndxCall).toBeDefined();
    expect(String(ndxCall![0])).toContain('2026-03-25');
  });

  it('returns success with zero rows when API returns empty data', async () => {
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
      success: true,
      totalStored: 0,
      totalSkipped: 0,
    });
    // No transactions (empty rows short-circuit before storeStrikes hits the txn)
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly across all tasks', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // All 5 transactions return empty arrays (ON CONFLICT DO NOTHING fired).
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
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
      totalSkipped: EXPECTED_TASKS,
    });
  });

  it('isolates per-task failures — surviving tasks still complete', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // First fetch (SPX 0DTE) rejects; remaining 4 succeed.
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('SPX 0DTE network blip'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeStrikeRow()] }),
      });
    vi.stubGlobal('fetch', fetchSpy);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      totalStored: EXPECTED_TASKS - 1,
    });
  });

  it('respects per-ticker ATM windows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Strike 5810 is within ALL ticker windows when price=5800.5
    // (SPX ±200, NDX ±500, SPY ±20, QQQ ±20). Strike 5900 is in SPX/NDX
    // but out of SPY/QQQ. Strike 6100 is only in NDX (out of SPX ±200).
    const rows = [
      makeStrikeRow({ strike: '5810', price: '5800.5' }),
      makeStrikeRow({ strike: '5900', price: '5800.5' }),
      makeStrikeRow({ strike: '6100', price: '5800.5' }),
    ];
    stubFetch(rows);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      perTicker: Record<string, { totalStored: number }>;
    };
    // SPX × 2 expiries × 2 strikes (5810, 5900) = 4
    expect(json.perTicker.SPX!.totalStored).toBe(4);
    // NDX × 1 expiry × 3 strikes = 3
    expect(json.perTicker.NDX!.totalStored).toBe(3);
    // SPY × 1 expiry × 1 strike (only 5810) = 1
    expect(json.perTicker.SPY!.totalStored).toBe(1);
    // QQQ × 1 expiry × 1 strike = 1
    expect(json.perTicker.QQQ!.totalStored).toBe(1);
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when ALL ticker fetches fail', async () => {
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
    expect(res._json).toMatchObject({ error: 'All ticker fetches failed' });
  });

  it('handles batch insert errors gracefully and logs warning', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Every transaction fails — handler should still respond 200 with 0 stored
    // and warn-level log on each failure.
    mockTransaction.mockRejectedValue(new Error('DB batch insert failed'));
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
      totalSkipped: EXPECTED_TASKS,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Batch strike exposure insert failed',
    );
  });
});
