// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

import handler from '../yesterday.js';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
} from '../_lib/api-helpers.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';

function makeDailyCandle(
  dateStr: string,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  // The fixture stamps 00:00Z of the trading day. Real Schwab daily bars are
  // stamped at a midnight in CT/ET (04:00-06:00Z), not at midnight UTC. The
  // handler reads the stamp's UTC calendar date (msToDateStr), which is the
  // trading day for either stamp, so the fixture gives the same dates.
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

  it('forwards schwabFetch errors', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Token expired',
      status: 401,
      code: 'SCHWAB_TOKEN_EXPIRED',
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Token expired' });
  });

  it('returns null when no candles', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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
    // Bot detection now lives inside guardOwnerOrGuestEndpoint — the
    // helper writes the 403 response and returns true to signal
    // "handled, exit early."
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 500 when handler throws unexpected error', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(schwabFetch).mockImplementation(() => {
      throw new Error('Crash');
    });

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('returns only yesterday when single candle', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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

// ============================================================
// THE EDGE CACHE NEVER OUTLIVES ITS ET DAY
// ============================================================
//
// The body names "the last completed session before today", so it is wrong
// from the next ET midnight. A cache lifetime that crosses midnight (a day
// long after the close, or an hour at 23:30) serves yesterday morning's body
// the next morning. s-maxage is the smaller of the usual lifetime and the time
// to the next 00:00 ET, and stale-while-revalidate is cut so the two together
// cannot cross it. The clock is pinned to exact UTC instants.

describe('GET /api/yesterday: the cache ends by the next ET midnight', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(setCacheHeaders).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Call the handler at `now` and return the (s-maxage, swr) it set. */
  async function cacheAt(now: number, marketOpen: boolean) {
    vi.mocked(setCacheHeaders).mockClear();
    vi.setSystemTime(now);
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(marketOpen);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        candles: [makeDailyCandle('2026-03-06', 5470, 5520, 5460, 5510)],
      },
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(200);
    expect(setCacheHeaders).toHaveBeenCalledTimes(1);
    const [calledRes, edgeSec, swr] = vi.mocked(setCacheHeaders).mock.calls[0]!;
    expect(calledRes).toBe(res);
    // The handler always passes both, though the helper's swr is optional.
    expect(swr).toBeDefined();
    return { edgeSec, swr: swr! };
  }

  // Tue 2026-11-24 is EST (UTC-5): its midnight to midnight is 05:00Z to 05:00Z.
  const NEXT_MIDNIGHT = Date.UTC(2026, 10, 25, 5, 0, 0);
  const at = (hour: number, minute: number, second = 0) =>
    Date.UTC(2026, 10, 24, hour + 5, minute, second);

  it('keeps the usual hour, and an hour of revalidation, mid-session', async () => {
    // 10:00 ET: 14 hours to midnight, so nothing is cut.
    expect(await cacheAt(at(10, 0), true)).toEqual({
      edgeSec: 3600,
      swr: 3600,
    });
  });

  it('cuts the day-long after-hours lifetime to the time left in the day', async () => {
    // 17:00 ET: 7 hours to midnight. The usual 86400 would serve this body
    // all of tomorrow morning.
    expect(await cacheAt(at(17, 0), false)).toEqual({
      edgeSec: 7 * 3600,
      swr: 0,
    });
  });

  it('ends by midnight for a response at 23:59 ET', async () => {
    const { edgeSec, swr } = await cacheAt(at(23, 59), false);

    expect(edgeSec).toBe(60);
    expect(swr).toBe(0);
    expect(at(23, 59) + (edgeSec + swr) * 1000).toBeLessThanOrEqual(
      NEXT_MIDNIGHT,
    );
  });

  it('rounds down to whole seconds, and caches nothing in the last second', async () => {
    expect(await cacheAt(at(23, 59, 30) + 400, false)).toEqual({
      edgeSec: 29,
      swr: 0,
    });
    expect(await cacheAt(NEXT_MIDNIGHT - 500, false)).toEqual({
      edgeSec: 0,
      swr: 0,
    });
  });

  it('cuts only the revalidation window when the hour fits but the extra hour does not', async () => {
    // 22:30 ET with the market flagged open: 5400 s to midnight. The hour
    // fits; the second hour of stale-while-revalidate is cut to the 1800 s left.
    expect(await cacheAt(at(22, 30), true)).toEqual({
      edgeSec: 3600,
      swr: 1800,
    });
  });

  it('is exact on the spring-forward day, whose midnight to midnight is 23 hours', async () => {
    // Sun 2026-03-08, 01:30 EST (06:30Z). The day's DST jump is at 02:00, so
    // the next midnight, Mon 03-09 00:00 EDT, is 04:00Z: 21.5 h away. A "24 h
    // minus the wall clock" count says 22.5 h.
    const now = Date.UTC(2026, 2, 8, 6, 30, 0);

    expect(await cacheAt(now, false)).toEqual({
      edgeSec: 21.5 * 3600,
      swr: 0,
    });
  });

  it('is exact on the fall-back day, whose midnight to midnight is 25 hours', async () => {
    // Sun 2026-11-01, 01:30 EDT (05:30Z), the first of the two 1:30s. The next
    // midnight, Mon 11-02 00:00 EST, is 05:00Z the next day: 23.5 h away.
    const now = Date.UTC(2026, 10, 1, 5, 30, 0);

    expect(await cacheAt(now, false)).toEqual({
      edgeSec: 23.5 * 3600,
      swr: 0,
    });
  });

  it('never lets lifetime plus revalidation cross midnight, at any time of day', async () => {
    // Every few minutes of Tue 2026-11-24 ET, market flag on and off.
    for (
      let t = Date.UTC(2026, 10, 24, 5, 0, 0);
      t < NEXT_MIDNIGHT;
      t += 307_000
    ) {
      for (const marketOpen of [true, false]) {
        const { edgeSec, swr } = await cacheAt(t, marketOpen);
        const toMidnight = Math.floor((NEXT_MIDNIGHT - t) / 1000);

        expect(edgeSec, `${new Date(t).toISOString()} open=${marketOpen}`).toBe(
          Math.min(marketOpen ? 3600 : 86400, toMidnight),
        );
        expect(edgeSec + swr).toBeLessThanOrEqual(toMidnight);
        expect(swr).toBeLessThanOrEqual(3600);
      }
    }
  });
});
