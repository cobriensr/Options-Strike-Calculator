// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Use vi.hoisted so mocks are available when vi.mock factories run (hoisted above imports)
const mockSaveOutcome = vi.hoisted(() => vi.fn());
const mockInsertOutcomeIfMissing = vi.hoisted(() => vi.fn());
const mockRedisGet = vi.hoisted(() => vi.fn());

vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    schwabFetch: vi.fn(),
    // Use passthrough withRetry to avoid fake-timer delays
    withRetry: vi.fn((fn: () => unknown) => fn()),
  };
});

const mockSql = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ settlement: 5700 }]),
);
vi.mock('../_lib/db.js', () => ({
  saveOutcome: mockSaveOutcome,
  insertOutcomeIfMissing: mockInsertOutcomeIfMissing,
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// The backfill reads the CBOE VIX1D daily map the refresh-vix1d cron keeps in
// Redis. The rest of the module stays real.
vi.mock('../_lib/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/redis.js')>();
  return { ...actual, redis: { get: mockRedisGet } };
});

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Spy on captureException only; the rest of the Sentry surface stays real.
const mockCaptureException = vi.hoisted(() => vi.fn());
vi.mock('../_lib/sentry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/sentry.js')>();
  return {
    ...actual,
    Sentry: { ...actual.Sentry, captureException: mockCaptureException },
  };
});

import handler from '../cron/fetch-outcomes.js';
import { schwabFetch } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';

const mockedSchwabFetch = schwabFetch as ReturnType<typeof vi.fn>;

// Fixed times for deterministic tests
// Tuesday 2026-03-24 at 5:00 PM ET = 21:00 UTC (inside post-close window)
const CLOSE_WINDOW_TIME = new Date('2026-03-24T21:00:00.000Z');
// Tuesday 2026-03-24 at 10:00 AM ET = 14:00 UTC (outside post-close window)
const OUTSIDE_WINDOW_TIME = new Date('2026-03-24T14:00:00.000Z');
// Saturday 2026-03-28 at 5:00 PM ET
const WEEKEND_TIME = new Date('2026-03-28T21:00:00.000Z');
// MLK Day 2026 (Monday 2026-01-19) at 5:00 PM ET = 22:00 UTC
// — full NYSE holiday, inside the post-close window, to exercise the
// trading-day gate AFTER the isAfterClose() time window passes.
const HOLIDAY_CLOSE_WINDOW_TIME = new Date('2026-01-19T22:00:00.000Z');

// Candle timestamps for 2026-03-24, starting 9:30 AM ET = 14:30 UTC
function makeCandles() {
  const base = new Date('2026-03-24T14:30:00.000Z').getTime();
  return [
    {
      open: 5700,
      high: 5720,
      low: 5695,
      close: 5710,
      volume: 100,
      datetime: base,
    },
    {
      open: 5710,
      high: 5730,
      low: 5700,
      close: 5725,
      volume: 200,
      datetime: base + 5 * 60_000,
    },
    {
      open: 5725,
      high: 5735,
      low: 5715,
      close: 5730,
      volume: 150,
      datetime: base + 10 * 60_000,
    },
  ];
}

function makeIntradayResponse(candles = makeCandles()) {
  return { ok: true as const, data: { candles, symbol: '$SPX', empty: false } };
}

function makeQuotesResponse(vix = 18, vix1d = 15) {
  return {
    ok: true as const,
    data: {
      $VIX: { quote: { lastPrice: vix } },
      $VIX1D: { quote: { lastPrice: vix1d } },
    },
  };
}

