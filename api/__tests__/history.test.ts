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

// ----- Duplicate-candle fixtures -----
// 2026-03-09/10 are EDT (UTC-4), so 9:30 AM ET is 13:30Z. These candles are
// placed by UTC so the regular-hours filter sees the same ET time on any host.
const TARGET_DAY = 10;
const PREV_DAY = 9;
const SESSION_SLOTS = 78; // 9:30 to 15:55 ET, every 5 minutes
const SYMBOL_KEYS = ['spx', 'vix', 'vix1d', 'vix9d', 'vvix'] as const;
const FETCH_DUP_MESSAGE = 'Schwab returned duplicate candles';
const CACHE_DUP_MESSAGE =
  'Cached history held duplicate or unordered candles; served normalized';

function sessionCandle(dayOfMonth: number, slot: number, close: number) {
  return {
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volume: 10000,
    datetime: Date.UTC(2026, 2, dayOfMonth, 13, 30 + 5 * slot),
  };
}

/** A full regular session of distinct, ascending candles. */
function sessionDay(dayOfMonth: number, closeBase = 5000) {
  return Array.from({ length: SESSION_SLOTS }, (_, slot) =>
    sessionCandle(dayOfMonth, slot, closeBase + slot),
  );
}

/** Every symbol's priceHistory returns `candles(path)`. */
function mockSchwabCandles(candles: (path: string) => unknown[]) {
  vi.mocked(schwabFetch).mockImplementation(async (path: string) => ({
    ok: true as const,
    data: { symbol: '$SPX', candles: candles(path), previousClose: 5380 },
  }));
}

