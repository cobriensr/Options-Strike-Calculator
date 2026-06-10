// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import {
  expectAllGexBindsNull,
  extractAllInsertBinds,
  extractInsertBinds,
} from './insert-binds';

const mockSql = vi.fn();

// `db.unsafe(raw)` → raw-SQL marker (mirrors neon's UnsafeRawSql; the feed-
// tier monitor splices INVERSION_BONUS_CASE_SQL via db.unsafe). The mockSql
// tagged template ignores its actual SQL (returns canned rows), so this just
// needs to be a non-throwing passthrough.
(mockSql as unknown as { unsafe: (raw: string) => { raw: string } }).unsafe = (
  raw: string,
) => ({ raw });

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

// GexBot context lookup is fail-open (migration #181). Default the
// helper to return null so the INSERT writes NULL into the gex_*
// columns and the SQL call count stays stable. Real-world fixtures
// where a snapshot was found are tested in the gexbot-queries unit
// tests; here we only need the integration-level no-snapshot path
// plus the populated-path assertion below.
const mockGetLatestGexbotSnapshotAt = vi.hoisted(() => vi.fn());
const mockMapToGexbotTicker = vi.hoisted(() => vi.fn());
vi.mock('../_lib/gexbot-queries.js', () => ({
  getLatestGexbotSnapshotAt: mockGetLatestGexbotSnapshotAt,
  mapToGexbotTicker: mockMapToGexbotTicker,
}));

