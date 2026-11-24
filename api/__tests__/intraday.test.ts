// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../intraday.js';
import {
  guardOwnerOrGuestEndpoint,
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
} from '../_lib/api-helpers.js';

/**
 * Create a 5-min candle at a specific ET time today.
 * hour/minute are in ET (e.g. 9, 30 for 9:30 AM).
 */
/**
 * Create a 5-min candle at a specific ET time.
 * hour/minute are in ET (e.g. 9, 30 for 9:30 AM).
 * Optional dateStr overrides the date (YYYY-MM-DD); defaults to today.
 */
function makeCandle(
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  dateStr?: string,
) {
  const day =
    dateStr ??
    new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
  // Create a date in ET
  const etDate = new Date(
    `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
  );
  // Convert to approximate UTC by adding ~5h (rough, but adequate for test filtering)
  const utcMs = etDate.getTime() + 5 * 60 * 60 * 1000;
  return { open, high, low, close, volume: 1000, datetime: utcMs };
}

describe('GET /api/intraday', () => {
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
      error: 'API down',
      status: 502,
      code: 'SCHWAB_API_502',
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'API down' });
  });

  it('returns today OHLC and opening range from candles', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    // 7 candles covering 9:30-10:05 — first 6 form the opening range
    const candles = [
      makeCandle(9, 30, 5500, 5510, 5495, 5505),
      makeCandle(9, 35, 5505, 5515, 5500, 5510),
      makeCandle(9, 40, 5510, 5520, 5505, 5515),
      makeCandle(9, 45, 5515, 5525, 5510, 5520),
      makeCandle(9, 50, 5520, 5530, 5515, 5525),
      makeCandle(9, 55, 5525, 5535, 5520, 5530),
      makeCandle(10, 0, 5530, 5540, 5525, 5535),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: Date.now() - 86400000,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.previousClose).toBe(5490);
    expect(json.marketOpen).toBe(true);
    // today and openingRange should exist (exact values depend on timezone filtering)
    expect(json).toHaveProperty('today');
    expect(json).toHaveProperty('openingRange');
    expect(json).toHaveProperty('candleCount');
  });

  it('returns 403 when bot detected (via guard)', async () => {
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

  it('handles empty candle data', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: true,
        previousClose: 5490,
        previousCloseDate: 0,
        candles: [],
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.today).toBeNull();
    expect(json.openingRange).toBeNull();
    expect(json.candleCount).toBe(0);
  });

  it('filters to most recent trading day when candles span multiple days', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString(
      'en-CA',
      { timeZone: 'America/New_York' },
    );
    const todayStr = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    // Yesterday's candle should be excluded, today's kept
    const candles = [
      makeCandle(9, 30, 5400, 5410, 5395, 5405, yesterday),
      makeCandle(9, 30, 5500, 5510, 5495, 5505, todayStr),
      makeCandle(9, 35, 5505, 5515, 5500, 5510, todayStr),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: 0,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Only today's 2 candles pass the filter, not yesterday's
    expect(json.candleCount).toBe(2);
    expect((json.today as { open: number }).open).toBe(5500);
  });

  it('returns prior session data on holidays/weekends', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);

    // Simulate a holiday: candles are from 2 days ago, none from today
    const priorDay = new Date(Date.now() - 2 * 86400000).toLocaleDateString(
      'en-CA',
      { timeZone: 'America/New_York' },
    );

    const candles = [
      makeCandle(9, 30, 5500, 5510, 5495, 5505, priorDay),
      makeCandle(9, 35, 5505, 5515, 5500, 5510, priorDay),
      makeCandle(9, 40, 5510, 5520, 5505, 5515, priorDay),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: false,
        previousClose: 5490,
        previousCloseDate: 0,
        candles,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Should return the prior session's candles, not empty
    expect(json.candleCount).toBe(3);
    expect(json.today).not.toBeNull();
    expect(json.marketOpen).toBe(false);
  });
});

// ============================================================
// THE SESSION THE RANGE IS FROM, AND WHEN IT IS COMPLETE
// ============================================================
//
// The response says which session its range is from (`sessionDate`), so the
// client can tell today's from a held previous session's. The range is
// complete only once the data shows the 9:55 ET bar has closed. Every time
// here is an exact UTC constant in November (EST, UTC-5) and the system clock
// is pinned: the cache and "complete" both depend on today's ET date.

/** A 5-minute bar starting at ET `hour:minute` on 2026-11-`day` (EST). */
function barAt(day: number, hour: number, minute: number, price = 5500) {
  return {
    open: price,
    high: price + 10,
    low: price - 10,
    close: price + 5,
    volume: 1000,
    datetime: Date.UTC(2026, 10, day, hour + 5, minute),
  };
}

/** `count` consecutive bars from ET `hour:minute`, the price rising a point a bar. */
function barsFrom(day: number, hour: number, minute: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const start = hour * 60 + minute + i * 5;
    return barAt(day, Math.floor(start / 60), start % 60, 5500 + i);
  });
}

/** A full regular session: 9:30 to 15:55 ET, 78 bars. */
const fullSession = (day: number) => barsFrom(day, 9, 30, 78);

// Mon 2026-11-23, Tue 11-24, Wed 11-25, Thu 11-26 (Thanksgiving), Fri 11-20
// and Sat 11-21, as UTC instants at a given ET time.
const et = (day: number, hour: number, minute: number) =>
  Date.UTC(2026, 10, day, hour + 5, minute);

describe('GET /api/intraday: sessionDate, complete and the cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(setCacheHeaders).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function callAt(
    nowMs: number,
    candles: ReturnType<typeof barAt>[],
    marketOpen: boolean,
  ) {
    vi.setSystemTime(nowMs);
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(marketOpen);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        empty: candles.length === 0,
        previousClose: 5490,
        previousCloseDate: 0,
        candles,
      },
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(200);
    return {
      res,
      json: res._json as {
        sessionDate: string | null;
        openingRange: {
          high: number;
          low: number;
          complete: boolean;
          minutes: number;
        } | null;
        today: unknown;
        candleCount: number;
      },
    };
  }

  const SHORT_CACHE = [120, 60] as const;
  const LONG_CACHE = [600, 120] as const;

  describe('sessionDate', () => {
    it("is today's date on a trading day once today's bars exist", async () => {
      // Tue 10:30 ET, Monday's session plus today's first bars.
      const { res, json } = await callAt(
        et(24, 10, 30),
        [...fullSession(23), ...barsFrom(24, 9, 30, 12)],
        true,
      );

      expect(json.sessionDate).toBe('2026-11-24');
      expect(json.candleCount).toBe(12);
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...SHORT_CACHE);
    });

    it("is today's date after the close, with the long cache", async () => {
      // Tue 17:00 ET: the session is over and final.
      const { res, json } = await callAt(et(24, 17, 0), fullSession(24), false);

      expect(json.sessionDate).toBe('2026-11-24');
      expect(json.openingRange?.complete).toBe(true);
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...LONG_CACHE);
    });

    it("is the previous session's date before today's first bar, with the short cache", async () => {
      // Tue 09:15 ET: only Monday's bars. The market is not open, but a
      // trading day's short cache keeps a 9:29 body from being served at 9:41.
      const { res, json } = await callAt(et(24, 9, 15), fullSession(23), false);

      expect(json.sessionDate).toBe('2026-11-23');
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...SHORT_CACHE);
    });

    it("is today's date with no range and the short cache when only pre-9:30 bars exist", async () => {
      // Tue 09:00 ET: Schwab's indicative bars from 8:00 make today the
      // latest date, but none is a regular-session bar.
      const { res, json } = await callAt(
        et(24, 9, 0),
        [...fullSession(23), ...barsFrom(24, 8, 0, 12)],
        false,
      );

      expect(json.sessionDate).toBe('2026-11-24');
      expect(json.openingRange).toBeNull();
      expect(json.today).toBeNull();
      expect(json.candleCount).toBe(0);
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...SHORT_CACHE);
    });

    it('is the last session on a holiday, with the long cache', async () => {
      // Thu 11-26 (Thanksgiving) 11:00 ET: the last session was Wed 11-25.
      const { res, json } = await callAt(
        et(26, 11, 0),
        [...fullSession(24), ...fullSession(25)],
        false,
      );

      expect(json.sessionDate).toBe('2026-11-25');
      expect(json.openingRange?.complete).toBe(true);
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...LONG_CACHE);
    });

    it('is the last session on a weekend, with the long cache', async () => {
      // Sat 11-21: Friday 11-20 was the last session.
      const { res, json } = await callAt(et(21, 12, 0), fullSession(20), false);

      expect(json.sessionDate).toBe('2026-11-20');
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...LONG_CACHE);
    });

    it('is null with no candles, and a trading day gets the short cache', async () => {
      const { res, json } = await callAt(et(24, 10, 0), [], true);

      expect(json.sessionDate).toBeNull();
      expect(json.openingRange).toBeNull();
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...SHORT_CACHE);
    });

    it('is null with no candles after the close too: nothing is final to cache long', async () => {
      const { res, json } = await callAt(et(24, 17, 0), [], false);

      expect(json.sessionDate).toBeNull();
      expect(setCacheHeaders).toHaveBeenLastCalledWith(res, ...SHORT_CACHE);
    });
  });

  describe('opening range complete', () => {
    it('is false with six bars and no 10:00 ET bar: the 9:55 bar may still be running', async () => {
      // Tue 09:57 ET, the 9:55 bar still open.
      const { json } = await callAt(
        et(24, 9, 57),
        barsFrom(24, 9, 30, 6),
        true,
      );

      expect(json.openingRange?.minutes).toBe(30);
      expect(json.openingRange?.complete).toBe(false);
    });

    it('is true once a 10:00 ET bar is present', async () => {
      const { json } = await callAt(
        et(24, 10, 2),
        barsFrom(24, 9, 30, 7),
        true,
      );

      expect(json.openingRange?.complete).toBe(true);
    });

    it('is false with fewer than six bars, whatever follows', async () => {
      // 9:45 is missing: five opening-range bars and a 10:00 bar. The range
      // is not the whole 30 minutes, so it is not complete.
      const bars = barsFrom(24, 9, 30, 8).filter(
        (_, i) => i !== 3, // the 9:45 ET bar
      );
      const { json } = await callAt(et(24, 10, 10), bars, true);

      expect(json.openingRange?.minutes).toBe(25);
      expect(json.openingRange?.complete).toBe(false);
    });

    it("is true for a previous session's six bars: that session is over", async () => {
      // Tue 09:15 ET, only Monday's first six bars came back.
      const { json } = await callAt(
        et(24, 9, 15),
        barsFrom(23, 9, 30, 6),
        false,
      );

      expect(json.sessionDate).toBe('2026-11-23');
      expect(json.openingRange?.complete).toBe(true);
    });

    it("is false for a previous session's five bars", async () => {
      const { json } = await callAt(
        et(24, 9, 15),
        barsFrom(23, 9, 30, 5),
        false,
      );

      expect(json.openingRange?.complete).toBe(false);
    });

    it('takes the range from the bars that start before 10:00 ET only', async () => {
      // With the 9:45 bar missing, the 10:00 bar is the sixth candle. Its
      // extreme range must not widen the opening range.
      const bars = [
        ...barsFrom(24, 9, 30, 6).filter((_, i) => i !== 3),
        { ...barAt(24, 10, 0), high: 9999, low: 1 },
      ];
      const { json } = await callAt(et(24, 10, 5), bars, true);

      // The five bars 9:30, 9:35, 9:40, 9:50, 9:55: highs up to 5515, lows
      // down to 5490.
      expect(json.openingRange?.high).toBe(5515);
      expect(json.openingRange?.low).toBe(5490);
      expect(json.openingRange?.minutes).toBe(25);
    });
  });
});
