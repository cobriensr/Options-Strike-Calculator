// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

import handler from '../yesterday.js';
import {
  rejectIfNotOwnerOrGuest,
  schwabFetch,
  isMarketOpen,
  checkBot,
} from '../_lib/api-helpers.js';

function makeDailyCandle(
  dateStr: string,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  // Schwab daily candles use midnight UTC timestamps
  return {
    open,
    high,
    low,
    close,
    volume: 1_000_000,
    datetime: new Date(dateStr + 'T00:00:00Z').getTime(),
  };
}

describe('GET /api/yesterday', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('forwards schwabFetch errors', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Token expired',
      status: 401,
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Token expired' });
  });

  it('returns null when no candles', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', empty: true, candles: [] },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.yesterday).toBeNull();
    expect(json.twoDaysAgo).toBeNull();
  });

  it('returns yesterday and twoDaysAgo summaries', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const candles = [
      makeDailyCandle('2026-03-09', 5400, 5450, 5390, 5430),
      makeDailyCandle('2026-03-10', 5430, 5480, 5420, 5470),
      makeDailyCandle('2026-03-11', 5470, 5520, 5460, 5510),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', empty: false, candles },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      yesterday: { date: string; open: number; rangePts: number };
      twoDaysAgo: { date: string };
    };
    // The last candle is the most recent completed day (yesterday)
    expect(json.yesterday.date).toBe('2026-03-11');
    expect(json.yesterday.open).toBe(5470);
    expect(json.yesterday.rangePts).toBe(60); // 5520 - 5460
    expect(json.twoDaysAgo.date).toBe('2026-03-10');
  });

  it('returns 403 when bot detected', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 500 when handler throws unexpected error', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockImplementation(() => {
      throw new Error('Crash');
    });

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('returns only yesterday when single candle', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        candles: [makeDailyCandle('2026-03-11', 5470, 5520, 5460, 5510)],
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.yesterday).not.toBeNull();
    expect(json.twoDaysAgo).toBeNull();
  });
});
