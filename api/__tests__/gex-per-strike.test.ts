// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../gex-per-strike.js';
import { rejectIfNotOwnerOrGuest, checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeDbRow(overrides = {}) {
  return {
    strike: '5800.00',
    price: '5795.00',
    call_gamma_oi: '500000000000',
    put_gamma_oi: '-300000000000',
    call_gamma_vol: '100000000000',
    put_gamma_vol: '-50000000000',
    call_gamma_ask: '-100000000',
    call_gamma_bid: '200000000',
    put_gamma_ask: '50000000',
    put_gamma_bid: '-150000000',
    call_charm_oi: '1000000000',
    put_charm_oi: '-800000000',
    call_charm_vol: '500000000',
    put_charm_vol: '-400000000',
    call_delta_oi: '5000000000',
    put_delta_oi: '-3000000000',
    call_vanna_oi: '100000000',
    put_vanna_oi: '-60000000',
    call_vanna_vol: '50000000',
    put_vanna_vol: '-30000000',
    timestamp: '2026-04-02T15:00:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gex-per-strike', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when bot detected', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('uses date query param when provided', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-28T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-03-28T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-28' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toBe('2026-03-28');
  });

  it('uses time param to filter snapshot timestamp', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-03-28T15:30:00Z' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-03-28T15:30:00Z' }]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-28', time: '10:30' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // 3 queries: time-filter lookup + timestamps list + strike fetch
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid date format', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    // Falls back to today ET
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty strikes when no data for date', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      timestamp: unknown;
      timestamps: unknown[];
    };
    expect(body.strikes).toEqual([]);
    expect(body.timestamp).toBeNull();
    expect(body.timestamps).toEqual([]);
  });

  it('returns strikes with computed netGamma and netCharm', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<Record<string, unknown>>;
      timestamp: string;
    };
    expect(body.strikes).toHaveLength(1);
    // toIso normalizes via Date.toISOString — appends milliseconds
    expect(body.timestamp).toBe('2026-04-02T15:00:00.000Z');

    const strike = body.strikes[0]!;
    expect(strike.strike).toBe(5800);
    expect(strike.price).toBe(5795);
    expect(strike.callGammaOi).toBe(500_000_000_000);
    expect(strike.putGammaOi).toBe(-300_000_000_000);
    // netGamma = callGammaOi + putGammaOi
    expect(strike.netGamma).toBe(200_000_000_000);
    // netCharm = callCharmOi + putCharmOi
    expect(strike.netCharm).toBe(200_000_000);
    // Vol fields
    expect(strike.callGammaVol).toBe(100_000_000_000);
    expect(strike.netGammaVol).toBe(50_000_000_000);
    // Vol reinforcement: OI net=+200B, vol net=+50B → same sign → reinforcing
    expect(strike.volReinforcement).toBe('reinforcing');
    // DEX
    expect(strike.netDelta).toBe(2_000_000_000);
    // Vanna
    expect(strike.netVanna).toBe(40_000_000);
    // Charm vol: call_charm_vol + put_charm_vol = 500M + (-400M) = 100M
    expect(strike.netCharmVol).toBe(100_000_000);
    // Vanna vol: call_vanna_vol + put_vanna_vol = 50M + (-30M) = 20M
    expect(strike.netVannaVol).toBe(20_000_000);
  });

  it('converts string DB values to numbers', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const strike = (res._json as { strikes: Array<Record<string, unknown>> })
      .strikes[0]!;
    expect(typeof strike.strike).toBe('number');
    expect(typeof strike.price).toBe('number');
    expect(typeof strike.callGammaOi).toBe('number');
    expect(typeof strike.putGammaOi).toBe('number');
    expect(typeof strike.netGamma).toBe('number');
    expect(typeof strike.callCharmOi).toBe('number');
    expect(typeof strike.netCharm).toBe('number');
    expect(typeof strike.netDelta).toBe('number');
    expect(typeof strike.netVanna).toBe('number');
    expect(typeof strike.netGammaVol).toBe('number');
    expect(typeof strike.volReinforcement).toBe('string');
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cb: (scope: {
          setTransactionName: typeof setTransactionName;
        }) => unknown,
      ) => cb({ setTransactionName }),
    );
    mockSql.mockResolvedValueOnce([{ latest_ts: null }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith('GET /api/gex-per-strike');
  });

  it('returns timestamps array for scrub navigation', async () => {
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T20:00:00Z' }]);
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-02T19:58:00Z' },
      { timestamp: '2026-04-02T19:59:00Z' },
      { timestamp: '2026-04-02T20:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { timestamps: string[]; timestamp: string };
    // Timestamps are normalized to canonical Date.toISOString form
    expect(body.timestamps).toEqual([
      '2026-04-02T19:58:00.000Z',
      '2026-04-02T19:59:00.000Z',
      '2026-04-02T20:00:00.000Z',
    ]);
    expect(body.timestamp).toBe('2026-04-02T20:00:00.000Z');
  });

  it('honors ?ts param for exact-snapshot lookup', async () => {
    // First query: ts equality lookup
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T19:30:00Z' }]);
    // Second query: timestamps list
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-02T19:30:00Z' },
      { timestamp: '2026-04-02T20:00:00Z' },
    ]);
    // Third query: strikes
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-02', ts: '2026-04-02T19:30:00Z' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { timestamp: string };
    expect(body.timestamp).toBe('2026-04-02T19:30:00.000Z');
    // 3 queries total: ts lookup + timestamps + strikes
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('falls back to latest when ?ts param does not match a snapshot', async () => {
    // ts lookup returns no rows
    mockSql.mockResolvedValueOnce([]);
    // Fallback latest query
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T20:00:00Z' }]);
    // Timestamps list
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T20:00:00Z' }]);
    // Strikes
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-02', ts: '2026-04-02T05:00:00Z' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { timestamp: string };
    expect(body.timestamp).toBe('2026-04-02T20:00:00.000Z');
  });

  it('rejects malformed ?ts and falls through to latest', async () => {
    // hasTs is false, hasTime is false → straight to latest
    mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T20:00:00Z' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T20:00:00Z' }]);
    mockSql.mockResolvedValueOnce([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-02', ts: 'not-an-iso-timestamp' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Only the latest+timestamps+strikes queries — no ts equality query
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('normalizes Date objects from the driver to ISO 8601 strings', async () => {
    // Neon's serverless driver returns TIMESTAMPTZ columns as Date objects.
    // The frontend's scrub controls compare `timestamp` against `timestamps[]`
    // via indexOf, so both fields must serialize to the same canonical form.
    const d1 = new Date('2026-04-02T19:58:00Z');
    const d2 = new Date('2026-04-02T19:59:00Z');
    const d3 = new Date('2026-04-02T20:00:00Z');
    mockSql.mockResolvedValueOnce([{ latest_ts: d3 }]);
    mockSql.mockResolvedValueOnce([
      { timestamp: d1 },
      { timestamp: d2 },
      { timestamp: d3 },
    ]);
    mockSql.mockResolvedValueOnce([makeDbRow({ timestamp: d3 })]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { timestamp: string; timestamps: string[] };
    expect(body.timestamp).toBe('2026-04-02T20:00:00.000Z');
    expect(body.timestamps).toEqual([
      '2026-04-02T19:58:00.000Z',
      '2026-04-02T19:59:00.000Z',
      '2026-04-02T20:00:00.000Z',
    ]);
    // Critical assertion: the displayed `timestamp` is findable in the
    // `timestamps[]` list. Without normalization the formats diverged
    // (Date.toString() vs JSON Date) and indexOf returned -1, silently
    // disabling the scrub buttons.
    expect(body.timestamps.indexOf(body.timestamp)).toBeGreaterThanOrEqual(0);
  });

  // ── ?window=Nm param (backtest 5m Δ% support) ────────────────────

  describe('?window=<N>m window snapshots', () => {
    it('returns windowSnapshots when window=5m is passed', async () => {
      // Primary snapshot resolution
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
      // Timestamps list
      mockSql.mockResolvedValueOnce([
        { timestamp: '2026-04-02T14:58:00Z' },
        { timestamp: '2026-04-02T14:59:00Z' },
        { timestamp: '2026-04-02T15:00:00Z' },
      ]);
      // Primary strikes fetch
      mockSql.mockResolvedValueOnce([
        makeDbRow({ timestamp: '2026-04-02T15:00:00Z' }),
      ]);
      // Window fetch — 2 prior snapshots in the window
      mockSql.mockResolvedValueOnce([
        makeDbRow({
          strike: '5800',
          timestamp: '2026-04-02T14:58:00Z',
        }),
        makeDbRow({
          strike: '5810',
          timestamp: '2026-04-02T14:58:00Z',
        }),
        makeDbRow({
          strike: '5800',
          timestamp: '2026-04-02T14:59:00Z',
        }),
      ]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-04-02',
            ts: '2026-04-02T15:00:00Z',
            window: '5m',
          },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        windowSnapshots: Array<{ timestamp: string; strikes: unknown[] }>;
      };
      expect(body.windowSnapshots).toHaveLength(2);
      expect(body.windowSnapshots[0]!.timestamp).toBe(
        '2026-04-02T14:58:00.000Z',
      );
      expect(body.windowSnapshots[0]!.strikes).toHaveLength(2);
      expect(body.windowSnapshots[1]!.timestamp).toBe(
        '2026-04-02T14:59:00.000Z',
      );
      expect(body.windowSnapshots[1]!.strikes).toHaveLength(1);
    });

    it('returns empty windowSnapshots when no prior snapshots fall in the window', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({ timestamp: '2026-04-02T15:00:00Z' }),
      ]);
      // Empty window fetch
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-04-02',
            ts: '2026-04-02T15:00:00Z',
            window: '5m',
          },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        windowSnapshots: Array<{ timestamp: string; strikes: unknown[] }>;
      };
      expect(body.windowSnapshots).toEqual([]);
    });

    it('does NOT fetch windowSnapshots when window param is absent', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({ timestamp: '2026-04-02T15:00:00Z' }),
      ]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-04-02', ts: '2026-04-02T15:00:00Z' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        windowSnapshots: Array<{ timestamp: string; strikes: unknown[] }>;
      };
      expect(body.windowSnapshots).toEqual([]);
      // Only 3 SQL calls — no window query.
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it('rejects malformed window values silently (returns empty)', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({ timestamp: '2026-04-02T15:00:00Z' }),
      ]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-04-02',
            ts: '2026-04-02T15:00:00Z',
            window: 'abc',
          },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        windowSnapshots: Array<{ timestamp: string; strikes: unknown[] }>;
      };
      expect(body.windowSnapshots).toEqual([]);
      // Only 3 SQL calls — the malformed param is treated as absent.
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it('clamps very large window values to the max bound (15m)', async () => {
      mockSql.mockResolvedValueOnce([{ latest_ts: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-02T15:00:00Z' }]);
      mockSql.mockResolvedValueOnce([
        makeDbRow({ timestamp: '2026-04-02T15:00:00Z' }),
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-04-02',
            ts: '2026-04-02T15:00:00Z',
            window: '999m',
          },
        }),
        res,
      );

      expect(res._status).toBe(200);
      // Still fires the window fetch (clamped, not rejected).
      expect(mockSql).toHaveBeenCalledTimes(4);
    });
  });
});
