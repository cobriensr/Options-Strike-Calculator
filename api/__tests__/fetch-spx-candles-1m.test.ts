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

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import handler from '../cron/fetch-spx-candles-1m.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');

interface CandleOverrides {
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: number;
  total_volume?: number;
  start_time?: string;
  end_time?: string;
  market_time?: 'pr' | 'r' | 'po';
}

function makeCandleRow(overrides: CandleOverrides = {}) {
  return {
    open: '580.00',
    high: '580.25',
    low: '579.90',
    close: '580.10',
    volume: 2480,
    total_volume: 93553050,
    start_time: '2026-03-24T14:30:00Z',
    end_time: '2026-03-24T14:31:00Z',
    market_time: 'r' as const,
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

describe('fetch-spx-candles-1m handler', () => {
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

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches 1m candles, translates SPY→SPX, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeCandleRow()]);

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
      job: 'fetch-spx-candles-1m',
      success: true,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('translates SPY prices to SPX via 10× ratio', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeCandleRow({
        open: '580.00',
        high: '581.50',
        low: '579.25',
        close: '580.90',
      }),
    ]);

    let capturedRow: Record<string, unknown> | null = null;
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = (..._args: unknown[]) => {
          // Neon's tagged-template signature: (strings, ...values).
          // We ignore the strings array and capture the bound values.
          const values = _args.slice(1);
          // positional values:
          //   0 date, 1 timestamp,
          //   2 open, 3 high, 4 low, 5 close,
          //   6 volume, 7 market_time
          capturedRow = {
            date: values[0],
            timestamp: values[1],
            open: values[2],
            high: values[3],
            low: values[4],
            close: values[5],
            volume: values[6],
            market_time: values[7],
          };
          return {};
        };
        const queries = fn(txnFn);
        return queries.map(() => [{ id: 1 }]);
      },
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(capturedRow).not.toBeNull();
    expect(capturedRow!.open).toBeCloseTo(5800.0, 5);
    expect(capturedRow!.high).toBeCloseTo(5815.0, 5);
    expect(capturedRow!.low).toBeCloseTo(5792.5, 5);
    expect(capturedRow!.close).toBeCloseTo(5809.0, 5);
    expect(capturedRow!.volume).toBe(2480);
    expect(capturedRow!.market_time).toBe('r');
  });

  it('stores premarket and postmarket candles alongside regular', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeCandleRow({
        start_time: '2026-03-24T13:00:00Z',
        market_time: 'pr',
        volume: 100,
      }),
      makeCandleRow({
        start_time: '2026-03-24T14:30:00Z',
        market_time: 'r',
        volume: 2480,
      }),
      makeCandleRow({
        start_time: '2026-03-24T21:05:00Z',
        market_time: 'po',
        volume: 50,
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
      success: true,
      stored: 3,
      skipped: 0,
    });
  });

  // ── Empty / malformed data ────────────────────────────────

  it('returns stored: false when UW returns empty data', async () => {
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
      reason: 'No 1m candles',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('filters out rows with NaN OHLC values', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const validRow = makeCandleRow();
    const badRow = makeCandleRow({
      open: 'not-a-number',
      start_time: '2026-03-24T14:31:00Z',
    });
    stubFetch([validRow, badRow]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Only 1 row should reach the transaction
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns stored: false when all rows are filtered as invalid', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeCandleRow({ open: 'bad' }),
      makeCandleRow({ high: 'bad', start_time: '2026-03-24T14:31:00Z' }),
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
      stored: false,
      reason: 'No valid 1m candles after filter',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Deduplication via ON CONFLICT ─────────────────────────

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Simulate ON CONFLICT DO NOTHING — RETURNING returns empty arrays
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    stubFetch([
      makeCandleRow({ start_time: '2026-03-24T14:30:00Z' }),
      makeCandleRow({ start_time: '2026-03-24T14:31:00Z' }),
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
      success: true,
      stored: 0,
      skipped: 2,
    });
  });

  it('counts partial deduplication (half new, half existing)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 2 rows: first returned [{id:1}], second returned [] (already existed)
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map((_, i) => (i === 0 ? [{ id: 1 }] : []));
      },
    );
    stubFetch([
      makeCandleRow({ start_time: '2026-03-24T14:30:00Z' }),
      makeCandleRow({ start_time: '2026-03-24T14:31:00Z' }),
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
      success: true,
      stored: 1,
      skipped: 1,
    });
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails with 5xx', async () => {
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
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'fetch-spx-candles-1m',
    );
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'fetch-spx-candles-1m error',
    );
  });

  it('handles batch insert errors gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockTransaction.mockRejectedValueOnce(new Error('DB batch insert failed'));
    stubFetch([makeCandleRow()]);

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
      'Batch spx_candles_1m insert failed',
    );
  });

  // ── Data quality check ────────────────────────────────────

  it('runs data quality check when stored > 10 and fires when all-zero volume', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Generate 11 distinct candle rows (> 10 threshold)
    const rows = Array.from({ length: 11 }, (_, i) =>
      makeCandleRow({
        start_time: `2026-03-24T14:${String(30 + i).padStart(2, '0')}:00Z`,
      }),
    );
    stubFetch(rows);

    // mockSql is invoked as a tagged template for the post-insert QC query.
    // Return total=11, nonzero=0 so checkDataQuality fires.
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('SELECT COUNT')) {
        return Promise.resolve([{ total: 11, nonzero: 0 }]);
      }
      return Promise.resolve([]);
    });

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
      stored: 11,
      skipped: 0,
    });

    // checkDataQuality → Sentry.captureMessage when nonzero === 0
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
  });

  it('skips data quality check when stored <= 10', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeCandleRow({
        start_time: `2026-03-24T14:${String(30 + i).padStart(2, '0')}:00Z`,
      }),
    );
    stubFetch(rows);

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
      stored: 10,
    });
    // QC should NOT have fired
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
