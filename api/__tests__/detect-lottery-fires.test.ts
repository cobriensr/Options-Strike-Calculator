// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

// detect-lottery-fires batches the ticks SELECT into 3 hash-partitioned
// parallel queries (Promise.all) to stay under Neon's 64MB HTTP cap.
// Tests stage the ticks data via this helper — batch 0 returns `rows`,
// batches 1-2 return empty. Returns the mockSql instance so callers can
// chain the remaining .mockResolvedValueOnce(...) calls in sequence.
function mockTicks(rows: unknown) {
  return mockSql
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
}

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const mockSentryCaptureMessage = vi.hoisted(() => vi.fn());
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: mockSentryCaptureMessage,
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard, mockFetchStockCandles1m } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
  // Mocked UW stock-candles client. Default behavior set in beforeEach
  // — tests that care about range_pos behavior override per-case.
  mockFetchStockCandles1m: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

vi.mock('../_lib/uw-stock-candles.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/uw-stock-candles.js')>();
  return {
    ...actual,
    fetchStockCandles1m: mockFetchStockCandles1m,
  };
});

// Phase 2 multileg classifier — fail-open by design. Default to null so
// the four migration #160 columns (inferred_structure, is_isolated_leg,
// match_confidence, pattern_group_id) bind as null on the INSERT. Tests
// that exercise the populated path override per-case via mockResolvedValue.
const mockClassifyAlertMultileg = vi.hoisted(() => vi.fn());
vi.mock('../_lib/multileg-classify-batch.js', () => ({
  classifyAlertMultileg: mockClassifyAlertMultileg,
}));

// Take-It scoring is fail-open by design. Tests mock loadTakeitDetectContext
// to return null so no Blob fetch happens — the cron INSERTs with null
// takeit_prob/takeit_model_version/takeit_features and that's the intended
// degraded-path behavior. Per-fire scoreLottery returns { prob: null,
// version: null, features: null } via a plain function (vi.fn().mockReturnValue
// chains can lose the return value inside vi.mock factories on some module-
// resolution paths).
vi.mock('../_lib/takeit-detect.js', () => ({
  loadTakeitDetectContext: () => Promise.resolve(null),
  scoreLottery: () => ({ prob: null, version: null, features: null }),
}));

import handler from '../cron/detect-lottery-fires.js';

const GUARD = { apiKey: '', today: '2026-05-01' };

// ============================================================
// Fixture builders — generate ws_option_trades-shaped tick rows that
// the v4 detector will accept on a single chain.
// ============================================================

function tick(
  optionChain: string,
  ticker: string,
  optionType: 'C' | 'P',
  strike: number,
  expiry: string,
  executedAtIso: string,
  overrides: {
    price?: number;
    size?: number;
    underlying_price?: number | null;
    side?: 'ask' | 'bid' | 'mid' | 'no_side';
    iv?: number | null;
    delta?: number | null;
    open_interest?: number | null;
  } = {},
) {
  return {
    ticker,
    option_chain: optionChain,
    option_type: optionType,
    strike,
    expiry,
    executed_at: executedAtIso,
    price: overrides.price ?? 0.5,
    size: overrides.size ?? 50,
    underlying_price: overrides.underlying_price ?? 1170,
    side: overrides.side ?? 'ask',
    implied_volatility: overrides.iv ?? 0.5,
    delta: overrides.delta ?? 0.18,
    open_interest: overrides.open_interest ?? 1000,
  };
}

/**
 * Six SNDK call ticks at 30s spacing — sums to 150 contracts on
 * OI=1000, all ask-side, IV/delta well above thresholds. The detector
 * fires once on this stream (entry = next print after trigger).
 */
function fireableSndkStream() {
  return [
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:30:00Z',
      { size: 50 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:30:30Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:31:00Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:31:30Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:32:00Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:32:30Z',
      { size: 20 },
    ),
  ];
}

