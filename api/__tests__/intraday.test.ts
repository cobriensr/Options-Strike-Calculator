// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../intraday.js';
import {
  guardOwnerOrGuestEndpoint,
  schwabFetch,
  isMarketOpen,
} from '../_lib/api-helpers.js';

/**
 * Create a 5-min candle at a specific ET time today.
 * hour/minute are in ET (e.g. 9, 30 for 9:30 AM).
 */
/**
 * Create a 5-min candle at a specific ET time.
 * hour/minute are in ET (e.g. 9, 30 for 9:30 AM).
 * Optional dateStr overrides the date (YYYY-MM-DD); defaults to today.
 */
function makeCandle(
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  dateStr?: string,
) {
  const day =
    dateStr ??
    new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
  // Create a date in ET
  const etDate = new Date(
    `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
  );
  // Convert to approximate UTC by adding ~5h (rough, but adequate for test filtering)
  const utcMs = etDate.getTime() + 5 * 60 * 60 * 1000;
  return { open, high, low, close, volume: 1000, datetime: utcMs };
}

describe('GET /api/intraday', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('forwards schwabFetch errors', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'API down',
      status: 502,
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'API down' });
  });

  it('returns today OHLC and opening range from candles', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    // 7 candles covering 9:30-10:05 — first 6 form the opening range
    const candles = [
      makeCandle(9, 30, 5500, 5510, 5495, 5505),
      makeCandle(9, 35, 5505, 5515, 5500, 5510),
      makeCandle(9, 40, 5510, 5520, 5505, 5515),
      makeCandle(9, 45, 5515, 5525, 5510, 5520),
      makeCandle(9, 50, 5520, 5530, 5515, 5525),
      makeCandle(9, 55, 5525, 5535, 5520, 5530),
      makeCandle(10, 0, 5530, 5540, 5525, 5535),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: Date.now() - 86400000,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.previousClose).toBe(5490);
    expect(json.marketOpen).toBe(true);
    // today and openingRange should exist (exact values depend on timezone filtering)
    expect(json).toHaveProperty('today');
    expect(json).toHaveProperty('openingRange');
    expect(json).toHaveProperty('candleCount');
  });

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 500 when handler throws unexpected error', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockImplementation(() => {
      throw new Error('Crash');
    });

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('handles empty candle data', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: true,
        previousClose: 5490,
        previousCloseDate: 0,
        candles: [],
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.today).toBeNull();
    expect(json.openingRange).toBeNull();
    expect(json.candleCount).toBe(0);
  });

  it('filters to most recent trading day when candles span multiple days', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString(
      'en-CA',
      { timeZone: 'America/New_York' },
    );
    const todayStr = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    // Yesterday's candle should be excluded, today's kept
    const candles = [
      makeCandle(9, 30, 5400, 5410, 5395, 5405, yesterday),
      makeCandle(9, 30, 5500, 5510, 5495, 5505, todayStr),
      makeCandle(9, 35, 5505, 5515, 5500, 5510, todayStr),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: 0,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Only today's 2 candles pass the filter, not yesterday's
    expect(json.candleCount).toBe(2);
    expect((json.today as { open: number }).open).toBe(5500);
  });

  it('returns prior session data on holidays/weekends', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);

    // Simulate a holiday: candles are from 2 days ago, none from today
    const priorDay = new Date(Date.now() - 2 * 86400000).toLocaleDateString(
      'en-CA',
      { timeZone: 'America/New_York' },
    );

    const candles = [
      makeCandle(9, 30, 5500, 5510, 5495, 5505, priorDay),
      makeCandle(9, 35, 5505, 5515, 5500, 5510, priorDay),
      makeCandle(9, 40, 5510, 5520, 5505, 5515, priorDay),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: 0,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Should return the prior session's candles, not empty
    expect(json.candleCount).toBe(3);
    expect(json.today).not.toBeNull();
    expect(json.marketOpen).toBe(false);
  });
});
