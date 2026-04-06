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

import handler from '../cron/fetch-gex-0dte.js';
import logger from '../_lib/logger.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_vol: '100000',
    put_gamma_vol: '-50000',
    call_gamma_ask: '200000',
    call_gamma_bid: '150000',
    put_gamma_ask: '-100000',
    put_gamma_bid: '-80000',
    call_charm_oi: '50000',
    put_charm_oi: '-40000',
    call_charm_vol: '25000',
    put_charm_vol: '-20000',
    call_delta_oi: '100000',
    put_delta_oi: '-75000',
    call_vanna_oi: '25000',
    put_vanna_oi: '-15000',
    call_vanna_vol: '12000',
    put_vanna_vol: '-8000',
    ...overrides,
  };
}

function stubFetch(data: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

describe('fetch-gex-0dte handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
    mockTransaction.mockImplementation(
      async (
        fn: (txn: (...args: unknown[]) => unknown) => unknown[],
      ) => {
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
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches 0DTE strikes, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-gex-0dte',
      success: true,
      price: 5800.5,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns correct response for empty API data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: false,
      reason: 'No 0DTE strike data',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockTransaction.mockImplementationOnce(
      async (
        fn: (txn: (...args: unknown[]) => unknown) => unknown[],
      ) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  it('filters out strikes beyond ±200 pts from ATM', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const nearStrike = makeStrikeRow({
      strike: '5800',
      price: '5800.5',
    });
    const farStrike = makeStrikeRow({
      strike: '6100',
      price: '5800.5',
    });
    stubFetch([nearStrike, farStrike]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Only near strike stored — 6100 is >200 pts away
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('handles batch insert errors gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockTransaction.mockRejectedValueOnce(
      new Error('DB batch insert failed'),
    );
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      stored: 0,
      skipped: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Batch gex_strike_0dte insert failed',
    );
  });
});
