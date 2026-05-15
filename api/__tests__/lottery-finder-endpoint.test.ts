// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import handler from '../lottery-finder.js';

const ROW = {
  id: 42,
  date: '2026-05-01',
  trigger_time_ct: '2026-05-01T19:00:00Z',
  entry_time_ct: '2026-05-01T19:01:00Z',
  option_chain_id: 'SNDK260501C01175000',
  underlying_symbol: 'SNDK',
  option_type: 'C',
  strike: '1175',
  expiry: '2026-05-01',
  dte: 0,
  trigger_vol_to_oi_window: '0.06',
  trigger_vol_to_oi_cum: '0.12',
  trigger_iv: '0.4',
  trigger_delta: '0.2',
  trigger_ask_pct: '0.7',
  trigger_window_size: '250',
  trigger_window_prints: 8,
  entry_price: '0.55',
  open_interest: 1000,
  spot_at_first: '1170',
  alert_seq: 2,
  minutes_since_prev_fire: '320',
  flow_quad: 'call_ask',
  tod: 'PM',
  mode: 'A_intraday_0DTE',
  reload_tagged: true,
  cheap_call_pm_tagged: true,
  burst_ratio_vs_prev: '2.5',
  entry_drop_pct_vs_prev: '-40',
  mkt_tide_ncp: '12.5',
  mkt_tide_npp: '8.2',
  mkt_tide_diff: '4.3',
  mkt_tide_otm_diff: null,
  spx_flow_diff: null,
  spy_etf_diff: null,
  qqq_etf_diff: null,
  zero_dte_diff: null,
  spx_spot_gamma_oi: null,
  spx_spot_gamma_vol: null,
  spx_spot_charm_oi: null,
  spx_spot_vanna_oi: null,
  gex_strike_call_minus_put: null,
  gex_strike_call_ask_minus_bid: null,
  gex_strike_put_ask_minus_bid: null,
  gex_strike_actual_strike: null,
  realized_trail30_10_pct: null,
  realized_hard30m_pct: null,
  realized_tier50_holdeod_pct: null,
  realized_eod_pct: null,
  peak_ceiling_pct: null,
  minutes_to_peak: null,
  inserted_at: '2026-05-01T19:01:05Z',
  enriched_at: null,
  // Score column (migration #126) — SNDK 0DTE call at $0.55 PM is
  // ticker(10) + mode(5) + price(3, ≤$1.00) + tod(0, PM) + opt(2) = 20
  // → Tier 1 (≥18). Ticker stats reflect a "reliable" SNDK row.
  score: 20,
  ticker_n_fires: 8147,
  ticker_high_peak_rate: 67.4,
  ticker_ci_lower: 66.4,
  ticker_ci_upper: 68.4,
  ticker_ci_width: 2.0,
  ticker_tier: 'reliable',
  // realized_flow_inversion_pct (4th exit policy) — null when not yet
  // enriched, mirroring the other realized_* columns above.
  realized_flow_inversion_pct: null,
  // fire_count comes from the chain-day dedup CTE's window function.
  // 1 = unique row, no cluster. Tests exercising multi-fire collapse
  // override. first_fire_time_ct mirrors trigger_time_ct for unique
  // rows; multi-fire tests override with the burst-start time.
  fire_count: 1,
  first_fire_time_ct: '2026-05-01T19:00:00Z',
};