// V2 score override hook. `mockComputeLotteryScoreV2` defaults to null,
// in which case the wrapper delegates to the REAL computeLotteryScoreV2
// (preserving live-weight behavior for every existing test). The
// cluster-bonus symmetry test sets a fixed numeric return so the bonus
// path is exercised without pinning the test to a specific weights
// retrain. LOTTERY_TIER_THRESHOLDS_V2 is passed through unchanged so the
// cluster t1 gate + feed-tier monitor keep their real cutoffs. The real
// fn is captured inside the factory (not re-imported) to avoid recursing
// back into this same mocked binding.
const mockComputeLotteryScoreV2 = vi.hoisted(() => ({
  override: null as number | null,
}));
vi.mock('../_lib/lottery-score-weights-v2.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../_lib/lottery-score-weights-v2.js')
    >();
  const real = actual.computeLotteryScoreV2;
  return {
    ...actual,
    computeLotteryScoreV2: (
      args: Parameters<typeof actual.computeLotteryScoreV2>[0],
    ) =>
      mockComputeLotteryScoreV2.override !== null
        ? mockComputeLotteryScoreV2.override
        : real(args),
  };
});

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
    // Default: pass-through ticker mapping (lookup fires even on tickers
    // outside GexBot universe); lookup returns null so the gex_* binds
    // resolve to NULL. Tests that exercise the populated path override.
    mockMapToGexbotTicker.mockImplementation((t: string) => t);
    mockGetLatestGexbotSnapshotAt.mockResolvedValue(null);
    // Default: no override → delegate to the real V2 score so every
    // existing test keeps its live-weight behavior. The cluster-bonus
    // test sets a numeric override.
    mockComputeLotteryScoreV2.override = null;
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped + warns when no ticks are in the scan window (active session)', async () => {
    // Three SQL calls (one per ticks batch), all returning []. The
    // handler short-circuits on rows.length === 0 and never reaches
    // macro / insert queries.
    // Fake only the clock to a clearly-active session time (11:00 ET) so
    // the isPastCashOpen() gate on the empty-window warning is satisfied
    // deterministically regardless of when CI runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-29T15:00:00Z')); // 11:00 ET, active
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
    // Empty trade window during active market hours is anomalous — emit
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
    vi.useRealTimers();
  });

  it('returns skipped WITHOUT warning when the empty window is pre-open', async () => {
    // 13:29 UTC = 9:29 ET = 8:29 CT — inside the isMarketHours 5-min
    // pre-open buffer but before the cash open. An empty scan here is
    // normal (the tape has not started), so the anomaly warning must be
    // suppressed. This is the exact false-alarm from Sentry DESERT-98.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-29T13:29:00Z')); // 9:29 ET, pre-open
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
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
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

  it('feed-tier monitor counts today fires via the no-gamma qas (SQL-computed), matching the feed exactly', async () => {
    // After the insert loop, the cron queries today's fires and tiers them
    // through the EXACT feed logic. The monitor now reads the qas the SQL
    // computes — GREATEST(0, score + round_trip_score_deduct +
    // fire_count_score_adjustment) + inversion bonus — IDENTICAL to the feed's
    // qasExprText('f.'). It DELIBERATELY no longer reads combined_score (which
    // still folds in a +1 gamma CASE term the feed dropped), so the mock row
    // returns `qas` directly. tierFromQualityScore cutoffs are 13/10.
    //
    // Rows chosen to exercise every branch:
    //   qas 13 -> tier1
    //   qas 13 -> tier1  (bonus already folded into the SQL qas)
    //   qas 10 -> tier2
    //   qas  5 -> tier3
    //   gated (direction_gated=true)        -> tier3 (regardless of qas)
    //   null score                          -> tier3
    //   qas 12, HIGH-GAMMA boundary row     -> tier2  (NOT tier1)
    // The last row is the key regression guard: a high-gamma fire whose
    // combined_score would be 13 (qas-no-gamma 12 + the +1 gamma term) is
    // counted as tier2 — exactly what the feed displays now that gamma is
    // dropped. Under the old combined_score-reading monitor it would have
    // tipped to tier1 and diverged from the feed.
    // => feedTier1=2, feedTier2=2, feedTier3=3
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]) // insert
      .mockResolvedValueOnce([
        { score: 5, qas: 13, direction_gated: false, inversion_quintile: 3 },
        { score: 5, qas: 13, direction_gated: false, inversion_quintile: 5 },
        { score: 5, qas: 10, direction_gated: false, inversion_quintile: 3 },
        { score: 5, qas: 5, direction_gated: false, inversion_quintile: 3 },
        { score: 5, qas: 20, direction_gated: true, inversion_quintile: 3 },
        { score: null, qas: 8, direction_gated: false, inversion_quintile: 5 },
        // HIGH-GAMMA boundary: no-gamma qas 12 (feed shows tier2). If the
        // monitor still read combined_score it would see 13 -> tier1.
        { score: 11, qas: 12, direction_gated: false, inversion_quintile: 3 },
      ]); // post-loop feed-tier monitor query

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      feedTier1: 2,
      feedTier2: 2,
      feedTier3: 3,
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
    // Named-bind extraction (see api/__tests__/insert-binds.ts) keeps
    // this test stable across future column-adds — every migration
    // that tail-appends a column would otherwise force a fresh
    // offset-shift dance.
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    // Empty ticker_flow_snapshot → isAligned=false → V2 returns null.
    expect(binds.get('score')).toBeNull();
    // SNDK call with no OTM tide tick → ungated.
    expect(binds.get('direction_gated')).toBe(false);
    // No UW candle data in default fixture → range_pos null.
    expect(binds.get('range_pos_at_trigger')).toBeNull();
    // Mocked takeit context returns null → all three takeit fields null.
    expect(binds.get('takeit_prob')).toBeNull();
    expect(binds.get('takeit_model_version')).toBeNull();
    expect(binds.get('takeit_features')).toBeNull();
    // Default mock returns null classification → all four multileg
    // columns bind as null.
    expect(binds.get('inferred_structure')).toBeNull();
    expect(binds.get('is_isolated_leg')).toBeNull();
    expect(binds.get('match_confidence')).toBeNull();
    expect(binds.get('pattern_group_id')).toBeNull();
    // lottery-fires fixture doesn't set trigger_gamma → null at the tail.
    expect(binds.get('gamma_at_trigger')).toBeNull();
    // Single SNDK fire, no prior tier1 fires in batch → isolated → cluster_bonus=0.
    expect(binds.get('cluster_bonus')).toBe(0);
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
    // Query order (two-pass, Fix 3): prior-fires → [Pass 1]
    // ticker_flow_snapshot (drives the score) → [Pass 2] flow_data,
    // spot_exposures → INSERT.
    const flowTs = '2026-05-01T13:29:30Z';
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        // CALL fire + cum_ncp > cum_npp → isAligned=true → V2 returns
        // a real integer score instead of short-circuiting to null.
        { ts: flowTs, cum_ncp: '5000000', cum_npp: '1000000' },
      ]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([]) // flow_data (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    const score = binds.get('score');
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    // Spot 1170 between low 1150 and high 1200 → 0.4
    expect(binds.get('range_pos_at_trigger')).toBeCloseTo(0.4, 5);
    // V2 score: ticker_flow_snapshot returns [] → isAligned=false → null.
    // range_pos is written for display only; V2 scoring ignores it.
    expect(binds.get('score')).toBeNull();
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

    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('range_pos_at_trigger')).toBe(0);
    // V2 score: ticker_flow_snapshot returns [] → isAligned=false → null.
    // range_pos is written for display only (NEW HIGH badge); not scored.
    expect(binds.get('score')).toBeNull();
  });

  it('binds mkt_tide_otm_diff from market_tide_otm ncp/npp (regression for vestigial otm_ncp bug, spec: silent-boom-otm-tide-and-trail-2026-05-13.md)', async () => {
    // For source='market_tide_otm' rows, OTM NCP/NPP lives in the
    // regular ncp/npp columns — the otm_ncp/otm_npp columns are
    // vestigial and 100% NULL (0/5,277 rows on 2026-05-13). A prior
    // form computed otm.otmNcp - otm.otmNpp and produced NULL on every
    // historical lottery fire (verified 0/96,781 coverage). This test
    // pins the correct read so the bug cannot reappear silently.
    // Query order (two-pass, Fix 3): prior-fires → ticker_flow_snapshot
    // (Pass 1) → flow_data, spot_exposures (Pass 2) → INSERT.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '4000', npp: '1000' },
      ]) // flow_data (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('mkt_tide_otm_diff')).toBe(3000); // 4000 - 1000
    // Sanity: mkt_tide_diff (no 'market_tide' source in the mock) is null
    expect(binds.get('mkt_tide_diff')).toBeNull();
    // SNDK call with otm_diff = +3000 (well below the ±150M gate) → ungated.
    expect(binds.get('direction_gated')).toBe(false);
  });

  it('binds null mkt_tide_otm_diff when no market_tide_otm row is in the macro window', async () => {
    // Query order (two-pass, Fix 3): prior-fires → ticker_flow_snapshot
    // (Pass 1) → flow_data, spot_exposures (Pass 2) → INSERT.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([
        { source: 'market_tide', ncp: '500', npp: '300' },
      ]) // flow_data — only all-in tide, no OTM (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('mkt_tide_diff')).toBe(200); // 500 - 300
    expect(binds.get('mkt_tide_otm_diff')).toBeNull();
    expect(binds.get('direction_gated')).toBe(false); // otm null → ungated
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
    // 2026-06-03: + the post-loop feed-tier monitor query (today's fires) = 10.
    expect(mockSql).toHaveBeenCalledTimes(10);
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
    // 2026-06-03: + the post-loop feed-tier monitor query = 5.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('continues with EMPTY_MACRO when the macro snapshot lookup throws', async () => {
    // Mock sequence (two-pass, Fix 3): tick SELECT → prior-fires →
    // [Pass 1] ticker_flow_snapshot → [Pass 2] flow_data REJECTS → insert
    // still happens because the cron catches macro errors. The other two
    // parallel macro queries are scheduled but the .then chain on
    // flow_data rejects first inside Promise.all, so we only need one
    // mocked query to drive the failure path.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockRejectedValueOnce(new Error('flow_data ECONNRESET')) // flow_data (Pass 2)
      // Promise.all evaluates all three macro queries in parallel; the
      // remaining one (spot_exposures) is still consumed even though
      // Promise.all already short-circuited via the rejection.
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
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
    // 2026-06-03: + the post-loop feed-tier monitor query = 5.
    expect(mockSql).toHaveBeenCalledTimes(5);
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
    // Query order (two-pass, Fix 3): prior-fires → ticker_flow_snapshot
    // (Pass 1) → flow_data, spot_exposures (Pass 2) → INSERT.
    mockTicks(putStream)
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '300000000', npp: '100000000' },
      ]) // flow_data → otm_diff +200_000_000 (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    // PUT fires are NEVER gated regardless of otm_diff (C.9 fix).
    expect(binds.get('direction_gated')).toBe(false);
    // V2: ticker_flow_snapshot returns [] → cumNcp/cumNpp null →
    // isAligned=false → score=null. Direction gate does NOT mutate score.
    expect(binds.get('score')).toBeNull();
  });

  it('flags direction_gated=true on a counter-trend CALL fire (mkt_tide_otm_diff < -150M)', async () => {
    // Call-side gate is preserved after V2.2 Phase C.9: gated calls had
    // mean +21.9% vs ungated calls +83.1% in the 30-day audit — the gate
    // correctly demotes them. This test drives a CALL fire with
    // otm_diff = -200M (below the -150M threshold).
    // flow_data mock: ncp=100M, npp=300M → otm_diff = -200_000_000.
    // Query order (two-pass, Fix 3): prior-fires → ticker_flow_snapshot
    // (Pass 1) → flow_data, spot_exposures (Pass 2) → INSERT.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([
        { source: 'market_tide_otm', ncp: '100000000', npp: '300000000' },
      ]) // flow_data → otm_diff -200_000_000 (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    // CALL fires with otm_diff < -150M → direction_gated=true (gate kept).
    expect(binds.get('direction_gated')).toBe(true);
    expect(binds.get('score')).toBeNull();
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('inferred_structure')).toBe('vertical');
    expect(binds.get('is_isolated_leg')).toBe(false);
    expect(binds.get('match_confidence')).toBe(0.83);
    expect(binds.get('pattern_group_id')).toBe('pg-abc-123');
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
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('inferred_structure')).toBeNull();
    expect(binds.get('is_isolated_leg')).toBeNull();
    expect(binds.get('match_confidence')).toBeNull();
    expect(binds.get('pattern_group_id')).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Task 6 / Finding 0.2 — multileg null-rate counters + Sentry alert.
  // Counters track the classifier's fail-open rate so a silent matcher
  // regression (5% → 95% null) surfaces operationally. The Sentry
  // capture fires ONLY when inserted > 10 AND hit-rate < 50%; low-volume
  // ticks (≤10 inserts) are protected from spurious alerting.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Build N independent firing chains by varying the strike on the
   * SNDK fixture. Each chain produces exactly one fire when paired with
   * the right SQL mock sequence. Used by the null-rate tests below to
   * cross the `inserted > 10` threshold without bespoke per-chain
   * fixtures.
   */
  function manyFireableSndkStreams(count: number) {
    const all: ReturnType<typeof tick>[] = [];
    for (let i = 0; i < count; i += 1) {
      const strike = 1175 + i;
      const chain = `SNDK260501C0${String(strike * 1000).padStart(7, '0')}`;
      const ticks = fireableSndkStream().map((t) => ({
        ...t,
        option_chain: chain,
        strike,
      }));
      all.push(...ticks);
    }
    return all;
  }

  /**
   * Queue the per-fire SQL mocks once per chain. With `inserted=true`
   * each chain returns `[{ id }]` from its INSERT; with `inserted=false`
   * the INSERT returns `[]` to simulate ON CONFLICT.
   *
   * Per-fire shape: flow_data + spot_exposures + INSERT. The
   * `ticker_flow_snapshot` lookup is cached per (ticker, date), so it
   * fires once on the FIRST SNDK fire only — every subsequent SNDK fire
   * hits the in-memory cache. `strike_exposures` is gated on
   * `TICKERS_WITH_GEX_STRIKE`, which excludes SNDK, so no DB call.
   */
  function queuePerFireMocks(count: number, inserted: boolean) {
    // Prior-fires lookup is one query at the start (covers all eligible
    // chains in a single ANY()), not per-fire.
    mockSql.mockResolvedValueOnce([]); // prior-fires
    for (let i = 0; i < count; i += 1) {
      mockSql
        .mockResolvedValueOnce([]) // flow_data
        .mockResolvedValueOnce([]); // spot_exposures
      if (i === 0) {
        mockSql.mockResolvedValueOnce([]); // ticker_flow_snapshot (cache miss on fire 0 only)
      }
      mockSql.mockResolvedValueOnce(inserted ? [{ id: 100 + i }] : []); // INSERT
    }
  }

  it('counts multilegHits when every classify call returns a populated result (no Sentry alert)', async () => {
    // 3 fires, every classify returns non-null → hits=3, misses=0,
    // inserted=3 (below the >10 alert threshold so no Sentry capture).
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue({
      id: 'anchor',
      inferredStructure: 'vertical',
      isIsolatedLeg: false,
      matchConfidence: 0.8,
      patternGroupId: 'pg-1',
    });
    mockTicks(manyFireableSndkStreams(3));
    queuePerFireMocks(3, true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      multilegHits: 3,
      multilegMisses: 0,
    });
    // No Sentry capture — inserted (3) is below the >10 protection floor.
    expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.anything(),
    );
  });

  it('captures Sentry warning when inserted>10 AND multileg hit-rate<50%', async () => {
    // 11 fires, classify returns null for every one → hits=0, misses=11.
    // Hit-rate 0 < 0.5 AND inserted=11 > 10 → captureMessage fires.
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue(null);
    mockTicks(manyFireableSndkStreams(11));
    queuePerFireMocks(11, true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      multilegHits: 0,
      multilegMisses: 11,
      inserted: 11,
    });
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          cron: 'detect-lottery-fires',
          multilegHits: 0,
          multilegMisses: 11,
          inserted: 11,
        }),
      }),
    );
  });

  it('does NOT capture Sentry warning at exactly 50% hit-rate (threshold is strict <)', async () => {
    // 12 fires, alternating hit/miss → hits=6, misses=6, ratio = 0.5.
    // Threshold check is `< 0.5`, so exactly-equal must NOT alert.
    mockSentryCaptureMessage.mockClear();
    let call = 0;
    mockClassifyAlertMultileg.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call % 2 === 1
          ? {
              id: 'anchor',
              inferredStructure: 'vertical',
              isIsolatedLeg: false,
              matchConfidence: 0.8,
              patternGroupId: 'pg-1',
            }
          : null,
      );
    });
    mockTicks(manyFireableSndkStreams(12));
    queuePerFireMocks(12, true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      multilegHits: 6,
      multilegMisses: 6,
      inserted: 12,
    });
    expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.anything(),
    );
  });

  it('does NOT capture Sentry warning at 100% miss rate when inserted<=10 (low-volume protection)', async () => {
    // Single fire, classify returns null → hit-rate 0% but inserted=1.
    // The >10 inserts gate suppresses the alert so quiet days don't page.
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue(null);
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
      inserted: 1,
      multilegHits: 0,
      multilegMisses: 1,
    });
    expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.anything(),
    );
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

  it('skips GexBot lookup and binds NULL gex_* when ticker is outside the GexBot universe', async () => {
    // Mirror of the Silent Boom out-of-universe test. mapToGexbotTicker
    // returns null → lookup MUST NOT fire → all 8 gex_* binds (last 8
    // positions of the INSERT) stay NULL.
    mockMapToGexbotTicker.mockReturnValue(null);
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
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    expect(mockGetLatestGexbotSnapshotAt).not.toHaveBeenCalled();
    expectAllGexBindsNull(extractInsertBinds(mockSql, 'lottery_finder_fires'));
  });

  it('fails open and binds NULL gex_* when the snapshot lookup throws', async () => {
    // Fail-open contract: a thrown error from getLatestGexbotSnapshotAt
    // MUST NOT block the INSERT. Sentry should capture, and all 8 gex_*
    // binds should resolve to NULL.
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
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
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          cron: 'detect-lottery-fires',
          op: 'getLatestGexbotSnapshotAt',
        }),
      }),
    );

    expectAllGexBindsNull(extractInsertBinds(mockSql, 'lottery_finder_fires'));
  });

  it('increments gexMisses (not gexHits) when the snapshot lookup THROWS — fail-open counter coherence', async () => {
    // Characterization of the gex counter accounting on the throw path:
    // the catch swallows the error (Sentry-captured, asserted above) and
    // leaves gexSnapshot === null, so the `if (gexSnapshot == null)
    // gexMisses += 1` branch runs — a thrown lookup is bucketed as a MISS,
    // not a hit. gexOutOfUniverse stays 0 because mapToGexbotTicker returns
    // a non-null ticker (default pass-through mock) so the lookup is
    // attempted. The fire still inserts (fail-open).
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert proceeds

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
      inserted: 1,
      // Thrown lookup is counted as a miss, never a hit.
      gexHits: 0,
      gexMisses: 1,
      // Ticker is in-universe (pass-through mapping) so the lookup WAS
      // attempted — not an out-of-universe skip.
      gexOutOfUniverse: 0,
    });
  });

  it('ON CONFLICT idempotency: re-running the same scan window inserts 0 new rows on the second pass', async () => {
    // The unique index (option_chain_id, trigger_time_ct) + ON CONFLICT DO
    // NOTHING make a re-scan of the SAME tick window idempotent. The mock
    // can't enforce the real unique constraint, so we simulate the DB's
    // behavior across two back-to-back handler invocations on the identical
    // fixture: run 1's INSERT RETURNS a row (first write wins); run 2's
    // INSERT RETURNS [] (the conflicting row already exists → DO NOTHING).
    // The handler counts `inserted` off the RETURNING length, so run 2
    // reports inserted: 0 even though the same fire was detected again.
    const ticks = fireableSndkStream();

    // ── Run 1: fire detected, row written ──
    mockTicks(ticks)
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // INSERT → first write wins

    const res1 = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res1,
    );
    expect(res1._status).toBe(200);
    expect(res1._json).toMatchObject({
      status: 'success',
      totalFires: 1,
      inserted: 1,
    });

    // ── Run 2: same window, same fire detected, but the row already
    //          exists so ON CONFLICT DO NOTHING returns no RETURNING rows ──
    mockTicks(ticks)
      .mockResolvedValueOnce([]) // prior fires (cooldown not seeded in mock)
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([]); // INSERT → ON CONFLICT, 0 rows returned

    const res2 = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res2,
    );
    expect(res2._status).toBe(200);
    // Fire is still DETECTED (the scan window is unchanged), but the
    // INSERT is a no-op — second run adds 0 new rows.
    expect(res2._json).toMatchObject({
      status: 'success',
      totalFires: 1,
      inserted: 0,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Fix 1 — macro / direction-gate snapshot must use EACH fire's own
  // trigger time, not the chain's first-tick executedAt. A 2nd fire on a
  // chain (>5 min after the first, past the cooldown) gets a DIFFERENT
  // macro as-of than the first.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Two firing bursts on ONE chain, spaced > 5 min apart so the detector
   * emits two fires (the 5-min cooldown gate clears between them). Burst
   * 1 triggers at 13:31:00Z; burst 2 triggers at 13:36:50Z. Both bursts
   * share the chain's first tick at 13:30:00Z.
   */
  function twoFireSndkStream() {
    const mk = (iso: string, size: number) =>
      tick('SNDK260501C01175000', 'SNDK', 'C', 1175, '2026-05-01', iso, {
        size,
      });
    return [
      // Burst 1 → fires at the 5th tick (13:31:00Z).
      mk('2026-05-01T13:30:00Z', 50),
      mk('2026-05-01T13:30:15Z', 20),
      mk('2026-05-01T13:30:30Z', 20),
      mk('2026-05-01T13:30:45Z', 20),
      mk('2026-05-01T13:31:00Z', 20),
      // Burst 2 → fires at the 5th tick (13:36:50Z), 5m50s after burst 1.
      mk('2026-05-01T13:36:10Z', 50),
      mk('2026-05-01T13:36:20Z', 20),
      mk('2026-05-01T13:36:30Z', 20),
      mk('2026-05-01T13:36:40Z', 20),
      mk('2026-05-01T13:36:50Z', 20),
    ];
  }

  /** Pull the `asOf` ISO bound into each `FROM flow_data` macro query, in
   *  call order. fetchMacroSnapshot binds asOf.toISOString() as the first
   *  interpolation of the flow_data SELECT. */
  function flowDataAsOfs(): string[] {
    return mockSql.mock.calls
      .filter((c) => {
        const strings = c[0] as readonly string[] | undefined;
        return Boolean(strings?.[0]?.includes('FROM flow_data'));
      })
      .map((c) => c[1] as string);
  }

  it('snapshots macro at each fire’s own trigger time (Fix 1: 2nd fire ≠ first-tick as-of)', async () => {
    // Query order (two-pass, Fix 3): prior-fires → [Pass 1]
    // ticker_flow_snapshot (once, cached per ticker+date) → [Pass 2]
    // per fire: flow_data, spot_exposures, INSERT.
    mockTicks(twoFireSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1, once for SNDK)
      // Fire 1 (Pass 2): flow_data, spot_exposures, INSERT
      .mockResolvedValueOnce([]) // flow_data (fire 1)
      .mockResolvedValueOnce([]) // spot_exposures (fire 1)
      .mockResolvedValueOnce([{ id: 1 }]) // INSERT (fire 1)
      // Fire 2 (Pass 2): flow_data, spot_exposures, INSERT
      .mockResolvedValueOnce([]) // flow_data (fire 2)
      .mockResolvedValueOnce([]) // spot_exposures (fire 2)
      .mockResolvedValueOnce([{ id: 2 }]); // INSERT (fire 2)

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
      totalFires: 2,
      inserted: 2,
    });

    const asOfs = flowDataAsOfs();
    expect(asOfs).toHaveLength(2);
    // Each fire's macro as-of is its OWN trigger time — NOT both pinned
    // to the chain's first tick (13:30:00Z). Pre-fix both would be
    // 13:30:00.000Z; post-fix they are the two distinct trigger times.
    expect(asOfs[0]).toBe('2026-05-01T13:31:00.000Z');
    expect(asOfs[1]).toBe('2026-05-01T13:36:50.000Z');
    // Neither may equal the chain's first-tick executedAt (the bug value).
    expect(asOfs).not.toContain('2026-05-01T13:30:00.000Z');
  });

  it('direction-gates each fire on ITS OWN trigger-time OTM tide (Fix 1)', async () => {
    // The OTM market_tide tick at -200M only exists in the window at/before
    // 13:36:50 (fire 2), not at 13:31:00 (fire 1). With the per-fire as-of
    // fix, fire 1 sees no qualifying OTM tick (ungated) while fire 2 sees
    // the -200M tide and is gated. Under the first-tick bug BOTH fires
    // would share fire-1's as-of and neither (or both) would gate
    // identically — the per-fire decision would be impossible.
    const otmTickAtFire2 = {
      source: 'market_tide_otm',
      ncp: '100000000',
      npp: '300000000', // diff = -200M, below the -150M call gate
    };
    // Query order (two-pass, Fix 3): prior-fires → [Pass 1]
    // ticker_flow_snapshot (once) → [Pass 2] per fire: flow_data,
    // spot_exposures, INSERT. Fires are processed in trigger-time order
    // (fire 1 then fire 2).
    mockTicks(twoFireSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1, once for SNDK)
      // Fire 1 (13:31:00Z): flow_data returns NO otm tick → ungated.
      .mockResolvedValueOnce([]) // flow_data (fire 1)
      .mockResolvedValueOnce([]) // spot_exposures (fire 1)
      .mockResolvedValueOnce([{ id: 1 }]) // INSERT (fire 1)
      // Fire 2 (13:36:50Z): flow_data returns the -200M otm tick → gated.
      .mockResolvedValueOnce([otmTickAtFire2]) // flow_data (fire 2)
      .mockResolvedValueOnce([]) // spot_exposures (fire 2)
      .mockResolvedValueOnce([{ id: 2 }]); // INSERT (fire 2)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const allBinds = extractAllInsertBinds(mockSql, 'lottery_finder_fires');
    expect(allBinds).toHaveLength(2);
    // Fire 1: no OTM tick at its as-of → ungated.
    expect(allBinds[0]!.get('direction_gated')).toBe(false);
    expect(allBinds[0]!.get('mkt_tide_otm_diff')).toBeNull();
    // Fire 2: -200M OTM tide at its as-of → CALL gate fires.
    expect(allBinds[1]!.get('direction_gated')).toBe(true);
    expect(allBinds[1]!.get('mkt_tide_otm_diff')).toBe(-200_000_000);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Fix 2 — date + dte stamped from the fire's OWN ET timestamp, not the
  // cron run clock (ctx.today). A fire whose trigger time falls on a
  // different ET session day than the run clock is filed under the fire's
  // day, and dte is computed from that day.
  // ──────────────────────────────────────────────────────────────────────

  it('stamps date + dte from the fire trigger timestamp, not the cron run clock (Fix 2)', async () => {
    // Late / retried run: ctx.today has rolled forward to 2026-05-02, but
    // the SNDK 0DTE fire triggered on the prior session (09:31 ET on
    // 2026-05-01, expiry same day). The row must be filed under 2026-05-01
    // with dte computed from THAT day:
    //   fire-day:  date=2026-05-01, dte=daysBetween('2026-05-01','2026-05-01')=0
    //   run-clock: date=2026-05-02, dte=daysBetween('2026-05-02','2026-05-01')=-1
    // (The -1 buggy dte would also fail the Mode-A dte===0 gate and
    // suppress the fire entirely — deriving from the fire timestamp fixes
    // both the stamp and the detection.) The fireable SNDK fixture already
    // uses 2026-05-01 ticks + expiry, so we only roll the run clock.
    mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-05-02' });
    // Query order (two-pass, Fix 3): prior-fires → ticker_flow_snapshot
    // (Pass 1) → flow_data, spot_exposures (Pass 2) → INSERT.
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([]) // flow_data (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    // Filed under the fire's own ET session day (2026-05-01), NOT the run
    // clock (2026-05-02).
    expect(binds.get('date')).toBe('2026-05-01');
    // dte from the fire-day date: 2026-05-01 − 2026-05-01 = 0 (0DTE).
    expect(binds.get('dte')).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Fix 3 — cluster bonus is symmetric: when two different tier1 tickers
  // fire within ±5 min in the same cron tick, BOTH get the same pair
  // bonus regardless of iteration order. Pre-fix the first-processed
  // chain saw an empty committedFires list (cluster_size=1, bonus 0)
  // while the second saw the first (bonus 1).
  // ──────────────────────────────────────────────────────────────────────

  it('gives both co-firing tier1 tickers the SAME (symmetric) cluster bonus (Fix 3)', async () => {
    // Two chains on DIFFERENT V3 tickers (SNDK + RKLB) fire in the same
    // cron tick at the same trigger time. The V2 score is forced to a
    // fixed tier1 value (>= t1=9) so the bonus path is exercised without
    // pinning the test to a live weights retrain. The pre-pass cofire
    // membership must give BOTH fires the pair bonus (clusterSize=2 → 1),
    // not 0 for the first-iterated chain and 1 for the second (the
    // order-dependence bug, where the first chain sees an empty
    // committedFires list).
    mockComputeLotteryScoreV2.override = 12; // tier1 (>= t1=9)
    const sndk = fireableSndkStream();
    const rklb = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'RKLB',
      option_chain: 'RKLB260501C01175000',
    }));
    // Every DB call defaults to [] (mockSql.mockResolvedValue([]) in
    // beforeEach), which is fine here: the assertions read the INSERT
    // binds via SQL-text parsing (extractAllInsertBinds), not the INSERT
    // return value, so we don't need to stage per-call `[{id}]` rows. Only
    // the ticks batches need staging so the two chains are present.
    mockTicks([...sndk, ...rklb]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const allBinds = extractAllInsertBinds(mockSql, 'lottery_finder_fires');
    expect(allBinds).toHaveLength(2);
    // Both fires scored tier1 (forced 12).
    expect(allBinds[0]!.get('score')).toBe(12);
    expect(allBinds[1]!.get('score')).toBe(12);
    // SYMMETRY: both co-firing tier1 tickers get the SAME pair bonus (1),
    // independent of Map iteration order.
    expect(allBinds[0]!.get('cluster_bonus')).toBe(1);
    expect(allBinds[1]!.get('cluster_bonus')).toBe(1);
  });
});
