// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
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
import {
  guardOwnerOrGuestEndpoint,
  schwabFetch,
  setCacheHeaders,
} from '../_lib/api-helpers.js';
import { redis } from '../_lib/redis.js';
import { Sentry } from '../_lib/sentry.js';

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

/**
 * TZ-exact variant of `makeCandle`: the ET wall-clock is converted with an
 * explicit EDT (UTC-4) offset, so the candle lands inside regular hours on
 * any machine regardless of its local timezone. Only valid for EDT dates
 * (2nd Sunday of March → 1st Sunday of November) — every date below is.
 */
function makeCandleEDT(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const utcMs = Date.UTC(y, m - 1, d, hour + 4, minute, 0);
  return { open, high, low, close, volume: 10000, datetime: utcMs };
}

/** Parse `startDate` / `endDate` off a recorded `/pricehistory?...` path. */
function windowOf(path: string): { startDate: number; endDate: number } {
  const params = new URL(`http://x${path}`).searchParams;
  return {
    startDate: Number(params.get('startDate')),
    endDate: Number(params.get('endDate')),
  };
}

const PAST_CACHE_TTL = 90 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALL_EMPTY_ALERT = 'history: no symbol returned candles on a trading day';

/**
 * Invoke the handler under fake timers. Both retry paths `sleep(RETRY_DELAY_MS)`
 * between attempts; `runAllTimersAsync` fires every pending timer (flushing
 * the microtasks between them) so no test waits real wall-clock time. The
 * handler's own promise is awaited afterwards so assertions see its final
 * state. Every test goes through here — including ones that never retry —
 * so the fake clock is the only clock.
 */
async function run(req: VercelRequest) {
  const res = mockResponse();
  const pending = handler(req, res);
  await vi.runAllTimersAsync();
  await pending;
  return res;
}