describe('lottery-finder endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false); // proceed past auth gate
    mockSql.mockResolvedValue([]);
  });

  it('returns transformed fires with default date (ET-today) and asOf=null', async () => {
    // Two SQL calls: rows query then COUNT(*) total query.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      asOf: string | null;
      filters: Record<string, unknown>;
      count: number;
      total: number;
      limit: number;
      fires: Array<Record<string, unknown>>;
    };
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50); // page size default
    expect(body.asOf).toBeNull();
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.fires[0]).toMatchObject({
      id: 42,
      underlyingSymbol: 'SNDK',
      strike: 1175,
      score: 20,
      scoreTier: 'tier1',
      forecastHighPeakPct: '30-50%',
      // SNDK tier1 has a per-ticker override at 340 (vs tier1 default of 219).
      avgHoldMinutes: 340,
      fireCount: 1,
      tickerStats: {
        nFires: 8147,
        highPeakRate: 67.4,
        ciLower: 66.4,
        ciUpper: 68.4,
        ciWidth: 2.0,
        tier: 'reliable',
      },
      tags: {
        flowQuad: 'call_ask',
        tod: 'PM',
        mode: 'A_intraday_0DTE',
        reload: true,
        cheapCallPm: true,
        burstRatioVsPrev: 2.5,
        entryDropPctVsPrev: -40,
      },
      entry: {
        price: 0.55,
        openInterest: 1000,
        alertSeq: 2,
      },
    });
  });

  it('exposes chain-day fire_count + first_fire_time_ct as fireCount + firstFireTimeCt', async () => {
    // Real-world: TSLA 392.5C fires 315 times across the session; the
    // chain-day CTE (PARTITION BY ticker × strike × type × expiry)
    // collapses to one rep row. fire_count = 315 is the burst size,
    // first_fire_time_ct = 09:35 the burst start, trigger_time_ct =
    // 15:30 the latest fire (also the rep's macro/score basis).
    const ROW_COLLAPSED = {
      ...ROW,
      fire_count: 315,
      first_fire_time_ct: '2026-05-01T14:35:00Z',
      trigger_time_ct: '2026-05-01T20:30:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_COLLAPSED])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<{
        fireCount: number;
        firstFireTimeCt: string;
        triggerTimeCt: string;
      }>;
    };
    expect(body.fires[0]!.fireCount).toBe(315);
    expect(body.fires[0]!.firstFireTimeCt).toBe('2026-05-01T14:35:00Z');
    expect(body.fires[0]!.triggerTimeCt).toBe('2026-05-01T20:30:00Z');
  });

  it('reports tickerStats=null when ticker_n_fires is missing (no JOIN match)', async () => {
    const ROW_NO_STATS = {
      ...ROW,
      ticker_n_fires: null,
      ticker_high_peak_rate: null,
      ticker_ci_lower: null,
      ticker_ci_upper: null,
      ticker_ci_width: null,
      ticker_tier: null,
    };
    mockSql
      .mockResolvedValueOnce([ROW_NO_STATS])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<{ tickerStats: unknown }> };
    expect(body.fires[0]!.tickerStats).toBeNull();
  });

  it('honors sort=score and echoes it in filters', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', sort: 'score' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.sort).toBe('score');
  });

  it('honors sort=peak and echoes it in filters', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', sort: 'peak' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.sort).toBe('peak');
  });

  it('honors minScore=18 — High Conviction filter binds the floor on both queries', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minScore: '18' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.minScore).toBe(18);
    // Both the rows query and the COUNT query must include the 18
    // threshold so the page total stays accurate when the filter is
    // on. Each tagged-template call is `(strings, ...values)`, so the
    // 18 lives among the bound values.
    const rowsCall = mockSql.mock.calls[0] as unknown[];
    const countCall = mockSql.mock.calls[1] as unknown[];
    expect(rowsCall.slice(1)).toContain(18);
    expect(countCall.slice(1)).toContain(18);
  });

  it('rejects sort outside the {chronological|score|peak} enum', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { sort: 'random' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('handles DATE column returned as a Date object (neon serverless default)', async () => {
    // Production regression: neon-serverless returns DATE columns as
    // Date objects, not strings. The endpoint was calling
    // `r.date.slice(0, 10)` which threw "r.date.slice is not a
    // function" on every prod request. toIso() at the boundary fixes
    // it; this test pins the behavior so a future "type says string,
    // why am I calling toIso?" cleanup doesn't regress.
    const ROW_WITH_DATE_OBJ = {
      ...ROW,
      date: new Date('2026-05-01T00:00:00.000Z'),
    };
    mockSql
      .mockResolvedValueOnce([ROW_WITH_DATE_OBJ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { fires: Array<{ date: string }> };
    expect(body.fires[0]!.date).toBe('2026-05-01');
  });

  it('honors explicit date param + at scrubber cutoff', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-21', at: '2026-04-21T18:30:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string; asOf: string | null };
    expect(body.date).toBe('2026-04-21');
    expect(body.asOf).toBe('2026-04-21T18:30:00.000Z');
  });

  it('rejects malformed date (not YYYY-MM-DD)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '04/21/2026' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects malformed at (not ISO datetime with offset)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { at: '14:30 PM' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('coerces numeric DB strings to numbers and nullable fields to null', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<Record<string, unknown>> };
    const fire = body.fires[0]!;
    expect(typeof fire.strike).toBe('number');
    expect((fire as { trigger: { askPct: unknown } }).trigger.askPct).toBe(0.7);
    // Nullable column → null after coercion (not NaN, not undefined)
    expect(
      (fire as { macro: { spxFlowDiff: unknown } }).macro.spxFlowDiff,
    ).toBeNull();
    expect(
      (fire as { outcomes: { realizedHard30mPct: unknown } }).outcomes
        .realizedHard30mPct,
    ).toBeNull();
  });

  it('rejects malformed ticker query (not 1-8 uppercase letters)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'sndk' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects malformed mode (not in enum)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { mode: 'C_overnight' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('caps limit at 200', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { limit: '5000' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Schema rejects > 200; the handler returns 400.
    expect(res._status).toBe(400);
  });

  it('paginates via offset + reports hasMore when more pages exist', async () => {
    // Page 2 (offset=50, limit=50) of a 1247-fire day.
    const ROWS = Array.from({ length: 50 }, (_, i) => ({ ...ROW, id: i + 51 }));
    mockSql
      .mockResolvedValueOnce(ROWS)
      .mockResolvedValueOnce([{ total: 1247 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', offset: '50', limit: '50' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    expect(body.count).toBe(50);
    expect(body.total).toBe(1247);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(50);
    expect(body.hasMore).toBe(true); // 50 + 50 < 1247
  });

  it('hasMore=false on the last page', async () => {
    const ROWS = Array.from({ length: 47 }, (_, i) => ({
      ...ROW,
      id: i + 1200,
    }));
    mockSql
      .mockResolvedValueOnce(ROWS)
      .mockResolvedValueOnce([{ total: 1247 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', offset: '1200', limit: '50' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { hasMore: boolean };
    expect(body.hasMore).toBe(false); // 1200 + 47 == 1247
  });

  it('honors minute param as a 1-minute point-in-time bucket', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-05-01',
        minute: '2026-05-01T14:35:00.000Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { minute: string | null };
    expect(body.minute).toBe('2026-05-01T14:35:00.000Z');
  });

  it('filters by optionType (calls only)', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', optionType: 'C' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.optionType).toBe('C');
  });

  it('filters by tod bucket', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', tod: 'PM' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.tod).toBe('PM');
  });

  it('rejects invalid optionType', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { optionType: 'X' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects invalid tod', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { tod: 'CLOSE' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('reflects filter params back in the response envelope', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    const req = mockRequest({
      method: 'GET',
      query: {
        ticker: 'SNDK',
        reload: 'true',
        cheapCallPm: 'true',
        mode: 'A_intraday_0DTE',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: Record<string, unknown>;
      count: number;
    };
    expect(body.filters).toMatchObject({
      ticker: 'SNDK',
      reload: true,
      cheapCallPm: true,
      mode: 'A_intraday_0DTE',
    });
    expect(body.count).toBe(0);
  });

  it('honors the guard short-circuit (returns immediately if guard returns true)', async () => {
    mockGuard.mockResolvedValueOnce(true); // guard already responded
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('binds MIN_ALERT_ENTRY_PRICE (0.10) into both rows + count SQL templates', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    // Two SQL calls: the rows CTE + the count subquery. Both must bind
    // 0.1 as a parameter (the entry-price floor). Neon's tagged-template
    // invocation packs interpolated values as call args after the
    // strings array, so we check every arg of every call.
    const callsWithFloor = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === 0.1),
    );
    expect(callsWithFloor.length).toBe(2);
  });
});