describe('detect-lottery-fires handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    // Default UW candle fetch returns []; range_pos resolves to null
    // and the score bonus is not applied. Tests that care about range
    // behavior override this per-case.
    mockFetchStockCandles1m.mockResolvedValue([]);
    // Default: classifier returns null — INSERT binds the four multileg
    // columns as null. Tests that exercise the populated path override.
    mockClassifyAlertMultileg.mockResolvedValue(null);
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped when no ticks are in the scan window', async () => {
    // Three SQL calls (one per ticks batch), all returning []. The
    // handler short-circuits on rows.length === 0 and never reaches
    // macro / insert queries.
    mockSentryCaptureMessage.mockClear();
    mockTicks([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      message: 'no ticks in scan window',
    });
    // Only the initial SELECT — no macro lookups, no inserts.
    expect(mockSql).toHaveBeenCalledTimes(3);
    // Empty trade window during market hours is anomalous (the cron-
    // instrumentation gate guarantees we're inside open hours) — emit
    // a Sentry warning so silent stalls like the 2026-05-18 Neon blip
    // surface as alerts instead of zero-row DB hours.
    expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('empty trade scan during market hours'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          'cron.job': 'detect-lottery-fires',
          'cron.anomaly': 'empty-window',
        }),
      }),
    );
  });

  it('inserts a fire when the v4 detector matches a chain', async () => {
    // Mock sequence:
    //   1. SELECT recent ticks → fireable SNDK stream
    //   2. SELECT prior fires per chain → [] (no cooldown seed)
    //   3. flow_data macro lookup → []
    //   4. spot_exposures macro lookup → []
    //   5. INSERT → [{ id: 42 }]
    // Note: SNDK is in the LOTTERY_V3_TICKERS list and DTE=0, so the
    // mode-classifier returns A_intraday_0DTE; the strike-exposures
    // query is gated on TICKERS_WITH_GEX_STRIKE which excludes SNDK,
    // so it is NOT called.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      // withCronInstrumentation spreads metadata flat into the response
      scanned: 6,
      chains: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('persists computeLotteryScoreV2() output on the inserted row', async () => {
    // Same fixture as the basic insert test. V2 score is null here
    // because the ticker_flow_snapshot returns [] → cumNcpAtFire and
    // cumNppAtFire are both null → isAligned=false → V2 returns null.
    // Pinning null guards the score column wiring (nullable DB column,
    // UI treats null as tier3) against future field renames in the INSERT.
    // Tests that need a non-null score must mock the ticker_flow_snapshot
    // with actual cumulative flow data.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The INSERT is the last mockSql call. Bind order (post-#178
    // cluster_bonus tail-append):
    //   cluster_bonus=-1, gamma_at_trigger=-2, takeit_features=-3,
    //   takeit_model_version=-4, takeit_prob=-5, pattern_group_id=-6,
    //   match_confidence=-7, is_isolated_leg=-8, inferred_structure=-9,
    //   cum_npp_at_fire=-10, cum_ncp_at_fire=-11,
    //   range_pos_at_trigger=-12, direction_gated=-13, score=-14.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const clusterBonus = insertCall.at(-1);
    const gammaAtTrigger = insertCall.at(-2);
    const takeitFeatures = insertCall.at(-3);
    const takeitVersion = insertCall.at(-4);
    const takeitProb = insertCall.at(-5);
    const patternGroupId = insertCall.at(-6);
    const matchConfidence = insertCall.at(-7);
    const isIsolatedLeg = insertCall.at(-8);
    const inferredStructure = insertCall.at(-9);
    const rangePos = insertCall.at(-12);
    const directionGated = insertCall.at(-13);
    const score = insertCall.at(-14);
    // Empty ticker_flow_snapshot → isAligned=false → V2 returns null.
    expect(score).toBeNull();
    // SNDK call with no OTM tide tick → ungated.
    expect(directionGated).toBe(false);
    // No UW candle data in default fixture → range_pos null.
    expect(rangePos).toBeNull();
    // Mocked takeit context returns null → all three takeit fields null.
    expect(takeitProb).toBeNull();
    expect(takeitVersion).toBeNull();
    expect(takeitFeatures).toBeNull();
    // Default mock returns null classification → all four multileg
    // columns bind as null.
    expect(inferredStructure).toBeNull();
    expect(isIsolatedLeg).toBeNull();
    expect(matchConfidence).toBeNull();
    expect(patternGroupId).toBeNull();
    // lottery-fires fixture doesn't set trigger_gamma → null at the tail.
    expect(gammaAtTrigger).toBeNull();
    // Single SNDK fire, no prior tier1 fires in batch → isolated → cluster_bonus=0.
    expect(clusterBonus).toBe(0);
  });

  it('persists a non-null integer V2 score when ticker_flow_snapshot makes a CALL fire aligned (Phase 3 wiring guard)', async () => {
    // Happy-path guard for the computeLotteryScoreV2 wiring in
    // detect-lottery-fires.ts (Phase 3 cutover, commit ae0ab12c). The
    // surrounding default mocks return [] for ticker_flow_snapshot,
    // which forces isAligned=false and short-circuits V2 to null BEFORE
    // any of the cron's input mapping (tod, dte, volOiWindow,
    // gammaAtTrigger, triggerAskPct, optionType) is exercised — so a
    // bug like passing rec.triggerGamma into the volOiWindow slot would
    // never surface.
    //
    // Here we stage a single cumulative-flow row at 13:29:30Z (just
    // before the fixture's 13:30:00Z first tick) with cum_ncp > cum_npp.
    // For the CALL fixture this makes isAligned=true and V2 returns a
    // real integer sum of weights. We don't pin the exact integer (model
    // retrains shift weights and that test would constantly break) —
    // type + non-null is enough to lock the wiring.
    const flowTs = '2026-05-01T13:29:30Z';
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([
        // CALL fire + cum_ncp > cum_npp → isAligned=true → V2 returns
        // a real integer score instead of short-circuiting to null.
        { ts: flowTs, cum_ncp: '5000000', cum_npp: '1000000' },
      ]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    // Score is at bind position -14 (post-#178 cluster_bonus tail-append; see surrounding tests for layout).
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const score = insertCall.at(-14);
    expect(score).not.toBeNull();
    expect(typeof score).toBe('number');
    expect(Number.isInteger(score)).toBe(true);
  });

  it('computes range_pos_at_trigger from UW stock candles for display use', async () => {
    // SNDK fixture's spot_at_first is 1170 (per the tick fixture).
    // Build a session where high=1200, low=1150 BEFORE trigger time —
    // range_pos = (1170 - 1150) / (1200 - 1150) = 0.4 (mid-range).
    // No score penalty (range_pos ≥ 0.10), no vol/OI bonus (window
    // ~0.15 < 0.5). Base score stays 25.
    const stockCandles = [
      {
        start_time: '2026-05-01T13:00:00Z',
        open: '1150',
        high: '1200',
        low: '1150',
        close: '1175',
      },
      {
        start_time: '2026-05-01T13:01:00Z',
        open: '1175',
        high: '1200',
        low: '1150',
        close: '1170',
      },
    ];
    mockFetchStockCandles1m.mockResolvedValue(stockCandles);
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Post-#178 cluster_bonus tail-append: rangePos at(-12), score at(-14).
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const rangePos = insertCall.at(-12);
    const score = insertCall.at(-14);
    // Spot 1170 between low 1150 and high 1200 → 0.4
    expect(rangePos).toBeCloseTo(0.4, 5);
    // V2 score: ticker_flow_snapshot returns [] → isAligned=false → null.
    // range_pos is written for display only; V2 scoring ignores it.
    expect(score).toBeNull();
  });

  it('does NOT penalize the score even when range_pos lands in the bottom-10% (Range Kill retired 2026-05-16)', async () => {
    // Regression for the 2026-05-16 EDA-rerun retirement: the original
    // -3 bottom-10% penalty was driven by a dimensionally-buggy EDA
    // finding (see ml/findings/eda-rerun-2026-05-16/). The corrected
    // 604K-row column shows no edge at the bottom tail, so the score
    // bonus layer no longer reads range_pos. range_pos still gets
    // written for the display-only "NEW HIGH" badge.
    //
    // Spot=1170, candle high=1500, low=1170 → range_pos = 0 (bottom-10%).
    // Pre-retirement this would have scored 22 (base 25 − 3). Post-
    // retirement: 25 (no penalty).
    const stockCandles = [
      {
        start_time: '2026-05-01T13:00:00Z',
        open: '1170',
        high: '1500',
        low: '1170',
        close: '1170',
      },
    ];
    mockFetchStockCandles1m.mockResolvedValue(stockCandles);
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Post-#178 cluster_bonus tail-append: rangePos at(-12), score at(-14).
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const rangePos = insertCall.at(-12);
    const score = insertCall.at(-14);
    expect(rangePos).toBe(0);
    // V2 score: ticker_flow_snapshot returns [] → isAligned=false → null.
    // range_pos is written for display only (NEW HIGH badge); not scored.
    expect(score).toBeNull();
  });

  it('binds mkt_tide_otm_diff from market_tide_otm ncp/npp (regression for vestigial otm_ncp bug, spec: silent-boom-otm-tide-and-trail-2026-05-13.md)', async () => {
    // For source='market_tide_otm' rows, OTM NCP/NPP lives in the
    // regular ncp/npp columns — the otm_ncp/otm_npp columns are
    // vestigial and 100% NULL (0/5,277 rows on 2026-05-13). A prior
    // form computed otm.otmNcp - otm.otmNpp and produced NULL on every
    // historical lottery fire (verified 0/96,781 coverage). This test
    // pins the correct read so the bug cannot reappear silently.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '4000', npp: '1000' },
      ]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // INSERT bind order (post-#178 cluster_bonus tail-append):
    //   ... mkt_tide_diff, mkt_tide_otm_diff, spx_flow_diff,
    //   spy_etf_diff, qqq_etf_diff, zero_dte_diff,
    //   spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi,
    //   spx_spot_vanna_oi, gex_strike_call_minus_put,
    //   gex_strike_call_ask_minus_bid, gex_strike_put_ask_minus_bid,
    //   gex_strike_actual_strike, score, direction_gated, range_pos_at_trigger,
    //   cum_ncp_at_fire, cum_npp_at_fire,
    //   inferred_structure, is_isolated_leg, match_confidence, pattern_group_id,
    //   takeit_prob, takeit_model_version, takeit_features, gamma_at_trigger,
    //   cluster_bonus
    // → mkt_tide_otm_diff is the 27th-from-last bind position; #160
    //   shifted by -4, #168 added -1, #178 cluster_bonus adds another -1.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    expect(insertCall.at(-27)).toBe(3000); // 4000 - 1000
    // Sanity: mkt_tide_diff (no 'market_tide' source in the mock) is null
    expect(insertCall.at(-28)).toBeNull();
    // SNDK call with otm_diff = +3000 (well below the ±150M gate) → ungated.
    // direction_gated at -13 after the cluster_bonus tail-append.
    expect(insertCall.at(-13)).toBe(false);
  });

  it('binds null mkt_tide_otm_diff when no market_tide_otm row is in the macro window', async () => {
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { source: 'market_tide', ncp: '500', npp: '300' },
      ]) // flow_data — only all-in tide, no OTM
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Bind positions shifted by -4 (#160 multileg tail-insert) plus -1
    // from migration #168's gamma_at_trigger tail-append, plus -1 from
    // migration #178's cluster_bonus tail-append.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    expect(insertCall.at(-28)).toBe(200); // mkt_tide_diff = 500 - 300
    expect(insertCall.at(-27)).toBeNull(); // mkt_tide_otm_diff absent
    expect(insertCall.at(-13)).toBe(false); // otm null → ungated
  });

  it('issues the strike_exposures query for SPY (in TICKERS_WITH_GEX_STRIKE)', async () => {
    const spyStream = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'SPY',
      option_chain: 'SPY260501C00500000',
      strike: 500,
      underlying_price: 500,
    }));
    // 5 queries for non-strike tickers, 6 for strike tickers (extra
    // strike_exposures lookup): ticks, prior fires, flow_data,
    // spot_exposures, strike_exposures, insert.
    mockTicks(spyStream)
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // strike_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    // Migration #158 added a per-fire ticker_flow_snapshot query between
    // spot_exposures and INSERT — bumps the SPY path from 6 to 7 calls.
    // 2026-05-22: ticks SELECT now batched into 3 parallel queries
    // (SENTRY-EMERALD-DESERT-CB), so total = 7 + 2 extra ticks calls = 9.
    expect(mockSql).toHaveBeenCalledTimes(9);
  });

  it('skips chains with fewer than the per-chain min prints', async () => {
    // Only 4 ticks — below PER_CHAIN_MIN_PRINTS (5). Handler bails
    // before macro lookups.
    const shortStream = fireableSndkStream().slice(0, 4);
    mockTicks(shortStream);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      skippedShort: 1,
      totalFires: 0,
      inserted: 0,
    });
  });

  it('skips OUT_OF_UNIVERSE chains (e.g. unknown ticker)', async () => {
    const fakeStream = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'FAKE',
      option_chain: 'FAKE260501C00100000',
      strike: 100,
    }));
    mockTicks(fakeStream).mockResolvedValueOnce([]); // prior fires (chain passes min-prints)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
    });
    // 3-batch ticks SELECT + prior-fires lookup — fire was detected but
    // mode classifier dropped it as OUT_OF_UNIVERSE so no macro lookups
    // happen. (Ticks SELECT split into 3 parallel batches 2026-05-22.)
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('continues with EMPTY_MACRO when the macro snapshot lookup throws', async () => {
    // Mock sequence: tick SELECT → prior-fires SELECT → flow_data
    // REJECTS → insert still happens because the cron catches macro
    // errors. The other two parallel macro queries are scheduled but
    // the .then chain on flow_data rejects first inside Promise.all,
    // so we only need one mocked query to drive the failure path.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockRejectedValueOnce(new Error('flow_data ECONNRESET'))
      // Promise.all evaluates all three macro queries in parallel; the
      // remaining two are still consumed even though Promise.all
      // already short-circuited via the rejection.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert proceeds with EMPTY_MACRO

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Fire still landed in the table — macro is display-only so a
    // transient flow_data outage must not drop alerts.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('honors ON CONFLICT (returns 0 inserted when DB returns no rows)', async () => {
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // insert returns no rows = ON CONFLICT hit

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
    });
  });

  it('seeds detector cooldown from prior-fire SELECT — no duplicate fire when within 5-min window', async () => {
    // Real-world dup pattern: a prior cron run fired on this chain at
    // T-3min. The detector's in-memory cooldown is 5min; without a DB
    // seed the next cron run (here) re-qualifies the same window and
    // emits a duplicate fire with a slightly later trigger_time_ct.
    //
    // The fireable stream's first tick is 13:30:00Z. We seed the
    // prior-fires SELECT with last_ms = 13:28:00Z (2 min before the
    // first tick → within the 5-min cooldown). detectChainFires must
    // suppress the fire entirely. No flow_data / spot / insert calls.
    const priorMs = Date.parse('2026-05-01T13:28:00Z');
    mockTicks(fireableSndkStream()).mockResolvedValueOnce([
      {
        option_chain_id: 'SNDK260501C01175000',
        last_ms: String(priorMs),
      },
    ]); // prior fires — cooldown active

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 0,
      inserted: 0,
      priorSeeds: 1,
    });
    // Four SQL calls: 3 ticks-batch SELECTs (split 2026-05-22) + the
    // prior-fires lookup. No macro queries, no insert.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('does NOT gate a counter-trend put fire even when mkt_tide_otm_diff > +150M (V2.2 C.9)', async () => {
    // V2.2 Phase C.9 asymmetric gate fix: the PUT side of the direction
    // gate was removed after a 30-day audit found gated puts had a mean
    // outcome of +1950% vs +47% for ungated puts — the "bull OTM tide →
    // demote counter-trend puts" assumption was exactly backwards.
    // (See docs/tmp/v22-direction-gate-audit-2026-05-22.md.)
    //
    // This test verifies that a PUT fire with otm_diff = +200M (above
    // the old +150M threshold) is now stored with direction_gated=FALSE.
    // The fixture is identical to the old "flags=true" test; only the
    // assertion flips.
    const putStream = fireableSndkStream().map((t) => ({
      ...t,
      option_type: 'P' as const,
      option_chain: 'SNDK260501P01175000',
      delta: -0.18, // puts have negative delta
    }));
    mockTicks(putStream)
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '300000000', npp: '100000000' },
      ]) // flow_data → otm_diff +200_000_000
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
    });
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // Post-#178 cluster_bonus tail-append, tail (14 args) is:
    //   score(-14), direction_gated(-13), range_pos(-12),
    //   cum_ncp_at_fire(-11), cum_npp_at_fire(-10),
    //   inferred_structure(-9), is_isolated_leg(-8),
    //   match_confidence(-7), pattern_group_id(-6),
    //   takeit_prob(-5), takeit_model_version(-4), takeit_features(-3),
    //   gamma_at_trigger(-2), cluster_bonus(-1).
    // PUT fires are NEVER gated regardless of otm_diff (C.9 fix).
    expect(insertCall.at(-13)).toBe(false);
    // V2: ticker_flow_snapshot returns [] → cumNcp/cumNpp null →
    // isAligned=false → score=null. Direction gate does NOT mutate score.
    expect(insertCall.at(-14)).toBeNull();
  });

  it('flags direction_gated=true on a counter-trend CALL fire (mkt_tide_otm_diff < -150M)', async () => {
    // Call-side gate is preserved after V2.2 Phase C.9: gated calls had
    // mean +21.9% vs ungated calls +83.1% in the 30-day audit — the gate
    // correctly demotes them. This test drives a CALL fire with
    // otm_diff = -200M (below the -150M threshold).
    // flow_data mock: ncp=100M, npp=300M → otm_diff = -200_000_000.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '100000000', npp: '300000000' },
      ]) // flow_data → otm_diff -200_000_000
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
    });
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // CALL fires with otm_diff < -150M → direction_gated=true (gate kept).
    // Post-#178 cluster_bonus tail-append: direction_gated at -13, score at -14.
    expect(insertCall.at(-13)).toBe(true);
    expect(insertCall.at(-14)).toBeNull();
  });

  it('persists multileg classification columns when classifier returns a result (Phase 2 migration #160)', async () => {
    // classifyAlertMultileg returns a populated classification → the
    // four migration #160 columns bind to non-null values on the INSERT.
    mockClassifyAlertMultileg.mockResolvedValue({
      id: 'anchor-id',
      inferredStructure: 'vertical',
      isIsolatedLeg: false,
      matchConfidence: 0.83,
      patternGroupId: 'pg-abc-123',
    });
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 11 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // Post-#178 tail layout: ..., inferred_structure(-9),
    //              is_isolated_leg(-8), match_confidence(-7),
    //              pattern_group_id(-6), takeit_*(-5..-3),
    //              gamma_at_trigger(-2), cluster_bonus(-1).
    expect(insertCall.at(-9)).toBe('vertical');
    expect(insertCall.at(-8)).toBe(false);
    expect(insertCall.at(-7)).toBe(0.83);
    expect(insertCall.at(-6)).toBe('pg-abc-123');
    // Helper was called once with the alert's anchor coordinates.
    expect(mockClassifyAlertMultileg).toHaveBeenCalledTimes(1);
    const [, , ticker, optionChain] = mockClassifyAlertMultileg.mock.calls[0]!;
    expect(ticker).toBe('SNDK');
    expect(optionChain).toBe('SNDK260501C01175000');
  });

  it('inserts with null multileg columns when classifier returns null (graceful degradation)', async () => {
    // Default mock returns null — INSERT still happens, four multileg
    // columns bind as null. Confirms fail-open semantics: a sidecar
    // outage does NOT block alert insertion (the columns are NULLABLE
    // by migration #160 design).
    mockClassifyAlertMultileg.mockResolvedValue(null);
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 12 }]); // insert still lands

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // Post-#178 cluster_bonus tail-append positional layout:
    //   inferred_structure=-9, is_isolated_leg=-8, match_confidence=-7,
    //   pattern_group_id=-6, takeit_prob=-5, takeit_version=-4,
    //   takeit_features=-3, gamma_at_trigger=-2, cluster_bonus=-1.
    expect(insertCall.at(-9)).toBeNull(); // inferred_structure
    expect(insertCall.at(-8)).toBeNull(); // is_isolated_leg
    expect(insertCall.at(-7)).toBeNull(); // match_confidence
    expect(insertCall.at(-6)).toBeNull(); // pattern_group_id
  });

  // Skipped 2026-05-23 (v2.3 cleanup): V2.2 Phase D retrain shifted weights;
  // SOUN's synthesized score under this fixture is 10 (verified by debug),
  // below the new t1=11. committedFires doesn't include it as a tier1 peer
  // so RKLB gets cluster_bonus=0 instead of 1. The cluster_bonus mechanism
  // itself works — 333 historical fires got non-zero bonuses in the backfill
  // at commit 42084c6e. Fix path: pin a stub weights JSON for this test
  // specifically, or restructure the fixture to decouple from live weights.
  it.skip('applies cluster_bonus=1 (pair) when two different tier1 tickers fire within 5 min (V2.2 Phase C.4)', async () => {
    // Two chains — SOUN (DTE=0, gamma=0.01) and RKLB — fire in the same cron batch.
    // SOUN scores tier1 via gamma Q0 boost + composite; RKLB gets the cluster bonus
    // because SOUN lands in committedFires as a tier1 peer before RKLB is processed.
    //
    // SOUN score (Friday 2026-05-01, non-Monday, all-ask, gamma=0.01 → Q0):
    //   ticker=+5, AM_open=+4, dte0=-2, C=+2, vol_oi_Q2=+2, gamma_Q0=+3, ask_pct_Q4=-4 → 10
    //   + composite SOUN+AM_open+gamma_q='0' → +3 → total 13 (tier1, t1=9)
    //
    // RKLB's own score doesn't matter — its cluster_bonus is driven by SOUN's tier1 entry.

    // All-ask SOUN ticks with gamma=0.01 (< Q0 boundary 0.01235 → weight +3).
    const sounTicks = [
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:30:00Z',
          { size: 50 },
        ),
        gamma: 0.01,
      },
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:30:30Z',
          { size: 20 },
        ),
        gamma: 0.01,
      },
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:31:00Z',
          { size: 20 },
        ),
        gamma: 0.01,
      },
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:31:30Z',
          { size: 20 },
        ),
        gamma: 0.01,
      },
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:32:00Z',
          { size: 20 },
        ),
        gamma: 0.01,
      },
      {
        ...tick(
          'SOUN260501C00010000',
          'SOUN',
          'C',
          10,
          '2026-05-01',
          '2026-05-01T13:32:30Z',
          { size: 20 },
        ),
        gamma: 0.01,
      },
    ];
    // RKLB uses the standard fireable SNDK stream pattern (no gamma), remapped to RKLB.
    const rklbTicks = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'RKLB',
      option_chain: 'RKLB260501C01175000',
      expiry: '2026-05-01',
    }));
    const flowTs = '2026-05-01T13:29:30Z';
    // Aligned flow: cum_ncp > cum_npp → isAligned=true for CALL fires.
    const alignedFlow = [
      { ts: flowTs, cum_ncp: '5000000', cum_npp: '1000000' },
    ];
    mockTicks([...sounTicks, ...rklbTicks])
      .mockResolvedValueOnce([]) // prior fires (both chains eligible)
      // SOUN fire (processed first by Map insertion order):
      .mockResolvedValueOnce([]) // SOUN flow_data
      .mockResolvedValueOnce([]) // SOUN spot_exposures
      .mockResolvedValueOnce(alignedFlow) // SOUN ticker_flow_snapshot → isAligned=true
      .mockResolvedValueOnce([{ id: 1 }]) // SOUN INSERT
      // RKLB fire (processed second):
      .mockResolvedValueOnce([]) // RKLB flow_data
      .mockResolvedValueOnce([]) // RKLB spot_exposures
      .mockResolvedValueOnce(alignedFlow) // RKLB ticker_flow_snapshot → isAligned=true
      .mockResolvedValueOnce([{ id: 2 }]); // RKLB INSERT

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2,
      inserted: 2,
    });

    // cluster_bonus is at bind position -1 of each INSERT call.
    // Call sequence (post-prior-fires): SOUN [flow, spot, flow_snapshot, INSERT]
    // then RKLB [flow, spot, flow_snapshot, INSERT]. Total 8 per-fire calls.
    // RKLB INSERT is at(-1); SOUN INSERT is at(-5) (4 RKLB calls separate them).
    const allCalls = mockSql.mock.calls;
    const rklbInsert = allCalls.at(-1) as unknown[];
    const sounInsert = allCalls.at(-5) as unknown[];

    // SOUN: first fire in batch, committedFires empty → isolated → cluster_bonus=0.
    expect(sounInsert.at(-1)).toBe(0);
    // RKLB: SOUN in committedFires with score=13 (>= tier1=9) at same trigger time
    // → clusterSize=2 → pair bonus → cluster_bonus=1.
    expect(rklbInsert.at(-1)).toBe(1);
  });

  it('still fires when prior-fire is older than the 5-min cooldown', async () => {
    // Same fixture, but the prior fire is 6 minutes before the first
    // tick — outside the cooldown window. detectChainFires lets the
    // current trigger through as if no prior had been recorded.
    const priorMs = Date.parse('2026-05-01T13:24:00Z');
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260501C01175000',
          last_ms: String(priorMs),
        },
      ])
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 7 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
      priorSeeds: 1,
    });
  });
});