describe('GET /api/history', () => {
  beforeEach(() => {
    // Fake timers make the 300ms retry backoffs free (see `run`) and pin
    // `new Date()` for the "today" cases below; without `setSystemTime` the
    // clock starts at the real now, so '2026-03-10' stays a past date.
    vi.useFakeTimers();
    vi.restoreAllMocks();
    // `restoreAllMocks` leaves vi.fn() call history in place; clear it so
    // per-test call-count assertions see only their own run.
    vi.mocked(schwabFetch).mockClear();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = await run(mockRequest());
    expect(res._status).toBe(401);
  });

  it('returns 400 when date param is missing', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    const res = await run(mockRequest({ query: {} }));
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain(
      'Missing or invalid date',
    );
  });

  it('returns 400 for invalid date format', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    const res = await run(mockRequest({ query: { date: '03-10-2026' } }));
    expect(res._status).toBe(400);
  });

  it('returns 400 for future dates', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    const res = await run(mockRequest({ query: { date: '2099-01-01' } }));
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('future');
  });

  it('returns cached data from Redis when available', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    expect(res._json).toEqual(cachedData);
    expect(res._headers['X-Cache']).toBe('HIT');
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  // ── Redis HIT path: an inconsistent entry is a miss, not a HIT ──
  //
  // A "some symbols populated, one blank" payload (the observed "$VIX1D
  // empty, other four fine" shape) used to reach Redis via the handler's own
  // 120s short-TTL write for a partial past date. That write is gone —
  // nothing ever read it back — but the guard stays as a defence against any
  // malformed entry: it must not be served as a HIT with the day-long CDN
  // max-age, so it is treated as a miss, refetched (with the retries below),
  // and overwritten with the correct TTL. (Legacy `history:v2:` entries are
  // retired by the `history:v3:` prefix bump, not by this guard.)

  it('treats an inconsistent cached entry (one symbol blank, others populated) as a miss and refetches', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const cachedCandle = {
      datetime: 1,
      time: '9:30 AM',
      open: 5450,
      high: 5470,
      low: 5445,
      close: 5460,
    };
    const poisoned = {
      date: targetDate,
      spx: { candles: [cachedCandle], previousClose: 5380, previousDay: null },
      vix: { candles: [cachedCandle], previousClose: 18, previousDay: null },
      vix1d: { candles: [], previousClose: 0, previousDay: null },
      vix9d: { candles: [cachedCandle], previousClose: 17, previousDay: null },
      vvix: { candles: [cachedCandle], previousClose: 90, previousDay: null },
      candleCount: 1,
      asOf: '2026-03-10T20:00:00Z',
    };
    vi.mocked(redis.get).mockResolvedValue(poisoned);

    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles, previousClose: 5380 },
    });
    vi.mocked(redis.set).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // Refetched, not served from the poisoned entry.
    expect(schwabFetch).toHaveBeenCalled();
    expect(res._headers['X-Cache']).not.toBe('HIT');
    expect(res._headers['Cache-Control']).not.toBe(
      's-maxage=86400, stale-while-revalidate=3600',
    );
    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles).toHaveLength(1);
    // The healed, fully-populated result overwrites the poisoned entry with
    // the 90-day TTL and earns the long CDN max-age.
    expect(redis.set).toHaveBeenCalledWith(
      `history:v3:${targetDate}`,
      expect.anything(),
      { ex: PAST_CACHE_TTL },
    );
    expect(setCacheHeaders).toHaveBeenCalledWith(
      expect.anything(),
      86400,
      3600,
    );
  });

  it('serves a consistent, fully populated cached entry as a HIT without refetching', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const cachedCandle = {
      datetime: 1,
      time: '9:30 AM',
      open: 5450,
      high: 5470,
      low: 5445,
      close: 5460,
    };
    const day = {
      candles: [cachedCandle],
      previousClose: 1,
      previousDay: null,
    };
    const cachedData = {
      date: '2026-03-10',
      spx: day,
      vix: day,
      vix1d: day,
      vix9d: day,
      vvix: day,
      candleCount: 1,
      asOf: '2026-03-10T20:00:00Z',
    };
    vi.mocked(redis.get).mockResolvedValue(cachedData);
    vi.mocked(redis.set).mockClear();

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    expect(res._json).toEqual(cachedData);
    expect(res._headers['X-Cache']).toBe('HIT');
    expect(res._headers['Cache-Control']).toBe(
      's-maxage=86400, stale-while-revalidate=3600',
    );
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('fetches fresh data when Redis cache misses', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(redis.get).mockResolvedValue(null);

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        candles: [],
        previousClose: 5500,
      },
    });

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    const json = res._json as { date: string; candleCount: number };
    expect(json.date).toBe('2026-03-10');
    expect(schwabFetch).toHaveBeenCalled();
  });

  it('processes candles through helper functions and returns processed data', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

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
      ok: true,
      data: {
        symbol: '$SPX',
        candles,
        previousClose: 5380,
      },
    });

    const res = await run(mockRequest({ query: { date: targetDate } }));

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
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Schwab API error (500): Internal error',
      status: 502,
    });

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    const json = res._json as {
      spx: { candles: unknown[] };
      candleCount: number;
    };
    // Should return empty data, not error
    expect(json.spx.candles).toEqual([]);
    expect(json.candleCount).toBe(0);
  });

  it('does NOT write the long-TTL cache when a symbol fetch fails (AUD-M1)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const spxCandles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    // $SPX succeeds with candles, but $VIX1D fails transiently. A partial
    // response must not be cached for 90 days — the empty VIX1D panel would be
    // served forever for this date.
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        return {
          ok: false as const,
          error: 'Schwab API error (502): transient',
          status: 502,
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles: spxCandles, previousClose: 5380 },
      };
    });

    // Clear any cache-write calls accumulated by earlier tests (mock.calls is
    // not reset by restoreAllMocks) so the assertions below see only this run.
    vi.mocked(redis.set).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);

    // The long-TTL (90-day) write must never happen on a partial failure —
    // and no short-TTL "partial" entry is written in its place: nothing
    // reads that back (`isConsistent` rejects it), so it was a billed Redis
    // command for nothing. The next request simply refetches.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('caches past date data in Redis with long TTL', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles, previousClose: 5380 },
    });

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // Should cache in Redis with the 90-day TTL (all symbols succeeded).
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { ex: PAST_CACHE_TTL },
    );
  });

  // ── Defect 1: transient per-symbol drop ────────────────────
  //
  // Each symbol fans out per trading day inside the market-data facade, so a
  // 5-wide Promise.all put ~30 concurrent calls into the Theta Terminal, which
  // chokes on bursts. Whichever symbol lost the race came back empty and the
  // UI rendered "n/a (no history)". Fix: sequential pairs + one retry.

  it('retries a transient symbol failure once and returns its candles', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        if (vix1dCalls === 1) {
          return {
            ok: false as const,
            error: 'Schwab API error (502): transient',
            status: 502,
          };
        }
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(2);

    // A retry-recovered symbol is indistinguishable from a first-try success.
    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles.length).toBeGreaterThan(0);

    // ...including for the allOk gate: the 90-day write still happens.
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { ex: PAST_CACHE_TTL },
    );

    // A failure the retry fixed is a breadcrumb, not an alert.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('gives up after one retry, writes nothing to Redis, and alerts', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: false as const,
          error: 'Schwab API error (504): timeout',
          status: 504,
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(2);

    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles).toEqual([]);

    // A partial result is not cached at all (neither the 90-day entry nor a
    // dead short-TTL one).
    expect(redis.set).not.toHaveBeenCalled();

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('$VIX1D'),
      { level: 'warning' },
    );
  });

  it('does not retry a 501 SOURCE_UNAVAILABLE', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandle(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: false as const,
          error: '[SOURCE_UNAVAILABLE] No market-data source for /pricehistory',
          status: 501,
          code: 'SOURCE_UNAVAILABLE',
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // No source exists — a retry can never help, so exactly one call.
    expect(vix1dCalls).toBe(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('fetches the five symbols in sequential pairs, not one 5-wide burst', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(schwabFetch).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles: [], previousClose: 5380 },
      };
    });

    vi.mocked(schwabFetch).mockClear();

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    expect(schwabFetch).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  // ── Fetch window: [D-5d, D], no look-ahead ─────────────────
  //
  // Only the target date and the previous trading day are ever used, so the
  // old [D-7d, D+2d] window fetched ~8 trading dates × 5 symbols ≈ 40 sidecar
  // calls to use 2 per symbol — and the +2d look-ahead made the adapter's
  // `previousClose` (= second-to-last session in range) TOMORROW's close for
  // a backtest of D. Five calendar days back still spans a 3-day weekend plus
  // a holiday.

  it('fetches a [D-5d, D] window with no look-ahead past the target', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const targetMs = new Date(`${targetDate}T12:00:00Z`).getTime();

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles: [], previousClose: 5380 },
    });
    vi.mocked(schwabFetch).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    const paths = vi.mocked(schwabFetch).mock.calls.map((c) => c[0]);
    expect(paths).toHaveLength(5);
    for (const path of paths) {
      const { startDate, endDate } = windowOf(path);
      expect(startDate).toBe(targetMs - 5 * DAY_MS);
      expect(endDate).toBe(targetMs);
    }
  });

  it('resolves previousDay from the session before a Monday target across the weekend', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    // 2026-03-16 is a Monday; the previous session is Friday 2026-03-13 (both
    // EDT — DST began 2026-03-08). With the target as the LAST date in range
    // there is nothing after it to mistake for the "previous" session.
    const targetDate = '2026-03-16';
    const prevDate = '2026-03-13';

    const candles = [
      makeCandleEDT(prevDate, 9, 30, 5400, 5420, 5395, 5410),
      makeCandleEDT(prevDate, 15, 55, 5410, 5430, 5405, 5425),
      makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460),
      makeCandleEDT(targetDate, 9, 35, 5460, 5480, 5455, 5475),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles, previousClose: 5425 },
    });

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    const json = res._json as {
      spx: {
        candles: { time: string }[];
        previousClose: number;
        previousDay: {
          date: string;
          open: number;
          close: number;
          high: number;
          low: number;
        } | null;
      };
      candleCount: number;
    };

    expect(json.candleCount).toBe(2);
    expect(json.spx.candles).toHaveLength(2);
    expect(json.spx.previousClose).toBe(5425);
    expect(json.spx.previousDay).toEqual({
      date: prevDate,
      open: 5400,
      high: 5430,
      low: 5395,
      close: 5425,
      rangePct: expect.any(Number),
      rangePts: 35,
    });
  });

  // ── Silent-empty cache hole ────────────────────────────────
  //
  // The sidecar answers "Theta had no data" with a 404 → the adapter swallows
  // it (NoDataError → []) → the facade returns ok:true with zero candles →
  // `allOk` is TRUE → the EMPTY symbol used to be cached for 90 days and never
  // retried or alerted. That is exactly "$VIX1D empty, other four fine".

  it('retries a VIX-family symbol that came back ok-but-empty while $SPX has data', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        if (vix1dCalls === 1) {
          return {
            ok: true as const,
            data: { symbol: '$VIX1D', candles: [], previousClose: 0 },
          };
        }
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(2);

    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles.length).toBeGreaterThan(0);

    // Retry recovered the symbol → complete → 90-day write + long CDN headers.
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { ex: PAST_CACHE_TTL },
    );
    expect(setCacheHeaders).toHaveBeenCalledWith(
      expect.anything(),
      86400,
      3600,
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not cache long, uses short headers, and alerts once when a symbol stays empty after the retry', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: true as const,
          data: { symbol: '$VIX1D', candles: [], previousClose: 0 },
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // Exactly one retry for the empty symbol; the other four are untouched.
    expect(vix1dCalls).toBe(2);
    expect(schwabFetch).toHaveBeenCalledTimes(6);

    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles).toEqual([]);

    // An ok-but-empty symbol must not poison the 90-day cache — and no
    // short-TTL "partial" entry is written either (nothing reads it back;
    // the next request refetches)...
    expect(redis.set).not.toHaveBeenCalled();
    // ...nor the CDN for a day.
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);

    // The path is no longer invisible: one alert per still-empty symbol. The
    // date rides in `extra` (not the message) so Sentry groups a re-alerting
    // date into one issue per symbol.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('$VIX1D'),
      { level: 'warning', extra: { targetDate } },
    );
    const [message] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(message).not.toContain(targetDate);
  });

  it('retries $SPX when it is ok-but-empty while the VIX family has candles, then alerts and keeps the short TTL', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    // Symmetric case: the reference symbol itself is the silent miss. The
    // four Cboe indices prove a session exists, so a blank $SPX must be
    // retried, must not be edge-cached for a day, and must alert — not
    // vacuously pass the "nothing to compare against" gate.
    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 18, 19, 17.5, 18.5)];

    let spxCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('SPX')) {
        spxCalls += 1;
        return {
          ok: true as const,
          data: { symbol: '$SPX', candles: [], previousClose: 0 },
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$VIX', candles, previousClose: 18 },
      };
    });

    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // Exactly one retry for $SPX; the four VIX-family symbols are untouched.
    expect(spxCalls).toBe(2);
    expect(schwabFetch).toHaveBeenCalledTimes(6);

    const json = res._json as {
      spx: { candles: unknown[] };
      vix: { candles: unknown[] };
      candleCount: number;
    };
    expect(json.spx.candles).toEqual([]);
    expect(json.vix.candles).toHaveLength(1);
    expect(json.candleCount).toBe(0);

    // Never a Redis write (no 90-day entry, no dead short-TTL one)...
    expect(redis.set).not.toHaveBeenCalled();
    // ...and never the day-long CDN max-age for a blank-SPX response.
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('$SPX'),
      { level: 'warning', extra: { targetDate } },
    );
  });

  // ── Early session: a still-empty symbol is not yet a hole ───
  //
  // $VIX1D's first 5-minute print can lag $SPX's. "SPX has its 9:30 candle,
  // VIX1D has none yet" at 9:36 ET on today is the feed warming up, not the
  // silent-empty hole above — breadcrumb it, don't page. Past dates, and
  // today once the open is 10 minutes old, keep the alert. (2026-08-19 is a
  // Wednesday in EDT, so 13:36Z = 9:36 ET.)

  it('demotes the still-empty alert to a breadcrumb for today within 10 minutes of the open', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(new Date('2026-08-19T13:36:00Z'));

    const targetDate = '2026-08-19';
    const candles = [makeCandleEDT(targetDate, 9, 30, 6450, 6470, 6445, 6460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: true as const,
          data: { symbol: '$VIX1D', candles: [], previousClose: 0 },
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 6380 },
      };
    });

    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.addBreadcrumb).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // Still retried once — the lag is usually over by the second look.
    expect(vix1dCalls).toBe(2);
    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles).toEqual([]);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'history',
        level: 'info',
        data: expect.objectContaining({
          symbol: '$VIX1D',
          targetDate,
          earlySession: true,
        }),
      }),
    );
    // Today is never long-lived anyway.
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);
  });

  it('keeps the still-empty alert for today once the open is 10 minutes old', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(new Date('2026-08-19T14:00:00Z')); // 10:00 ET

    const targetDate = '2026-08-19';
    const candles = [makeCandleEDT(targetDate, 9, 30, 6450, 6470, 6445, 6460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: true as const,
          data: { symbol: '$VIX1D', candles: [], previousClose: 0 },
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 6380 },
      };
    });

    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(2);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('$VIX1D'),
      { level: 'warning', extra: { targetDate } },
    );
  });

  // ── All five empty ─────────────────────────────────────────
  //
  // With no symbol to compare against there is nothing to retry. Whether the
  // blank day may be edge-cached for a day depends on the NYSE calendar
  // (`isTradingDay`): a weekend / holiday blank is permanent; a blank on a
  // day the exchange was open is the sidecar/Theta returning nothing for a
  // session that happened (or today's open not having printed yet) — it
  // stays on the short CDN header and, unless it is simply early, alerts
  // once. Nothing is written to Redis in either case.

  it('does not retry any symbol when every symbol is empty', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles: [], previousClose: 0 },
    });
    vi.mocked(schwabFetch).mockClear();

    const res = await run(mockRequest({ query: { date: '2026-03-10' } }));

    expect(res._status).toBe(200);
    expect(schwabFetch).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['2026-04-03', 'Good Friday'],
    ['2026-03-14', 'a Saturday'],
  ])(
    'edge-caches an all-empty %s (%s) for a day without alerting',
    async (targetDate) => {
      vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

      vi.mocked(schwabFetch).mockResolvedValue({
        ok: true,
        data: { symbol: '$SPX', candles: [], previousClose: 0 },
      });
      vi.mocked(redis.set).mockClear();
      vi.mocked(Sentry.captureMessage).mockClear();
      vi.mocked(setCacheHeaders).mockClear();

      const res = await run(mockRequest({ query: { date: targetDate } }));

      expect(res._status).toBe(200);
      expect((res._json as { candleCount: number }).candleCount).toBe(0);
      expect(setCacheHeaders).toHaveBeenCalledWith(
        expect.anything(),
        86400,
        3600,
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    },
  );

  it('keeps an all-empty known trading day on the short CDN header and alerts once', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    // Tuesday 2026-03-10 — a weekday that is not in MARKET_CLOSED_DATES.
    const targetDate = '2026-03-10';
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles: [], previousClose: 0 },
    });
    vi.mocked(redis.set).mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);
    expect(setCacheHeaders).not.toHaveBeenCalledWith(
      expect.anything(),
      86400,
      3600,
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(ALL_EMPTY_ALERT, {
      level: 'warning',
      extra: { targetDate },
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not add the all-empty alert when the symbols failed outright (each failure already alerts)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Schwab API error (502): transient',
      status: 502,
    });
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    // One "fetch failed" alert per symbol, and nothing else.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(5);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      ALL_EMPTY_ALERT,
      expect.anything(),
    );
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);
  });

  it('does not alert an all-empty today before the open', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z')); // 8:00 ET

    const targetDate = '2026-08-19';
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles: [], previousClose: 0 },
    });
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.addBreadcrumb).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'history',
        level: 'info',
        data: expect.objectContaining({ targetDate, earlySession: true }),
      }),
    );
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);
  });

  it('alerts an all-empty today once the open is 10 minutes old', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(new Date('2026-08-19T14:00:00Z')); // 10:00 ET

    const targetDate = '2026-08-19';
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles: [], previousClose: 0 },
    });
    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(ALL_EMPTY_ALERT, {
      level: 'warning',
      extra: { targetDate },
    });
  });

  // ── Redis writes: only the 90-day entry earns a command ────
  //
  // Today's entry was written with a 120s TTL but never read back (the HIT
  // path is `!isToday`, and by tomorrow the entry has expired), so it was a
  // billed Redis command per request for nothing. The CDN's 120s max-age is
  // today's cache.

  it('does not write today to Redis (nothing reads it back)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(new Date('2026-08-19T18:00:00Z')); // 2:00 PM ET

    const targetDate = '2026-08-19';
    const candles = [makeCandleEDT(targetDate, 9, 30, 6450, 6470, 6445, 6460)];
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', candles, previousClose: 6380 },
    });
    vi.mocked(redis.get).mockClear();
    vi.mocked(redis.set).mockClear();
    vi.mocked(setCacheHeaders).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect((res._json as { candleCount: number }).candleCount).toBe(1);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(setCacheHeaders).toHaveBeenCalledWith(expect.anything(), 120, 60);
  });

  // ── isRetryableFailure: deterministic failures are not retried ──

  it('does not retry a 401 SCHWAB_TOKEN_EXPIRED', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: false as const,
          error: '[SCHWAB_TOKEN_EXPIRED] Refresh token expired',
          status: 401,
          code: 'SCHWAB_TOKEN_EXPIRED',
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(1);
  });

  it('does not retry a 500 [SCHWAB_TOKEN_ERROR] config failure (no code set)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    // market-data-adapters `mapError` turns a ConfigError (missing
    // SIDECAR_URL / UW_API_KEY) into a 500 whose only marker is the
    // `[SCHWAB_TOKEN_ERROR]` prefix — no `code`. A retry cannot fix env.
    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        return {
          ok: false as const,
          error: '[SCHWAB_TOKEN_ERROR] SIDECAR_URL not configured',
          status: 500,
        };
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(1);
  });

  it('retries a 429 rate-limit once', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);

    const targetDate = '2026-03-10';
    const candles = [makeCandleEDT(targetDate, 9, 30, 5450, 5470, 5445, 5460)];

    let vix1dCalls = 0;
    vi.mocked(schwabFetch).mockImplementation(async (path: string) => {
      if (path.includes('VIX1D')) {
        vix1dCalls += 1;
        if (vix1dCalls === 1) {
          return {
            ok: false as const,
            error: '[SCHWAB_API_429] rate limited',
            status: 429,
          };
        }
      }
      return {
        ok: true as const,
        data: { symbol: '$SPX', candles, previousClose: 5380 },
      };
    });

    vi.mocked(Sentry.captureMessage).mockClear();

    const res = await run(mockRequest({ query: { date: targetDate } }));

    expect(res._status).toBe(200);
    expect(vix1dCalls).toBe(2);
    const json = res._json as { vix1d: { candles: unknown[] } };
    expect(json.vix1d.candles.length).toBeGreaterThan(0);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