interface CandleJson {
  datetime: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
interface DayJson {
  candles: CandleJson[];
  previousClose: number;
  previousDay: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null;
}
type HistoryJson = Record<(typeof SYMBOL_KEYS)[number], DayJson> & {
  candleCount: number;
};

/** The shape a stored entry has: processed candles, one per symbol. */
function cachedCandles(count = SESSION_SLOTS) {
  return Array.from({ length: count }, (_, slot) => {
    const { datetime, open, high, low, close } = sessionCandle(
      TARGET_DAY,
      slot,
      5000 + slot,
    );
    return { datetime, time: `slot ${slot}`, open, high, low, close };
  });
}

function cachedEntry(candles: unknown[], candleCount = candles.length) {
  const day = () => ({ candles, previousClose: 5380, previousDay: null });
  return {
    response: {
      date: TARGET_DATE,
      spx: day(),
      vix: day(),
      vix1d: day(),
      vix9d: day(),
      vvix: day(),
      candleCount,
      asOf: '2026-03-10T21:00:00Z',
    },
    complete: true,
  };
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

  // 2026-11-11: Schwab returned the whole session twice, end to end. The
  // client takes high/low over candles 0..index of the SPX array, so a doubled
  // array hands every snapshot of that day the full day's high/low (lookahead).
  describe('duplicate candles from Schwab', () => {
    async function fetchHistory() {
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);
      expect(res._status).toBe(200);
      return res._json as HistoryJson;
    }

    it('serves one copy of every symbol when the session arrives twice end to end', async () => {
      const day = sessionDay(TARGET_DAY);
      mockSchwabCandles(() => [...day, ...day]);

      const json = await fetchHistory();

      for (const key of SYMBOL_KEYS) {
        expect(json[key].candles.map((c) => c.datetime)).toEqual(
          day.map((c) => c.datetime),
        );
        expect(json[key].candles.map((c) => c.close)).toEqual(
          day.map((c) => c.close),
        );
        // The internal fetch flags stay out of the response.
        expect(json[key]).not.toHaveProperty('ok');
        expect(json[key]).not.toHaveProperty('hadDuplicates');
      }
      expect(json.candleCount).toBe(SESSION_SLOTS);
    });

    it('caches the cleaned candles, not the doubled ones', async () => {
      const day = sessionDay(TARGET_DAY);
      mockSchwabCandles(() => [...day, ...day]);

      await fetchHistory();

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [, entry, opts] = vi.mocked(redis.set).mock.calls[0] as [
        string,
        { response: HistoryJson; complete: boolean },
        { ex: number },
      ];
      expect(opts).toEqual({ ex: PAST_CACHE_TTL });
      expect(entry.complete).toBe(true);
      for (const key of SYMBOL_KEYS) {
        expect(entry.response[key].candles).toHaveLength(SESSION_SLOTS);
      }
      expect(entry.response.candleCount).toBe(SESSION_SLOTS);
    });

    it('sorts out-of-order candles and drops scattered repeats, keeping the first of a pair', async () => {
      const day = sessionDay(TARGET_DAY);
      // day[2] arrives twice with different values: the first one wins.
      const laterRevision = { ...day[2]!, close: 9999 };
      const raw = [
        day[3]!,
        day[0]!,
        day[2]!,
        laterRevision,
        day[5]!,
        day[0]!,
        day[1]!,
        day[4]!,
        day[3]!,
      ];
      mockSchwabCandles(() => raw);

      const json = await fetchHistory();

      const expected = day.slice(0, 6);
      expect(json.spx.candles.map((c) => c.datetime)).toEqual(
        expected.map((c) => c.datetime),
      );
      expect(json.spx.candles.map((c) => c.close)).toEqual(
        expected.map((c) => c.close),
      );
      expect(json.candleCount).toBe(6);
    });

    it('serves a clean response unchanged and reports nothing', async () => {
      const day = sessionDay(TARGET_DAY);
      mockSchwabCandles(() => day);

      const json = await fetchHistory();

      for (const key of SYMBOL_KEYS) {
        expect(json[key].candles.map((c) => c.datetime)).toEqual(
          day.map((c) => c.datetime),
        );
        expect(json[key].candles.map((c) => c.open)).toEqual(
          day.map((c) => c.open),
        );
        expect(json[key].candles.map((c) => c.close)).toEqual(
          day.map((c) => c.close),
        );
      }
      expect(json.candleCount).toBe(SESSION_SLOTS);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('summarises the previous day from sorted, unique candles', async () => {
      const prev = sessionDay(PREV_DAY, 4000);
      const target = sessionDay(TARGET_DAY);
      // The previous day arrives reversed and then again in order.
      mockSchwabCandles(() => [...[...prev].reverse(), ...prev, ...target]);

      const json = await fetchHistory();

      expect(json.spx.previousDay).toEqual({
        date: '2026-03-09',
        open: prev[0]!.open,
        high: prev.at(-1)!.high,
        low: prev[0]!.low,
        close: prev.at(-1)!.close,
        rangePct: expect.any(Number),
        rangePts: expect.any(Number),
      });
      expect(json.spx.candles).toHaveLength(SESSION_SLOTS);
    });

    it('warns once per symbol with the raw and unique counts, and sends one Sentry message per response', async () => {
      const day = sessionDay(TARGET_DAY);
      mockSchwabCandles(() => [...day, ...day]);

      await fetchHistory();

      expect(logger.warn).toHaveBeenCalledTimes(SYMBOL_KEYS.length);
      for (const symbol of ['$SPX', '$VIX', '$VIX1D', '$VIX9D', '$VVIX']) {
        expect(logger.warn).toHaveBeenCalledWith(
          {
            symbol,
            date: TARGET_DATE,
            rawCount: 2 * SESSION_SLOTS,
            uniqueCount: SESSION_SLOTS,
          },
          FETCH_DUP_MESSAGE,
        );
      }
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'history: duplicate candles from Schwab',
        { level: 'warning' },
      );
    });

    it('reports only the symbol that had duplicates', async () => {
      const day = sessionDay(TARGET_DAY);
      mockSchwabCandles((path) =>
        path.includes('SPX') ? [...day, ...day] : day,
      );

      await fetchHistory();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: '$SPX', date: TARGET_DATE }),
        FETCH_DUP_MESSAGE,
      );
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    describe('on a cache hit', () => {
      async function hit(entry: unknown) {
        vi.mocked(redis.get).mockResolvedValue(entry);
        const res = mockResponse();
        await handler(mockRequest({ query: { date: TARGET_DATE } }), res);
        expect(res._status).toBe(200);
        expect(res._headers['X-Cache']).toBe('HIT');
        expect(schwabFetch).not.toHaveBeenCalled();
        expect(redis.set).not.toHaveBeenCalled();
        return res;
      }

      it.each([
        [
          'two copies end to end (the 2026-11-11 shape)',
          [...cachedCandles(), ...cachedCandles()],
        ],
        [
          'reversed with scattered repeats',
          [...cachedCandles().reverse(), ...cachedCandles().slice(10, 20)],
        ],
      ])(
        'serves a stored entry holding %s sorted and unique, with no Redis write',
        async (_label, candles) => {
          const before = candles.map((c) => c.datetime);
          const res = await hit(cachedEntry(candles));

          expect(res._json).toEqual(cachedEntry(cachedCandles()).response);
          expect(res._headers['Cache-Control']).toBe('private, max-age=86400');
          // The fetched entry is repaired in the response only: its own
          // candle array keeps the order and length it had.
          expect(candles.map((c) => c.datetime)).toEqual(before);
        },
      );

      it('logs the repair by name but sends nothing to Sentry', async () => {
        const doubled = [...cachedCandles(), ...cachedCandles()];
        await hit(cachedEntry(doubled));

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            cacheKey: CACHE_KEY,
            repaired: SYMBOL_KEYS.map((field) => ({
              field,
              rawCount: 2 * SESSION_SLOTS,
              uniqueCount: SESSION_SLOTS,
            })),
          },
          CACHE_DUP_MESSAGE,
        );
        expect(logger.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          FETCH_DUP_MESSAGE,
        );
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });

      it('serves a clean stored entry untouched and quiet', async () => {
        const res = await hit(cachedEntry(cachedCandles()));

        expect(res._json).toEqual(cachedEntry(cachedCandles()).response);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });

      it('leaves a stored candleCount alone when no SPX candles needed repair', async () => {
        const entry = cachedEntry(cachedCandles(), 12345);
        entry.response.vix = {
          candles: [...cachedCandles(3), ...cachedCandles(3)],
          previousClose: 18,
          previousDay: null,
        };
        const res = await hit(entry);

        const json = res._json as HistoryJson;
        expect(json.vix.candles).toHaveLength(3);
        expect(json.candleCount).toBe(12345);
      });

      it.each([
        ['a null symbol', { spx: null }],
        ['a symbol with no candles field', { spx: { previousClose: 1 } }],
        ['candles that are not an array', { spx: { candles: 'bad' } }],
        [
          'candles with no datetime',
          { spx: { candles: [{ close: 1 }, null] } },
        ],
      ])(
        'passes a stored entry with %s through as stored',
        async (_label, fields) => {
          const response = {
            date: TARGET_DATE,
            candleCount: 1,
            ...fields,
          };
          const res = await hit({ response, complete: true });

          expect(res._json).toEqual(response);
          expect(logger.warn).not.toHaveBeenCalled();
        },
      );
    });
  });
});
