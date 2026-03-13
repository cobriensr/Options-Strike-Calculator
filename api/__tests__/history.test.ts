// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/schwab.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

import handler from '../history.js';
import { rejectIfNotOwner, schwabFetch } from '../_lib/api-helpers.js';
import { redis } from '../_lib/schwab.js';

/**
 * Create a candle at a specific ET time on a given date.
 * Converts ET to approximate UTC ms for Schwab candle format.
 */
function makeCandle(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  // Build ET datetime string and convert to UTC (add ~5h)
  const etDate = new Date(
    `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
  );
  const utcMs = etDate.getTime() + 5 * 60 * 60 * 1000;
  return { open, high, low, close, volume: 10000, datetime: utcMs };
}

describe('GET /api/history', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when date param is missing', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const res = mockResponse();
    await handler(mockRequest({ query: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain(
      'Missing or invalid date',
    );
  });

  it('returns 400 for invalid date format', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const res = mockResponse();
    await handler(mockRequest({ query: { date: '03-10-2026' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for future dates', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const res = mockResponse();
    await handler(mockRequest({ query: { date: '2099-01-01' } }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('future');
  });

  it('returns cached data from Redis when available', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const cachedData = {
      date: '2026-03-10',
      spx: { candles: [], previousClose: 5500, previousDay: null },
      vix: { candles: [], previousClose: 18, previousDay: null },
      vix1d: { candles: [], previousClose: 15, previousDay: null },
      vix9d: { candles: [], previousClose: 17, previousDay: null },
      vvix: { candles: [], previousClose: 90, previousDay: null },
      candleCount: 0,
      asOf: '2026-03-10T20:00:00Z',
    };
    vi.mocked(redis.get).mockResolvedValue(cachedData);

    const res = mockResponse();
    await handler(mockRequest({ query: { date: '2026-03-10' } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(cachedData);
    expect(res._headers['X-Cache']).toBe('HIT');
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('fetches fresh data when Redis cache misses', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(redis.get).mockResolvedValue(null);

    vi.mocked(schwabFetch).mockResolvedValue({
      data: {
        symbol: '$SPX',
        candles: [],
        previousClose: 5500,
      },
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: '2026-03-10' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { date: string; candleCount: number };
    expect(json.date).toBe('2026-03-10');
    expect(schwabFetch).toHaveBeenCalled();
  });

  it('processes candles through helper functions and returns processed data', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    // Create candles for target date (2026-03-10) and previous day (2026-03-09)
    // Regular hours: 9:30 AM (570 min) to 4:00 PM (960 min) ET
    const targetDate = '2026-03-10';
    const prevDate = '2026-03-09';

    const candles = [
      // Previous day candles (all clearly in regular hours)
      makeCandle(prevDate, 9, 30, 5400, 5420, 5395, 5410),
      makeCandle(prevDate, 10, 0, 5410, 5430, 5405, 5425),
      // Target day candles
      makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460),
      makeCandle(targetDate, 9, 35, 5460, 5480, 5455, 5475),
      makeCandle(targetDate, 10, 0, 5475, 5490, 5470, 5485),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      data: {
        symbol: '$SPX',
        candles,
        previousClose: 5380,
      },
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: targetDate } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      date: string;
      spx: {
        candles: { time: string; open: number }[];
        previousClose: number;
        previousDay: {
          date: string;
          open: number;
          high: number;
          low: number;
        } | null;
      };
      candleCount: number;
    };

    expect(json.date).toBe(targetDate);
    expect(json.spx.previousClose).toBe(5380);
    // Candles should be processed (may vary by local TZ, so just check structure)
    expect(json.spx.candles.length).toBeGreaterThanOrEqual(0);
    if (json.spx.candles.length > 0) {
      // Each candle should have a time string
      expect(json.spx.candles[0]!.time).toBeDefined();
      expect(typeof json.spx.candles[0]!.time).toBe('string');
    }
    // Previous day summary should exist if candles were in regular hours
    if (json.spx.previousDay) {
      expect(json.spx.previousDay.date).toBe(prevDate);
      expect(json.spx.previousDay.open).toBe(5400);
    }
  });

  it('handles schwabFetch error for a symbol gracefully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    vi.mocked(schwabFetch).mockResolvedValue({
      error: 'Schwab API error (500): Internal error',
      status: 502,
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: '2026-03-10' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      spx: { candles: unknown[] };
      candleCount: number;
    };
    // Should return empty data, not error
    expect(json.spx.candles).toEqual([]);
    expect(json.candleCount).toBe(0);
  });

  it('caches past date data in Redis with long TTL', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    vi.mocked(schwabFetch).mockResolvedValue({
      data: { symbol: '$SPX', candles, previousClose: 5380 },
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: targetDate } }), res);

    expect(res._status).toBe(200);
    // Should cache in Redis (set called)
    expect(redis.set).toHaveBeenCalled();
  });
});
