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
 * Create a candle at a specific ET time on a given date. The offset is the
 * EDT one (UTC-4), so use it only for dates after the March DST change
 * (2026-03-09 and 2026-03-10 here). The datetime is placed by UTC, so it reads
 * the same ET time on any host.
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
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const datetime = new Date(`${dateStr}T${hh}:${mm}:00-04:00`).getTime();
  return { open, high, low, close, volume: 10000, datetime };
}

/** A flat candle at an ISO instant (with its UTC offset) and a close. */
function flatCandle(iso: string, close: number) {
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 10000,
    datetime: new Date(iso).getTime(),
  };
}

/** A previous-session summary whose close is `close`. */
function previousDaySummary(close: number) {
  return {
    date: '2026-03-09',
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    rangePct: 0.1,
    rangePts: 5,
  };
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
const CACHE_PREV_CLOSE_MESSAGE =
  'Cached history held a previousClose other than the previous session close; served that close';
const HOLE_MESSAGE =
  'Schwab window lacks the prior trading day; serving previousClose 0';

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

function cachedEntry(
  candles: unknown[],
  candleCount = candles.length,
  previous: { previousClose: number; previousDay: unknown } = {
    previousClose: 5380,
    previousDay: previousDaySummary(5380),
  },
) {
  const day = () => ({ candles, ...previous });
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

  // 2026-02-30 and 2026-13-01 are not dates; 0000-01-01 is, but priorTradingDay
  // throws on it, and Schwab holds nothing before 2000. A 400, not a 500 with
  // a Sentry event.
  it.each(['2026-02-30', '2026-13-01', '0000-01-01', '1999-12-31'])(
    'answers 400 for the invalid date %s without reaching Schwab or Sentry',
    async (date) => {
      const res = mockResponse();
      await handler(mockRequest({ query: { date } }), res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain(
        'Missing or invalid date',
      );
      expect(schwabFetch).not.toHaveBeenCalled();
      expect(redis.get).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it('returns cached data from Redis when available', async () => {
    const cachedData = {
      date: TARGET_DATE,
      spx: {
        candles: [],
        previousClose: 5500,
        previousDay: previousDaySummary(5500),
      },
      vix: {
        candles: [],
        previousClose: 18,
        previousDay: previousDaySummary(18),
      },
      vix1d: {
        candles: [],
        previousClose: 15,
        previousDay: previousDaySummary(15),
      },
      vix9d: {
        candles: [],
        previousClose: 17,
        previousDay: previousDaySummary(17),
      },
      vvix: {
        candles: [],
        previousClose: 90,
        previousDay: previousDaySummary(90),
      },
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
          close: number;
        } | null;
      };
      candleCount: number;
    };

    expect(json.date).toBe(targetDate);
    // Each target-day candle is processed and carries a time string.
    expect(json.spx.candles.map((c) => c.open)).toEqual([5450, 5460, 5475]);
    for (const candle of json.spx.candles) {
      expect(typeof candle.time).toBe('string');
    }
    expect(json.spx.previousDay).toMatchObject({
      date: prevDate,
      open: 5400,
      close: 5425,
    });
    // The previous session's last close, not Schwab's raw 5380.
    expect(json.spx.previousClose).toBe(5425);
  });

  // $SPX is the one symbol the page and the backfill cannot do without. When
  // it fails, a 200 with no candles reads as "no data for that date" and hides
  // the cause (the Schwab login lapsed on 2026-11-18 and every cache miss
  // answered 200 empty). A failed VIX-family symbol with $SPX fine keeps its
  // short-TTL 200.
  describe('when $SPX fails', () => {
    const LOGGED_OUT_BODY = {
      error: 'Schwab is logged out. The owner needs to log in to Schwab again.',
      code: 'schwab_logged_out',
    };
    const FETCH_FAILED_BODY = {
      error: 'Schwab history fetch failed',
      code: 'schwab_fetch_failed',
    };
    const loggedOut = {
      ok: false as const,
      error: '[SCHWAB_TOKEN_EXPIRED] No tokens found',
      status: 401,
      code: 'SCHWAB_TOKEN_EXPIRED' as const,
    };
    const spxOnly = (spxFailure: unknown) => async (path: string) =>
      path.includes('SPX') ? spxFailure : okFetch();

    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers 503 schwab_logged_out, uncached, when every symbol finds no tokens', async () => {
      const done = vi.fn();
      vi.mocked(metrics.request).mockReturnValueOnce(done);
      vi.mocked(schwabFetch).mockResolvedValue(loggedOut);
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(503);
      expect(res._json).toEqual(LOGGED_OUT_BODY);
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(res._headers['X-Cache']).toBeUndefined();
      expect(redis.set).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledWith({
        status: 503,
        error: 'schwab_logged_out',
      });
      // A logged-out Schwab is not an unhandled error. The per-symbol
      // warnings are its only Sentry trace, so they stay: one for each of the
      // five symbols, $SPX among them.
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'history: $SPX fetch failed',
        { level: 'warning' },
      );
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(5);
    });

    it('answers 503 when only $SPX is logged out and the VIX family answers', async () => {
      vi.mocked(schwabFetch).mockImplementation(
        spxOnly(loggedOut) as typeof schwabFetch,
      );
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(503);
      expect(res._json).toEqual(LOGGED_OUT_BODY);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('writes no 120 s entry for today either, which a failed fetch used to leave', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${TARGET_DATE}T16:00:00Z`));
      vi.mocked(schwabFetch).mockResolvedValue(loggedOut);
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(503);
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(redis.set).not.toHaveBeenCalled();
    });

    it.each([
      ['a refresh that failed for another reason', 'SCHWAB_TOKEN_ERROR', 500],
      ['a data API that rejected a held token', 'SCHWAB_API_REJECTED', 401],
      ['a network failure', 'SCHWAB_API_NETWORK', 504],
      ['a Schwab 500', 'SCHWAB_API_500', 502],
    ] as const)(
      'answers 502 schwab_fetch_failed, uncached, on %s',
      async (_label, code, status) => {
        const done = vi.fn();
        vi.mocked(metrics.request).mockReturnValueOnce(done);
        vi.mocked(schwabFetch).mockResolvedValue({
          ok: false,
          error: `[${code}] upstream failed`,
          status,
          code,
        });
        const res = mockResponse();
        await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

        expect(res._status).toBe(502);
        expect(res._json).toEqual(FETCH_FAILED_BODY);
        expect(res._headers['Cache-Control']).toBe('no-store');
        expect(redis.set).not.toHaveBeenCalled();
        expect(done).toHaveBeenCalledWith({
          status: 502,
          error: 'schwab_fetch_failed',
        });
        // Each failed symbol still surfaces as a named Sentry warning.
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'history: $SPX fetch failed',
          { level: 'warning' },
        );
      },
    );

    it('answers 502 when $SPX failed for another reason and the VIX family is logged out', async () => {
      // The $SPX failure decides, not the other symbols'.
      vi.mocked(schwabFetch).mockImplementation((async (path: string) =>
        path.includes('SPX')
          ? {
              ok: false,
              error: '[SCHWAB_API_503] down',
              status: 502,
              code: 'SCHWAB_API_503',
            }
          : loggedOut) as typeof schwabFetch);
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(502);
      expect(res._json).toEqual(FETCH_FAILED_BODY);
    });

    it('keeps the short-TTL 200 when $SPX is fine and the VIX family is logged out', async () => {
      vi.mocked(schwabFetch).mockImplementation((async (path: string) =>
        path.includes('SPX') ? okFetch() : loggedOut) as typeof schwabFetch);
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      expect(res._headers['Cache-Control']).toBe('private, max-age=120');
      expect(redis.set).toHaveBeenCalledWith(
        CACHE_KEY,
        {
          response: expect.objectContaining({ date: TARGET_DATE }),
          complete: false,
        },
        { ex: 120 },
      );
    });

    it('keeps the 200 with empty candles when $SPX answers with none: a date beyond Schwab’s window', async () => {
      vi.mocked(schwabFetch).mockResolvedValue({
        ok: true,
        data: { symbol: '$SPX', candles: [] },
      });
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      const json = res._json as {
        spx: { candles: unknown[] };
        candleCount: number;
      };
      expect(json.spx.candles).toEqual([]);
      expect(json.candleCount).toBe(0);
      expect(redis.set).not.toHaveBeenCalled();
    });
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
    // the 300 s browser max-age that only a complete result earns.
    it.each([
      [true, 'private, max-age=300'],
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

    it('complete past-date fetch: private, max-age=300', async () => {
      vi.mocked(schwabFetch).mockResolvedValue(okFetch());
      const res = mockResponse();
      await handler(mockRequest({ query: { date: TARGET_DATE } }), res);

      expect(res._status).toBe(200);
      // The fetch path ran: one call per symbol, no Redis hit.
      expect(schwabFetch).toHaveBeenCalledTimes(5);
      expect(res._headers['X-Cache']).toBeUndefined();
      expect(res._headers['Cache-Control']).toBe('private, max-age=300');
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
        expect(res._headers['Cache-Control']).toBe('private, max-age=300');
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
          expect(res._headers['Cache-Control']).toBe('private, max-age=300');
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
          previousDay: previousDaySummary(18),
        };
        const res = await hit(entry);

        const json = res._json as HistoryJson;
        expect(json.vix.candles).toHaveLength(3);
        expect(json.candleCount).toBe(12345);
      });

      it.each([
        ['a null symbol', { spx: null }],
        ['a symbol that is a string', { spx: 'bad' }],
        ['a symbol that is an array', { spx: [] }],
        [
          'a symbol with no candles field',
          { spx: { previousClose: 1, previousDay: previousDaySummary(1) } },
        ],
        [
          'candles that are not an array',
          {
            spx: {
              candles: 'bad',
              previousClose: 5380,
              previousDay: previousDaySummary(5380),
            },
          },
        ],
        [
          'candles with no datetime',
          {
            spx: {
              candles: [{ close: 1 }, null],
              previousClose: 5380,
              previousDay: previousDaySummary(5380),
            },
          },
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

  // The request window starts 7 days before the target, so Schwab's own
  // previousClose is the close before that start: 2026-11-06 got 7720.39. The
  // endpoint serves the previous session's last 5-minute close instead, which
  // for 2026-11-05 is its 7356.73 settlement.
  describe("previousClose is the target session's previous close", () => {
    const NOV_TARGET = '2026-11-06';
    // Each symbol's last close on the session before the target, and the
    // range-start value Schwab sends as previousClose.
    const SYMBOLS = {
      spx: { name: '$SPX', prevLast: 7356.73, schwabRaw: 7720.39 },
      vix: { name: '$VIX', prevLast: 17.95, schwabRaw: 17.2 },
      vix1d: { name: '$VIX1D', prevLast: 14.4, schwabRaw: 13.1 },
      vix9d: { name: '$VIX9D', prevLast: 16.25, schwabRaw: 15.5 },
      vvix: { name: '$VVIX', prevLast: 92.8, schwabRaw: 88.4 },
    } as const;

    /**
     * A session whose last 5-minute bar, 15:55 ET, closes at `lastClose`.
     * `offset` is the ET offset on `day`: EST (-05:00) for the November
     * dates, EDT (-04:00) for the April and September ones.
     */
    function session(day: string, lastClose: number, offset = '-05:00') {
      return [
        flatCandle(`${day}T09:30:00${offset}`, lastClose - 20),
        flatCandle(`${day}T12:00:00${offset}`, lastClose + 15),
        flatCandle(`${day}T15:55:00${offset}`, lastClose),
      ];
    }

    type Sym = (typeof SYMBOLS)[keyof typeof SYMBOLS];

    /** Every symbol's priceHistory returns `candlesFor(symbol)`. */
    function mockSchwab(candlesFor: (symbol: Sym) => unknown[]) {
      vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
        const name = new URLSearchParams(path.split('?')[1]).get('symbol');
        const symbol = Object.values(SYMBOLS).find((s) => s.name === name)!;
        return {
          ok: true as const,
          data: {
            symbol: symbol.name,
            candles: candlesFor(symbol),
            previousClose: symbol.schwabRaw,
          },
        };
      });
    }

    // Windows around the target. 2026-10-30 is an earlier session, 2026-11-05
    // the prior trading day, 2026-11-09 a session after the target.
    const earlier = (s: Sym) => session('2026-10-30', s.prevLast - 111);
    const prior = (s: Sym) => session('2026-11-05', s.prevLast);
    const target = (s: Sym) => session(NOV_TARGET, s.prevLast + 50);
    const later = (s: Sym) => session('2026-11-09', s.prevLast + 99);

    async function fetchOn(date: string) {
      const res = mockResponse();
      await handler(mockRequest({ query: { date } }), res);
      expect(res._status).toBe(200);
      return res._json as HistoryJson;
    }

    const fetchNov = () => fetchOn(NOV_TARGET);

    it("serves each symbol's previous session close, not Schwab's range-start previousClose", async () => {
      mockSchwab((s) => [
        ...earlier(s),
        ...prior(s),
        ...target(s),
        ...later(s),
      ]);

      const json = await fetchNov();

      expect(json.spx.previousClose).toBe(7356.73);
      expect(json.vix.previousClose).toBe(17.95);
      expect(json.vix1d.previousClose).toBe(14.4);
      expect(json.vix9d.previousClose).toBe(16.25);
      expect(json.vvix.previousClose).toBe(92.8);
      expect(json.spx.previousDay).toMatchObject({
        date: '2026-11-05',
        close: 7356.73,
      });
      // The long-lived cache entry carries the corrected value too.
      const [, entry] = vi.mocked(redis.set).mock.calls[0] as [
        string,
        { response: HistoryJson },
      ];
      expect(entry.response.spx.previousClose).toBe(7356.73);
      expect(entry.response.vix.previousClose).toBe(17.95);
    });

    it('serves previousClose 0 for every symbol when the window holds no previous session', async () => {
      mockSchwab((s) => [...target(s), ...later(s)]);

      const json = await fetchNov();

      for (const key of SYMBOL_KEYS) {
        expect(json[key].previousClose).toBe(0);
        expect(json[key].previousDay).toBeNull();
      }
    });

    it('serves previousClose 0 and no previousDay when the target has no candles of its own', async () => {
      // Sessions before the target but none on it: with no candles of its own
      // the target is not found, so no session counts as its previous one.
      mockSchwab((s) => [...earlier(s), ...prior(s)]);

      const json = await fetchNov();

      for (const key of SYMBOL_KEYS) {
        expect(json[key].previousClose).toBe(0);
        expect(json[key].previousDay).toBeNull();
      }
    });

    it.each([
      ['null', null],
      ['missing', undefined],
    ])(
      "serves previousClose 0 when the previous session's last candle has a %s close",
      async (_label, brokenClose) => {
        mockSchwab((s) => [
          ...earlier(s),
          ...prior(s).slice(0, -1),
          { ...prior(s).at(-1)!, close: brokenClose },
          ...target(s),
        ]);

        const json = await fetchNov();

        for (const key of SYMBOL_KEYS) {
          expect(json[key].previousClose).toBe(0);
        }
      },
    );

    // Schwab can drop the session right before the target and still return an
    // earlier one. That older close is not yesterday's, so it is not served.
    describe('when the window lacks the prior trading day', () => {
      it("serves previousClose 0 for the symbol that lacks it and warns once, leaving the others' closes", async () => {
        mockSchwab((s) =>
          s.name === '$SPX'
            ? [...earlier(s), ...target(s)]
            : [...earlier(s), ...prior(s), ...target(s)],
        );

        const json = await fetchNov();

        expect(json.spx.previousClose).toBe(0);
        // The summary itself is the older session, as before.
        expect(json.spx.previousDay).toMatchObject({ date: '2026-10-30' });
        expect(json.vix.previousClose).toBe(17.95);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            symbol: '$SPX',
            date: NOV_TARGET,
            previousDayDate: '2026-10-30',
            expected: '2026-11-05',
          },
          HOLE_MESSAGE,
        );
      });

      it('does not cache the hole as a good close: the stored entry carries 0', async () => {
        mockSchwab((s) => [...earlier(s), ...target(s)]);

        await fetchNov();

        const [, entry] = vi.mocked(redis.set).mock.calls[0] as [
          string,
          { response: HistoryJson },
        ];
        for (const key of SYMBOL_KEYS) {
          expect(entry.response[key].previousClose).toBe(0);
        }
      });
    });

    // A weekend or a holiday between the target and its previous session is
    // not a hole: priorTradingDay skips them.
    it.each([
      ['a weekend', '2026-11-09', '2026-11-06', '-05:00'],
      ['Labor Day', '2026-09-08', '2026-09-04', '-04:00'],
      ['Good Friday', '2026-04-06', '2026-04-02', '-04:00'],
      ['Memorial Day', '2026-05-26', '2026-05-22', '-04:00'],
      ['Juneteenth', '2026-06-22', '2026-06-18', '-04:00'],
      ['Independence Day observed', '2026-07-06', '2026-07-02', '-04:00'],
    ])(
      'does not treat %s as a hole: serves the last session before it',
      async (_label, targetDate, priorDate, offset) => {
        mockSchwab((s) => [
          ...session(priorDate, s.prevLast, offset),
          ...session(targetDate, s.prevLast + 50, offset),
        ]);

        const json = await fetchOn(targetDate);

        expect(json.spx.previousClose).toBe(7356.73);
        expect(json.vix.previousClose).toBe(17.95);
        expect(json.spx.previousDay).toMatchObject({ date: priorDate });
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );

    describe('on a cache hit', () => {
      async function hit(entry: unknown, date = TARGET_DATE) {
        vi.mocked(redis.get).mockResolvedValue(entry);
        const res = mockResponse();
        await handler(mockRequest({ query: { date } }), res);
        expect(res._status).toBe(200);
        expect(res._headers['X-Cache']).toBe('HIT');
        expect(schwabFetch).not.toHaveBeenCalled();
        expect(redis.set).not.toHaveBeenCalled();
        return res._json as HistoryJson;
      }

      /** A stored entry as written before the fix: Schwab's range-start value. */
      function staleEntry() {
        const entry = cachedEntry(cachedCandles());
        for (const key of SYMBOL_KEYS) {
          const { prevLast, schwabRaw } = SYMBOLS[key];
          entry.response[key] = {
            ...entry.response[key],
            previousClose: schwabRaw,
            previousDay: previousDaySummary(prevLast),
          };
        }
        return entry;
      }

      it("serves each symbol's previous day close and leaves the stored entry alone", async () => {
        const entry = staleEntry();

        const json = await hit(entry);

        expect(json.spx.previousClose).toBe(7356.73);
        expect(json.vix.previousClose).toBe(17.95);
        expect(json.vix1d.previousClose).toBe(14.4);
        expect(json.vix9d.previousClose).toBe(16.25);
        expect(json.vvix.previousClose).toBe(92.8);
        // Only previousClose changes in the response.
        for (const key of SYMBOL_KEYS) {
          expect(json[key].candles).toEqual(entry.response[key].candles);
          expect(json[key].previousDay).toEqual(
            entry.response[key].previousDay,
          );
        }
        // The stored object keeps Schwab's value: the repair is on read only.
        expect(entry.response.spx.previousClose).toBe(7720.39);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            cacheKey: CACHE_KEY,
            expected: '2026-03-09',
            repaired: SYMBOL_KEYS.map((field) => ({
              field,
              stored: SYMBOLS[field].schwabRaw,
              served: SYMBOLS[field].prevLast,
              previousDayDate: '2026-03-09',
            })),
          },
          CACHE_PREV_CLOSE_MESSAGE,
        );
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });

      it.each([
        ['null', { previousDay: null }, null],
        ['absent', {}, null],
        [
          'one with no numeric close',
          { previousDay: { ...previousDaySummary(7356.73), close: 'bad' } },
          '2026-03-09',
        ],
      ])(
        'serves previousClose 0 when the stored previousDay is %s',
        async (_label, previousDayField, previousDayDate) => {
          const spx = {
            candles: cachedCandles(),
            previousClose: 7720.39,
            ...previousDayField,
          };
          const response = { ...cachedEntry(cachedCandles()).response, spx };

          const json = await hit({ response, complete: true });

          expect(json.spx).toEqual({ ...spx, previousClose: 0 });
          expect(logger.warn).toHaveBeenCalledTimes(1);
          expect(logger.warn).toHaveBeenCalledWith(
            {
              cacheKey: CACHE_KEY,
              expected: '2026-03-09',
              repaired: [
                { field: 'spx', stored: 7720.39, served: 0, previousDayDate },
              ],
            },
            CACHE_PREV_CLOSE_MESSAGE,
          );
        },
      );

      // An entry stored while Schwab left the field out has no previousClose
      // key: JSON drops undefined. Its previousDay still says what to serve.
      it('serves previousDay.close for a stored symbol with no previousClose key', async () => {
        const spx = {
          candles: cachedCandles(),
          previousDay: previousDaySummary(5380),
        };
        const response = { ...cachedEntry(cachedCandles()).response, spx };

        const json = await hit({ response, complete: true });

        expect(json.spx).toEqual({ ...spx, previousClose: 5380 });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            cacheKey: CACHE_KEY,
            expected: '2026-03-09',
            repaired: [
              {
                field: 'spx',
                stored: undefined,
                served: 5380,
                previousDayDate: '2026-03-09',
              },
            ],
          },
          CACHE_PREV_CLOSE_MESSAGE,
        );
      });

      it('serves 0 for a stored symbol with neither previousClose nor previousDay', async () => {
        const response = {
          ...cachedEntry(cachedCandles()).response,
          spx: { candles: cachedCandles() },
        };

        const json = await hit({ response, complete: true });

        expect(json.spx.previousClose).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      // The stored previousDay is an older session than the request's prior
      // trading day (2026-03-09 for 2026-03-10): its close is not yesterday's.
      it('serves previousClose 0 when the stored previousDay is not the prior trading day', async () => {
        const entry = cachedEntry(cachedCandles());
        entry.response.spx = {
          ...entry.response.spx,
          previousClose: 7720.39,
          previousDay: { ...previousDaySummary(7300), date: '2026-03-06' },
        };

        const json = await hit(entry);

        expect(json.spx.previousClose).toBe(0);
        expect(json.vix.previousClose).toBe(5380);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          {
            cacheKey: CACHE_KEY,
            expected: '2026-03-09',
            repaired: [
              {
                field: 'spx',
                stored: 7720.39,
                served: 0,
                previousDayDate: '2026-03-06',
              },
            ],
          },
          CACHE_PREV_CLOSE_MESSAGE,
        );
      });

      // 2026-09-04 is the last session before Labor Day, so for 2026-09-08 it
      // is the prior trading day and nothing needs repair.
      it('leaves a stored previousDay that skips a holiday alone', async () => {
        const entry = cachedEntry(cachedCandles(), undefined, {
          previousClose: 5380,
          previousDay: { ...previousDaySummary(5380), date: '2026-09-04' },
        });

        const json = await hit(entry, '2026-09-08');

        expect(json).toEqual(entry.response);
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it.each([
        ["the previous day's close", cachedEntry(cachedCandles())],
        [
          'previousClose 0 with no previous session',
          cachedEntry(cachedCandles(), undefined, {
            previousClose: 0,
            previousDay: null,
          }),
        ],
      ])(
        'serves a stored entry already holding %s unchanged and logs nothing',
        async (_label, entry) => {
          const json = await hit(entry);

          expect(json).toEqual(entry.response);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(Sentry.captureMessage).not.toHaveBeenCalled();
        },
      );
    });
  });
});
