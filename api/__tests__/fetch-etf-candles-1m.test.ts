// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockUwFetch, mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: mockWithRetry,
}));

import handler from '../cron/fetch-etf-candles-1m.js';

// ── Fixtures ──────────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-27' };

function makeCandle(overrides: Record<string, unknown> = {}) {
  return {
    start_time: '2026-04-27T14:32:00Z',
    open: '527.50',
    high: '528.10',
    low: '527.20',
    close: '527.85',
    volume: 345678,
    ...overrides,
  };
}

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

describe('fetch-etf-candles-1m handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: cronGuard returns valid guard (market open, auth ok)
    mockCronGuard.mockReturnValue(GUARD);
    // Default: uwFetch returns one candle for both tickers
    mockUwFetch.mockResolvedValue([makeCandle()]);
    // Default: withRetry passes through
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    // Default: SQL INSERT returns a row (stored)
    mockSql.mockResolvedValue([{ id: 1 }]);
  });

  // ── Guard delegation ───────────────────────────────────────

  it('exits early without fetching when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('passes auth when CRON_SECRET matches', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours gate ─────────────────────────────────────

  it('skips when outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(500).json({ error: 'UW_API_KEY not configured' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches both tickers, stores both, returns 200 with per-ticker counts', async () => {
    const spyCandle = makeCandle({ start_time: '2026-04-27T14:32:00Z' });
    const qqqCandle = makeCandle({
      start_time: '2026-04-27T14:32:00Z',
      open: '455.10',
      high: '455.80',
      low: '454.90',
      close: '455.60',
    });

    // First call returns SPY candle, second returns QQQ candle
    mockUwFetch
      .mockResolvedValueOnce([spyCandle])
      .mockResolvedValueOnce([qqqCandle]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-candles-1m',
      tickers: {
        SPY: { stored: 1, skipped: 0 },
        QQQ: { stored: 1, skipped: 0 },
      },
    });
    // 2 INSERT calls (1 per ticker)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Verifies both endpoints are called ────────────────────

  it('calls both /stock/SPY/ohlc/1m and /stock/QQQ/ohlc/1m endpoints', async () => {
    mockUwFetch.mockResolvedValue([]);
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(urls.some((u) => u.includes('/stock/SPY/ohlc/1m'))).toBe(true);
    expect(urls.some((u) => u.includes('/stock/QQQ/ohlc/1m'))).toBe(true);
  });

  // ── Empty data ────────────────────────────────────────────

  it('handles empty data for both tickers (returns all zeros)', async () => {
    mockUwFetch.mockResolvedValue([]);
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { stored: 0, skipped: 0 },
        QQQ: { stored: 0, skipped: 0 },
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── ON CONFLICT (duplicate) path ──────────────────────────

  it('counts ON CONFLICT rows as skipped, not stored', async () => {
    // Empty result array = ON CONFLICT DO NOTHING (no row returned)
    mockSql.mockResolvedValue([]);
    mockUwFetch
      .mockResolvedValueOnce([makeCandle()])
      .mockResolvedValueOnce([makeCandle()]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { stored: 0, skipped: 1 },
        QQQ: { stored: 0, skipped: 1 },
      },
    });
  });

  // ── Insert error handling ─────────────────────────────────

  it('counts insert error as skipped; whole handler still returns 200', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB insert failed'));
    mockUwFetch.mockResolvedValueOnce([makeCandle()]).mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { stored: 0, skipped: 1 },
        QQQ: { stored: 0, skipped: 0 },
      },
    });
  });

  // ── UW API errors ─────────────────────────────────────────

  it('returns 500 when UW API returns non-ok response', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('UW API 500: Server error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when UW fetch throws a network error', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('Network error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  // ── INSERT column coverage ────────────────────────────────

  it('persists all OHLC + volume columns in the INSERT (field coverage)', async () => {
    // Regression guard: ensures open, high, low, close, volume are all
    // present in the SQL and that the interpolated values carry the actual
    // candle data. If a column is dropped from the INSERT, this fails.
    const candle = makeCandle({
      start_time: '2026-04-27T14:32:00Z',
      open: '527.50',
      high: '528.10',
      low: '527.20',
      close: '527.85',
      volume: 345678,
    });
    mockUwFetch.mockResolvedValueOnce([candle]).mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Inspect the tagged-template call: call[0] is the strings array.
    const [strings, ...values] = mockSql.mock.calls[0]!;
    const sqlText = (strings as readonly string[]).join('?');

    // All OHLC + volume column names must appear in the SQL
    expect(sqlText).toContain('open');
    expect(sqlText).toContain('high');
    expect(sqlText).toContain('low');
    expect(sqlText).toContain('close');
    expect(sqlText).toContain('volume');

    // Interpolated values must include all field values from the fixture
    expect(values).toContain('527.50'); // open
    expect(values).toContain('528.10'); // high
    expect(values).toContain('527.20'); // low
    expect(values).toContain('527.85'); // close
    expect(values).toContain(345678); // volume
  });

  // ── Volume null coercion ───────────────────────────────────

  it('inserts successfully when volume is undefined (coerces to null)', async () => {
    // UW sometimes omits volume — candle.volume ?? null must be used
    const candleNoVolume = makeCandle({ volume: undefined });
    mockUwFetch
      .mockResolvedValueOnce([candleNoVolume])
      .mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // The volume parameter in the INSERT should be null, not undefined
    const [, ...values] = mockSql.mock.calls[0]!;
    // Find the volume value position (6th interpolated param: ticker, ts, open, high, low, close, volume)
    expect(values).toContain(null);
    // Ensure undefined did NOT reach SQL
    expect(values).not.toContain(undefined);
  });

  // ── Sentry metric on insert failure ──────────────────────

  it('fires Sentry metric on insert error', async () => {
    const { metrics: sentryMetrics } = await import('../_lib/sentry.js');
    mockSql.mockRejectedValueOnce(new Error('DB insert failed'));
    mockUwFetch.mockResolvedValueOnce([makeCandle()]).mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(sentryMetrics.increment).toHaveBeenCalledWith(
      'fetch_etf_candles_1m.store_error',
    );
  });
});
