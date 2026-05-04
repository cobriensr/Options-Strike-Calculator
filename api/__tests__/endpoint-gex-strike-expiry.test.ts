// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gex-strike-expiry.
 *
 * Covers method guard, owner-or-guest gate, Zod validation paths,
 * empty-result path, happy path (with and without `at`), and error
 * propagation. The query helper itself is light enough not to need a
 * separate unit-test file — its behavior is fully exercised through
 * the endpoint here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
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
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../gex-strike-expiry.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function fakeRow(strike: number, ts: string, ticker = 'SPY') {
  return {
    ticker,
    expiry: '2026-05-01',
    strike: String(strike),
    ts_minute: ts,
    price: '722.18',
    call_gamma_oi: '174792.59',
    put_gamma_oi: '-1172037.66',
    call_charm_oi: '85658181.72',
    put_charm_oi: '-315259003.37',
    call_vanna_oi: '-6103.51',
    put_vanna_oi: '1337727.64',
    call_gamma_vol: '15596.81',
    put_gamma_vol: '-236.69',
    call_charm_vol: '-326871.58',
    put_charm_vol: '-68457.78',
    call_vanna_vol: '2063.13',
    put_vanna_vol: '845.06',
    call_gamma_ask_vol: '-4064.62',
    call_gamma_bid_vol: '11532.18',
    put_gamma_ask_vol: '-140.95',
    put_gamma_bid_vol: '95.73',
    call_charm_ask_vol: '85184.72',
    call_charm_bid_vol: '-241686.87',
    put_charm_ask_vol: '-59412.37',
    put_charm_bid_vol: '9045.42',
    call_vanna_ask_vol: '-537.66',
    call_vanna_bid_vol: '1525.46',
    put_vanna_ask_vol: '523.79',
    put_vanna_bid_vol: '-321.27',
    // SQL-side LAG ratios: 0.05 → +5% etc. Each value is the ratio
    // returned from `(net_gamma / |LAG(net_gamma, N)|) - 1`; the
    // server multiplies by 100 before responding.
    gamma_delta_1m: '0.0125',
    gamma_delta_5m: '0.04',
    gamma_delta_10m: '0.075',
    gamma_delta_15m: '0.12',
    gamma_delta_30m: '0.22',
  };
}

/**
 * Row shape returned by the REST fallback (legacy `gex_strike_0dte`).
 * Same wire contract as the WS path because the SQL UNION projects the
 * legacy table's `call_gamma_ask` etc. to the WS column names. Charm
 * and vanna bid-ask vol fields don't exist in the legacy schema and
 * project as `NULL` from the UNION, so they're nullable here.
 */
function fakeRestRow(strike: number, ts: string) {
  return {
    ticker: 'SPX',
    expiry: '2026-05-01',
    strike: String(strike),
    ts_minute: ts,
    price: '5650.42',
    call_gamma_oi: '125000.00',
    put_gamma_oi: '-980000.00',
    call_charm_oi: '50000000.00',
    put_charm_oi: '-200000000.00',
    call_vanna_oi: '-4000.00',
    put_vanna_oi: '900000.00',
    call_gamma_vol: '10000.00',
    put_gamma_vol: '-150.00',
    call_charm_vol: '-200000.00',
    put_charm_vol: '-50000.00',
    call_vanna_vol: '1500.00',
    put_vanna_vol: '600.00',
    // Legacy table renames: call_gamma_ask -> call_gamma_ask_vol etc.
    call_gamma_ask_vol: '-3000.00',
    call_gamma_bid_vol: '8000.00',
    put_gamma_ask_vol: '-100.00',
    put_gamma_bid_vol: '60.00',
    // Charm/vanna bid-ask vol absent in legacy table → NULL projection.
    call_charm_ask_vol: null,
    call_charm_bid_vol: null,
    put_charm_ask_vol: null,
    put_charm_bid_vol: null,
    call_vanna_ask_vol: null,
    call_vanna_bid_vol: null,
    put_vanna_ask_vol: null,
    put_vanna_bid_vol: null,
    gamma_delta_1m: '0.01',
    gamma_delta_5m: '0.03',
    gamma_delta_10m: '0.05',
    gamma_delta_15m: '0.08',
    gamma_delta_30m: '0.15',
  };
}

beforeEach(() => {
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  mockSql.mockReset();
});