describe('fetch-outcomes handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Restore mockSql default (resetAllMocks clears it)
    mockSql.mockResolvedValue([{ settlement: 5700 }]);
    process.env = { ...originalEnv };
    vi.setSystemTime(CLOSE_WINDOW_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  // ── Auth ──────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and auth header does not match', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('allows request when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'my-secret';
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce(makeQuotesResponse());
    mockSaveOutcome.mockResolvedValueOnce(undefined);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer my-secret' },
      query: { force: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('settlement');
  });

  // ── Time window ───────────────────────────────────────────

  it('skips when outside post-close window and force is not set', async () => {
    vi.setSystemTime(OUTSIDE_WINDOW_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockedSchwabFetch).not.toHaveBeenCalled();
  });

  it('skips on weekends even during the right time', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('skipped', true);
  });

  it('runs when force=true even outside the post-close window', async () => {
    vi.setSystemTime(OUTSIDE_WINDOW_TIME);
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce(makeQuotesResponse());
    mockSaveOutcome.mockResolvedValueOnce(undefined);

    const req = mockRequest({
      method: 'GET',
      query: { force: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('settlement');
    expect(mockedSchwabFetch).toHaveBeenCalledTimes(2);
  });

  // ── Trading-day gate (BE-CRON-009) ────────────────────────

  it('skips with not_trading_day reason on a NYSE holiday (MLK Day 2026)', async () => {
    vi.setSystemTime(HOLIDAY_CLOSE_WINDOW_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Wrapper-emitted skipped body. The `date` key was dropped from the
    // body when the holiday gate moved into dynamicTimeCheck (which
    // doesn't have access to the cron's `today` formatter); the per-cron
    // metadata is now keyed under `reason`. The Axiom-side dashboard is
    // unaffected — `reportCronRun` still receives the date via the
    // wrapper's startTimeMs/durationMs envelope.
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'not_trading_day',
    });
    expect(mockedSchwabFetch).not.toHaveBeenCalled();
    expect(mockSaveOutcome).not.toHaveBeenCalled();
  });

  it('force=true bypasses the trading-day gate and runs on a holiday', async () => {
    vi.setSystemTime(HOLIDAY_CLOSE_WINDOW_TIME);
    // Simulate Schwab returning candles dated for MLK Day (even though in
    // reality Schwab wouldn't) — the point of this test is that the handler
    // makes the call rather than short-circuiting.
    const mlkBase = new Date('2026-01-19T14:30:00.000Z').getTime();
    const mlkCandles = [
      {
        open: 5800,
        high: 5810,
        low: 5795,
        close: 5805,
        volume: 10,
        datetime: mlkBase,
      },
    ];
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse(mlkCandles));
    mockedSchwabFetch.mockResolvedValueOnce(makeQuotesResponse());
    mockSaveOutcome.mockResolvedValueOnce(undefined);

    const req = mockRequest({
      method: 'GET',
      query: { force: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockedSchwabFetch).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ date: '2026-01-19' });
  });

  // ── Successful fetch and save ─────────────────────────────

  it('fetches intraday candles and VIX quotes, saves outcome, returns 200', async () => {
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce(makeQuotesResponse(20, 16));
    mockSaveOutcome.mockResolvedValueOnce(undefined);

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      date: '2026-03-24',
      settlement: 5730,
      dayOpen: 5700,
      dayHigh: 5735,
      dayLow: 5695,
      rangePts: 40,
      vixClose: 20,
      vix1dClose: 16,
    });

    expect(mockSaveOutcome).toHaveBeenCalledOnce();
    expect(mockSaveOutcome).toHaveBeenCalledWith({
      date: '2026-03-24',
      settlement: 5730,
      dayOpen: 5700,
      dayHigh: 5735,
      dayLow: 5695,
      vixClose: 20,
      vix1dClose: 16,
    });
  });

  // ── Error scenarios ───────────────────────────────────────

  it('returns 502 when intraday schwabFetch fails', async () => {
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: false,
      error: 'Schwab API down',
      status: 502,
    });

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'Schwab API down' });
    expect(mockSaveOutcome).not.toHaveBeenCalled();
  });

  it('skips quietly (200, skipped, no capture) when Schwab is logged out', async () => {
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: false,
      error: '[SCHWAB_TOKEN_EXPIRED] No tokens found.',
      status: 401,
      code: 'SCHWAB_TOKEN_EXPIRED',
    });

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      skipped: true,
      reason: 'schwab_logged_out',
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockSaveOutcome).not.toHaveBeenCalled();
    // No follow-up VIX fetch once we know we're logged out.
    expect(mockedSchwabFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SCHWAB_TOKEN_ERROR', 500],
    ['SCHWAB_API_REJECTED', 401],
    ['SCHWAB_API_NETWORK', 504],
  ] as const)('stays a captured 502 on %s', async (code, status) => {
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: false,
      error: `[${code}] boom`,
      status,
      code,
    });

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: `[${code}] boom` });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with skipped when no candles found for today', async () => {
    // Return candles with a different date (yesterday) so they get filtered out
    const yesterday = new Date('2026-03-23T14:30:00.000Z').getTime();
    const staleCandles = [
      {
        open: 5700,
        high: 5720,
        low: 5695,
        close: 5710,
        volume: 100,
        datetime: yesterday,
      },
    ];
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse(staleCandles));

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true, reason: 'No candles' });
    expect(mockSaveOutcome).not.toHaveBeenCalled();
  });

  it('still saves SPX data when VIX quotes fail (warns but does not error)', async () => {
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: false,
      error: 'VIX unavailable',
      status: 502,
    });
    mockSaveOutcome.mockResolvedValueOnce(undefined);

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      settlement: 5730,
      vixClose: null,
      vix1dClose: null,
    });

    expect(mockSaveOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        settlement: 5730,
        vixClose: undefined,
        vix1dClose: undefined,
      }),
    );
  });

  it('returns 500 when saveOutcome throws unexpectedly', async () => {
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce(makeQuotesResponse());
    mockSaveOutcome.mockRejectedValueOnce(new Error('DB connection lost'));

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  // ── Backfill mode ─────────────────────────────────────────

  describe('backfill mode', () => {
    // Helper: daily candles spanning several days (timestamps at midnight UTC)
    function makeDailyCandles() {
      // Use dates that are clearly in the past relative to 2026-03-24
      return [
        {
          open: 5600,
          high: 5650,
          low: 5580,
          close: 5640,
          volume: 1000,
          datetime: new Date('2026-03-20T05:00:00.000Z').getTime(),
        },
        {
          open: 5640,
          high: 5700,
          low: 5630,
          close: 5690,
          volume: 1100,
          datetime: new Date('2026-03-21T05:00:00.000Z').getTime(),
        },
        {
          open: 5690,
          high: 5710,
          low: 5670,
          close: 5700,
          volume: 900,
          datetime: new Date('2026-03-22T05:00:00.000Z').getTime(),
        },
        {
          open: 5700,
          high: 5730,
          low: 5695,
          close: 5725,
          volume: 950,
          datetime: new Date('2026-03-23T05:00:00.000Z').getTime(),
        },
        // Today's candle should be excluded
        {
          open: 5725,
          high: 5750,
          low: 5720,
          close: 5740,
          volume: 800,
          datetime: new Date('2026-03-24T05:00:00.000Z').getTime(),
        },
      ];
    }

    function makeVixDailyCandles() {
      return [
        {
          open: 17,
          high: 19,
          low: 16,
          close: 18,
          volume: 500,
          datetime: new Date('2026-03-20T05:00:00.000Z').getTime(),
        },
        {
          open: 18,
          high: 20,
          low: 17,
          close: 19,
          volume: 600,
          datetime: new Date('2026-03-21T05:00:00.000Z').getTime(),
        },
        {
          open: 19,
          high: 21,
          low: 18,
          close: 20,
          volume: 550,
          datetime: new Date('2026-03-22T05:00:00.000Z').getTime(),
        },
        {
          open: 20,
          high: 22,
          low: 19,
          close: 21,
          volume: 570,
          datetime: new Date('2026-03-23T05:00:00.000Z').getTime(),
        },
      ];
    }

    // The CBOE VIX1D daily map that refresh-vix1d keeps in Redis, keyed by
    // trading day. 03-22 is left out to cover a day the map does not hold.
    const VIX1D_MAP = {
      '2026-03-20': { o: 14, h: 16, l: 13, c: 15.1 },
      '2026-03-21': { o: 15, h: 16, l: 14, c: 15.2 },
      '2026-03-23': { o: 15, h: 18, l: 14, c: 15.4 },
    };

    const ALL_DAYS = ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23'];

    beforeEach(() => {
      // resetAllMocks cleared every default: by default the map is there and
      // every day is new.
      mockRedisGet.mockResolvedValue(VIX1D_MAP);
      mockInsertOutcomeIfMissing.mockResolvedValue(true);
    });

    it('fetches daily candles and fills each completed day that has no row', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeDailyCandles(), symbol: '$SPX', empty: false },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeVixDailyCandles(), symbol: '$VIX', empty: false },
      });

      const req = mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      // Today (2026-03-24) should be excluded, so 4 days inserted
      expect(res._json).toEqual({
        backfill: true,
        status: 'success',
        saved: 4,
        present: 0,
        skipped: 0,
        insertedDates: ALL_DAYS,
        // The map holds no close for 03-22.
        vix1dMissingDates: ['2026-03-22'],
      });
      expect(mockInsertOutcomeIfMissing).toHaveBeenCalledTimes(4);

      // One of the days carries the daily bar, the VIX close joined by date
      // and the VIX1D close from the CBOE map.
      expect(mockInsertOutcomeIfMissing).toHaveBeenCalledWith({
        date: '2026-03-20',
        settlement: 5640,
        dayOpen: 5600,
        dayHigh: 5650,
        dayLow: 5580,
        vixClose: 18,
        vix1dClose: 15.1,
      });
    });

    it('never calls saveOutcome: its DO UPDATE would overwrite a stored day', async () => {
      mockDailyHistory();

      await handler(backfillReq(), mockResponse());

      expect(mockInsertOutcomeIfMissing).toHaveBeenCalled();
      expect(mockSaveOutcome).not.toHaveBeenCalled();
    });

    it('counts a day that already has a row as present, and the run is a success', async () => {
      mockDailyHistory();
      mockInsertOutcomeIfMissing.mockResolvedValue(false);

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        backfill: true,
        status: 'success',
        saved: 0,
        present: 4,
        skipped: 0,
        insertedDates: [],
        vix1dMissingDates: [],
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('takes vix1dClose from the CBOE map by date, and leaves it undefined for a day the map lacks', async () => {
      mockDailyHistory();

      await handler(backfillReq(), mockResponse());

      const byDate = Object.fromEntries(
        mockInsertOutcomeIfMissing.mock.calls.map(([input]) => [
          input.date,
          input.vix1dClose,
        ]),
      );
      expect(byDate).toEqual({
        '2026-03-20': 15.1,
        '2026-03-21': 15.2,
        '2026-03-22': undefined,
        '2026-03-23': 15.4,
      });
    });

    it('reads the VIX1D map once per run, from the key the refresh cron writes', async () => {
      mockDailyHistory();

      await handler(backfillReq(), mockResponse());

      expect(mockRedisGet).toHaveBeenCalledTimes(1);
      expect(mockRedisGet).toHaveBeenCalledWith('vix1d:daily-map');
    });

    it.each([
      ['is missing from Redis', null],
      ['is empty', {}],
    ])(
      'saves NULL vix1d and warns, without failing, when the VIX1D map %s',
      async (_label, map) => {
        mockDailyHistory();
        mockRedisGet.mockResolvedValue(map);

        const res = mockResponse();
        await handler(backfillReq(), res);

        expect(res._status).toBe(200);
        expect(res._json).toEqual({
          backfill: true,
          status: 'success',
          saved: 4,
          present: 0,
          skipped: 0,
          insertedDates: ALL_DAYS,
          vix1dMissingDates: ALL_DAYS,
        });
        for (const [input] of mockInsertOutcomeIfMissing.mock.calls) {
          expect(input.vix1dClose).toBeUndefined();
        }
        expect(logger.warn).toHaveBeenCalledWith(
          { key: 'vix1d:daily-map' },
          expect.stringContaining('VIX1D map missing'),
        );
        // ...and one more warn naming every day that was stored without one.
        expect(logger.warn).toHaveBeenCalledWith(
          { dates: ALL_DAYS },
          expect.stringContaining('no VIX1D close'),
        );
        expect(mockCaptureException).not.toHaveBeenCalled();
      },
    );

    it('saves NULL vix1d and warns with the cause, without failing, when the Redis read throws', async () => {
      mockDailyHistory();
      const redisDown = new Error('Redis: connect ETIMEDOUT');
      mockRedisGet.mockRejectedValue(redisDown);

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        backfill: true,
        status: 'success',
        saved: 4,
        present: 0,
        skipped: 0,
        insertedDates: ALL_DAYS,
        vix1dMissingDates: ALL_DAYS,
      });
      for (const [input] of mockInsertOutcomeIfMissing.mock.calls) {
        expect(input.vix1dClose).toBeUndefined();
      }
      expect(logger.warn).toHaveBeenCalledWith(
        { err: redisDown, key: 'vix1d:daily-map' },
        expect.stringContaining('VIX1D map read failed'),
      );
    });

    it('logs the inserted dates and leaves the days that were present out of them', async () => {
      mockDailyHistory();
      mockInsertOutcomeIfMissing
        .mockResolvedValueOnce(false) // 03-20 already stored
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await handler(backfillReq(), mockResponse());

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          insertedDates: ['2026-03-21', '2026-03-23'],
          saved: 2,
          present: 2,
          skipped: 0,
        }),
        'fetch-outcomes: backfill complete',
      );
    });

    // A day stored with a NULL vix1d_close can never be repaired by a re-run
    // (DO NOTHING), so the run names it: one warn, and the response lists it.
    function noCloseWarns() {
      const warn = logger.warn as ReturnType<typeof vi.fn>;
      return warn.mock.calls.filter(([, message]) =>
        String(message).includes('no VIX1D close'),
      );
    }

    it('lists an inserted day the map has no close for, with one warn naming it', async () => {
      mockDailyHistory(); // the default map holds no close for 03-22

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._json).toMatchObject({
        insertedDates: ALL_DAYS,
        vix1dMissingDates: ['2026-03-22'],
      });
      expect(noCloseWarns()).toEqual([
        [{ dates: ['2026-03-22'] }, expect.stringContaining('no VIX1D close')],
      ]);
      // The map itself is fine, so no whole-map warning.
      expect(logger.warn).not.toHaveBeenCalledWith(
        { key: 'vix1d:daily-map' },
        expect.anything(),
      );
    });

    it('keeps a present day and a failed day out of vix1dMissingDates, even when the map lacks them', async () => {
      mockDailyHistory();
      // The map lacks 03-20 (present below) and 03-22 (its insert fails).
      mockRedisGet.mockResolvedValue({
        '2026-03-21': { o: 15, h: 16, l: 14, c: 15.2 },
        '2026-03-23': { o: 15, h: 18, l: 14, c: 15.4 },
      });
      mockInsertOutcomeIfMissing
        .mockResolvedValueOnce(false) // 03-20 already stored
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(true);

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._json).toMatchObject({
        insertedDates: ['2026-03-21', '2026-03-23'],
        vix1dMissingDates: [],
      });
      expect(noCloseWarns()).toEqual([]);
    });

    it('lists no missing dates and does not warn when every inserted day has a close', async () => {
      mockDailyHistory();
      mockRedisGet.mockResolvedValue({
        ...VIX1D_MAP,
        '2026-03-22': { o: 15, h: 17, l: 14, c: 15.3 },
      });

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._json).toMatchObject({
        insertedDates: ALL_DAYS,
        vix1dMissingDates: [],
      });
      expect(noCloseWarns()).toEqual([]);
    });

    it('adds up a mixed run: inserted, already present and failed days', async () => {
      mockDailyHistory();
      mockInsertOutcomeIfMissing
        .mockResolvedValueOnce(true) // 03-20 inserted
        .mockResolvedValueOnce(false) // 03-21 already stored
        .mockRejectedValueOnce(new Error('connection lost')) // 03-22 fails
        .mockResolvedValueOnce(true); // 03-23 inserted

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        backfill: true,
        status: 'partial',
        saved: 2,
        present: 1,
        skipped: 1,
        // Neither the present day (03-21) nor the failed one (03-22) is listed.
        insertedDates: ['2026-03-20', '2026-03-23'],
        vix1dMissingDates: [],
      });
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'connection lost' }),
        {
          tags: { 'cron.job': 'fetch-outcomes', mode: 'backfill' },
          extra: {
            saved: 2,
            skipped: 1,
            total: 4,
            failedDates: ['2026-03-22'],
          },
        },
      );
    });

    it('returns 502 when SPX fetch fails in backfill', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: false,
        error: 'SPX history unavailable',
        status: 502,
      });

      const req = mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(502);
      expect(res._json).toEqual({ error: 'SPX history unavailable' });
    });

    it('skips days where the insert throws and counts them in skipped', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeDailyCandles(), symbol: '$SPX', empty: false },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeVixDailyCandles(), symbol: '$VIX', empty: false },
      });

      // First two inserts succeed, third and fourth fail
      mockInsertOutcomeIfMissing
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('duplicate key'))
        .mockRejectedValueOnce(new Error('duplicate key'));

      const req = mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        backfill: true,
        status: 'partial',
        saved: 2,
        present: 0,
        skipped: 2,
        insertedDates: ['2026-03-20', '2026-03-21'],
        vix1dMissingDates: [],
      });
      // One Sentry event per run (not per day), naming the failed days.
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'duplicate key' }),
        {
          tags: { 'cron.job': 'fetch-outcomes', mode: 'backfill' },
          extra: {
            saved: 2,
            skipped: 2,
            total: 4,
            failedDates: ['2026-03-22', '2026-03-23'],
          },
        },
      );
    });

    function backfillReq() {
      return mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      });
    }

    function mockDailyHistory() {
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeDailyCandles(), symbol: '$SPX', empty: false },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: makeVixDailyCandles(), symbol: '$VIX', empty: false },
      });
    }

    it('reports status success and sends nothing to Sentry when every day saves', async () => {
      mockDailyHistory();

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        backfill: true,
        status: 'success',
        saved: 4,
        present: 0,
        skipped: 0,
        insertedDates: ALL_DAYS,
        vix1dMissingDates: ['2026-03-22'],
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('every insert fails → 500, status error, one Sentry event with the first error', async () => {
      mockDailyHistory();
      const neonDown = new Error('Neon: connection terminated');
      mockInsertOutcomeIfMissing.mockRejectedValue(neonDown);

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({
        backfill: true,
        status: 'error',
        saved: 0,
        present: 0,
        skipped: 4,
        insertedDates: [],
        vix1dMissingDates: [],
      });
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(neonDown, {
        tags: { 'cron.job': 'fetch-outcomes', mode: 'backfill' },
        extra: {
          saved: 0,
          skipped: 4,
          total: 4,
          failedDates: ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23'],
        },
      });
    });

    it('no completed daily candles → 500 and a Sentry event, not a quiet success', async () => {
      // Two months of daily history always holds completed sessions, so an
      // empty set (here: only today's candle) means Schwab returned nothing
      // usable.
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: {
          candles: [makeDailyCandles().at(-1)],
          symbol: '$SPX',
          empty: false,
        },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        ok: true,
        data: { candles: [], symbol: '$VIX', empty: true },
      });

      const res = mockResponse();
      await handler(backfillReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal error' });
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'fetch-outcomes backfill: Schwab returned no completed daily SPX candles',
        }),
      );
      expect(mockInsertOutcomeIfMissing).not.toHaveBeenCalled();
      expect(mockSaveOutcome).not.toHaveBeenCalled();
    });
  });
});
