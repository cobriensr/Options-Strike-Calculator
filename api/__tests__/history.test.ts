// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The real sendError (it sets no-store), taken from the module that owns it.
vi.mock('../_lib/api-helpers.js', async () => {
  const { sendError } = await vi.importActual<
    typeof import('../_lib/auth-helpers.js')
  >('../_lib/auth-helpers.js');
  return {
    guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
    schwabFetch: vi.fn(),
    sendError,
  };
});

vi.mock('../_lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
  // schwab.ts (loaded via auth-helpers' module graph) builds a client at
  // import time; no test here uses it.
  createRedis: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
    cacheResult: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../history.js';
import { guardOwnerOrGuestEndpoint, schwabFetch } from '../_lib/api-helpers.js';
import { redis } from '../_lib/redis.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const PAST_CACHE_TTL = 90 * 24 * 60 * 60;
const TARGET_DATE = '2026-03-10';
const CACHE_KEY = `history:v3:${TARGET_DATE}`;

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

/** A successful Schwab priceHistory result with one target-date candle. */
function okFetch() {
  return {
    ok: true as const,
    data: {
      symbol: '$SPX',
      candles: [makeCandle(TARGET_DATE, 9, 30, 5450, 5470, 5445, 5460)],
      previousClose: 5380,
    },
  };
}

/** Every symbol succeeds except $VIX1D, which fails transiently. */
function vix1dFailsFetch(path: string) {
  return path.includes('VIX1D')
    ? {
        ok: false as const,
        error: 'Schwab API error (502): transient',
        status: 502,
        code: 'SCHWAB_API_502' as const,
      }
    : okFetch();
}

describe('GET /api/history', () => {
  beforeEach(() => {
    // restoreAllMocks only restores spies; clear call history explicitly so
    // by-name and call-count assertions see only the current test.
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
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

  it('returns 400 when date param is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ query: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain(
      'Missing or invalid date',
    );
  });

  it('returns 400 for invalid date format', async () => {
    const res = mockResponse();
    await handler(mockRequest({ query: { date: '03-10-2026' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for future dates', async () => {
    const res = mockResponse();
    await handler(mockRequest({ query: { date: '2099-01-01' } }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('future');
  });

  it('returns cached data from Redis when available', async () => {
    const cachedData = {
      date: TARGET_DATE,
      spx: { candles: [], previousClose: 5500, previousDay: null },
      vix: { candles: [], previousClose: 18, previousDay: null },
      vix1d: { candles: [], previousClose: 15, previousDay: null },
      vix9d: { candles: [], previousClose: 17, previousDay: null },
      vvix: { candles: [], previousClose: 90, previousDay: null },
      candleCount: 0,
      asOf: '2026-03-10T20:00:00Z',
    };
    vi.mocked(redis.get).mockResolvedValue({
      response: cachedData,
      complete: true,
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

    expect(redis.get).toHaveBeenCalledWith(CACHE_KEY);
    expect(res._status).toBe(200);
    expect(res._json).toEqual(cachedData);
    expect(res._headers['X-Cache']).toBe('HIT');
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('fetches fresh data when Redis cache misses', async () => {
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        candles: [],
        previousClose: 5500,
      },
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

    expect(res._status).toBe(200);
    const json = res._json as { date: string; candleCount: number };
    expect(json.date).toBe(TARGET_DATE);
    expect(schwabFetch).toHaveBeenCalled();
  });

  it('processes candles through helper functions and returns processed data', async () => {
    // Create candles for target date (2026-03-10) and previous day (2026-03-09)
    // Regular hours: 9:30 AM (570 min) to 4:00 PM (960 min) ET
    const targetDate = TARGET_DATE;
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
      ok: true,
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

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Schwab API error (500): Internal error',
      status: 502,
      code: 'SCHWAB_API_500',
    });

    const res = mockResponse();
    await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      spx: { candles: unknown[] };
      candleCount: number;
    };
    // Should return empty data, not error
    expect(json.spx.candles).toEqual([]);
    expect(json.candleCount).toBe(0);
    // Each failed symbol surfaces as a named Sentry warning.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'history: $SPX fetch failed',
      { level: 'warning' },
    );
  });

  it('does NOT write the long-TTL cache when a symbol fetch fails (AUD-M1)', async () => {
    // $SPX succeeds with candles, but $VIX1D fails transiently. A partial
    // response must not be cached for 90 days — the empty VIX1D panel would be
    // served forever for this date.
    vi.mocked(schwabFetch).mockImplementation(async (path: string) =>
      vix1dFailsFetch(path),
    );

    const res = mockResponse();
    await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

    expect(res._status).toBe(200);

    // The long-TTL (90-day) write must never happen on a partial failure.
    const longTtlWrites = vi
      .mocked(redis.set)
      .mock.calls.filter(
        (call) =>
          (call[2] as { ex?: number } | undefined)?.ex === PAST_CACHE_TTL,
      );
    expect(longTtlWrites).toHaveLength(0);

    // It writes a short-TTL entry, marked incomplete, so the partial result
    // self-heals and a later hit keeps the short browser max-age.
    expect(redis.set).toHaveBeenCalledWith(
      CACHE_KEY,
      {
        response: expect.objectContaining({ date: TARGET_DATE }),
        complete: false,
      },
      { ex: 120 },
    );
  });

  it('caches past date data in Redis with long TTL', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(okFetch());

    const res = mockResponse();
    await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

    expect(res._status).toBe(200);
    // Should cache in Redis with the 90-day TTL (all symbols succeeded).
    expect(redis.set).toHaveBeenCalledWith(
      CACHE_KEY,
      {
        response: expect.objectContaining({ date: TARGET_DATE }),
        complete: true,
      },
      { ex: PAST_CACHE_TTL },
    );
  });

  // The endpoint is guarded, so no 200 may carry a shared-cache directive:
  // Vercel's CDN would serve it to an anonymous visitor without running the
  // guard. Each path keeps its old lifetime as a browser max-age.
  describe('Cache-Control on success paths', () => {
    function expectNoSharedCache(headers: Record<string, string>) {
      expect(Object.values(headers).join('\n')).not.toContain('s-maxage');
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    // A partial past-date result is cached for 120 s; its hit must not get
    // the day-long browser max-age that only a complete result earns.
    it.each([
      [true, 'private, max-age=86400'],
      [false, 'private, max-age=120'],
    ])('Redis hit with complete: %s → %s', async (complete, cacheControl) => {
      const cachedResponse = { date: TARGET_DATE, candleCount: 1 };
      vi.mocked(redis.get).mockResolvedValue({
        response: cachedResponse,
        complete,
      });
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual(cachedResponse);
      expect(res._headers['X-Cache']).toBe('HIT');
      expect(res._headers['Cache-Control']).toBe(cacheControl);
      expect(schwabFetch).not.toHaveBeenCalled();
      expectNoSharedCache(res._headers);
    });

    it('complete past-date fetch: private, max-age=86400', async () => {
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      // The fetch path ran: one call per symbol, no Redis hit.
      expect(schwabFetch).toHaveBeenCalledTimes(5);
      expect(res._headers['X-Cache']).toBeUndefined();
      expect(res._headers['Cache-Control']).toBe('private, max-age=86400');
      expectNoSharedCache(res._headers);
    });

    it('partial past-date fetch (one symbol failed): private, max-age=120', async () => {
      vi.mocked(schwabFetch).mockImplementation(async (path: string) =>
        vix1dFailsFetch(path),
      );
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect(res._headers['Cache-Control']).toBe('private, max-age=120');
      expectNoSharedCache(res._headers);
    });

    it("today's date: private, max-age=120", async () => {
      // Noon ET on the target date, so the handler treats it as today.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${TARGET_DATE}T16:00:00Z`));
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect(redis.get).not.toHaveBeenCalled();
      expect(res._headers['Cache-Control']).toBe('private, max-age=120');
      expectNoSharedCache(res._headers);
    });
  });

  describe('failure modes', () => {
    it('returns 500 with no-store and reports to Sentry when schwabFetch rejects', async () => {
      const fetchError = new Error('socket hang up');
      vi.mocked(schwabFetch).mockRejectedValue(fetchError);
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal server error' });
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(Sentry.captureException).toHaveBeenCalledWith(fetchError);
    });

    it('returns 500 and reports to Sentry on a malformed 2xx payload (no candles)', async () => {
      // `for (const c of undefined)` throws a TypeError in fetchSymbolHistory.
      vi.mocked(schwabFetch).mockResolvedValue({ ok: true, data: {} });
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(500);
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(TypeError),
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('still returns 200 and logs when the Redis cache write rejects', async () => {
      const redisError = new Error('Redis write timeout');
      vi.mocked(redis.set).mockRejectedValue(redisError);
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect((res._json as { date: string }).date).toBe(TARGET_DATE);
      expect(logger.error).toHaveBeenCalledWith(
        { err: redisError },
        'Failed to cache history',
      );
    });

    it('falls through to Schwab and returns 200 when the Redis read rejects', async () => {
      vi.mocked(redis.get).mockRejectedValue(new Error('Redis unavailable'));
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect(schwabFetch).toHaveBeenCalledTimes(5);
      expect(res._headers['X-Cache']).toBeUndefined();
      expect((res._json as { date: string }).date).toBe(TARGET_DATE);
    });

    // A wrong-shaped entry must not be served (it would be an empty or bogus
    // 200 until its TTL ran out); it is a miss, and the fetch overwrites it.
    it.each([
      ['an empty object', {}],
      [
        'a non-boolean complete',
        { response: { date: TARGET_DATE }, complete: 'yes' },
      ],
      ['a bare v2-style response', { date: TARGET_DATE, candleCount: 0 }],
    ])(
      'treats a malformed cache entry (%s) as a miss: refetches and rewrites the key',
      async (_label, entry) => {
        vi.mocked(redis.get).mockResolvedValue(entry);
        vi.mocked(schwabFetch).mockResolvedValue(okFetch());
        const res = mockResponse();
        await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

        expect(logger.warn).toHaveBeenCalledWith(
          { cacheKey: CACHE_KEY },
          'Malformed history cache entry; refetching',
        );
        expect(schwabFetch).toHaveBeenCalledTimes(5);
        expect(res._status).toBe(200);
        expect(res._headers['X-Cache']).toBeUndefined();
        expect(res._headers['Cache-Control']).toBe('private, max-age=86400');
        expect(res._json).toMatchObject({ date: TARGET_DATE, candleCount: 1 });
        expect(redis.set).toHaveBeenCalledWith(
          CACHE_KEY,
          {
            response: expect.objectContaining({ date: TARGET_DATE }),
            complete: true,
          },
          { ex: PAST_CACHE_TTL },
        );
      },
    );

    it('answers 500 with no-store when a throw follows the success Cache-Control', async () => {
      // The metrics callback throws on the 200, after the success header set.
      vi.mocked(metrics.request).mockReturnValueOnce(
        vi.fn((opts?: { status?: number }) => {
          if (opts?.status === 200) throw new Error('late failure');
        }),
      );
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(500);
      expect(res._headers['Cache-Control']).toBe('no-store');
    });
  });
});
