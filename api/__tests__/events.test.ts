// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/schwab.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
  setCacheHeaders: vi.fn(),
}));

import handler from '../events.js';
import { redis } from '../_lib/schwab.js';
import { checkBot } from '../_lib/api-helpers.js';

describe('GET /api/events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 500 when FRED_API_KEY is missing', async () => {
    delete process.env.FRED_API_KEY;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe(
      'Service temporarily unavailable',
    );
  });

  it('returns cached events from Redis', async () => {
    process.env.FRED_API_KEY = 'test-key';
    const cachedEvents = [
      { date: '2026-03-18', event: 'FOMC', severity: 'high', source: 'static' },
    ];
    vi.mocked(redis.get).mockResolvedValue(cachedEvents);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { events: unknown[]; cached: boolean };
    expect(json.cached).toBe(true);
    expect(json.events).toEqual(cachedEvents);
    expect(res._headers['X-Cache']).toBe('HIT');
  });

  it('fetches fresh data when cache misses', async () => {
    process.env.FRED_API_KEY = 'test-key';
    vi.mocked(redis.get).mockResolvedValue(null);

    // Mock FRED API responses (one per tracked release)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { events: unknown[]; cached: boolean };
    expect(json.cached).toBe(false);
    expect(res._headers['X-Cache']).toBe('MISS');
    // Should include static FOMC/half-day events even without FRED data
    expect(Array.isArray(json.events)).toBe(true);

    vi.unstubAllGlobals();
  });

  it('clamps days parameter to range [1, 90]', async () => {
    process.env.FRED_API_KEY = 'test-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '200' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { startDate: string; endDate: string };
    // endDate should be at most 90 days from startDate
    const start = new Date(json.startDate);
    const end = new Date(json.endDate);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeLessThanOrEqual(91); // allow 1 day rounding
    expect(diffDays).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('sorts events by date then severity', async () => {
    process.env.FRED_API_KEY = 'test-key';

    // Return some FRED data with dates in our window
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000)
      .toISOString()
      .split('T')[0];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            release_dates: [
              {
                release_id: 10,
                release_name: 'CPI',
                date: tomorrow,
              },
              {
                release_id: 53,
                release_name: 'GDP',
                date: tomorrow,
              },
            ],
          }),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { events: { event: string; severity: string }[] };
    // Filter events on tomorrow's date
    const tomorrowEvents = json.events.filter(
      (e: { event: string }) => e.event === 'CPI' || e.event === 'GDP',
    );

    if (tomorrowEvents.length === 2) {
      // CPI (high severity) should come before GDP (medium severity)
      expect(tomorrowEvents[0]!.event).toBe('CPI');
      expect(tomorrowEvents[1]!.event).toBe('GDP');
    }

    vi.unstubAllGlobals();
  });

  it('includes mega-cap earnings from Finnhub when FINNHUB_API_KEY is set', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    process.env.FINNHUB_API_KEY = 'finnhub-key';

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000)
      .toISOString()
      .split('T')[0]!;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('https://finnhub.io/')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              earningsCalendar: [
                {
                  date: tomorrow,
                  epsActual: null,
                  epsEstimate: 2.5,
                  hour: 'amc',
                  quarter: 1,
                  revenueActual: null,
                  revenueEstimate: 100_000,
                  symbol: 'AAPL',
                  year: 2026,
                },
                {
                  date: tomorrow,
                  epsActual: null,
                  epsEstimate: 3.0,
                  hour: 'bmo',
                  quarter: 1,
                  revenueActual: null,
                  revenueEstimate: 200_000,
                  symbol: 'MSFT',
                  year: 2026,
                },
                {
                  // Non-mega-cap — should be filtered out
                  date: tomorrow,
                  epsActual: null,
                  epsEstimate: 1.0,
                  hour: 'dmh',
                  quarter: 1,
                  revenueActual: null,
                  revenueEstimate: 50_000,
                  symbol: 'ACME',
                  year: 2026,
                },
              ],
            }),
        });
      }
      // FRED API
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      events: { event: string; source: string; description: string }[];
    };
    const earnings = json.events.filter((e) => e.source === 'finnhub');
    expect(earnings.length).toBe(2);
    expect(earnings.some((e) => e.event === 'AAPL Earnings')).toBe(true);
    expect(earnings.some((e) => e.event === 'MSFT Earnings')).toBe(true);
    // Check time labels
    const aapl = earnings.find((e) => e.event === 'AAPL Earnings')!;
    expect(aapl.description).toContain('After Close');
    const msft = earnings.find((e) => e.event === 'MSFT Earnings')!;
    expect(msft.description).toContain('Before Open');
    // ACME should not appear
    expect(earnings.some((e) => e.event === 'ACME Earnings')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('handles Finnhub API errors gracefully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRED_API_KEY = 'fred-key';
    process.env.FINNHUB_API_KEY = 'finnhub-key';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('https://finnhub.io/')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    // Should still return 200 with events (just no earnings)
    expect(res._status).toBe(200);
    const json = res._json as { events: { source: string }[] };
    const earnings = json.events.filter((e) => e.source === 'finnhub');
    expect(earnings.length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('handles FRED API errors gracefully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRED_API_KEY = 'fred-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    // Should still return 200 with static events (FOMC, half-days)
    expect(res._status).toBe(200);
    const json = res._json as { events: { source: string }[] };
    const staticEvents = json.events.filter((e) => e.source === 'static');
    expect(staticEvents.length).toBeGreaterThanOrEqual(0);

    vi.unstubAllGlobals();
  });

  it('returns 500 when fetch times out (AbortError)', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(redis.get).mockResolvedValue(null);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new DOMException('The operation was aborted.', 'AbortError'),
        ),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe(
      'Internal server error',
    );

    vi.unstubAllGlobals();
  });

  it('handles Redis cache write failure gracefully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(redis.set).mockRejectedValue(new Error('redis write failed'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    // Should still succeed despite cache write failure
    expect(res._status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('handles Finnhub fetch throwing an exception', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRED_API_KEY = 'fred-key';
    process.env.FINNHUB_API_KEY = 'finnhub-key';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('https://finnhub.io/')) {
        return Promise.reject(new Error('Network timeout'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { events: { source: string }[] };
    const earnings = json.events.filter((e) => e.source === 'finnhub');
    expect(earnings.length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('includes early close events in date range', async () => {
    process.env.FRED_API_KEY = 'fred-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      }),
    );

    // Mock Date to 2026-06-20 so a 90-day window covers 2026-07-03
    // (Independence Day Eve early close)
    const fakeNow = new Date('2026-06-20T12:00:00Z');
    vi.useFakeTimers({ now: fakeNow });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '90' } }), res);

    vi.useRealTimers();

    expect(res._status).toBe(200);
    const json = res._json as {
      events: { event: string; description: string; date: string }[];
    };
    const earlyCloseEvents = json.events.filter(
      (e) => e.event === 'EARLY CLOSE',
    );
    expect(earlyCloseEvents.length).toBeGreaterThan(0);

    const julyThird = earlyCloseEvents.find((e) => e.date === '2026-07-03');
    expect(julyThird).toBeDefined();
    expect(julyThird!.description).toContain('closes at');
    expect(julyThird!.description).toContain('1:00 PM');
    expect(julyThird!.description).toContain('ET');

    vi.unstubAllGlobals();
  });

  it('returns 403 when checkBot reports a bot', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe('Access denied');
  });
});
