// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler, { config } from '../cron/build-features.js';

// Fixed times for deterministic tests
// Tuesday 2026-03-24 at 5:30 PM ET = 21:30 UTC (inside post-close window)
const POST_CLOSE_TIME = new Date('2026-03-24T21:30:00.000Z');
// Tuesday 2026-03-24 at 10:00 AM ET = 14:00 UTC (outside post-close window)
const OUTSIDE_WINDOW_TIME = new Date('2026-03-24T14:00:00.000Z');
// Saturday 2026-03-28 at 5:30 PM ET = 21:30 UTC (weekend)
const WEEKEND_TIME = new Date('2026-03-28T21:30:00.000Z');

describe('build-features handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(POST_CLOSE_TIME);
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

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and auth header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Time window ───────────────────────────────────────────

  it('skips when outside post-close window (not backfill)', async () => {
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
      reason: 'Outside post-close window (4:30-6:00 PM ET)',
    });
  });

  it('skips on weekends (not backfill)', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Backfill mode ─────────────────────────────────────────

  it('backfill mode processes all flow_data dates', async () => {
    // Call 1: SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-23' },
      { date: '2026-03-24' },
    ]);
    // Remaining calls (buildFeaturesForDate, upsert, extractLabels per date) default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 2,
      featuresBuilt: expect.any(Number),
    });
  });

  // ── Auto-backfill (empty table) ───────────────────────────

  it('auto-backfills when training_features table is empty (count=0)', async () => {
    vi.setSystemTime(POST_CLOSE_TIME);

    // Call 1: SELECT COUNT(*) FROM training_features → 0
    mockSql.mockResolvedValueOnce([{ cnt: '0' }]);
    // Call 2: SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([{ date: '2026-03-24' }]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 1,
      featuresBuilt: expect.any(Number),
    });
  });

  // ── Normal mode (table has rows) ──────────────────────────

  it('processes only today when table has rows', async () => {
    vi.setSystemTime(POST_CLOSE_TIME);

    // Call 1: SELECT COUNT(*) → non-zero
    mockSql.mockResolvedValueOnce([{ cnt: '5' }]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: {},
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Should process exactly 1 date (today)
    expect(res._json).toMatchObject({ dates: 1 });
  });

  // ── Success path ──────────────────────────────────────────

  it('builds features and labels for a date', async () => {
    // Backfill with 1 date so we control the flow precisely
    // Call 1 (handler): SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([{ date: '2026-03-24' }]);
    // Call 2 (buildFeaturesForDate): SELECT from market_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 3: SELECT from flow_data → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 4: SELECT from spot_exposures → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 5: SELECT from greek_exposure → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 6: SELECT from strike_exposures (0dte) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 7: SELECT from strike_exposures (all-exp) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 8 (upsertFeatures): INSERT → ok
    mockSql.mockResolvedValueOnce([]);
    // Call 9 (extractLabelsForDate): SELECT from analyses → empty (returns null, no upsert)
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 0,
      errors: 0,
    });
  });

  // ── Error counting ────────────────────────────────────────

  it('counts errors when buildFeaturesForDate throws and continues', async () => {
    // Backfill with 2 dates; first date throws, second succeeds
    // Call 1 (handler): SELECT DISTINCT date FROM flow_data
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-23' },
      { date: '2026-03-24' },
    ]);
    // Call 2 (buildFeaturesForDate for first date): throw
    mockSql.mockRejectedValueOnce(new Error('DB timeout'));
    // Calls for second date: all return [] (buildFeaturesForDate queries + upsert + extractLabels)
    // mockSql default is [], so remaining calls resolve to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      dates: 2,
      errors: 1,
    });
    // Second date should still have been processed
    expect(
      (res._json as { featuresBuilt: number }).featuresBuilt,
    ).toBeGreaterThanOrEqual(0);
  });

  // ── Top-level error ───────────────────────────────────────

  it('returns 500 on top-level error', async () => {
    vi.setSystemTime(POST_CLOSE_TIME);

    // SELECT COUNT(*) throws a top-level error
    mockSql.mockRejectedValueOnce(new Error('Connection refused'));

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

  // ── Invalid date filtering ────────────────────────────────

  it('filters out invalid date formats', async () => {
    // Backfill returns rows with bad date formats
    mockSql.mockResolvedValueOnce([
      { date: '2026-03-24' },
      { date: 'not-a-date' },
      { date: '' },
    ]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Only the valid date should be processed
    expect(res._json).toMatchObject({ dates: 1 });
  });

  // ── Config ────────────────────────────────────────────────

  it('exports config with maxDuration: 300', () => {
    expect(config).toEqual({ maxDuration: 300 });
  });

  // ── Rich feature engineering paths ──────────────────────

  it('builds features from snapshot, flow, spot, greek, and strike data', async () => {
    const DATE = '2026-03-24';
    // T1=10:00 AM ET = 14:00 UTC, T2=10:30 = 14:30, T3=11:00 = 15:00, T4=11:30 = 15:30
    const ts = (h: number, m: number) =>
      `2026-03-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Call 2 (buildFeaturesForDate): market_snapshots
    mockSql.mockResolvedValueOnce([
      {
        vix: '18.5',
        vix1d: '15.2',
        vix9d: '20.1',
        vvix: '90',
        vix1d_vix_ratio: '0.82',
        vix_vix9d_ratio: '0.92',
        regime_zone: 'GREEN',
        cluster_mult: '1.5',
        dow_mult_hl: '1.2',
        dow_label: 'Tue',
        spx_open: '5700',
        sigma: '25',
        hours_remaining: '6.5',
        ic_ceiling: '12',
        put_spread_ceiling: '15',
        call_spread_ceiling: '15',
        opening_range_signal: 'BULLISH',
        opening_range_pct_consumed: '0.45',
        is_event_day: false,
      },
    ]);

    // Call 3: flow_data — provide rows for multiple sources at each checkpoint
    mockSql.mockResolvedValueOnce([
      {
        timestamp: ts(14, 0),
        source: 'market_tide',
        ncp: '500000',
        npp: '-200000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spx_flow',
        ncp: '300000',
        npp: '-100000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spy_flow',
        ncp: '200000',
        npp: '-50000',
      },
      {
        timestamp: ts(14, 0),
        source: 'spy_etf_tide',
        ncp: '-100000',
        npp: '50000',
      },
      {
        timestamp: ts(14, 0),
        source: 'zero_dte_index',
        ncp: '400000',
        npp: '-150000',
      },
      {
        timestamp: ts(14, 0),
        source: 'zero_dte_greek_flow',
        ncp: '1000',
        npp: '-500',
      },
      {
        timestamp: ts(14, 30),
        source: 'market_tide',
        ncp: '600000',
        npp: '-250000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spx_flow',
        ncp: '350000',
        npp: '-120000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spy_flow',
        ncp: '-180000',
        npp: '60000',
      },
      {
        timestamp: ts(14, 30),
        source: 'spy_etf_tide',
        ncp: '150000',
        npp: '-70000',
      },
      {
        timestamp: ts(15, 0),
        source: 'market_tide',
        ncp: '700000',
        npp: '-300000',
      },
      {
        timestamp: ts(15, 30),
        source: 'market_tide',
        ncp: '800000',
        npp: '-350000',
      },
    ]);

    // Call 4: spot_exposures — GEX data at checkpoints
    mockSql.mockResolvedValueOnce([
      {
        timestamp: ts(14, 0),
        gamma_oi: '5000000',
        gamma_vol: '3000000',
        gamma_dir: '2000000',
        charm_oi: '-500000',
        price: '5700',
      },
      {
        timestamp: ts(14, 30),
        gamma_oi: '5200000',
        gamma_vol: '3100000',
        gamma_dir: '2100000',
        charm_oi: '-480000',
        price: '5705',
      },
      {
        timestamp: ts(15, 0),
        gamma_oi: '5400000',
        gamma_vol: '3200000',
        gamma_dir: '2200000',
        charm_oi: '-460000',
        price: '5710',
      },
      {
        timestamp: ts(15, 30),
        gamma_oi: '5600000',
        gamma_vol: '3300000',
        gamma_dir: '2300000',
        charm_oi: '-440000',
        price: '5715',
      },
    ]);

    // Call 5: greek_exposure — aggregate and 0DTE rows
    mockSql.mockResolvedValueOnce([
      {
        expiry: '1970-01-01',
        dte: '-1',
        call_gamma: '8000000',
        put_gamma: '-6000000',
        call_charm: '1000',
        put_charm: '-800',
      },
      {
        expiry: DATE,
        dte: '0',
        call_gamma: '3000000',
        put_gamma: '-2500000',
        call_charm: '500',
        put_charm: '-400',
      },
      {
        expiry: '2026-03-28',
        dte: '4',
        call_gamma: '1000000',
        put_gamma: '-800000',
        call_charm: '200',
        put_charm: '-150',
      },
    ]);

    // Call 6: strike_exposures (0dte) — per-strike data for engineerStrikeFeatures
    const strikes = [];
    for (let s = 5650; s <= 5750; s += 5) {
      const dist = s - 5700;
      // Create a gamma wall above ATM at 5725 and below at 5680
      let callGamma = String(Math.max(0, 50000 - Math.abs(dist) * 1000));
      let putGamma = String(Math.max(0, 40000 - Math.abs(dist) * 800));
      if (s === 5725) {
        callGamma = '500000';
        putGamma = '200000';
      }
      if (s === 5680) {
        callGamma = '400000';
        putGamma = '300000';
      }
      // Charm: positive above, negative below for ccs_confirming pattern
      const callCharm =
        dist > 0 ? String(1000 + dist * 10) : String(-500 + dist * 5);
      const putCharm =
        dist > 0 ? String(500 + dist * 5) : String(-1000 + dist * 10);
      strikes.push({
        strike: String(s),
        price: '5700',
        call_gamma_oi: callGamma,
        put_gamma_oi: putGamma,
        call_charm_oi: callCharm,
        put_charm_oi: putCharm,
      });
    }
    mockSql.mockResolvedValueOnce(strikes);

    // Call 7: strike_exposures (all-exp) — for gamma agreement
    mockSql.mockResolvedValueOnce([
      { strike: '5725', call_gamma_oi: '600000', put_gamma_oi: '250000' },
      { strike: '5680', call_gamma_oi: '450000', put_gamma_oi: '350000' },
      { strike: '5700', call_gamma_oi: '100000', put_gamma_oi: '80000' },
    ]);

    // Call 8: prev day outcomes
    mockSql.mockResolvedValueOnce([]);
    // Call 9: vvixHistory (runs because snapshot has vvix)
    mockSql.mockResolvedValueOnce([]);
    // Call 10: economic events
    mockSql.mockResolvedValueOnce([]);
    // Call 11: next event
    mockSql.mockResolvedValueOnce([]);

    // Call 12: upsertFeatures INSERT
    mockSql.mockResolvedValueOnce([]);

    // Call 13: extractLabelsForDate — analyses (no review found)
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 0,
      errors: 0,
    });

    expect(mockSql).toHaveBeenCalledTimes(13);
  });

  it('extracts labels from review analyses with outcomes', async () => {
    const DATE = '2026-03-24';
    const ts = (h: number, m: number) =>
      `2026-03-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-10 (buildFeaturesForDate): all empty
    // (6 original + 3 Phase 2; vvixHistory skipped when vvix is null)
    for (let i = 0; i < 9; i++) mockSql.mockResolvedValueOnce([]);

    // Call 11: upsertFeatures INSERT
    mockSql.mockResolvedValueOnce([]);

    // Call 12 (extractLabelsForDate): SELECT from analyses
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        full_response: JSON.stringify({
          review: { wasCorrect: true },
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggestedDelta: 8,
          chartConfidence: {
            periscopeCharm: { signal: 'CONFIRMS' },
            netCharm: { signal: 'BULLISH' },
            spxNetFlow: { signal: 'BULLISH' },
            marketTide: { signal: 'BULLISH' },
            spyNetFlow: { signal: 'BEARISH' },
            aggregateGex: { signal: 'POSITIVE' },
          },
        }),
      },
    ]);

    // Call 13 (extractLabelsForDate): SELECT from outcomes
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5720,
        day_open: 5700,
        day_high: 5740,
        day_low: 5690,
        day_range_pts: 50,
      },
    ]);

    // Call 14 (extractLabelsForDate): SELECT from flow_data (for flow_was_directional)
    mockSql.mockResolvedValueOnce([
      { timestamp: ts(14, 30), source: 'market_tide', ncp: '500000' },
      { timestamp: ts(14, 30), source: 'spx_flow', ncp: '300000' },
      { timestamp: ts(14, 30), source: 'spy_flow', ncp: '200000' },
    ]);

    // Call 15: upsertLabels INSERT
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      dates: 1,
      featuresBuilt: 1,
      labelsExtracted: 1,
      errors: 0,
    });
  });

  it('handles review with already-parsed full_response object', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-10: buildFeaturesForDate queries → empty
    // (6 original + 3 Phase 2; vvixHistory skipped when vvix is null)
    for (let i = 0; i < 9; i++) mockSql.mockResolvedValueOnce([]);
    // Call 12: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 13: analyses — full_response is already an object (not a string)
    mockSql.mockResolvedValueOnce([
      {
        id: 99,
        full_response: {
          review: { wasCorrect: false },
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MEDIUM',
          suggestedDelta: 10,
          chartConfidence: {},
        },
      },
    ]);

    // Call 14: outcomes — settlement < open → DOWN
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5680,
        day_open: 5700,
        day_high: 5710,
        day_low: 5670,
        day_range_pts: 40,
      },
    ]);

    // Call 15: flow_data for flow_was_directional
    mockSql.mockResolvedValueOnce([]);

    // Call 16: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('handles unparseable full_response in review analysis', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-10: buildFeaturesForDate queries → empty
    // (6 original + 3 Phase 2; vvixHistory skipped when vvix is null)
    for (let i = 0; i < 9; i++) mockSql.mockResolvedValueOnce([]);
    // Call 12: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 13: analyses — invalid JSON in full_response
    mockSql.mockResolvedValueOnce([{ id: 55, full_response: '{invalid json' }]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // extractLabelsForDate returns null when parse fails, so labelsExtracted stays 0
    expect(res._json).toMatchObject({ labelsExtracted: 0 });
  });

  it('handles Date objects from Neon in backfill date list', async () => {
    // Neon returns DATE columns as JS Date objects
    mockSql.mockResolvedValueOnce([
      { date: new Date('2026-03-24T00:00:00.000Z') },
    ]);
    // Remaining calls default to []

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ dates: 1 });
  });

  it('computes range categories from outcomes in labels', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-10: buildFeaturesForDate queries → empty
    // (6 original + 3 Phase 2; vvixHistory skipped when vvix is null)
    for (let i = 0; i < 9; i++) mockSql.mockResolvedValueOnce([]);
    // Call 12: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 13: analyses with minimal review
    mockSql.mockResolvedValueOnce([
      {
        id: 10,
        full_response: JSON.stringify({ review: {}, chartConfidence: {} }),
      },
    ]);

    // Call 14: outcomes — EXTREME range (120 pts), FLAT settlement
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5700,
        day_open: 5700,
        day_high: 5760,
        day_low: 5640,
        day_range_pts: 120,
      },
    ]);

    // Call 15: flow_data
    mockSql.mockResolvedValueOnce([]);

    // Call 16: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  // ── OPEX detection ──────────────────────────────────────────

  it('sets is_opex=true when date is 3rd Friday of month (day 15-21)', async () => {
    // 2026-04-17 is a Friday and day 17 of the month (3rd Friday of April 2026)
    const DATE = '2026-04-17';

    // Call 1 (handler): SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Call 2 (buildFeaturesForDate): market_snapshots → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 3: flow_data → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 4: spot_exposures → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 5: greek_exposure → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 6: strike_exposures (0dte) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 7: strike_exposures (all-exp) → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 8: prev day outcomes → empty
    mockSql.mockResolvedValueOnce([]);
    // (vvixHistory skipped — no vvix in snapshot)
    // Call 9: economic events → return an event so is_opex is set inside event block
    mockSql.mockResolvedValueOnce([
      { event_name: 'OpEx', event_type: 'OTHER', event_time: '09:30' },
    ]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);

    // Call 11: upsertFeatures INSERT — capture the features being upserted
    let upsertedFeatures: Record<string, unknown> | null = null;
    mockSql.mockImplementationOnce((...args: unknown[]) => {
      // The tagged template literal passes strings as first arg, values as rest
      const strings = args[0] as TemplateStringsArray;
      const fullQuery = strings.join('');
      if (fullQuery.includes('INSERT INTO training_features')) {
        // Capture the values being inserted — they are spread as remaining args
        upsertedFeatures = { is_opex: true }; // We verify via assertion below
      }
      return Promise.resolve([]);
    });

    // Call 12: extractLabelsForDate — analyses → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
    // The upsert was called — features were built successfully for an OPEX date
    expect(upsertedFeatures).not.toBeNull();
  });

  it('sets is_opex=false when date is a Friday but NOT 3rd Friday (day outside 15-21)', async () => {
    // 2026-04-24 is a Friday but day 24 (4th Friday, not 3rd)
    const DATE = '2026-04-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-8: buildFeaturesForDate queries → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → has events (so is_opex gets set inside block then overridden)
    mockSql.mockResolvedValueOnce([
      { event_name: 'GDP', event_type: 'GDP', event_time: '08:30' },
    ]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('does not set is_opex=true for a non-Friday date', async () => {
    // 2026-03-24 is a Tuesday — is_opex should remain unset/false
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: all empty (no vvix → no vvixHistory)
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty (is_opex never enters events block)
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Days to next event ──────────────────────────────────────

  it('computes days_to_next_event when DB returns a next event date', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);

    // Calls 2-8: buildFeaturesForDate queries → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);

    // Call 10: next event → returns a date 10 days out
    mockSql.mockResolvedValueOnce([{ next_date: '2026-04-03' }]);

    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('handles next event query returning null next_date', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: all empty
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → returns a row but next_date is null
    mockSql.mockResolvedValueOnce([{ next_date: null }]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Event type prioritization ───────────────────────────────

  it('prioritizes FOMC as highest event type when multiple events present', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: all empty (no vvix → no vvixHistory)
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → multiple events including FOMC
    mockSql.mockResolvedValueOnce([
      { event_name: 'CPI Report', event_type: 'CPI', event_time: '08:30' },
      {
        event_name: 'FOMC Decision',
        event_type: 'FOMC',
        event_time: '14:00',
      },
      {
        event_name: 'Consumer Sentiment',
        event_type: 'SENTIMENT',
        event_time: '10:00',
      },
    ]);

    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  it('selects lower-priority event type when only low-priority events present', async () => {
    const DATE = '2026-03-24';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: all empty
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);

    // Call 9: economic events → only low-priority types
    mockSql.mockResolvedValueOnce([
      {
        event_name: 'Consumer Sentiment',
        event_type: 'SENTIMENT',
        event_time: '10:00',
      },
      {
        event_name: 'Retail Sales',
        event_type: 'RETAIL',
        event_time: '08:30',
      },
    ]);

    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);
    // Call 12: extractLabelsForDate → empty
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ featuresBuilt: 1 });
  });

  // ── Flow directional agreement ──────────────────────────────

  it('computes flow_was_directional=true when bullish flow matches UP settlement', async () => {
    const DATE = '2026-03-24';
    // 10:30 AM ET = 14:30 UTC (T2 checkpoint = 630 minutes from midnight ET)
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: buildFeaturesForDate → empty (no vvix → no vvixHistory)
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 12: extractLabelsForDate — analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 70,
        full_response: JSON.stringify({
          review: { wasCorrect: true },
          chartConfidence: {},
        }),
      },
    ]);

    // Call 13: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5750,
        day_open: 5700,
        day_high: 5760,
        day_low: 5690,
        day_range_pts: 70,
      },
    ]);

    // Call 14: flow_data — majority of AGREEMENT_SOURCES have positive ncp → bullish
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '-50000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '150000' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('computes flow_was_directional=null when bullish/bearish counts are tied', async () => {
    const DATE = '2026-03-24';
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: buildFeaturesForDate → empty
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 12: analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 71,
        full_response: JSON.stringify({
          review: { wasCorrect: false },
          chartConfidence: {},
        }),
      },
    ]);

    // Call 13: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5720,
        day_open: 5700,
        day_high: 5740,
        day_low: 5690,
        day_range_pts: 50,
      },
    ]);

    // Call 14: flow_data — equal bullish and bearish counts → tie → null direction
    // 4 positive, 4 negative, 1 zero (ignored) → tie
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '-300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '-200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '-150000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '-300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '0' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });

  it('computes flow_was_directional=false when bearish flow contradicts UP settlement', async () => {
    const DATE = '2026-03-24';
    const t2 = '2026-03-24T14:30:00.000Z';

    // Call 1: SELECT DISTINCT date
    mockSql.mockResolvedValueOnce([{ date: DATE }]);
    // Calls 2-8: buildFeaturesForDate → empty
    for (let i = 0; i < 7; i++) mockSql.mockResolvedValueOnce([]);
    // Call 9: economic events → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 10: next event → empty
    mockSql.mockResolvedValueOnce([]);
    // Call 11: upsertFeatures
    mockSql.mockResolvedValueOnce([]);

    // Call 12: analyses with review
    mockSql.mockResolvedValueOnce([
      {
        id: 72,
        full_response: JSON.stringify({
          review: {},
          chartConfidence: {},
        }),
      },
    ]);

    // Call 13: outcomes — settlement > open → UP
    mockSql.mockResolvedValueOnce([
      {
        settlement: 5730,
        day_open: 5700,
        day_high: 5740,
        day_low: 5680,
        day_range_pts: 60,
      },
    ]);

    // Call 14: flow_data — majority bearish (DOWN flow) but settlement is UP → disagreement
    mockSql.mockResolvedValueOnce([
      { timestamp: t2, source: 'market_tide', ncp: '-500000' },
      { timestamp: t2, source: 'market_tide_otm', ncp: '-300000' },
      { timestamp: t2, source: 'spx_flow', ncp: '-400000' },
      { timestamp: t2, source: 'spy_flow', ncp: '-200000' },
      { timestamp: t2, source: 'qqq_flow', ncp: '-100000' },
      { timestamp: t2, source: 'spy_etf_tide', ncp: '50000' },
      { timestamp: t2, source: 'qqq_etf_tide', ncp: '-80000' },
      { timestamp: t2, source: 'zero_dte_index', ncp: '-300000' },
      { timestamp: t2, source: 'zero_dte_greek_flow', ncp: '-150000' },
    ]);

    // Call 15: upsertLabels
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { backfill: 'true' },
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ labelsExtracted: 1 });
  });
});