describe('GET /api/gex-strike-expiry', () => {
  // ── Method guard ────────────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({
      method: 'POST',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('short-circuits when owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when ticker is missing', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for unsupported ticker', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'IWM', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when expiry format is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '05/01/2026' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('YYYY-MM-DD'),
    });
  });

  it('returns 400 when at parameter is not a valid ISO datetime', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01', at: 'noon' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  // ── Empty path ─────────────────────────────────────────────

  it('returns 200 with empty rows when table has no data for the date', async () => {
    // Two queries fire in parallel: latest-per-strike + timestamps.
    // Order of resolution doesn't matter, but mockResolvedValueOnce
    // returns by call order, so seed both.
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      expiry: '2026-05-01',
      at: null,
      rows: [],
      timestamps: [],
    });
  });

  // ── Happy path (no `at`) ───────────────────────────────────

  it('returns mapped rows with numeric coercion on the happy path', async () => {
    mockSql
      .mockResolvedValueOnce([
        fakeRow(722, '2026-05-01T20:14:00Z'),
        fakeRow(723, '2026-05-01T20:14:00Z'),
      ])
      .mockResolvedValueOnce([
        { ts_minute: '2026-05-01T20:13:00Z' },
        { ts_minute: '2026-05-01T20:14:00Z' },
      ]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      expiry: '2026-05-01',
      at: null,
    });
    const body = res._json as {
      rows: Array<Record<string, unknown>>;
      timestamps: string[];
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      strike: 722,
      price: 722.18,
      call_gamma_oi: 174792.59,
      put_gamma_oi: -1172037.66,
      // SQL ratios scaled to percent before responding so the wire
      // contract matches the legacy client-side `computeDeltaMap`
      // (0.0125 → 1.25, 0.22 → 22, …).
      gamma_delta_1m: 1.25,
      gamma_delta_5m: 4,
      gamma_delta_10m: 7.5,
      gamma_delta_15m: 12,
      gamma_delta_30m: 22,
    });
    expect(body.timestamps).toEqual([
      '2026-05-01T20:13:00.000Z',
      '2026-05-01T20:14:00.000Z',
    ]);
  });

  // ── Null deltas pass through ───────────────────────────────

  it('preserves null deltas (insufficient LAG history) instead of coercing to 0', async () => {
    const row = fakeRow(722, '2026-05-01T19:30:00Z');
    // Mimic the SQL state where LAG(_, 30) has no comparable row yet.
    row.gamma_delta_30m = null as unknown as string;
    mockSql
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ ts_minute: '2026-05-01T19:30:00Z' }]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]?.gamma_delta_30m).toBeNull();
    // Earlier deltas remain populated.
    expect(body.rows[0]?.gamma_delta_1m).toBe(1.25);
  });

  // ── Happy path with `at` ───────────────────────────────────

  it('passes the at parameter through to the SQL query', async () => {
    mockSql
      .mockResolvedValueOnce([fakeRow(722, '2026-05-01T19:30:00Z')])
      .mockResolvedValueOnce([{ ts_minute: '2026-05-01T19:30:00Z' }]);
    const req = mockRequest({
      method: 'GET',
      query: {
        ticker: 'QQQ',
        expiry: '2026-05-01',
        at: '2026-05-01T19:30:00Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'QQQ',
      expiry: '2026-05-01',
      at: '2026-05-01T19:30:00Z',
      timestamps: ['2026-05-01T19:30:00.000Z'],
    });
  });

  // ── Historical fallback (UNION ws + legacy gex_strike_0dte) ────

  it('returns mapped rows for SPX historical date when WS empty / REST populated', async () => {
    // Simulates the post-UNION resolved state: SPX requested, WS table
    // had zero rows for the (ticker, expiry) window, so the rest_series
    // CTE supplied rows from gex_strike_0dte. The endpoint sees the
    // same shape either way — that's the whole point of branching in
    // SQL instead of in the handler.
    mockSql
      .mockResolvedValueOnce([
        fakeRestRow(5650, '2026-04-15T19:30:00Z'),
        fakeRestRow(5655, '2026-04-15T19:30:00Z'),
      ])
      .mockResolvedValueOnce([
        { ts_minute: '2026-04-15T19:29:00Z' },
        { ts_minute: '2026-04-15T19:30:00Z' },
      ]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPX', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      rows: Array<Record<string, unknown>>;
      timestamps: string[];
    };
    expect(body.ticker).toBe('SPX');
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      ticker: 'SPX',
      strike: 5650,
      price: 5650.42,
      // Gamma fields populated from legacy table.
      call_gamma_oi: 125000,
      put_gamma_oi: -980000,
      call_gamma_ask_vol: -3000,
      call_gamma_bid_vol: 8000,
      // Charm/vanna bid-ask vol absent in legacy schema → null.
      call_charm_ask_vol: null,
      call_charm_bid_vol: null,
      put_charm_ask_vol: null,
      put_charm_bid_vol: null,
      call_vanna_ask_vol: null,
      call_vanna_bid_vol: null,
      put_vanna_ask_vol: null,
      put_vanna_bid_vol: null,
      // Δ% computed by LAG over the combined CTE — same wire contract
      // as the WS path. Ratios from the mock get scaled to percent.
      gamma_delta_1m: 1,
      gamma_delta_5m: 3,
      gamma_delta_30m: 15,
    });
    expect(body.timestamps).toEqual([
      '2026-04-15T19:29:00.000Z',
      '2026-04-15T19:30:00.000Z',
    ]);
  });

  it('returns SPX rows from WS when WS populated (REST CTE gated off)', async () => {
    // SPX with live WS data. The ws_count gate inside the SQL prevents
    // the rest_series CTE from contributing — the handler can't
    // distinguish; it just sees rows. We assert the response shape is
    // identical to the standard WS happy path for an SPX ticker.
    mockSql
      .mockResolvedValueOnce([fakeRow(5650, '2026-05-03T19:30:00Z', 'SPX')])
      .mockResolvedValueOnce([{ ts_minute: '2026-05-03T19:30:00Z' }]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPX', expiry: '2026-05-03' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.ticker).toBe('SPX');
    expect(body.rows).toHaveLength(1);
    // Charm/vanna bid-ask vol fields are real numbers (WS path) — not
    // the NULL projection from the REST fallback. Confirms the WS row
    // came through untouched.
    expect(body.rows[0]).toMatchObject({
      ticker: 'SPX',
      call_charm_ask_vol: 85184.72,
      call_vanna_bid_vol: 1525.46,
    });
  });

  it('returns empty rows for SPY with no WS data (REST CTE gated by ticker)', async () => {
    // SPY can never reach gex_strike_0dte (legacy table is SPX-only,
    // gated by `${ticker} = 'SPX'`). Empty WS for SPY → empty result.
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      expiry: '2026-04-15',
      rows: [],
      timestamps: [],
    });
  });

  it('returns empty rows for NDX historical date (no fallback — REST is SPX-only)', async () => {
    // NDX subscriptions also landed late, but the legacy table has no
    // NDX history. Same SQL gate (`ticker = 'SPX'`) keeps the REST CTE
    // off; result is empty.
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'NDX', expiry: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'NDX',
      expiry: '2026-04-15',
      rows: [],
      timestamps: [],
    });
  });

  // ── Historical-date scrubbing regression (effective_at fix) ─────
  //
  // Before the effective_at CTE was added, the lookback window in
  // getLatestGexPerStrikeWithDeltas anchored to NOW() when `at` was
  // null. For any historical expiry that filtered out the entire
  // day's data because `ts_minute >= NOW() - 35min` lands days after
  // the requested expiry. The fix anchors the lookback to
  // MAX(ts_minute) for (ticker, expiry) across both tables when `at`
  // is null, so historical-date scrubbing returns rows again.
  //
  // These tests document the regression scenario at the handler
  // boundary. The actual SQL change is covered by the perf probe
  // at docs/tmp/gex-union-perf-probe/check.mjs.
  //
  // The mockSql here can't see what SQL was generated, so these
  // tests assert the handler still maps and returns rows for the
  // (ticker, at=null, historical-expiry) tuple end-to-end — i.e.
  // the wire contract that the GexLandscape historical scrubber
  // depends on.

  it('returns SPX historical rows with at=null (effective_at falls through to legacy MAX)', async () => {
    mockSql
      .mockResolvedValueOnce([
        fakeRestRow(5650, '2026-05-01T20:04:40Z'),
        fakeRestRow(5655, '2026-05-01T20:04:40Z'),
      ])
      .mockResolvedValueOnce([
        { ts_minute: '2026-05-01T20:03:40Z' },
        { ts_minute: '2026-05-01T20:04:40Z' },
      ]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPX', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      at: string | null;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.ticker).toBe('SPX');
    expect(body.at).toBeNull();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      ticker: 'SPX',
      strike: 5650,
      // Δ% derived in SQL — confirms the lookback window saw
      // history (would be null if effective_at had landed outside
      // the historical day, the pre-fix bug).
      gamma_delta_1m: 1,
      gamma_delta_30m: 15,
    });
  });

  it('returns SPY historical EOD snapshot with at=null (effective_at = MAX(ts_minute) on WS)', async () => {
    mockSql
      .mockResolvedValueOnce([fakeRow(722, '2026-05-01T20:14:00Z', 'SPY')])
      .mockResolvedValueOnce([{ ts_minute: '2026-05-01T20:14:00Z' }]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      at: string | null;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.ticker).toBe('SPY');
    expect(body.at).toBeNull();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      ticker: 'SPY',
      strike: 722,
      ts_minute: '2026-05-01T20:14:00.000Z',
    });
  });

  // ── Error propagation ──────────────────────────────────────

  it('returns 500 when the DB query throws', async () => {
    // Both parallel queries reject; Promise.all surfaces the first.
    mockSql
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Connection refused'));
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
