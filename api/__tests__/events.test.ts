// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Every events cache call goes through the fail-fast `limiterRedis`: the window
// cache (events.ts) and the per-release FRED date lists (market-events.ts). The
// retrying `redis` is mocked only so a test can assert nothing reaches it: it
// takes about 64 s to give up in an outage, on each read and again on each
// write. A test on the window cache reads its own keys through `windowReads`
// and `windowWrites`, because the date lists share the client.
vi.mock('../_lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
  limiterRedis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
  respondIfInvalid: vi.fn(
    (
      parsed: { success: boolean; error?: { issues: { message: string }[] } },
      res: { status: (n: number) => { json: (o: unknown) => void } },
      done?: (opts: { status: number }) => void,
    ) => {
      if (parsed.success) return false;
      done?.({ status: 400 });
      res.status(400).json({
        error: parsed.error?.issues[0]?.message ?? 'Invalid request body',
      });
      return true;
    },
  ),
}));

// Pass-through spy: the real fetch runs, and a test reads the window it got.
vi.mock('../_lib/market-events.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/market-events.js')>();
  return { ...actual, fetchMarketEvents: vi.fn(actual.fetchMarketEvents) };
});

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
import { limiterRedis, redis } from '../_lib/redis.js';
import { checkBot, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { fetchMarketEvents } from '../_lib/market-events.js';
import { Sentry, metrics } from '../_lib/sentry.js';

// FRED's `release/dates` answers a release's whole history, so a tracked
// release's list is never empty, and an empty one makes the window incomplete.
// A stub that means "no FRED event in this window" gives each list one date
// from 2020, which the window filter drops (the earliest `from` allowed is
// 2025-01-01).
const OLD_RELEASE_DATES = {
  release_dates: [{ release_id: 10, date: '2020-01-03' }],
};

const WINDOW_KEY_PREFIX = 'events:v3:';

/** The window-cache keys the fail-fast client was asked to read. */
function windowReads(): string[] {
  return vi
    .mocked(limiterRedis.get)
    .mock.calls.map(([key]) => key)
    .filter((key) => key.startsWith(WINDOW_KEY_PREFIX));
}

/** The window-cache writes to the fail-fast client, as [key, value, options]. */
function windowWrites() {
  return vi
    .mocked(limiterRedis.set)
    .mock.calls.filter(([key]) => key.startsWith(WINDOW_KEY_PREFIX));
}

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
    vi.mocked(limiterRedis.get).mockResolvedValue(null);
    vi.mocked(limiterRedis.set).mockResolvedValue('OK');
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
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
    vi.mocked(limiterRedis.get).mockResolvedValue(cachedEvents);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { events: unknown[]; cached: boolean };
    expect(json.cached).toBe(true);
    expect(json.events).toEqual(cachedEvents);
    expect(res._headers['X-Cache']).toBe('HIT');
    // The read goes through the fail-fast client, never the retrying one.
    expect(windowReads()).toHaveLength(1);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('fetches fresh data when cache misses', async () => {
    process.env.FRED_API_KEY = 'test-key';
    vi.mocked(limiterRedis.get).mockResolvedValue(null);

    // Mock FRED API responses (one per tracked release)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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
    vi.mocked(limiterRedis.get).mockResolvedValue(null);

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
    // The cache write is the bug: a FRED error must skip the window write
    // entirely. Nothing else writes either: no release list came back.
    expect(windowWrites()).toEqual([]);
    expect(limiterRedis.set).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    // And a Sentry warning is emitted on the non-OK FRED response.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'FRED API non-OK',
      expect.objectContaining({ level: 'warning' }),
    );

    vi.unstubAllGlobals();
  });

  // An empty list from FRED for a tracked release is a gap (FRED sends each
  // release's whole history), not "no events". It used to count as complete, so
  // the window was cached for seven days with no CPI or NFP in it.
  it('does NOT cache the window when FRED answers a release with an empty list', async () => {
    process.env.FRED_API_KEY = 'fred-key';
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
    expect(res._headers['X-Cache']).toBe('MISS');
    expect(windowWrites()).toEqual([]);
    expect(limiterRedis.set).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'FRED API empty release list',
      expect.objectContaining({ level: 'warning' }),
    );

    vi.unstubAllGlobals();
  });

  it('caches the day-scoped key when all FRED sources return OK', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(limiterRedis.get).mockResolvedValue(null);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(OLD_RELEASE_DATES),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    // Full success → write-through to the date-scoped cache, on the fail-fast
    // client (the per-release FRED date lists share it, so count only the
    // window key). The retrying `redis` is never touched.
    expect(windowWrites()).toHaveLength(1);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();

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
    vi.mocked(limiterRedis.get).mockImplementation((key: string) =>
      Promise.resolve(key.startsWith('events:v2:') ? v2Entry : null),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(OLD_RELEASE_DATES),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '30' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as { cached: boolean }).cached).toBe(false);
    // The only window read is the v3 key: the v2 key is never asked for. (The
    // per-release FRED date lists are read through the same client.)
    expect(windowReads()).toEqual([
      expect.stringMatching(/^events:v3:\d{4}-\d{2}-\d{2}:30$/),
    ]);
    expect(
      vi
        .mocked(limiterRedis.get)
        .mock.calls.filter(([key]) => key.startsWith('events:v2:')),
    ).toEqual([]);
    expect(limiterRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^events:v3:\d{4}-\d{2}-\d{2}:30$/),
      expect.anything(),
      expect.anything(),
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('returns 500 when fetch times out (AbortError)', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(limiterRedis.get).mockResolvedValue(null);

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
    vi.mocked(limiterRedis.set).mockRejectedValue(
      new Error('redis write failed'),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(OLD_RELEASE_DATES),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    // Should still succeed despite cache write failure
    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('MISS');
    // The window write was attempted, on the fail-fast client.
    expect(windowWrites()).toHaveLength(1);
    expect(redis.set).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('fetches fresh data when the Redis read throws', async () => {
    process.env.FRED_API_KEY = 'fred-key';
    vi.mocked(limiterRedis.get).mockRejectedValue(
      new Error('redis read failed'),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(OLD_RELEASE_DATES),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '5' } }), res);

    expect(res._status).toBe(200);
    expect(res._headers['X-Cache']).toBe('MISS');
    expect(windowReads()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();

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
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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
        json: () => Promise.resolve(OLD_RELEASE_DATES),
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

  describe('?from= start date', () => {
    // 13:00 ET on 2026-11-12. today + 90 days is 2027-02-10.
    const NOW = '2026-11-12T18:00:00Z';
    const BAD_DATE = 'from must be a real date, YYYY-MM-DD';

    type EventsJson = {
      events: { date: string; event: string }[];
      startDate: string;
      endDate: string;
      cached: boolean;
    };

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    const FRED_OK = {
      ok: true,
      json: () => Promise.resolve(OLD_RELEASE_DATES),
    };

    async function get(
      query: Record<string, string | string[]>,
      now = NOW,
      fredReply: unknown = FRED_OK,
    ) {
      process.env.FRED_API_KEY = 'fred-key';
      const fredFetch = vi.fn().mockResolvedValue(fredReply);
      vi.stubGlobal('fetch', fredFetch);
      vi.useFakeTimers({ now: new Date(now) });
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query }), res);
      return { res, fredFetch, json: res._json as EventsJson };
    }

    it('fetches from .. from + days for a past date and caches under its own key', async () => {
      const { res, json } = await get({ from: '2026-04-29', days: '1' });

      expect(res._status).toBe(200);
      expect(fetchMarketEvents).toHaveBeenCalledTimes(1);
      expect(fetchMarketEvents).toHaveBeenCalledWith(
        '2026-04-29',
        '2026-04-30',
      );
      expect(limiterRedis.get).toHaveBeenCalledWith('events:v3:2026-04-29:1');
      expect(limiterRedis.set).toHaveBeenCalledWith(
        'events:v3:2026-04-29:1',
        expect.anything(),
        expect.anything(),
      );
      expect(json.startDate).toBe('2026-04-29');
      expect(json.endDate).toBe('2026-04-30');
      // The April 2026 FOMC decision day comes back for a replay of that day.
      expect(
        json.events.some((e) => e.date === '2026-04-29' && e.event === 'FOMC'),
      ).toBe(true);
    });

    it("does not serve today's cache entry for a past date", async () => {
      vi.mocked(limiterRedis.get).mockImplementation((key: string) =>
        Promise.resolve(
          key === 'events:v3:2026-11-12:30'
            ? { data: [{ date: '2026-11-12', event: 'CPI' }], cachedAt: 1 }
            : null,
        ),
      );

      const { json } = await get({ from: '2026-04-29', days: '30' });

      expect(json.cached).toBe(false);
      expect(json.events.some((e) => e.event === 'CPI')).toBe(false);
      expect(limiterRedis.get).toHaveBeenCalledWith('events:v3:2026-04-29:30');
    });

    it('serves a cached past window without fetching, startDate echoing from', async () => {
      vi.mocked(limiterRedis.get).mockImplementation((key: string) =>
        Promise.resolve(
          key === 'events:v3:2026-04-29:1'
            ? {
                data: [{ date: '2026-04-29', event: 'FOMC' }],
                cachedAt: Date.now(),
              }
            : null,
        ),
      );

      const { res, json } = await get({ from: '2026-04-29', days: '1' });

      expect(res._headers['X-Cache']).toBe('HIT');
      expect(json.cached).toBe(true);
      expect(json.startDate).toBe('2026-04-29');
      expect(json.endDate).toBe('2026-04-30');
      expect(fetchMarketEvents).not.toHaveBeenCalled();
    });

    it('starts today (ET) when from is absent', async () => {
      const { json } = await get({ days: '3' });

      expect(fetchMarketEvents).toHaveBeenCalledWith(
        '2026-11-12',
        '2026-11-15',
      );
      expect(limiterRedis.get).toHaveBeenCalledWith('events:v3:2026-11-12:3');
      expect(json.startDate).toBe('2026-11-12');
      expect(json.endDate).toBe('2026-11-15');
    });

    it('takes today from the ET date, not the UTC date', async () => {
      // 22:00 ET on 11-12 is already 11-13 in UTC.
      await get({ days: '3' }, '2026-11-13T03:00:00Z');

      expect(fetchMarketEvents).toHaveBeenCalledWith(
        '2026-11-12',
        '2026-11-15',
      );
    });

    it('still clamps days to 90 when from is given', async () => {
      const { json } = await get({ from: '2026-04-29', days: '200' });

      expect(json.endDate).toBe('2026-07-28');
      expect(limiterRedis.get).toHaveBeenCalledWith('events:v3:2026-04-29:90');
    });

    it.each(['2026-02-30', 'abc'])(
      'answers 400 for the malformed from %s without fetching',
      async (from) => {
        const { res, fredFetch } = await get({ from });

        expect(res._status).toBe(400);
        expect((res._json as { error: string }).error).toBe(BAD_DATE);
        expect(fetchMarketEvents).not.toHaveBeenCalled();
        expect(fredFetch).not.toHaveBeenCalled();
        expect(limiterRedis.get).not.toHaveBeenCalled();
        expect(limiterRedis.set).not.toHaveBeenCalled();
      },
    );

    it('answers 400 for a repeated from parameter', async () => {
      const { res } = await get({ from: ['2026-04-29', '2026-04-30'] });

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toBe(BAD_DATE);
      expect(fetchMarketEvents).not.toHaveBeenCalled();
    });

    it('answers 400 for a from before 2025-01-01', async () => {
      const { res, fredFetch } = await get({ from: '2024-12-31' });

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toBe(
        'from must be 2025-01-01 or later',
      );
      expect(fetchMarketEvents).not.toHaveBeenCalled();
      expect(fredFetch).not.toHaveBeenCalled();
    });

    it('answers 400 for a from more than 90 days after today, and accepts 90', async () => {
      const tooFar = await get({ from: '2027-02-11' });
      expect(tooFar.res._status).toBe(400);
      expect((tooFar.res._json as { error: string }).error).toBe(
        'from must be no more than 90 days after today',
      );
      expect(fetchMarketEvents).not.toHaveBeenCalled();
      expect(tooFar.fredFetch).not.toHaveBeenCalled();

      const edge = await get({ from: '2027-02-10', days: '1' });
      expect(edge.res._status).toBe(200);
      expect(fetchMarketEvents).toHaveBeenCalledWith(
        '2027-02-10',
        '2027-02-11',
      );
    });

    it.each([
      ['30.5', 30, '2026-12-12'],
      ['0.5', 1, '2026-11-13'],
      ['89.9', 89, '2027-02-09'],
      ['-3.7', 1, '2026-11-13'],
    ])(
      'truncates days=%s to the whole number %i, in the window and the cache key',
      async (days, whole, endDate) => {
        const { json } = await get({ days });

        expect(json.endDate).toBe(endDate);
        expect(fetchMarketEvents).toHaveBeenCalledWith('2026-11-12', endDate);
        expect(limiterRedis.get).toHaveBeenCalledWith(
          `events:v3:2026-11-12:${whole}`,
        );
        expect(limiterRedis.set).toHaveBeenCalledWith(
          `events:v3:2026-11-12:${whole}`,
          expect.anything(),
          expect.anything(),
        );
      },
    );

    describe('rate limit on from', () => {
      it('answers 429 and fetches nothing when the limiter rejects a from lookup after a cache miss', async () => {
        vi.mocked(rejectIfRateLimited).mockImplementation((_req, res) => {
          res.status(429).json({ error: 'Too many requests.' });
          return Promise.resolve(true);
        });

        const { res, fredFetch } = await get({
          from: '2026-04-29',
          days: '1',
        });

        expect(res._status).toBe(429);
        expect((res._json as { error: string }).error).toBe(
          'Too many requests.',
        );
        expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
        expect(rejectIfRateLimited).toHaveBeenCalledWith(
          expect.anything(),
          res,
          'events',
          30,
        );
        expect(fetchMarketEvents).not.toHaveBeenCalled();
        expect(fredFetch).not.toHaveBeenCalled();
        expect(limiterRedis.set).not.toHaveBeenCalled();
        // The request is recorded as a 429 on the metrics `done` callback.
        const done = vi.mocked(metrics.request).mock.results[0]?.value;
        expect(done).toHaveBeenCalledWith({ status: 429 });
      });

      it('lets a from lookup through when the limiter allows it', async () => {
        const { res } = await get({ from: '2026-04-29', days: '1' });

        expect(res._status).toBe(200);
        expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
        expect(fetchMarketEvents).toHaveBeenCalledTimes(1);
      });

      it('never calls the limiter for a default request, so it cannot get a 429', async () => {
        const { res } = await get({ days: '30' });

        expect(res._status).toBe(200);
        expect(rejectIfRateLimited).not.toHaveBeenCalled();
        expect(fetchMarketEvents).toHaveBeenCalledTimes(1);
      });

      it('never calls the limiter for a from cache hit', async () => {
        vi.mocked(limiterRedis.get).mockImplementation((key: string) =>
          Promise.resolve(
            key === 'events:v3:2026-04-29:1'
              ? {
                  data: [{ date: '2026-04-29', event: 'FOMC' }],
                  cachedAt: Date.now(),
                }
              : null,
          ),
        );

        const { res, json } = await get({ from: '2026-04-29', days: '1' });

        expect(res._status).toBe(200);
        expect(json.cached).toBe(true);
        expect(rejectIfRateLimited).not.toHaveBeenCalled();
        expect(fetchMarketEvents).not.toHaveBeenCalled();
      });
    });

    it('answers 200 uncached for a past date when FRED answers 503, and writes nothing under that date', async () => {
      const { res, json } = await get({ from: '2026-04-29' }, NOW, {
        ok: false,
        status: 503,
      });

      expect(res._status).toBe(200);
      expect(json.cached).toBe(false);
      expect(res._headers['X-Cache']).toBe('MISS');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'FRED API non-OK',
        expect.objectContaining({ level: 'warning' }),
      );
      // A degraded list under events:v3:2026-04-29:* would pin the missing
      // release flags to that date for the 7-day TTL.
      expect(limiterRedis.set).not.toHaveBeenCalled();
    });

    // Finnhub's free key serves about a month of past earnings (a live probe on
    // 2026-11-13 found rows 26 days back and none 40 or more days back), so a
    // window ending more than 45 days before today asks it nothing. The
    // missing earnings are not a failure: the window is complete and cached.
    describe('a window older than Finnhub history', () => {
      async function getWithFinnhub(query: Record<string, string>) {
        process.env.FRED_API_KEY = 'fred-key';
        process.env.FINNHUB_API_KEY = 'finnhub-key';
        const fetchMock = vi.fn((url: string) =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve(
                url.startsWith('https://finnhub.io/')
                  ? { earningsCalendar: [] }
                  : OLD_RELEASE_DATES,
              ),
          }),
        );
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers({ now: new Date(NOW) });
        const res = mockResponse();
        await handler(mockRequest({ method: 'GET', query }), res);
        const finnhubCalls = fetchMock.mock.calls.filter(([url]) =>
          url.startsWith('https://finnhub.io/'),
        );
        return { res, json: res._json as EventsJson, finnhubCalls };
      }

      // Today (ET) is 2026-11-12, so 2026-09-28 is 45 days back and
      // 2026-09-27 is 46. A one-day window from F ends on F + 1.
      it.each([
        ['2026-09-27', 1],
        ['2026-09-26', 0],
        ['2026-04-29', 0],
      ])(
        'from %s makes %i Finnhub fetches and caches the window as complete',
        async (from, finnhubFetches) => {
          const { res, json, finnhubCalls } = await getWithFinnhub({
            from,
            days: '1',
          });

          expect(res._status).toBe(200);
          expect(json.cached).toBe(false);
          expect(res._headers['X-Cache']).toBe('MISS');
          expect(finnhubCalls).toHaveLength(finnhubFetches);
          expect(windowWrites()).toHaveLength(1);
          expect(limiterRedis.set).toHaveBeenCalledWith(
            `events:v3:${from}:1`,
            { data: json.events, cachedAt: expect.any(Number) },
            expect.anything(),
          );
        },
      );
    });
  });
});
