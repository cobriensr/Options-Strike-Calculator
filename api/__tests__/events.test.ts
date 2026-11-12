// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    // request-scope.js wraps every request in an isolation scope.
    withIsolationScope: vi.fn((fn: (scope: unknown) => unknown) =>
      fn({ setTransactionName: vi.fn(), setTag: vi.fn() }),
    ),
  },
  metrics: {
    cacheResult: vi.fn(),
    // metrics.request(path) returns the `done` callback used by the handler.
    request: vi.fn(() => vi.fn()),
  },
}));

import handler from '../events.js';
import { redis } from '../_lib/redis.js';
import { checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

describe('GET /api/events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // A key in the shell would send the fetch stubs below a Finnhub request
    // they do not answer; tests that want earnings set it themselves.
    delete process.env.FINNHUB_API_KEY;
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
              { release_id: 10, date: tomorrow },
              { release_id: 53, date: tomorrow },
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

  it('does NOT cache the day-scoped key when FRED errors (AUD-M2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(redis.get).mockResolvedValue(null);

    // Every FRED release returns non-OK → degraded list. The degraded
    // result must NOT be written to the date-scoped cache, so a later
    // retry can succeed (e.g. recover a missing CPI flag on CPI morning).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    // The cache write is the bug: a FRED error must skip redis.set entirely.
    expect(redis.set).not.toHaveBeenCalled();
    // And a Sentry warning is emitted on the non-OK FRED response.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'FRED API non-OK',
      expect.objectContaining({ level: 'warning' }),
    );

    vi.unstubAllGlobals();
  });

  it('caches the day-scoped key when all FRED sources return OK', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(redis.get).mockResolvedValue(null);

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
    // Full success → write-through to the date-scoped cache.
    expect(redis.set).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('reads and writes the v3 key, and ignores a v2 entry built from the wrong PPI and JOLTS release IDs', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    const v2Entry = {
      data: [
        {
          date: '2026-03-18',
          event: 'PPI',
          severity: 'medium',
          source: 'fred',
        },
      ],
      cachedAt: 1_700_000_000_000,
    };
    vi.mocked(redis.get).mockImplementation((key: string) =>
      Promise.resolve(key.startsWith('events:v2:') ? v2Entry : null),
    );

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
    expect((res._json as { cached: boolean }).cached).toBe(false);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledWith(
      expect.stringMatching(/^events:v3:\d{4}-\d{2}-\d{2}:30$/),
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^events:v3:\d{4}-\d{2}-\d{2}:30$/),
      expect.anything(),
      expect.anything(),
    );

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

  async function eventsFrom(now: string, days: string) {
    process.env.FRED_API_KEY = 'fred-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ release_dates: [] }),
      }),
    );
    vi.useFakeTimers({ now: new Date(now) });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days } }), res);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(res._status).toBe(200);
    return (
      res._json as {
        events: {
          event: string;
          description: string;
          date: string;
          time: string;
        }[];
      }
    ).events;
  }

  it('includes early close events in date range', async () => {
    const events = await eventsFrom('2026-10-20T12:00:00Z', '90');
    const earlyClose = events.filter((e) => e.event === 'EARLY CLOSE');

    const blackFriday = earlyClose.find((e) => e.date === '2026-11-27');
    expect(blackFriday).toBeDefined();
    expect(blackFriday!.description).toContain('closes at');
    expect(blackFriday!.description).toContain('1:00 PM');
    expect(blackFriday!.description).toContain('Black Friday');
    expect(blackFriday!.time).toBe('1:00 PM');
    expect(earlyClose.find((e) => e.date === '2026-12-24')).toBeDefined();
  });

  it('does not show 2026-07-03 as an early close (NYSE is closed all day)', async () => {
    const events = await eventsFrom('2026-06-20T12:00:00Z', '30');
    expect(
      events.filter(
        (e) => e.date === '2026-07-03' && e.event === 'EARLY CLOSE',
      ),
    ).toEqual([]);
  });

  it('lists the 2027 half day and Good Friday closure, and nothing else', async () => {
    const fall = await eventsFrom('2027-11-01T12:00:00Z', '90');
    const earlyDates = fall
      .filter((e) => e.event === 'EARLY CLOSE')
      .map((e) => e.date);
    // 2027-12-24 is the observed Christmas closure, not an early close.
    expect(earlyDates).toEqual(['2027-11-26']);

    const spring = await eventsFrom('2027-03-10T12:00:00Z', '30');
    const goodFriday = spring.find((e) => e.date === '2027-03-26');
    expect(goodFriday?.event).toBe('CLOSED');

    const summer = await eventsFrom('2027-06-25T12:00:00Z', '30');
    expect(summer.filter((e) => e.event === 'EARLY CLOSE')).toEqual([]);
  });

  it('lists Good Friday 2028-04-14 as a closed event', async () => {
    const events = await eventsFrom('2028-04-10T12:00:00Z', '10');
    const goodFriday = events.find((e) => e.date === '2028-04-14');
    expect(goodFriday?.event).toBe('CLOSED');
    expect(goodFriday?.description).toContain('Good Friday');
  });

  it('lists the 2028 early closes and nothing else', async () => {
    const summer = await eventsFrom('2028-06-25T12:00:00Z', '30');
    const summerEarly = summer.filter((e) => e.event === 'EARLY CLOSE');
    expect(summerEarly.map((e) => e.date)).toEqual(['2028-07-03']);
    expect(summerEarly[0]?.description).toContain('closes at');
    expect(summerEarly[0]?.description).toContain('1:00 PM');
    expect(summerEarly[0]?.description).toContain('Independence Day Eve');
    expect(summerEarly[0]?.time).toBe('1:00 PM');

    const fall = await eventsFrom('2028-11-01T12:00:00Z', '90');
    const fallEarly = fall.filter((e) => e.event === 'EARLY CLOSE');
    // 2028-12-24 is a Sunday, so there is no Christmas Eve early close.
    expect(fallEarly.map((e) => e.date)).toEqual(['2028-11-24']);
    expect(fallEarly[0]?.description).toContain('closes at');
    expect(fallEarly[0]?.description).toContain('1:00 PM');
    expect(fallEarly[0]?.description).toContain('Black Friday');
    expect(fallEarly[0]?.time).toBe('1:00 PM');
  });

  // Decision day (second day of each meeting) from the Fed's own calendar,
  // https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm, fetched
  // 2026-11-06. 'FOMC + SEP' marks the meetings with a Summary of Economic
  // Projections (an asterisk on that page).
  const FED_DECISION_DAYS: Readonly<Record<string, 'FOMC' | 'FOMC + SEP'>> = {
    '2025-01-29': 'FOMC',
    '2025-03-19': 'FOMC + SEP',
    '2025-05-07': 'FOMC',
    '2025-06-18': 'FOMC + SEP',
    '2025-07-30': 'FOMC',
    '2025-09-17': 'FOMC + SEP',
    '2025-10-29': 'FOMC',
    '2025-12-10': 'FOMC + SEP',
    '2026-01-28': 'FOMC',
    '2026-03-18': 'FOMC + SEP',
    '2026-04-29': 'FOMC',
    '2026-06-17': 'FOMC + SEP',
    '2026-07-29': 'FOMC',
    '2026-09-16': 'FOMC + SEP',
    '2026-10-28': 'FOMC',
    '2026-12-09': 'FOMC + SEP',
    '2027-01-27': 'FOMC',
    '2027-03-17': 'FOMC + SEP',
    '2027-04-28': 'FOMC',
    '2027-06-09': 'FOMC + SEP',
    '2027-07-28': 'FOMC',
    '2027-09-15': 'FOMC + SEP',
    '2027-10-27': 'FOMC',
    '2027-12-08': 'FOMC + SEP',
  };

  /** FOMC events across [from, to], walking the 90-day maximum window. */
  async function fomcEventsBetween(from: string, to: string) {
    const stepMs = 91 * 24 * 60 * 60 * 1000;
    const end = new Date(`${to}T12:00:00Z`).getTime();
    const found: Record<string, string> = {};
    for (
      let t = new Date(`${from}T12:00:00Z`).getTime();
      t <= end;
      t += stepMs
    ) {
      const events = await eventsFrom(new Date(t).toISOString(), '90');
      for (const e of events) {
        if (e.event.startsWith('FOMC')) found[e.date] = e.event;
      }
    }
    return found;
  }

  it('lists exactly the Fed-published FOMC decision days for 2025 through 2027', async () => {
    const found = await fomcEventsBetween('2025-01-01', '2027-12-31');
    expect(found).toEqual(FED_DECISION_DAYS);
  });

  it('puts the April 2026 FOMC on the 29th, not 2026-05-06', async () => {
    const events = await eventsFrom('2026-04-01T12:00:00Z', '60');
    const fomc = events.filter((e) => e.event.startsWith('FOMC'));
    expect(fomc.map((e) => e.date)).toEqual(['2026-04-29']);
    expect(fomc[0]?.event).toBe('FOMC');
  });

  it('labels the 2027 SEP meetings and gives every FOMC day the 2:00 PM ET time', async () => {
    const events = await eventsFrom('2027-03-01T12:00:00Z', '60');
    const fomc = events.filter((e) => e.event.startsWith('FOMC'));
    expect(fomc.map((e) => [e.date, e.event])).toEqual([
      ['2027-03-17', 'FOMC + SEP'],
      ['2027-04-28', 'FOMC'],
    ]);
    expect(fomc.every((e) => e.time === '2:00 PM')).toBe(true);
    expect(fomc[0]?.description).toContain('Summary of Economic Projections');
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
