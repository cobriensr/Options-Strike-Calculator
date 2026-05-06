// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(() => false),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../ticker-candles.js';
import { guardOwnerOrGuestEndpoint, schwabFetch } from '../_lib/api-helpers.js';

/**
 * Build a Schwab candle pinned to a specific ET wall-clock minute.
 * May 2026 is EDT (UTC-4), so the ET → UTC offset is fixed at +4h.
 * Encoding the offset directly via Date.UTC avoids TZ-dependent
 * test flake when run in environments other than UTC.
 */
function makeCandle(
  year: number,
  month1: number,
  day: number,
  etHour: number,
  etMinute: number,
  close: number,
) {
  const utcMs = Date.UTC(year, month1 - 1, day, etHour + 4, etMinute, 0);
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    datetime: utcMs,
  };
}

describe('GET /api/ticker-candles', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ query: { ticker: 'AMZN' } }), res);
    expect(res._status).toBe(401);
  });

  it('rejects invalid ticker with 400', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    const res = mockResponse();
    await handler(mockRequest({ query: { ticker: 'amzn' } }), res);
    expect(res._status).toBe(400);
  });

  it('forwards schwabFetch upstream errors as 502', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'rate limited',
      status: 429,
    });
    const res = mockResponse();
    await handler(
      mockRequest({ query: { ticker: 'AMZN', date: '2026-05-05' } }),
      res,
    );
    expect(res._status).toBe(502);
    expect((res._json as { upstream: number }).upstream).toBe(429);
  });

  it('filters candles to the requested ET date and regular session', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: 'AMZN',
        empty: false,
        previousClose: 270.5,
        previousCloseDate: 0,
        candles: [
          makeCandle(2026, 5, 4, 14, 30, 269.0), // wrong ET date — drop
          makeCandle(2026, 5, 5, 9, 0, 268.5), // 9:00 ET, pre-9:30 — drop
          makeCandle(2026, 5, 5, 9, 30, 270.0), // keep
          makeCandle(2026, 5, 5, 10, 0, 271.5), // keep
          makeCandle(2026, 5, 6, 9, 30, 272.0), // wrong ET date — drop
        ],
      },
    });

    const res = mockResponse();
    await handler(
      mockRequest({ query: { ticker: 'AMZN', date: '2026-05-05' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      date: string;
      previousClose: number;
      count: number;
      candles: Array<{ ts: string; close: number }>;
    };
    expect(body.ticker).toBe('AMZN');
    expect(body.date).toBe('2026-05-05');
    expect(body.previousClose).toBe(270.5);
    expect(body.count).toBe(2);
    expect(body.candles.map((c) => c.close)).toEqual([270.0, 271.5]);
  });
});
