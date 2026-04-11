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
  metrics: {
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  schwabFetch: vi.fn(),
  withRetry: vi.fn(),
  cronGuard: vi.fn(),
  checkDataQuality: vi.fn(),
}));

import handler from '../cron/fetch-spx-candles-1m.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  uwFetch,
  schwabFetch,
  withRetry,
  cronGuard,
  checkDataQuality,
} from '../_lib/api-helpers.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const TODAY = '2026-03-24';

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

/** Default Schwab quote response with a ~11.65× ratio. */
function makeSchwabQuotes(spxPrice = 6817.43, spyPrice = 585.0) {
  return {
    ok: true as const,
    data: {
      $SPX: { quote: { lastPrice: spxPrice } },
      SPY: { quote: { lastPrice: spyPrice } },
    },
  };
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
    process.env.UW_API_KEY = 'uwkey';

    // Default pass-through behaviors
    vi.mocked(withRetry).mockImplementation((fn: () => Promise<unknown>) =>
      fn(),
    );
    vi.mocked(cronGuard).mockReturnValue({ apiKey: 'uwkey', today: TODAY });
    vi.mocked(schwabFetch).mockResolvedValue(makeSchwabQuotes());
    vi.mocked(uwFetch).mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    vi.mocked(cronGuard).mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches 1m candles, translates SPY→SPX, stores, and returns 200', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

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

  it('includes the ratio in the success response', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);
    vi.mocked(schwabFetch).mockResolvedValue(makeSchwabQuotes(6817.43, 585.0));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // ratio = 6817.43 / 585 ≈ 11.6537, rounded to 4 decimal places
    expect(json.ratio).toBeCloseTo(6817.43 / 585.0, 4);
  });

  it('translates SPY prices to SPX using the live Schwab ratio', async () => {
    const spxPrice = 6817.43;
    const spyPrice = 585.0;
    vi.mocked(schwabFetch).mockResolvedValue(
      makeSchwabQuotes(spxPrice, spyPrice),
    );
    vi.mocked(uwFetch).mockResolvedValue([
      makeCandleRow({
        open: '580.00',
        high: '581.50',
        low: '579.25',
        close: '580.90',
      }),
    ]);

    const ratio = spxPrice / spyPrice;

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
    expect(capturedRow!.open).toBeCloseTo(580.0 * ratio, 4);
    expect(capturedRow!.high).toBeCloseTo(581.5 * ratio, 4);
    expect(capturedRow!.low).toBeCloseTo(579.25 * ratio, 4);
    expect(capturedRow!.close).toBeCloseTo(580.9 * ratio, 4);
    expect(capturedRow!.volume).toBe(2480);
    expect(capturedRow!.market_time).toBe('r');
  });

  it('stores premarket and postmarket candles alongside regular', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
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

  // ── Schwab ratio fetch failure ────────────────────────────

  it('returns stored: false when Schwab quote fetch fails', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false as const,
      status: 503,
      error: 'Service unavailable',
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
      stored: false,
      reason: 'SPX/SPY ratio unavailable from Schwab',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(vi.mocked(metrics).increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.ratio_unavailable',
    );
  });

  it('returns stored: false when Schwab returns missing price data', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true as const,
      data: { $SPX: {}, SPY: {} },
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
      stored: false,
      reason: 'SPX/SPY ratio unavailable from Schwab',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── Empty / malformed data ────────────────────────────────

  it('returns stored: false when UW returns empty data', async () => {
    vi.mocked(uwFetch).mockResolvedValue([]);

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
    vi.mocked(uwFetch).mockResolvedValue([
      makeCandleRow(),
      makeCandleRow({
        open: 'not-a-number',
        start_time: '2026-03-24T14:31:00Z',
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
    // Only 1 row should reach the transaction
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns stored: false when all rows are filtered as invalid', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
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
    // Simulate ON CONFLICT DO NOTHING — RETURNING returns empty arrays
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    vi.mocked(uwFetch).mockResolvedValue([
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
    // 2 rows: first returned [{id:1}], second returned [] (already existed)
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map((_, i) => (i === 0 ? [{ id: 1 }] : []));
      },
    );
    vi.mocked(uwFetch).mockResolvedValue([
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

  it('returns 500 when UW API throws', async () => {
    vi.mocked(uwFetch).mockRejectedValue(new Error('UW API timeout'));

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
    mockTransaction.mockRejectedValueOnce(new Error('DB batch insert failed'));
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

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

  it('runs data quality check when stored > 10', async () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      makeCandleRow({
        start_time: `2026-03-24T14:${String(30 + i).padStart(2, '0')}:00Z`,
      }),
    );
    vi.mocked(uwFetch).mockResolvedValue(rows);

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('SELECT COUNT')) {
        return Promise.resolve([{ total: 11, nonzero: 11 }]);
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
    expect(vi.mocked(checkDataQuality)).toHaveBeenCalledWith(
      expect.objectContaining({
        job: 'fetch-spx-candles-1m',
        table: 'spx_candles_1m',
        date: TODAY,
      }),
    );
  });

  it('skips data quality check when stored <= 10', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeCandleRow({
        start_time: `2026-03-24T14:${String(30 + i).padStart(2, '0')}:00Z`,
      }),
    );
    vi.mocked(uwFetch).mockResolvedValue(rows);

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
    expect(vi.mocked(checkDataQuality)).not.toHaveBeenCalled();
  });

  // ── Schwab price anchor (spx_schwab_price) ────────────────

  it('returns { ratio, spxPrice } from Schwab and surfaces spxPrice in response', async () => {
    const spxPrice = 6817.43;
    const spyPrice = 585.0;
    vi.mocked(schwabFetch).mockResolvedValue(
      makeSchwabQuotes(spxPrice, spyPrice),
    );
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.spxPrice).toBeCloseTo(spxPrice, 2);
    expect(json.ratio).toBeCloseTo(spxPrice / spyPrice, 4);
  });

  it('calls UPDATE to anchor spx_schwab_price on the current minute candle', async () => {
    const spxPrice = 6817.43;
    vi.mocked(schwabFetch).mockResolvedValue(makeSchwabQuotes(spxPrice, 585.0));
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

    // Track all direct sql calls (non-transaction)
    const sqlCalls: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join('?'));
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
    // Verify at least one SQL call contained the UPDATE for spx_schwab_price
    const hasUpdate = sqlCalls.some((q) => q.includes('spx_schwab_price'));
    expect(hasUpdate).toBe(true);
  });

  it('does not attempt spx_schwab_price UPDATE when ratio fetch returns null', async () => {
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false as const,
      status: 503,
      error: 'Service unavailable',
    });
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

    const sqlCalls: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join('?'));
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

    // Ratio is null → handler returns early, no UPDATE attempted
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: false });
    const hasUpdate = sqlCalls.some((q) => q.includes('spx_schwab_price'));
    expect(hasUpdate).toBe(false);
  });

  it('proceeds normally even when spx_schwab_price UPDATE fails', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeCandleRow()]);

    // Make the UPDATE throw (any direct sql call that includes the right string)
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      if (strings.join('').includes('spx_schwab_price')) {
        throw new Error('UPDATE failed');
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

    // Should still return 200 success — anchor failure is non-fatal
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true });
  });
});
