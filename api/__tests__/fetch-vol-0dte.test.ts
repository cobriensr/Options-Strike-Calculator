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

import handler, {
  parseOptionSymbol,
  aggregateByStrike,
} from '../cron/fetch-vol-0dte.js';
import logger from '../_lib/logger.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-04-08T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-04-08T11:00:00.000Z');

function makeContractRow(overrides = {}) {
  return {
    option_symbol: 'SPXW260408C06800000',
    volume: 118509,
    open_interest: 4864,
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

// ============================================================
// parseOptionSymbol
// ============================================================

describe('parseOptionSymbol', () => {
  it('parses a standard SPXW call', () => {
    expect(parseOptionSymbol('SPXW260408C06800000')).toEqual({
      strike: 6800,
      type: 'C',
    });
  });

  it('parses a standard SPXW put', () => {
    expect(parseOptionSymbol('SPXW260408P06750000')).toEqual({
      strike: 6750,
      type: 'P',
    });
  });

  it('parses a fractional strike correctly', () => {
    // 6752.5 × 1000 = 6752500 → 8-digit int 06752500
    expect(parseOptionSymbol('SPXW260408C06752500')).toEqual({
      strike: 6752.5,
      type: 'C',
    });
  });

  it('parses a plain SPX monthly symbol', () => {
    expect(parseOptionSymbol('SPX260408C06800000')).toEqual({
      strike: 6800,
      type: 'C',
    });
  });

  it('returns null for empty string', () => {
    expect(parseOptionSymbol('')).toBeNull();
  });

  it('returns null for too-short symbol', () => {
    expect(parseOptionSymbol('SPXW')).toBeNull();
  });

  it('returns null for unrecognized type character', () => {
    expect(parseOptionSymbol('SPXW260408X06800000')).toBeNull();
  });

  it('returns null for non-numeric strike section', () => {
    expect(parseOptionSymbol('SPXW260408Cabcdefgh')).toBeNull();
  });
});

// ============================================================
// aggregateByStrike
// ============================================================

describe('aggregateByStrike', () => {
  it('aggregates a single call and a single put into one strike row', () => {
    const rows = [
      makeContractRow({
        option_symbol: 'SPXW260408C06800000',
        volume: 1000,
        open_interest: 500,
      }),
      makeContractRow({
        option_symbol: 'SPXW260408P06800000',
        volume: 400,
        open_interest: 200,
      }),
    ];
    const result = aggregateByStrike(rows);
    expect(result).toEqual([
      {
        strike: 6800,
        call_volume: 1000,
        put_volume: 400,
        call_oi: 500,
        put_oi: 200,
      },
    ]);
  });

  it('returns rows sorted by strike ascending', () => {
    const rows = [
      makeContractRow({ option_symbol: 'SPXW260408C06810000', volume: 100 }),
      makeContractRow({ option_symbol: 'SPXW260408P06780000', volume: 50 }),
      makeContractRow({ option_symbol: 'SPXW260408C06800000', volume: 200 }),
    ];
    const result = aggregateByStrike(rows);
    expect(result.map((r) => r.strike)).toEqual([6780, 6800, 6810]);
  });

  it('skips contracts with unparseable symbols', () => {
    const rows = [
      makeContractRow({ option_symbol: 'SPXW260408C06800000', volume: 100 }),
      makeContractRow({ option_symbol: 'garbage', volume: 999 }),
      makeContractRow({ option_symbol: 'SPXW260408P06800000', volume: 50 }),
    ];
    const result = aggregateByStrike(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.call_volume).toBe(100);
    expect(result[0]!.put_volume).toBe(50);
  });

  it('sums multiple contracts for the same strike and side', () => {
    // Shouldn't happen in practice (one contract per strike+side+expiry),
    // but defensive: sum rather than overwrite.
    const rows = [
      makeContractRow({
        option_symbol: 'SPXW260408C06800000',
        volume: 100,
        open_interest: 10,
      }),
      makeContractRow({
        option_symbol: 'SPXW260408C06800000',
        volume: 200,
        open_interest: 20,
      }),
    ];
    const result = aggregateByStrike(rows);
    expect(result[0]!.call_volume).toBe(300);
    expect(result[0]!.call_oi).toBe(30);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateByStrike([])).toEqual([]);
  });
});

// ============================================================
// handler
// ============================================================

describe('fetch-vol-0dte handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
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

  // ── Method / auth / env guards ────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

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

  it('fetches contracts, aggregates per strike, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeContractRow({
        option_symbol: 'SPXW260408C06800000',
        volume: 118509,
        open_interest: 4864,
      }),
      makeContractRow({
        option_symbol: 'SPXW260408P06750000',
        volume: 65786,
        open_interest: 2900,
      }),
    ]);

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
      job: 'fetch-vol-0dte',
      success: true,
      contracts: 2,
      strikes: 2,
      stored: 2,
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
      reason: 'No 0DTE contracts with volume',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    stubFetch([makeContractRow()]);

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
    mockTransaction.mockRejectedValue(new Error('DB batch insert failed'));
    stubFetch([makeContractRow()]);

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
      'Batch volume_per_strike_0dte insert failed',
    );
  });
});
