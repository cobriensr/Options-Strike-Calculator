// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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
  default: { error: vi.fn() },
}));

import handler, { _internal } from '../interval-ba-feed.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const RAW_ROW = {
  id: 1,
  option_chain: 'SPXW260327C05800000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: '5800.000',
  expiry: new Date('2026-03-27T00:00:00Z'),
  bucket_start: new Date('2026-03-27T17:05:00Z'),
  bucket_end: new Date('2026-03-27T17:10:00Z'),
  fired_at: new Date('2026-03-27T17:06:24Z'),
  ratio_pct: '85.50',
  ask_premium: '1200000.00',
  total_premium: '1400000.00',
  trade_count: 8,
  top_trade_premium: '600000.00',
  top_trade_size: 1000,
  top_trade_executed_at: new Date('2026-03-27T17:06:23Z'),
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: '5795.00',
  confluence_tickers: null,
};

describe('GET /api/interval-ba-feed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 for non-owner-or-guest', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when date is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for malformed date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026/03/27' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for malformed time', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', startTime: '8:30am' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when endTime <= startTime', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          date: '2026-03-27',
          startTime: '12:00',
          endTime: '12:00',
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns shaped alerts + summary on success', async () => {
    mockSql.mockResolvedValue([RAW_ROW]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: Record<string, unknown>[];
      summary: Record<string, number>;
    };
    expect(body.alerts).toHaveLength(1);
    const alert = body.alerts[0]!;
    expect(alert.option_chain).toBe('SPXW260327C05800000');
    expect(alert.strike).toBe(5800);
    expect(alert.ratio_pct).toBe(85.5);
    expect(alert.total_premium).toBe(1400000);
    expect(alert.severity).toBe('extreme');
    expect(alert.expiry).toBe('2026-03-27');
    expect(body.summary).toEqual({
      count: 1,
      total_premium: 1400000,
      extreme: 1,
      critical: 0,
      warning: 0,
    });
  });

  it('filters by option_type when provided', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', optionType: 'P' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // The SQL branch with the option_type filter was used (1 call).
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid optionType (treats as both)', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', optionType: 'X' },
      }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('sets Cache-Control: no-store', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 + captures on DB error', async () => {
    mockSql.mockRejectedValue(new Error('pg down'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // Phase 5: confluence_tickers pass-through + ?confluenceOnly=1 filter.
  it('coalesces null confluence_tickers to [] in response', async () => {
    mockSql.mockResolvedValue([RAW_ROW]); // confluence_tickers=null
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    const body = res._json as { alerts: Record<string, unknown>[] };
    expect(body.alerts[0]!.confluence_tickers).toEqual([]);
  });

  it('passes populated confluence_tickers through unchanged', async () => {
    mockSql.mockResolvedValue([
      { ...RAW_ROW, confluence_tickers: ['SPY', 'QQQ'] },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    const body = res._json as { alerts: Record<string, unknown>[] };
    expect(body.alerts[0]!.confluence_tickers).toEqual(['SPY', 'QQQ']);
  });

  it('?confluenceOnly=1 binds the confluence gate into the SQL', async () => {
    // SQL now applies the filter — the mock returns only what the
    // filtered query would return (just the partnered row).
    mockSql.mockResolvedValue([
      { ...RAW_ROW, id: 12, confluence_tickers: ['SPY'] },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', confluenceOnly: '1' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // The SQL template must contain the confluence gate so the LIMIT
    // operates against the filtered set, not the full universe.
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const strings = call[0] as TemplateStringsArray | undefined;
    const sqlText = (strings ?? []).join(' ');
    expect(sqlText).toContain('confluence_tickers IS NOT NULL');
    // Aliased to `a` after the WITH base CTE was introduced for the
    // SPXW→SPX spot fallback.
    expect(sqlText).toContain('cardinality(a.confluence_tickers)');
    const body = res._json as {
      alerts: Array<{ id: number }>;
      summary: { count: number };
    };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]!.id).toBe(12);
    expect(body.summary.count).toBe(1);
  });

  it('confluenceOnly=1 does NOT apply a JS post-filter (SQL gate is authoritative)', async () => {
    // Regression-proofing: if someone re-adds a JS .filter() on top of
    // the SQL gate, this test fails. We feed the mock a row with empty
    // confluence_tickers — a row that the real SQL gate would never
    // return, but the mock returns regardless. If JS-side filtering is
    // re-introduced, this row gets dropped and the assertion fails.
    mockSql.mockResolvedValue([{ ...RAW_ROW, id: 99, confluence_tickers: [] }]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', confluenceOnly: '1' },
      }),
      res,
    );
    const body = res._json as { alerts: Array<{ id: number }> };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]!.id).toBe(99);
  });

  it('confluenceOnly with no value or wrong value leaves the gate off (NULL sentinel)', async () => {
    mockSql.mockResolvedValue([
      { ...RAW_ROW, id: 1, confluence_tickers: null },
      { ...RAW_ROW, id: 2, confluence_tickers: ['SPY'] },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', confluenceOnly: 'yes' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // The gate compiles to `(NULL::text IS NULL OR …)` so Postgres
    // short-circuits to TRUE — every row passes. Verify the bound
    // parameter is null.
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const params = call.slice(1) as Array<unknown>;
    expect(params).toContain(null);
    const body = res._json as { alerts: Array<{ id: number }> };
    expect(body.alerts).toHaveLength(2);
  });

  // SPXW underlying_price fallback — the SELECT now COALESCEs the
  // on-row underlying_price with the closest-prior SPX 1m candle
  // close via LEFT JOIN LATERAL on index_candles_1m.
  it('SQL JOINs index_candles_1m to fill SPXW underlying_price', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const strings = call[0] as TemplateStringsArray | undefined;
    const sqlText = (strings ?? []).join(' ');
    expect(sqlText).toContain('index_candles_1m');
    expect(sqlText).toContain("a.ticker = 'SPXW'");
    expect(sqlText).toContain("c.symbol = 'SPX'");
    expect(sqlText).toContain('COALESCE');
    expect(sqlText).toContain('effective_spot AS underlying_price');
  });

  // Moneyness filter — single-select chip on the UI. Compiles to a
  // `(NULL::text IS NULL OR …)` gate against the COALESCEd spot.
  it('?moneyness=ITM binds the ITM gate into the SQL', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', moneyness: 'ITM' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const params = call.slice(1) as Array<unknown>;
    expect(params).toContain('ITM');
  });

  it('?moneyness=OTM binds the OTM gate into the SQL', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', moneyness: 'OTM' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const params = call.slice(1) as Array<unknown>;
    expect(params).toContain('OTM');
  });

  it('?moneyness with junk value leaves the gate off (NULL sentinel)', async () => {
    mockSql.mockResolvedValue([RAW_ROW]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', moneyness: 'wat' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls.at(-1) as unknown[];
    const params = call.slice(1) as Array<unknown>;
    // The bound moneyness param is null on bad input, so Postgres
    // short-circuits the gate to TRUE and every row passes.
    expect(params).toContain(null);
    const body = res._json as { alerts: Array<unknown> };
    expect(body.alerts).toHaveLength(1);
  });
});

describe('shapeRow', () => {
  it('coerces BIGSERIAL id string to number', () => {
    // Neon's serverless driver returns BIGINT as a string to preserve
    // precision. The FeedAlert contract types id as number, so the
    // shape function must coerce — otherwise downstream code that
    // round-trips the id (e.g. a future bulk-ack POST) would ship a
    // quoted string and trip Zod number checks.
    const shaped = _internal.shapeRow({ ...RAW_ROW, id: '12345' });
    expect(shaped.id).toBe(12345);
    expect(typeof shaped.id).toBe('number');
  });
});

describe('summary derivation', () => {
  it('counts by severity bucket', () => {
    const make = (tp: number) =>
      _internal.shapeRow({ ...RAW_ROW, total_premium: tp });
    const alerts = [
      make(2_000_000), // extreme
      make(900_000), // critical
      make(700_000), // critical
      make(300_000), // warning
      make(50_000), // warning
    ];
    const s = _internal.buildSummary(alerts);
    expect(s).toEqual({
      count: 5,
      total_premium: 2_000_000 + 900_000 + 700_000 + 300_000 + 50_000,
      extreme: 1,
      critical: 2,
      warning: 2,
    });
  });
});
