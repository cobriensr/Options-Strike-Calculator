// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard, mockSetCacheHeaders } = vi.hoisted(() => ({
  mockGuard: vi.fn(),
  mockSetCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCacheHeaders,
}));

import handler from '../greek-heatmap.js';
import { buildIntradayRange } from '../_lib/db-greek-heatmap.js';

function gexRow(
  strike: number,
  callGammaOi: number,
  putGammaOi: number,
  callCharmOi: number,
  putCharmOi: number,
  callVannaOi: number,
  putVannaOi: number,
  price: string,
  tsIso: string,
) {
  return {
    strike: String(strike),
    ts_minute: new Date(tsIso),
    price,
    call_gamma_oi: String(callGammaOi),
    put_gamma_oi: String(putGammaOi),
    call_charm_oi: String(callCharmOi),
    put_charm_oi: String(putCharmOi),
    call_vanna_oi: String(callVannaOi),
    put_vanna_oi: String(putVannaOi),
  };
}

describe('greek-heatmap endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false); // proceed past auth gate
    mockSql.mockResolvedValue([]);
  });

  it('returns top 5 strikes + ATM + regime + net flow for a valid ticker', async () => {
    // 6 strikes feed in; top-5 by |call_gamma + put_gamma| should drop
    // strike 490 (|25k - 10k| = 15k is the smallest abs net). Underlying
    // is 462.50 so among the top-5 (440/450/460/470/480) the ATM is 460.
    mockSql
      .mockResolvedValueOnce([
        gexRow(
          440,
          100_000,
          -50_000,
          1000,
          -500,
          200,
          -100,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          450,
          200_000,
          -100_000,
          2000,
          -1000,
          400,
          -200,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          460,
          50_000,
          -25_000,
          500,
          -250,
          100,
          -50,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          470,
          500_000,
          -300_000,
          5000,
          -3000,
          800,
          -400,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          480,
          150_000,
          -75_000,
          1500,
          -750,
          300,
          -150,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          490,
          25_000,
          -10_000,
          250,
          -100,
          50,
          -25,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
      ])
      .mockResolvedValueOnce([
        {
          ts: new Date('2026-05-15T16:30:00Z'),
          cum_call_prem: '1716.00',
          cum_call_vol: '6',
          cum_put_prem: '1990.00',
          cum_put_vol: '17',
        },
      ]);

    const req = mockRequest({ method: 'GET', query: { ticker: 'TSLA' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      topStrikes: { strike: number; netGamma: number }[];
      atmStrike: number;
      underlyingPrice: number;
      regime: string;
      netGexK: number;
      netFlow: { cumulativeCallPrem: number; cumulativePutVol: number };
    };
    expect(body.ticker).toBe('TSLA');
    expect(body.topStrikes).toHaveLength(5);
    expect(body.topStrikes.map((s) => s.strike).sort()).toEqual([
      440, 450, 460, 470, 480,
    ]);
    expect(body.topStrikes.map((s) => s.strike)).not.toContain(490);
    // Highest |netGamma| should sort first (470: 500k - 300k = 200k abs).
    expect(body.topStrikes[0]!.strike).toBe(470);
    expect(body.atmStrike).toBe(460);
    expect(body.underlyingPrice).toBe(462.5);
    // Sum of all net gammas is positive across the chain — Long Γ regime.
    expect(body.regime).toBe('Long Γ');
    expect(body.netGexK).toBeGreaterThan(0);
    expect(body.netFlow.cumulativeCallPrem).toBe(1716);
    expect(body.netFlow.cumulativePutVol).toBe(17);
  });

  it('returns empty snapshot for weekends / holidays with no 0DTE rows', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { ticker: 'SPY' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      topStrikes: unknown[];
      atmStrike: null;
      regime: null;
      netFlow: null;
    };
    expect(body.topStrikes).toEqual([]);
    expect(body.atmStrike).toBeNull();
    expect(body.regime).toBeNull();
    expect(body.netFlow).toBeNull();
  });

  it('classifies Short Γ when total net gamma is negative', async () => {
    mockSql
      .mockResolvedValueOnce([
        // Calls smaller than puts across the chain → net negative.
        gexRow(
          440,
          10_000,
          -100_000,
          100,
          -1000,
          20,
          -200,
          '450.00',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          450,
          20_000,
          -200_000,
          200,
          -2000,
          40,
          -400,
          '450.00',
          '2026-05-15T16:00:00Z',
        ),
      ])
      .mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { ticker: 'TSLA' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { regime: string; netGexK: number };
    expect(body.regime).toBe('Short Γ');
    expect(body.netGexK).toBeLessThan(0);
  });

  it('rejects ticker outside the alerts universe with 400', async () => {
    const req = mockRequest({ method: 'GET', query: { ticker: 'ZZZZ' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = res._json as { error: string; issues: { message: string }[] };
    expect(body.error).toBe('invalid query');
    expect(body.issues[0]!.message).toMatch(/alerts universe/i);
  });

  it('rejects missing ticker with 400', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects lowercase / malformed ticker with 400', async () => {
    const req = mockRequest({ method: 'GET', query: { ticker: 'tsla' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('short-circuits when the auth guard denies', async () => {
    mockGuard.mockResolvedValueOnce(true); // guard already responded
    const req = mockRequest({ method: 'GET', query: { ticker: 'SPY' } });
    const res = mockResponse();
    await handler(req, res);

    // Handler returned before any DB or response work.
    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toBeNull();
  });

  it('rejects historical date beyond the 90-day window with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', date: '2024-01-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    const body = res._json as { issues: { message: string }[] };
    expect(body.issues.some((i) => /90 days/i.test(i.message))).toBe(true);
  });

  it('rejects malformed date with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects malformed `at` (non-ISO) with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', at: 'not-an-iso' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    const body = res._json as { issues: { message: string }[] };
    expect(body.issues.some((i) => /ISO 8601 UTC/i.test(i.message))).toBe(true);
  });

  it('forwards `at` and emits `intradayRange` in the response', async () => {
    // Three SQL calls in Promise.all interleave order: snapshot query,
    // net-flow query, intradayRange probe.
    mockSql
      .mockResolvedValueOnce([
        gexRow(
          560,
          100_000,
          1000,
          200,
          0,
          0,
          0,
          '562.50',
          '2026-05-15T16:00:00Z',
        ),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          first: '2026-05-15 13:30:00+00',
          last: '2026-05-15 20:00:00+00',
          distinct_count: 391,
        },
      ]);

    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', at: '2026-05-15T15:00:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      at: string | null;
      intradayRange: { min: string; max: string; count: number } | null;
    };
    expect(body.at).toBe('2026-05-15T15:00:00.000Z');
    expect(body.intradayRange).not.toBeNull();
    expect(body.intradayRange!.count).toBe(391);
    expect(body.intradayRange!.min).toMatch(/^2026-05-15T13:30:00/);
  });

  it('cache headers: 30s/60s for live tip', async () => {
    mockSql.mockResolvedValue([]);
    const req = mockRequest({ method: 'GET', query: { ticker: 'SPY' } });
    const res = mockResponse();
    await handler(req, res);
    // Live tip = today's date + no `at` set → short TTL.
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 30, 60);
  });

  it('cache headers: 3600s/60s when scrubbed via `at`', async () => {
    mockSql.mockResolvedValue([]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', at: '2026-05-15T15:00:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);
    // Scrubbed = pinned to a past minute → long TTL.
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 3600, 60);
  });

  it('returns chainStrikes window centered on the ATM strike', async () => {
    mockSql
      .mockResolvedValueOnce([
        // 6 strikes; spot is 462.50 so ATM = 460 (the closest).
        gexRow(
          440,
          100_000,
          1000,
          200,
          0,
          0,
          0,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          450,
          200_000,
          2000,
          400,
          0,
          0,
          0,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          460,
          50_000,
          500,
          100,
          0,
          0,
          0,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          470,
          500_000,
          5000,
          800,
          0,
          0,
          0,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(
          480,
          150_000,
          1500,
          300,
          0,
          0,
          0,
          '462.50',
          '2026-05-15T16:00:00Z',
        ),
        gexRow(490, 25_000, 250, 50, 0, 0, 0, '462.50', '2026-05-15T16:00:00Z'),
      ])
      .mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { ticker: 'TSLA' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      chainStrikes: { strike: number }[];
      topStrikes: { strike: number }[];
      atmStrike: number;
    };
    // All 6 fit within the ATM ± 50 window, so chainStrikes returns
    // every strike (sorted DESC by strike for grid display).
    expect(body.chainStrikes.map((s) => s.strike)).toEqual([
      490, 480, 470, 460, 450, 440,
    ]);
    // topStrikes still independently sorts by |netGamma| DESC, top-5.
    expect(body.topStrikes).toHaveLength(5);
    expect(body.atmStrike).toBe(460);
  });
});

describe('buildIntradayRange', () => {
  it('returns null when the aggregate row has null first/last (zero source rows)', () => {
    expect(buildIntradayRange(undefined)).toBeNull();
    expect(
      buildIntradayRange({ first: null, last: null, distinct_count: 0 }),
    ).toBeNull();
    expect(
      buildIntradayRange({
        first: '2026-05-15 13:30:00+00',
        last: null,
        distinct_count: 1,
      }),
    ).toBeNull();
  });

  it('normalizes Postgres ::text output through new Date().toISOString()', () => {
    const out = buildIntradayRange({
      first: '2026-05-15 13:30:00+00',
      last: '2026-05-15 20:00:00+00',
      distinct_count: 391,
    });
    expect(out).not.toBeNull();
    expect(out!.min).toMatch(/^2026-05-15T13:30:00/);
    expect(out!.max).toMatch(/^2026-05-15T20:00:00/);
    expect(out!.count).toBe(391);
  });
});
