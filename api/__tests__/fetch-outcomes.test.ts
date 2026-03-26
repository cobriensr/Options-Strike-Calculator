// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Use vi.hoisted so mocks are available when vi.mock factories run (hoisted above imports)
const mockSaveOutcome = vi.hoisted(() => vi.fn());

vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  saveOutcome: mockSaveOutcome,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../cron/fetch-outcomes.js';
import { schwabFetch } from '../_lib/api-helpers.js';

const mockedSchwabFetch = schwabFetch as ReturnType<typeof vi.fn>;

// Fixed times for deterministic tests
// Tuesday 2026-03-24 at 5:00 PM ET = 21:00 UTC (inside post-close window)
const CLOSE_WINDOW_TIME = new Date('2026-03-24T21:00:00.000Z');
// Tuesday 2026-03-24 at 10:00 AM ET = 14:00 UTC (outside post-close window)
const OUTSIDE_WINDOW_TIME = new Date('2026-03-24T14:00:00.000Z');
// Saturday 2026-03-28 at 5:00 PM ET
const WEEKEND_TIME = new Date('2026-03-28T21:00:00.000Z');

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
  return { data: { candles, symbol: '$SPX', empty: false } };
}

function makeQuotesResponse(vix = 18, vix1d = 15) {
  return {
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
    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside post-close window (4:15-5:30 PM ET)',
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
    mockedSchwabFetch.mockResolvedValueOnce({ error: 'Schwab API down' });

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
    expect(res._json).toEqual({ skipped: true, reason: 'No candles' });
    expect(mockSaveOutcome).not.toHaveBeenCalled();
  });

  it('still saves SPX data when VIX quotes fail (warns but does not error)', async () => {
    mockedSchwabFetch.mockResolvedValueOnce(makeIntradayResponse());
    mockedSchwabFetch.mockResolvedValueOnce({ error: 'VIX unavailable' });
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
    expect(res._json).toEqual({ error: 'Internal error' });
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

    it('fetches daily candles and saves each completed day', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        data: { candles: makeDailyCandles(), symbol: '$SPX', empty: false },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        data: { candles: makeVixDailyCandles(), symbol: '$VIX', empty: false },
      });
      mockSaveOutcome.mockResolvedValue(undefined);

      const req = mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      // Today (2026-03-24) should be excluded, so 4 days saved
      expect(res._json).toMatchObject({ backfill: true, saved: 4, skipped: 0 });
      expect(mockSaveOutcome).toHaveBeenCalledTimes(4);

      // Verify one of the saved outcomes has VIX data joined by date
      expect(mockSaveOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-03-20',
          settlement: 5640,
          dayOpen: 5600,
          dayHigh: 5650,
          dayLow: 5580,
          vixClose: 18,
          vix1dClose: undefined,
        }),
      );
    });

    it('returns 502 when SPX fetch fails in backfill', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        error: 'SPX history unavailable',
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

    it('skips days where saveOutcome throws and counts them in skipped', async () => {
      mockedSchwabFetch.mockResolvedValueOnce({
        data: { candles: makeDailyCandles(), symbol: '$SPX', empty: false },
      });
      mockedSchwabFetch.mockResolvedValueOnce({
        data: { candles: makeVixDailyCandles(), symbol: '$VIX', empty: false },
      });

      // First two saves succeed, third and fourth fail
      mockSaveOutcome
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
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
      expect(res._json).toMatchObject({ backfill: true, saved: 2, skipped: 2 });
    });
  });
});
