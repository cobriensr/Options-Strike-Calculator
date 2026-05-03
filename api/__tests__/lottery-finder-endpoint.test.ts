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
};

describe('lottery-finder endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false); // proceed past auth gate
    mockSql.mockResolvedValue([]);
  });

  it('returns transformed fires with default since (today)', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      since: string;
      filters: Record<string, unknown>;
      count: number;
      fires: Array<Record<string, unknown>>;
    };
    expect(body.count).toBe(1);
    expect(body.fires[0]).toMatchObject({
      id: 42,
      underlyingSymbol: 'SNDK',
      strike: 1175,
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
    expect(body.since).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it('coerces numeric DB strings to numbers and nullable fields to null', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<Record<string, unknown>> };
    const fire = body.fires[0]!;
    expect(typeof fire.strike).toBe('number');
    expect((fire as { trigger: { askPct: unknown } }).trigger.askPct).toBe(0.7);
    // Nullable column → null after coercion (not NaN, not undefined)
    expect((fire as { macro: { spxFlowDiff: unknown } }).macro.spxFlowDiff).toBeNull();
    expect((fire as { outcomes: { realizedHard30mPct: unknown } }).outcomes.realizedHard30mPct).toBeNull();
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
      query: { limit: '500' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Schema rejects > 200; the handler returns 400.
    expect(res._status).toBe(400);
  });

  it('reflects filter params back in the response envelope', async () => {
    mockSql.mockResolvedValueOnce([]);

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
    const body = res._json as { filters: Record<string, unknown>; count: number };
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
});
