// @vitest-environment node

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import type { AnchorLegs, AnchorRequest } from '../_lib/anchor-legs.js';
import type { SpreadLeg } from '../../src/types/spread-legs.js';
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

// withDbRetry calls the thunk once; it is a spy so tests can pin the retry
// arguments a query is given (vi.fn(impl) keeps impl across resetAllMocks).
// The real isRetryableDbError / TransientDbError stay, so the flow-series
// and Take-It failure paths classify transient vs genuine against the
// actual DB_RETRYABLE_RX.
const mockWithDbRetry = vi.hoisted(() =>
  vi.fn<
    (
      fn: () => Promise<unknown>,
      retries?: number,
      perAttemptTimeoutMs?: number,
    ) => Promise<unknown>
  >((fn) => fn()),
);
vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: mockWithDbRetry,
    isRetryableDbError: actual.isRetryableDbError,
    TransientDbError: actual.TransientDbError,
  };
});

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

const { mockCronGuard, mockFetchStockCandles1m, mockUwFetch } = vi.hoisted(
  () => ({
    mockCronGuard: vi.fn(),
    // Mocked UW stock-candles client. Default behavior set in beforeEach
    // — tests that care about range_pos behavior override per-case.
    mockFetchStockCandles1m: vi.fn(),
    // The UW boundary under the REAL fetchStockCandles1m, for the tests
    // that route the candle mock through the real module.
    mockUwFetch: vi.fn(),
  }),
);

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
  uwFetch: mockUwFetch,
}));

vi.mock('../_lib/uw-stock-candles.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/uw-stock-candles.js')>();
  return {
    ...actual,
    fetchStockCandles1m: mockFetchStockCandles1m,
  };
});

// The exchange multi-leg anchor lookup that replaced the classifier, mocked
// at the module boundary: its SQL has its own PGlite tests, and keeping it
// off mockSql leaves every query sequence in this file unchanged. The
// default (set in beforeEach) answers DEFAULT_ANCHOR, a single-leg anchor,
// for every fire, as on a live tick: a fire's own trigger print always
// qualifies as its anchor.
const DEFAULT_ANCHOR: AnchorLegs = {
  anchorWsTradeId: '0c9d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f',
  anchorTradeCode: 'auto',
  legKind: 'single',
  spreadShape: null,
  spreadLegs: null,
};
const mockLookupAnchorLegs = vi.hoisted(() =>
  vi.fn<
    (requests: AnchorRequest[]) => Promise<Map<string, AnchorLegs | null>>
  >(),
);
vi.mock('../_lib/anchor-legs.js', () => ({
  lookupAnchorLegs: mockLookupAnchorLegs,
}));

// The migration #160 columns the classifier used to fill. The cron no
// longer writes them; they stay NULL on new rows.
const OLD_MULTILEG_COLUMNS = [
  'inferred_structure',
  'is_isolated_leg',
  'match_confidence',
  'pattern_group_id',
] as const;

// Take-It scoring is fail-open by design. Tests mock loadTakeitDetectContext
// to resolve null (set in beforeEach) so no Blob fetch happens — the cron
// INSERTs with null takeit_prob/takeit_model_version/takeit_features and
// that's the intended degraded-path behavior. The Take-It tests below
// override it, to run the cron's prefetch queries or the real helper. The
// win-rate day cache resolves [] without SQL by default (it is kicked
// before the tick scan, so a real loader would shift every mock sequence);
// the warm-up tests swap in the real cache. Per-fire scoreLottery returns
// { prob: null, version: null, features: null } via a plain function
// (vi.fn().mockReturnValue chains can lose the return value inside vi.mock
// factories on some module-resolution paths).
const {
  mockLoadTakeitDetectContext,
  mockPriorSessionWinRatesForDay,
  mockAwaitWinRateWarmup,
} = vi.hoisted(() => ({
  mockLoadTakeitDetectContext: vi.fn(),
  mockPriorSessionWinRatesForDay: vi.fn(),
  mockAwaitWinRateWarmup: vi.fn(),
}));
vi.mock('../_lib/takeit-detect.js', () => ({
  loadTakeitDetectContext: mockLoadTakeitDetectContext,
  priorSessionWinRatesForDay: mockPriorSessionWinRatesForDay,
  awaitWinRateWarmup: mockAwaitWinRateWarmup,
  scoreLottery: () => ({ prob: null, version: null, features: null }),
}));
// The real takeit-detect (used by the prefetch-deadline test) loads its
// bundle through here.
const mockGetBundle = vi.hoisted(() => vi.fn());
vi.mock('../_lib/takeit-bundle-loader.js', () => ({
  getBundle: mockGetBundle,
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
import { reportCronRun } from '../_lib/axiom.js';
import { AXIOM_TOP_LEVEL_KEYS } from '../_lib/axiom-fields.js';
import { cronGuard as realCronGuard } from '../_lib/cron-helpers.js';
import { TransientDbError } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// The real candle client. Its `uwFetch` import still resolves to the
// mocked api-helpers above, so routing mockFetchStockCandles1m through
// it exercises the real payload checks against a mocked UW boundary.
const { fetchStockCandles1m: realFetchStockCandles1m } = await vi.importActual<
  typeof import('../_lib/uw-stock-candles.js')
>('../_lib/uw-stock-candles.js');

const GUARD = { apiKey: 'test-uw-key', today: '2026-05-01' };

const authorizedReq = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

// The default UW candle answer: a session range from before the
// fixtures' 13:30Z trigger, 1150–1200, so SNDK's spot_at_first (1170)
// gives range_pos 0.4. A healthy run gets candles; an empty answer is a
// degraded row (the run reports 'partial'), so the empty and failed
// paths set their own answer.
const SESSION_CANDLES = [
  {
    start_time: '2026-05-01T13:00:00Z',
    open: '1150',
    high: '1200',
    low: '1150',
    close: '1170',
  },
];

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

/**
 * fireableSndkStream() moved onto another ticker / chain. SPXW and TSLA
 * are on the Mode A (V3, 0DTE) list like SNDK, so it fires the same way.
 */
function streamFor(ticker: string, optionChain: string) {
  return fireableSndkStream().map((t) => ({
    ...t,
    ticker,
    option_chain: optionChain,
  }));
}

describe('detect-lottery-fires handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    // Default UW candle fetch returns a session range (range_pos 0.4 for
    // the SNDK fixture). Tests of the empty, failed and breaker-skip paths
    // override this per-case.
    mockFetchStockCandles1m.mockResolvedValue(SESSION_CANDLES);
    // Default: pass-through ticker mapping (lookup fires even on tickers
    // outside GexBot universe); lookup returns null so the gex_* binds
    // resolve to NULL. Tests that exercise the populated path override.
    mockMapToGexbotTicker.mockImplementation((t: string) => t);
    mockGetLatestGexbotSnapshotAt.mockResolvedValue(null);
    // Default: no override → delegate to the real V2 score so every
    // existing test keeps its live-weight behavior. The cluster-bonus
    // test sets a numeric override.
    mockComputeLotteryScoreV2.override = null;
    // Default: no Take-It context, no prefetch or warm-up queries.
    mockLoadTakeitDetectContext.mockResolvedValue(null);
    mockPriorSessionWinRatesForDay.mockResolvedValue([]);
    mockAwaitWinRateWarmup.mockResolvedValue(undefined);
    // Default: every fire finds its (single-leg) anchor, as on a live tick.
    mockLookupAnchorLegs.mockImplementation(
      async (requests) =>
        new Map(
          requests.map((r): [string, AnchorLegs | null] => [
            r.key,
            DEFAULT_ANCHOR,
          ]),
        ),
    );
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
    // Default candle fixture: spot 1170 in the 1150–1200 range → 0.4.
    expect(binds.get('range_pos_at_trigger')).toBeCloseTo(0.4, 5);
    // Mocked takeit context returns null → all three takeit fields null.
    expect(binds.get('takeit_prob')).toBeNull();
    expect(binds.get('takeit_model_version')).toBeNull();
    expect(binds.get('takeit_features')).toBeNull();
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

  // Spec: docs/superpowers/specs/range-pos-fix-and-backfill-2026-10-28.md
  // (Phase 1). The cron used to run with requireApiKey:false, so every
  // candle call went out keyless and the 401 was swallowed to [].
  describe('UW candle fetch for range_pos', () => {
    const CANDLE_FAILED_MSG =
      'detect-lottery-fires: stock candle fetch failed; range_pos left null';
    const CANDLE_EMPTY_MSG =
      'detect-lottery-fires: UW returned no stock candles; range_pos left null';

    const authorizedReq = (query: Record<string, string> = {}) =>
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
        query,
      });

    function candleWarnCalls(message = CANDLE_FAILED_MSG) {
      return vi
        .mocked(logger.warn)
        .mock.calls.filter((call) => call[1] === message);
    }

    // Symbols the candle lookup was attempted for, in call order.
    function fetchedTickers() {
      return mockFetchStockCandles1m.mock.calls.map((call) => call[1]);
    }

    // Runs the handler with timers faked, so withRetry's backoff (≤1 s)
    // and the per-fetch deadline elapse without real waiting. afterEach
    // restores real timers.
    async function runWithFakeTimers(
      res: ReturnType<typeof mockResponse>,
      advanceMs = 1_000,
    ) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const run = handler(authorizedReq(), res);
      await vi.advanceTimersByTimeAsync(advanceMs);
      await run;
    }

    afterEach(() => {
      delete process.env.UW_API_KEY;
      vi.useRealTimers();
    });

    it('passes the real UW_API_KEY from cronGuard to the candle fetch', async () => {
      process.env.UW_API_KEY = 'uw-real-key';
      mockCronGuard.mockImplementation(realCronGuard);
      mockTicks(fireableSndkStream());

      const res = mockResponse();
      // force=1 lifts only the time gate; CRON_SECRET and the key check
      // still run inside the real cronGuard.
      await handler(authorizedReq({ force: '1' }), res);

      expect(res._status).toBe(200);
      expect(mockFetchStockCandles1m).toHaveBeenCalledWith(
        'uw-real-key',
        'SNDK',
        '2026-05-01',
      );
    });

    it('returns 500 "UW_API_KEY not configured" and runs nothing when the key is missing', async () => {
      mockCronGuard.mockImplementation(realCronGuard);

      const res = mockResponse();
      await handler(authorizedReq({ force: '1' }), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'UW_API_KEY not configured' });
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockFetchStockCandles1m).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a UW non-2xx',
        () =>
          mockUwFetch.mockRejectedValue(
            new Error('UW API 500: Internal Server Error'),
          ),
        'UW API 500: Internal Server Error',
      ],
      [
        'a 200 whose data is not an array',
        () => mockUwFetch.mockResolvedValue('x'),
        'UW stock candles malformed: data is string, not an array',
      ],
      [
        'a 200 whose body is not JSON',
        () =>
          mockUwFetch.mockRejectedValue(
            new SyntaxError('Unexpected token < in JSON at position 0'),
          ),
        'Unexpected token < in JSON at position 0',
      ],
    ])(
      'surfaces %s, still writes the fire with a null range_pos, and reports partial',
      async (_label, stageUw, expectedError) => {
        mockFetchStockCandles1m.mockImplementation(realFetchStockCandles1m);
        stageUw();
        mockTicks(fireableSndkStream())
          .mockResolvedValueOnce([]) // prior fires
          .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
          .mockResolvedValueOnce([]) // flow_data (Pass 2)
          .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
          .mockResolvedValueOnce([{ id: 42 }]); // insert

        const res = mockResponse();
        await runWithFakeTimers(res);

        // A candle failure must not fail fire detection, but the fire it
        // wrote is missing range_pos, so the run is not a clean success.
        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'partial',
          rows: 1,
          candleFetchFailures: 1,
          candleFetchSkippedIndex: 0,
          candleFetchSkippedBreaker: 0,
        });
        const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
        expect(binds.get('range_pos_at_trigger')).toBeNull();

        const firstCandleFetchError = {
          ticker: 'SNDK',
          date: '2026-05-01',
          error: expectedError,
        };
        expect(candleWarnCalls()).toEqual([
          [
            expect.objectContaining({
              candleFetchFailures: 1,
              firstCandleFetchError,
            }),
            CANDLE_FAILED_MSG,
          ],
        ]);
        expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
        expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
          CANDLE_FAILED_MSG,
          expect.objectContaining({
            level: 'warning',
            fingerprint: ['detect-lottery-fires', 'candle-fetch-failed'],
            extra: expect.objectContaining({
              candleFetchFailures: 1,
              firstCandleFetchError,
            }),
          }),
        );
        expect(reportCronRun).toHaveBeenCalledWith(
          'detect-lottery-fires',
          expect.objectContaining({
            status: 'partial',
            candleFetchFailures: 1,
            candleFetchSkippedIndex: 0,
          }),
        );
      },
    );

    it('counts each failing ticker-day once and sends one Sentry message per run', async () => {
      // A definite 4xx: not retried and doesn't open the breaker, so
      // every ticker-day is still asked for.
      mockFetchStockCandles1m.mockRejectedValue(
        new Error('UW API 404: Not Found'),
      );
      // Two SNDK chains (one ticker-day) plus one TSLA chain.
      mockTicks([
        ...fireableSndkStream(),
        ...streamFor('SNDK', 'SNDK260501C01180000'),
        ...streamFor('TSLA', 'TSLA260501C01175000'),
      ]);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      // The failed SNDK lookup is cached for the run, not retried per fire.
      expect(fetchedTickers()).toEqual(['SNDK', 'TSLA']);
      expect(res._json).toMatchObject({
        candleFetchFailures: 2,
        candleFetchSkippedBreaker: 0,
      });
      const rangePos = extractAllInsertBinds(
        mockSql,
        'lottery_finder_fires',
      ).map((b) => b.get('range_pos_at_trigger'));
      expect(rangePos).toEqual([null, null, null]);
      expect(candleWarnCalls()).toEqual([
        [
          expect.objectContaining({
            candleFetchFailures: 2,
            firstCandleFetchError: {
              ticker: 'SNDK',
              date: '2026-05-01',
              error: 'UW API 404: Not Found',
            },
          }),
          CANDLE_FAILED_MSG,
        ],
      ]);
      expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it('skips the candle fetch for cash-index roots (D8) and leaves their range_pos null', async () => {
      mockTicks([
        ...streamFor('SPXW', 'SPXW260501C01175000'),
        ...fireableSndkStream(),
      ]);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(mockFetchStockCandles1m).toHaveBeenCalledTimes(1);
      expect(mockFetchStockCandles1m).toHaveBeenCalledWith(
        'test-uw-key',
        'SNDK',
        '2026-05-01',
      );
      expect(res._json).toMatchObject({
        candleFetchSkippedIndex: 1,
        candleFetchFailures: 0,
      });
      const rangePosBySymbol = new Map(
        extractAllInsertBinds(mockSql, 'lottery_finder_fires').map((b) => [
          b.get('underlying_symbol'),
          b.get('range_pos_at_trigger'),
        ]),
      );
      expect(rangePosBySymbol.get('SPXW')).toBeNull();
      expect(rangePosBySymbol.get('SNDK')).toBeCloseTo(0.4, 5);
      // A skip is by design, not a failure.
      expect(candleWarnCalls()).toEqual([]);
      expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
    });

    it('surfaces a day UW returns no candles for as empty, not as a failure', async () => {
      mockFetchStockCandles1m.mockResolvedValue([]);
      mockTicks(fireableSndkStream());

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        candleFetchEmpty: 1,
        candleFetchFailures: 0,
      });
      expect(candleWarnCalls()).toEqual([]);
      const firstCandleFetchEmpty = { ticker: 'SNDK', date: '2026-05-01' };
      expect(candleWarnCalls(CANDLE_EMPTY_MSG)).toEqual([
        [
          expect.objectContaining({
            candleFetchEmpty: 1,
            firstCandleFetchEmpty,
          }),
          CANDLE_EMPTY_MSG,
        ],
      ]);
      expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
        CANDLE_EMPTY_MSG,
        expect.objectContaining({
          level: 'warning',
          fingerprint: ['detect-lottery-fires', 'candle-fetch-empty'],
          extra: expect.objectContaining({
            candleFetchEmpty: 1,
            firstCandleFetchEmpty,
          }),
        }),
      );
    });

    it.each([
      ['a UW 503', new Error('UW API 503: Service Unavailable')],
      [
        'a UW 429',
        new Error('UW API 429: You have exceeded 3 concurrent requests'),
      ],
      ['a network error', new Error('fetch failed')],
    ])(
      'stops asking UW for candles for the rest of the run after %s (breaker)',
      async (_label, uwError) => {
        mockFetchStockCandles1m.mockRejectedValue(uwError);
        mockTicks([
          ...fireableSndkStream(),
          ...streamFor('TSLA', 'TSLA260501C01175000'),
        ]);

        const res = mockResponse();
        await runWithFakeTimers(res);

        expect(res._status).toBe(200);
        // SNDK is tried twice (one retry); TSLA is never asked for.
        expect(fetchedTickers()).toEqual(['SNDK', 'SNDK']);
        expect(res._json).toMatchObject({
          candleFetchFailures: 1,
          candleFetchSkippedBreaker: 1,
        });
        const rangePos = extractAllInsertBinds(
          mockSql,
          'lottery_finder_fires',
        ).map((b) => b.get('range_pos_at_trigger'));
        expect(rangePos).toEqual([null, null]);
        expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
        expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
          CANDLE_FAILED_MSG,
          expect.objectContaining({
            extra: expect.objectContaining({
              candleFetchFailures: 1,
              candleFetchSkippedBreaker: 1,
            }),
          }),
        );
      },
    );

    it('retries a transient candle failure once before giving up', async () => {
      mockFetchStockCandles1m
        .mockRejectedValueOnce(new Error('UW API 503: Service Unavailable'))
        .mockResolvedValueOnce(SESSION_CANDLES);
      mockTicks(fireableSndkStream());

      const res = mockResponse();
      await runWithFakeTimers(res);

      expect(res._status).toBe(200);
      expect(fetchedTickers()).toEqual(['SNDK', 'SNDK']);
      expect(res._json).toMatchObject({
        candleFetchFailures: 0,
        candleFetchSkippedBreaker: 0,
      });
      const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
      expect(binds.get('range_pos_at_trigger')).toBeCloseTo(0.4, 5);
      expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
    });

    it('gives up on a candle fetch that outlives its 5 s deadline, opens the breaker and reports partial', async () => {
      // SNDK's lookup never answers (a stalled UW call); TSLA's would.
      // The shape of the 2026-10-29 incident (SENTRY-EMERALD-DESERT-JP),
      // a run that wrote fires with range_pos NULL and reported success.
      mockFetchStockCandles1m.mockImplementation(
        (_apiKey: string, ticker: string) =>
          ticker === 'SNDK'
            ? new Promise<never>(() => {})
            : Promise.resolve(SESSION_CANDLES),
      );
      mockTicks([
        ...fireableSndkStream(),
        ...streamFor('TSLA', 'TSLA260501C01175000'),
      ])
        .mockResolvedValueOnce([]) // prior fires
        .mockResolvedValueOnce([]) // SNDK ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // TSLA ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // SNDK flow_data (Pass 2)
        .mockResolvedValueOnce([]) // SNDK spot_exposures (Pass 2)
        .mockResolvedValueOnce([{ id: 1 }]) // SNDK insert
        .mockResolvedValueOnce([]) // TSLA flow_data (Pass 2)
        .mockResolvedValueOnce([]) // TSLA spot_exposures (Pass 2)
        .mockResolvedValueOnce([{ id: 2 }]); // TSLA insert

      const res = mockResponse();
      await runWithFakeTimers(res, 5_000);

      expect(res._status).toBe(200);
      expect(fetchedTickers()).toEqual(['SNDK']);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 2,
        inserted: 2,
        candleFetchFailures: 1,
        candleFetchSkippedBreaker: 1,
      });
      expect(reportCronRun).toHaveBeenCalledWith(
        'detect-lottery-fires',
        expect.objectContaining({
          status: 'partial',
          candleFetchFailures: 1,
          candleFetchSkippedBreaker: 1,
        }),
      );
      // Both fires are still written, without range_pos.
      const rangePos = extractAllInsertBinds(
        mockSql,
        'lottery_finder_fires',
      ).map((b) => b.get('range_pos_at_trigger'));
      expect(rangePos).toEqual([null, null]);
      expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
        CANDLE_FAILED_MSG,
        expect.objectContaining({
          extra: expect.objectContaining({
            candleFetchFailures: 1,
            candleFetchSkippedBreaker: 1,
            firstCandleFetchError: {
              ticker: 'SNDK',
              date: '2026-05-01',
              error: 'stock candle fetch passed its 5000 ms deadline',
            },
          }),
        }),
      );
    });

    it('reports every candle counter to Axiom under meta, never as a top-level column', async () => {
      mockTicks(fireableSndkStream());

      await handler(authorizedReq(), mockResponse());

      const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
      const candleKeys = Object.keys(payload)
        .filter((key) => key.startsWith('candleFetch'))
        .sort();
      expect(candleKeys).toEqual([
        'candleFetchEmpty',
        'candleFetchFailures',
        'candleFetchSkippedBreaker',
        'candleFetchSkippedIndex',
      ]);
      // reportCronRun folds any key outside AXIOM_TOP_LEVEL_KEYS into
      // `meta`; the dataset is at its column cap.
      for (const key of candleKeys) {
        expect(AXIOM_TOP_LEVEL_KEYS.has(key)).toBe(false);
      }
    });

    // A fire written with range_pos NULL because its lookup failed, was
    // skipped by the breaker or came back empty is a degraded row, so the
    // run reports 'partial' (R4), as a flow-series failure does. Index
    // roots are skipped by design and leave the run 'success'; so does a
    // failure on a run that wrote nothing.
    describe('run status', () => {
      function reportedStatus() {
        expect(reportCronRun).toHaveBeenCalledTimes(1);
        return vi.mocked(reportCronRun).mock.calls[0]![1].status;
      }

      it('reports partial when the breaker skipped the ticker of the only fire written', async () => {
        // SNDK's lookup fails with a 5xx (retried once), which opens the
        // breaker, so TSLA's is never asked for. Only TSLA's fire lands.
        mockFetchStockCandles1m.mockRejectedValue(
          new Error('UW API 503: Service Unavailable'),
        );
        mockTicks([
          ...fireableSndkStream(),
          ...streamFor('TSLA', 'TSLA260501C01175000'),
        ])
          .mockResolvedValueOnce([]) // prior fires
          .mockResolvedValueOnce([]) // SNDK ticker_flow_snapshot (Pass 1)
          .mockResolvedValueOnce([]) // TSLA ticker_flow_snapshot (Pass 1)
          .mockResolvedValueOnce([]) // SNDK flow_data (Pass 2)
          .mockResolvedValueOnce([]) // SNDK spot_exposures (Pass 2)
          .mockResolvedValueOnce([]) // SNDK insert: ON CONFLICT, not written
          .mockResolvedValueOnce([]) // TSLA flow_data (Pass 2)
          .mockResolvedValueOnce([]) // TSLA spot_exposures (Pass 2)
          .mockResolvedValueOnce([{ id: 7 }]); // TSLA insert: written

        const res = mockResponse();
        await runWithFakeTimers(res);

        expect(res._status).toBe(200);
        expect(fetchedTickers()).toEqual(['SNDK', 'SNDK']);
        expect(res._json).toMatchObject({
          status: 'partial',
          rows: 1,
          inserted: 1,
          candleFetchFailures: 1,
          candleFetchSkippedBreaker: 1,
          candleFetchEmpty: 0,
          candleFetchSkippedIndex: 0,
        });
        const tsla = extractAllInsertBinds(
          mockSql,
          'lottery_finder_fires',
        ).find((b) => b.get('underlying_symbol') === 'TSLA');
        expect(tsla!.get('range_pos_at_trigger')).toBeNull();
        expect(reportedStatus()).toBe('partial');
      });

      it('reports partial when UW returns no candles for the ticker of a written fire', async () => {
        mockFetchStockCandles1m.mockResolvedValue([]);
        mockTicks(fireableSndkStream())
          .mockResolvedValueOnce([]) // prior fires
          .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
          .mockResolvedValueOnce([]) // flow_data (Pass 2)
          .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
          .mockResolvedValueOnce([{ id: 42 }]); // insert

        const res = mockResponse();
        await handler(authorizedReq(), res);

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'partial',
          rows: 1,
          candleFetchEmpty: 1,
          candleFetchFailures: 0,
          candleFetchSkippedBreaker: 0,
        });
        expect(
          extractInsertBinds(mockSql, 'lottery_finder_fires').get(
            'range_pos_at_trigger',
          ),
        ).toBeNull();
        expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
          CANDLE_EMPTY_MSG,
          expect.objectContaining({
            fingerprint: ['detect-lottery-fires', 'candle-fetch-empty'],
          }),
        );
        expect(reportedStatus()).toBe('partial');
      });

      it('stays success for an index-root fire whose candle fetch is skipped by design', async () => {
        mockTicks(streamFor('SPXW', 'SPXW260501C01175000'))
          .mockResolvedValueOnce([]) // prior fires
          .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
          .mockResolvedValueOnce([]) // flow_data (Pass 2)
          .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
          .mockResolvedValueOnce([]) // strike_exposures (Pass 2; SPXW has per-strike GEX)
          .mockResolvedValueOnce([{ id: 42 }]); // insert

        const res = mockResponse();
        await handler(authorizedReq(), res);

        expect(res._status).toBe(200);
        expect(mockFetchStockCandles1m).not.toHaveBeenCalled();
        expect(res._json).toMatchObject({
          status: 'success',
          rows: 1,
          candleFetchSkippedIndex: 1,
          candleFetchFailures: 0,
          candleFetchEmpty: 0,
          candleFetchSkippedBreaker: 0,
        });
        expect(
          extractInsertBinds(mockSql, 'lottery_finder_fires').get(
            'range_pos_at_trigger',
          ),
        ).toBeNull();
        expect(reportedStatus()).toBe('success');
      });

      it('stays success when a candle fetch fails but no fire is written, and still reports the failure', async () => {
        mockFetchStockCandles1m.mockRejectedValue(
          new Error('UW API 404: Not Found'),
        );
        // Default [] everywhere: the INSERT hits ON CONFLICT and returns no id.
        mockTicks(fireableSndkStream());

        const res = mockResponse();
        await handler(authorizedReq(), res);

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'success',
          rows: 0,
          inserted: 0,
          candleFetchFailures: 1,
        });
        expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
          CANDLE_FAILED_MSG,
          expect.objectContaining({
            fingerprint: ['detect-lottery-fires', 'candle-fetch-failed'],
          }),
        );
        expect(reportedStatus()).toBe('success');
      });
    });

    it('fails the run when the fire INSERT rejects, even while candles fail open', async () => {
      const writeError = new Error(
        'relation "lottery_finder_fires" does not exist',
      );
      mockFetchStockCandles1m.mockRejectedValue(
        new Error('UW API 404: Not Found'),
      );
      mockTicks(fireableSndkStream())
        .mockResolvedValueOnce([]) // prior fires
        .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // flow_data (Pass 2)
        .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
        .mockRejectedValueOnce(writeError); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(500);
      expect(reportCronRun).toHaveBeenCalledWith(
        'detect-lottery-fires',
        expect.objectContaining({
          status: 'error',
          message: writeError.message,
        }),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(writeError);
    });
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

  it('continues with EMPTY_MACRO when the macro snapshot lookup throws, and reports partial', async () => {
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

    // Fire still landed in the table — a transient flow_data outage must
    // not drop alerts. But the row has no macro context (and so no
    // direction gate), so the run is 'partial'.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 1,
      totalFires: 1,
      inserted: 1,
      macroSnapshotFailures: 1,
    });
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    expect(binds.get('mkt_tide_diff')).toBeNull();
    expect(binds.get('direction_gated')).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'flow_data ECONNRESET' }),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ stage: 'macro_snapshot' }),
      }),
    );
    const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
    expect(payload).toMatchObject({
      status: 'partial',
      macroSnapshotFailures: 1,
    });
    // The counter lands in Axiom `meta`, not as a new top-level column.
    expect(AXIOM_TOP_LEVEL_KEYS.has('macroSnapshotFailures')).toBe(false);
  });

  it('stays success when the macro snapshot lookup throws but no fire is written, and still reports the failure', async () => {
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockRejectedValueOnce(new Error('flow_data ECONNRESET')); // flow_data (Pass 2)
    // Default [] for the rest: the INSERT hits ON CONFLICT, no id back.

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      inserted: 0,
      macroSnapshotFailures: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'flow_data ECONNRESET' }),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'macro_snapshot' }),
      }),
    );
    expect(vi.mocked(reportCronRun).mock.calls[0]![1]).toMatchObject({
      status: 'success',
      macroSnapshotFailures: 1,
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

  // ──────────────────────────────────────────────────────────────────────
  // Multileg classifier removed from the lottery cron (2026-10-29). Its
  // serial per-fire calls timed the cron out at busy ticks. The cron no
  // longer calls it, no longer writes the four migration #160 columns
  // (they stay NULL), and dropped the multilegHits / multilegMisses
  // counters and the multileg.classify.high_null_rate warning with it.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Build N independent firing chains by varying the strike on the
   * SNDK fixture. Each chain produces exactly one fire when paired with
   * queuePerFireMocks(N, ...).
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

  it('leaves the four old columns out of the INSERT', async () => {
    mockTicks(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
      .mockResolvedValueOnce([]) // flow_data (Pass 2)
      .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
      .mockResolvedValueOnce([{ id: 11 }]); // insert

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
    });

    const insertCalls = mockSql.mock.calls.filter((call) =>
      Boolean(
        (call[0] as readonly string[] | undefined)?.[0]?.includes(
          'INSERT INTO lottery_finder_fires',
        ),
      ),
    );
    expect(insertCalls).toHaveLength(1);
    const insertCall = insertCalls[0]!;
    const insertSql = (insertCall[0] as readonly string[]).join('$');
    for (const column of OLD_MULTILEG_COLUMNS) {
      expect(insertSql).not.toContain(column);
    }
    const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
    for (const column of OLD_MULTILEG_COLUMNS) {
      expect(binds.has(column)).toBe(false);
    }
    // One bound value per listed column: the four were dropped from the
    // column list and from VALUES together, so nothing shifted.
    expect(binds.size).toBe(insertCall.length - 1);
    // The neighbours of the removed block still carry their own values.
    expect(binds.get('cum_npp_at_fire')).toBeNull();
    expect(binds.get('takeit_prob')).toBeNull();
    expect(binds.get('takeit_features')).toBeNull();
  });

  it('writes every fire on a busy tick with no multileg counters and no high-null-rate warning', async () => {
    // 11 fires. Before the removal this tick made 11 serial classifier
    // calls, and an all-null result raised multileg.classify.high_null_rate
    // (inserted > 10, hit rate < 50%).
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
      rows: 11,
      totalFires: 11,
      inserted: 11,
    });
    expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.anything(),
    );

    const allBinds = extractAllInsertBinds(mockSql, 'lottery_finder_fires');
    expect(allBinds).toHaveLength(11);
    for (const binds of allBinds) {
      for (const column of OLD_MULTILEG_COLUMNS) {
        expect(binds.has(column)).toBe(false);
      }
    }

    // The counters are gone from the response, the Axiom report and the
    // completion log.
    expect(res._json).not.toHaveProperty('multilegHits');
    expect(res._json).not.toHaveProperty('multilegMisses');
    const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
    expect(payload).not.toHaveProperty('multilegHits');
    expect(payload).not.toHaveProperty('multilegMisses');
    const completedLog = vi
      .mocked(logger.info)
      .mock.calls.find(
        (call) => (call as unknown[])[1] === 'detect-lottery-fires completed',
      );
    expect(completedLog).toBeDefined();
    expect(completedLog![0]).toMatchObject({ inserted: 11 });
    expect(completedLog![0]).not.toHaveProperty('multilegHits');
    expect(completedLog![0]).not.toHaveProperty('multilegMisses');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Anchor legs from the exchange multi-leg flag (spec
  // 2026-10-28-classifier-replacement-design.md, migration #197): one
  // batched lookupAnchorLegs call per tick, before the INSERTs.
  // ──────────────────────────────────────────────────────────────────────
  describe('anchor legs from the exchange multi-leg flag', () => {
    const SNDK_CHAIN = 'SNDK260501C01175000';
    const ANCHOR_FAILED = 'anchor_legs.lookup_failed';
    const ANCHOR_MISSING_MSG =
      'detect-lottery-fires: no anchor print found for a fresh fire; anchor columns left null';
    const ANCHOR_COLUMNS = [
      'anchor_ws_trade_id',
      'anchor_trade_code',
      'anchor_leg_kind',
      'spread_shape',
      'spread_legs',
    ] as const;

    const VERTICAL_LEGS: SpreadLeg[] = [
      {
        optionType: 'C',
        strike: 1175,
        expiry: '2026-05-01',
        size: 120,
        price: 0.5,
        tradeCode: 'mlet',
      },
      {
        optionType: 'C',
        strike: 1180,
        expiry: '2026-05-01',
        size: 120,
        price: 0.21,
        tradeCode: 'mlet',
      },
    ];
    const SPREAD_LEG_ANCHOR: AnchorLegs = {
      anchorWsTradeId: '3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c',
      anchorTradeCode: 'mlet',
      legKind: 'multi_leg',
      spreadShape: 'vertical',
      spreadLegs: VERTICAL_LEGS,
    };
    const SINGLE_ANCHOR: AnchorLegs = {
      anchorWsTradeId: '7a2b3c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
      anchorTradeCode: 'auto',
      legKind: 'single',
      spreadShape: null,
      spreadLegs: null,
    };
    const STOCK_TIED_ANCHOR: AnchorLegs = {
      anchorWsTradeId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      anchorTradeCode: 'tlet',
      legKind: 'stock_tied',
      spreadShape: null,
      spreadLegs: null,
    };
    const ALL_NULL = {
      anchor_ws_trade_id: null,
      anchor_trade_code: null,
      anchor_leg_kind: null,
      spread_shape: null,
      spread_legs: null,
    };

    /** Answer each request by its chain, as the real helper keys by `key`. */
    function answerAnchorsByChain(byChain: Record<string, AnchorLegs>) {
      mockLookupAnchorLegs.mockImplementation(
        async (requests) =>
          new Map(
            requests.map((r): [string, AnchorLegs | null] => [
              r.key,
              byChain[r.optionChain] ?? null,
            ]),
          ),
      );
    }

    /** One SNDK fire: ticks, prior fires, flow series, macro, INSERT. */
    function queueOneSndkFire(insertedId: number | null) {
      mockTicks(fireableSndkStream())
        .mockResolvedValueOnce([]) // prior fires
        .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // flow_data (Pass 2)
        .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
        .mockResolvedValueOnce(insertedId == null ? [] : [{ id: insertedId }]); // insert
    }

    function anchorBinds(binds: Map<string, unknown>) {
      return Object.fromEntries(
        ANCHOR_COLUMNS.map((column) => [column, binds.get(column)]),
      );
    }

    function anchorFailedCaptures() {
      return vi
        .mocked(Sentry.captureException)
        .mock.calls.filter(
          (call) =>
            (call[1] as { fingerprint?: string[] } | undefined)
              ?.fingerprint?.[1] === ANCHOR_FAILED,
        );
    }

    function anchorMissingCaptures() {
      return mockSentryCaptureMessage.mock.calls.filter(
        (call) => call[0] === ANCHOR_MISSING_MSG,
      );
    }

    /** No fire found its anchor: null for every request. */
    function answerNoAnchors() {
      mockLookupAnchorLegs.mockImplementation(
        async (requests) =>
          new Map(
            requests.map((r): [string, AnchorLegs | null] => [r.key, null]),
          ),
      );
    }

    function completedLog() {
      const call = vi
        .mocked(logger.info)
        .mock.calls.find(
          (c) => (c as unknown[])[1] === 'detect-lottery-fires completed',
        );
      expect(call).toBeDefined();
      return (call as unknown[])[0];
    }

    it('looks the anchor up once, before the INSERT, and writes a spread leg’s five columns in place of the four old ones', async () => {
      answerAnchorsByChain({ [SNDK_CHAIN]: SPREAD_LEG_ANCHOR });
      queueOneSndkFire(42);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 1,
        anchorsFound: 1,
        anchorsMissing: 0,
        anchorLookupFailures: 0,
        anchorLookupError: null,
      });

      const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
      expect(anchorBinds(binds)).toEqual({
        anchor_ws_trade_id: '3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c',
        anchor_trade_code: 'mlet',
        anchor_leg_kind: 'multi_leg',
        spread_shape: 'vertical',
        // jsonb: the SpreadLeg objects exactly as returned, serialised.
        spread_legs: JSON.stringify(VERTICAL_LEGS),
      });
      const storedLegs = JSON.parse(binds.get('spread_legs') as string) as {
        [key: string]: unknown;
      }[];
      expect(storedLegs).toEqual(VERTICAL_LEGS);
      expect(Object.keys(storedLegs[0]!)).toEqual([
        'optionType',
        'strike',
        'expiry',
        'size',
        'price',
        'tradeCode',
      ]);
      for (const column of OLD_MULTILEG_COLUMNS) {
        expect(binds.has(column)).toBe(false);
      }

      // One request for the one fire: its ticker and chain as the tick
      // scan read them from ws_option_trades, window [trigger − 30 s,
      // trigger + 30 s).
      expect(mockLookupAnchorLegs).toHaveBeenCalledTimes(1);
      const triggerMs = Date.parse(binds.get('trigger_time_ct') as string);
      expect(mockLookupAnchorLegs.mock.calls[0]![0]).toEqual([
        {
          key: expect.any(String),
          ticker: 'SNDK',
          optionChain: SNDK_CHAIN,
          windowStart: new Date(triggerMs - 30_000),
          windowEnd: new Date(triggerMs + 30_000),
        },
      ]);
      // Through the DB retry helper: one retry, 5 s per attempt.
      expect(mockWithDbRetry).toHaveBeenCalledWith(
        expect.any(Function),
        1,
        5_000,
      );
      // Before the INSERT, not after it.
      const insertIdx = mockSql.mock.calls.findIndex((call) =>
        Boolean(
          (call[0] as readonly string[] | undefined)?.[0]?.includes(
            'INSERT INTO lottery_finder_fires',
          ),
        ),
      );
      expect(mockLookupAnchorLegs.mock.invocationCallOrder[0]).toBeLessThan(
        mockSql.mock.invocationCallOrder[insertIdx]!,
      );
      expect(anchorFailedCaptures()).toHaveLength(0);
      // Every fire found its anchor: no anchor-missing warning.
      expect(anchorMissingCaptures()).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        ANCHOR_MISSING_MSG,
      );
    });

    it('makes one batched lookup for every fire on a tick and writes each fire its own anchor', async () => {
      answerAnchorsByChain({
        SNDK260501C01175000: SPREAD_LEG_ANCHOR,
        SNDK260501C01176000: SINGLE_ANCHOR,
        SNDK260501C01177000: STOCK_TIED_ANCHOR,
        // SNDK260501C01178000: no anchor print in its window.
      });
      mockTicks(manyFireableSndkStreams(4));
      queuePerFireMocks(4, true);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 4,
        anchorsFound: 3,
        anchorsMissing: 1,
        anchorLookupFailures: 0,
      });

      // R5: one call for the tick, one request per fire, keys unique.
      expect(mockLookupAnchorLegs).toHaveBeenCalledTimes(1);
      const requests = mockLookupAnchorLegs.mock.calls[0]![0];
      expect(requests.map((r) => r.optionChain)).toEqual([
        'SNDK260501C01175000',
        'SNDK260501C01176000',
        'SNDK260501C01177000',
        'SNDK260501C01178000',
      ]);
      expect(new Set(requests.map((r) => r.key)).size).toBe(4);

      const byChain = new Map(
        extractAllInsertBinds(mockSql, 'lottery_finder_fires').map((b) => [
          b.get('option_chain_id'),
          anchorBinds(b),
        ]),
      );
      expect(byChain.get('SNDK260501C01175000')).toMatchObject({
        anchor_leg_kind: 'multi_leg',
        spread_shape: 'vertical',
      });
      expect(byChain.get('SNDK260501C01176000')).toEqual({
        anchor_ws_trade_id: '7a2b3c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
        anchor_trade_code: 'auto',
        anchor_leg_kind: 'single',
        spread_shape: null,
        spread_legs: null,
      });
      expect(byChain.get('SNDK260501C01177000')).toEqual({
        anchor_ws_trade_id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        anchor_trade_code: 'tlet',
        anchor_leg_kind: 'stock_tied',
        spread_shape: null,
        spread_legs: null,
      });
      expect(byChain.get('SNDK260501C01178000')).toEqual(ALL_NULL);

      // One missing anchor among four fires: one warning for the run.
      const missing = anchorMissingCaptures();
      expect(missing).toHaveLength(1);
      expect(missing[0]![1]).toMatchObject({
        level: 'warning',
        extra: { anchorsMissing: 1, anchorsFound: 3 },
      });
    });

    it('writes NULL anchor columns and stays success when a fresh fire finds no anchor print, and warns once per run', async () => {
      answerNoAnchors();
      queueOneSndkFire(42);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 1,
        anchorsFound: 0,
        anchorsMissing: 1,
        anchorLookupFailures: 0,
        anchorLookupError: null,
      });
      expect(
        anchorBinds(extractInsertBinds(mockSql, 'lottery_finder_fires')),
      ).toEqual(ALL_NULL);
      // Not a lookup failure: no anchor_legs.lookup_failed event or line.
      expect(anchorFailedCaptures()).toHaveLength(0);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(ANCHOR_FAILED),
      );
      // But a fresh fire's trigger print always qualifies as its anchor,
      // so the miss is raised once for the run as a warning.
      const missing = anchorMissingCaptures();
      expect(missing).toHaveLength(1);
      expect(missing[0]![1]).toEqual({
        level: 'warning',
        fingerprint: ['detect-lottery-fires', 'anchor-missing'],
        tags: {
          'cron.job': 'detect-lottery-fires',
          'cron.anomaly': 'anchor-missing',
        },
        extra: { anchorsMissing: 1, anchorsFound: 0 },
      });
      expect(logger.warn).toHaveBeenCalledWith(
        { anchorsMissing: 1, anchorsFound: 0 },
        ANCHOR_MISSING_MSG,
      );
      expect(completedLog()).toMatchObject({
        anchorsFound: 0,
        anchorsMissing: 1,
        anchorLookupFailures: 0,
      });
    });

    it('still writes the fire with NULL anchor columns when the lookup fails, names anchor_legs.lookup_failed in Sentry and the log, and reports partial', async () => {
      const broken = new Error('column "trade_code" does not exist');
      mockLookupAnchorLegs.mockRejectedValue(broken);
      queueOneSndkFire(42);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 1,
        inserted: 1,
        // A failed lookup is not counted as missing anchors.
        anchorsFound: 0,
        anchorsMissing: 0,
        anchorLookupFailures: 1,
        anchorLookupError: broken.message,
      });
      expect(
        anchorBinds(extractInsertBinds(mockSql, 'lottery_finder_fires')),
      ).toEqual(ALL_NULL);

      const captures = anchorFailedCaptures();
      expect(captures).toHaveLength(1);
      expect(captures[0]![0]).toBe(broken);
      expect(captures[0]![1]).toMatchObject({
        level: 'error',
        fingerprint: ['detect-lottery-fires', ANCHOR_FAILED],
        tags: {
          'cron.job': 'detect-lottery-fires',
          'cron.anomaly': ANCHOR_FAILED,
        },
        extra: { fires: 1 },
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: broken, fires: 1 }),
        expect.stringContaining(ANCHOR_FAILED),
      );
      // A failed lookup is not reported as missing anchors.
      expect(anchorMissingCaptures()).toHaveLength(0);

      // Axiom: the run is partial, and the new fields ride in `meta`.
      const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
      expect(payload).toMatchObject({
        status: 'partial',
        anchorLookupError: broken.message,
      });
      for (const key of [
        'anchorsFound',
        'anchorsMissing',
        'anchorLookupFailures',
        'anchorLookupError',
      ]) {
        expect(payload).toHaveProperty(key);
        expect(AXIOM_TOP_LEVEL_KEYS.has(key)).toBe(false);
      }
    });

    it('reports a lookup that exhausted its retries on a Neon blip at warning level, and still reports partial', async () => {
      const blip = new TransientDbError(new Error('fetch failed'));
      mockLookupAnchorLegs.mockRejectedValue(blip);
      queueOneSndkFire(42);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 1,
        anchorLookupFailures: 1,
        anchorLookupError: 'fetch failed',
      });
      expect(
        anchorBinds(extractInsertBinds(mockSql, 'lottery_finder_fires')),
      ).toEqual(ALL_NULL);
      const captures = anchorFailedCaptures();
      expect(captures).toHaveLength(1);
      expect(captures[0]![0]).toBe(blip);
      expect(captures[0]![1]).toMatchObject({ level: 'warning' });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: blip, fires: 1 }),
        expect.stringContaining(ANCHOR_FAILED),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('stays success when the lookup fails but every fire hit ON CONFLICT (no row lost its anchor), and still raises the failure', async () => {
      mockLookupAnchorLegs.mockRejectedValue(new Error('boom'));
      queueOneSndkFire(null);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 0,
        anchorLookupFailures: 1,
        anchorLookupError: 'boom',
      });
      expect(anchorFailedCaptures()).toHaveLength(1);
    });
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

  it('fails open and binds NULL gex_* when the snapshot lookup throws, and reports partial', async () => {
    // Fail-open contract: a thrown error from getLatestGexbotSnapshotAt
    // MUST NOT block the INSERT. Sentry should capture, and all 8 gex_*
    // binds should resolve to NULL. The written row is missing its GexBot
    // context, so the run is 'partial', not 'success'.
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
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 1,
      gexLookupFailures: 1,
    });

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

    const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
    expect(payload).toMatchObject({ status: 'partial', gexLookupFailures: 1 });
    // The counter lands in Axiom `meta`, not as a new top-level column.
    expect(AXIOM_TOP_LEVEL_KEYS.has('gexLookupFailures')).toBe(false);
  });

  it('stays success when the GexBot lookup throws but no fire is written, and still reports the failure', async () => {
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
    // Default [] everywhere: the INSERT hits ON CONFLICT and returns no id.
    mockTicks(fireableSndkStream());

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      inserted: 0,
      gexLookupFailures: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon timeout' }),
      expect.objectContaining({
        tags: expect.objectContaining({ op: 'getLatestGexbotSnapshotAt' }),
      }),
    );
    expect(vi.mocked(reportCronRun).mock.calls[0]![1]).toMatchObject({
      status: 'success',
      gexLookupFailures: 1,
    });
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
      status: 'partial',
      rows: 1,
      inserted: 1,
      // Thrown lookup is counted as a miss, never a hit, and also as a
      // lookup failure (the subset of misses that threw).
      gexHits: 0,
      gexMisses: 1,
      gexLookupFailures: 1,
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
    mockCronGuard.mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-05-02',
    });
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

  // Spec lottery-cron-timeouts-2026-10-28.md, Phase A: the setup phase
  // must not time the run out, and each degraded path is surfaced.
  describe('setup-phase degradation', () => {
    const TAKEIT_TIMEOUT =
      'Take-It prefetch passed its 5000 ms deadline' as const;
    const TAKEIT_WARN =
      'detect-lottery-fires: Take-It prefetch failed; takeit_prob left null';
    const FLOW_FAILED_MSG =
      'detect-lottery-fires: ticker flow series failed; fires written without flow features';
    const FLOW_ERROR_MSG =
      'detect-lottery-fires: ticker flow series query error; fires written without flow features';
    const FLOW_DEADLINE = 'ticker flow series passed its 5000 ms deadline';

    // The real win-rate day cache. It is module state, so each test that
    // uses it runs on its own ET date.
    async function useRealWinRateCache(today: string) {
      const actual = await vi.importActual<
        typeof import('../_lib/takeit-detect.js')
      >('../_lib/takeit-detect.js');
      mockPriorSessionWinRatesForDay.mockImplementation(
        actual.priorSessionWinRatesForDay,
      );
      mockCronGuard.mockReturnValue({ ...GUARD, today });
    }

    // Runs the cron's own prefetch closures, as the real helper would.
    function runPrefetchClosures() {
      mockLoadTakeitDetectContext.mockImplementation(
        async (
          _alertType: string,
          deps: {
            fetchRecentSameType: (m: number) => Promise<unknown>;
            fetchRecentOtherTypeByChain: (m: number) => Promise<unknown>;
            fetchPriorSessionWinRateByTicker: () => Promise<unknown>;
          },
        ) => {
          await deps.fetchRecentSameType(35);
          await deps.fetchRecentOtherTypeByChain(10);
          await deps.fetchPriorSessionWinRateByTicker();
          return null;
        },
      );
    }

    // Every tagged-template SQL call: its text with `${}` where each bind
    // sat, plus the binds in order.
    function sqlCalls() {
      return mockSql.mock.calls.map((call) => {
        const [strings, ...params] = call as [readonly string[], ...unknown[]];
        return { text: strings.join('${}'), params };
      });
    }
    function sqlCall(...needles: string[]) {
      const found = sqlCalls().filter((c) =>
        needles.every((n) => c.text.includes(n)),
      );
      expect(found).toHaveLength(1);
      return found[0]!;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('bounds both recent-fire prefetch queries to ET today and yesterday, and loads win rates once for the early kick and the prefetch', async () => {
      const today = '2026-06-01';
      await useRealWinRateCache(today);
      runPrefetchClosures();
      mockSql.mockResolvedValueOnce([]); // win-rate load, kicked before the tick scan
      mockTicks(fireableSndkStream());

      await handler(authorizedReq(), mockResponse());

      // Without a `date` bound these walked the whole (date, trigger_time_ct)
      // index; the leading-column range makes them a two-day range scan.
      const sameType = sqlCall(
        'FROM lottery_finder_fires',
        'trigger_time_ct AS fire_time',
      );
      expect(sameType.text).toMatch(
        /WHERE date >= \$\{\}::date - 1\s+AND trigger_time_ct >= NOW\(\)/,
      );
      expect(sameType.params).toEqual([today, 35]);

      const otherType = sqlCall(
        'FROM silent_boom_alerts',
        'bucket_ct AS fire_time',
      );
      expect(otherType.text).toMatch(
        /WHERE date >= \$\{\}::date - 1\s+AND bucket_ct >= NOW\(\)/,
      );
      expect(otherType.params).toEqual([today, 10]);

      // Kicked at the top of the run, then asked for again by the prefetch:
      // the same loader both times, and one query, since the prefetch joins
      // the load already in flight.
      expect(mockPriorSessionWinRatesForDay).toHaveBeenCalledTimes(2);
      const [kick, prefetch] = mockPriorSessionWinRatesForDay.mock.calls;
      expect(kick).toEqual(['lottery', today, expect.any(Function)]);
      expect(prefetch).toEqual(['lottery', today, kick![2]]);
      const winRate = sqlCall('AVG(daily_rate)', 'FROM lottery_finder_fires');
      expect(winRate.text).toContain('AND date < ${}::date');
      expect(winRate.params).toEqual([today]);
      // ...and it went out before the tick scan, not after it.
      expect(sqlCalls()[0]!.text).toContain('AVG(daily_rate)');

      // Both recent-fire queries get one retry and no per-attempt cap: the
      // 5 s prefetch deadline bounds the total, and a cap would turn a slow
      // success into a failure plus a second, uncancelled copy of the query.
      expect(mockWithDbRetry).toHaveBeenCalledWith(expect.any(Function), 1);
      expect(
        mockWithDbRetry.mock.calls.filter(
          (call) => call.length === 2 && call[1] === 1,
        ),
      ).toHaveLength(2);
    });

    it('starts the win-rate load on an empty pre-open scan and waits for it, so the cache is warm at the open', async () => {
      const today = '2026-06-02';
      await useRealWinRateCache(today);
      mockSql.mockResolvedValueOnce([
        { underlying_symbol: 'SNDK', win_rate: 0.4 },
      ]); // win-rate warm-up
      mockTicks([]);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({ status: 'skipped' });
      expect(
        sqlCall('AVG(daily_rate)', 'FROM lottery_finder_fires').params,
      ).toEqual([today]);
      // The skipped run waits on the very load it started, with a budget
      // measured from the run's own start time.
      const warmup = mockPriorSessionWinRatesForDay.mock.results[0]!.value;
      expect(mockAwaitWinRateWarmup).toHaveBeenCalledExactlyOnceWith(
        warmup,
        expect.any(Number),
      );
      const startTimeMs = mockAwaitWinRateWarmup.mock.calls[0]![1] as number;
      expect(Date.now() - startTimeMs).toBeGreaterThanOrEqual(0);
      expect(Date.now() - startTimeMs).toBeLessThan(10_000);
      await expect(warmup).resolves.toEqual([
        { underlying_symbol: 'SNDK', win_rate: 0.4 },
      ]);
    });

    it('writes the fire with takeit_prob NULL when the Take-It prefetch passes its 5 s deadline, and reports partial with a counter and one Sentry warning', async () => {
      const actual = await vi.importActual<
        typeof import('../_lib/takeit-detect.js')
      >('../_lib/takeit-detect.js');
      mockLoadTakeitDetectContext.mockImplementation(
        actual.loadTakeitDetectContext,
      );
      mockGetBundle.mockResolvedValue({ version: 'test-v1' });
      const hang = () => new Promise(() => {});
      // The win-rate load comes from the mocked day cache (resolves []).
      mockTicks(fireableSndkStream())
        .mockResolvedValueOnce([]) // prior fires
        .mockReturnValueOnce(hang()) // recent same-type fires: never answers
        .mockReturnValueOnce(hang()) // recent silent-boom fires: never answers
        .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // flow_data (Pass 2)
        .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
        .mockResolvedValueOnce([{ id: 42 }]); // insert

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const res = mockResponse();
      const run = handler(authorizedReq(), res);
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 1,
        takeitPrefetchFailures: 1,
        takeitPrefetchError: TAKEIT_TIMEOUT,
      });
      const binds = extractInsertBinds(mockSql, 'lottery_finder_fires');
      expect(binds.get('takeit_prob')).toBeNull();
      expect(binds.get('takeit_model_version')).toBeNull();

      // One Sentry warning for the run, under the timeout fingerprint.
      const takeitCaptures = vi
        .mocked(Sentry.captureException)
        .mock.calls.filter(
          (call) =>
            (call[1] as { fingerprint?: string[] } | undefined)
              ?.fingerprint?.[0] === 'takeit-detect',
        );
      expect(takeitCaptures).toHaveLength(1);
      expect((takeitCaptures[0]![0] as Error).message).toBe(TAKEIT_TIMEOUT);
      expect(takeitCaptures[0]![1]).toMatchObject({
        level: 'warning',
        fingerprint: ['takeit-detect', 'lottery', 'prefetch-timeout'],
      });
      expect(logger.warn).toHaveBeenCalledWith(
        {
          takeitPrefetchError: TAKEIT_TIMEOUT,
          takeitPrefetchFailureKind: 'timeout',
        },
        TAKEIT_WARN,
      );

      // The counter lands in Axiom `meta`, not as a new top-level column.
      const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
      expect(payload).toMatchObject({
        status: 'partial',
        takeitPrefetchFailureKind: 'timeout',
      });
      for (const key of [
        'takeitPrefetchFailures',
        'takeitPrefetchError',
        'takeitPrefetchFailureKind',
      ]) {
        expect(payload).toHaveProperty(key);
        expect(AXIOM_TOP_LEVEL_KEYS.has(key)).toBe(false);
      }
    });

    it('fails the run with an error-level capture when the Take-It prefetch hits a genuine query error, and still writes the fire', async () => {
      const actual = await vi.importActual<
        typeof import('../_lib/takeit-detect.js')
      >('../_lib/takeit-detect.js');
      mockLoadTakeitDetectContext.mockImplementation(
        actual.loadTakeitDetectContext,
      );
      mockGetBundle.mockResolvedValue({ version: 'test-v1' });
      const broken = new Error('column "trigger_time_ct" does not exist');
      mockTicks(fireableSndkStream())
        .mockResolvedValueOnce([]) // prior fires
        .mockRejectedValueOnce(broken) // recent same-type fires: broken query
        .mockResolvedValueOnce([]) // recent silent-boom fires
        .mockResolvedValueOnce([]) // ticker_flow_snapshot (Pass 1)
        .mockResolvedValueOnce([]) // flow_data (Pass 2)
        .mockResolvedValueOnce([]) // spot_exposures (Pass 2)
        .mockResolvedValueOnce([{ id: 42 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      // A bug, not Neon being slow: red check-in, whatever was written.
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        inserted: 1,
        takeitPrefetchFailures: 1,
        takeitPrefetchError: broken.message,
        takeitPrefetchFailureKind: 'error',
      });
      expect(
        extractInsertBinds(mockSql, 'lottery_finder_fires').get('takeit_prob'),
      ).toBeNull();
      const takeitCaptures = vi
        .mocked(Sentry.captureException)
        .mock.calls.filter((call) => call[0] === broken);
      expect(takeitCaptures).toHaveLength(1);
      expect(takeitCaptures[0]![1]).toMatchObject({
        level: 'error',
        fingerprint: ['takeit-detect', 'lottery', 'prefetch-error'],
      });
      expect(logger.error).toHaveBeenCalledWith(
        {
          takeitPrefetchError: broken.message,
          takeitPrefetchFailureKind: 'error',
        },
        'detect-lottery-fires: Take-It prefetch query error; takeit_prob left null',
      );
    });

    it('stays success when the Take-It prefetch fails but every fire was already written (no row lost its score)', async () => {
      mockLoadTakeitDetectContext.mockImplementation(
        async (
          _alertType: string,
          _deps: unknown,
          onPrefetchFailure: (failure: {
            reason: string;
            kind: string;
          }) => void,
        ) => {
          onPrefetchFailure({ reason: TAKEIT_TIMEOUT, kind: 'timeout' });
          return null;
        },
      );
      // Default [] everywhere: the INSERT hits ON CONFLICT and returns no id.
      mockTicks(fireableSndkStream());

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 0,
        takeitPrefetchFailures: 1,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        {
          takeitPrefetchError: TAKEIT_TIMEOUT,
          takeitPrefetchFailureKind: 'timeout',
        },
        TAKEIT_WARN,
      );
    });

    it('writes a ticker’s fires without flow features on a transient flow-series failure, then skips the rest by breaker, and reports it once', async () => {
      const flowError = 'db attempt timeout';
      mockTicks([
        ...fireableSndkStream(),
        ...streamFor('TSLA', 'TSLA260501C01175000'),
        ...streamFor('TSLA', 'TSLA260501C01180000'),
        ...streamFor('RKLB', 'RKLB260501C01175000'),
      ])
        .mockResolvedValueOnce([]) // prior fires
        // Pass 1, one flow series per ticker-day.
        .mockResolvedValueOnce([
          {
            ts: '2026-05-01T13:29:30Z',
            cum_ncp: '5000000',
            cum_npp: '1000000',
          },
        ]) // SNDK: aligned call
        .mockRejectedValueOnce(new Error(flowError)) // TSLA: transient failure
        // TSLA's second chain reuses the failed day; RKLB is skipped.
        // Pass 2, per fire: flow_data, spot_exposures, INSERT.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 3 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 4 }]);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 4,
        flowSeriesFailures: 1,
        flowSeriesSkippedBreaker: 1,
        flowSeriesGenuineFailures: 0,
        firstFlowSeriesError: {
          ticker: 'TSLA',
          date: '2026-05-01',
          error: flowError,
        },
      });
      // The failed ticker-day is not retried for its second chain, and the
      // breaker keeps RKLB from asking a struggling Neon at all.
      expect(
        sqlCalls().filter((c) => c.text.includes('ws_net_flow_per_ticker')),
      ).toHaveLength(2);

      const [sndk, tsla1, tsla2, rklb] = extractAllInsertBinds(
        mockSql,
        'lottery_finder_fires',
      );
      // SNDK keeps its flow features and its score.
      expect(sndk!.get('underlying_symbol')).toBe('SNDK');
      expect(sndk!.get('cum_ncp_at_fire')).toBe(5_000_000);
      expect(Number.isInteger(sndk!.get('score'))).toBe(true);
      // The other fires are written with the flow features NULL, not 0.
      // With no flow, the fire isn't aligned, so its V2 score is NULL too.
      expect(rklb!.get('underlying_symbol')).toBe('RKLB');
      for (const binds of [tsla1!, tsla2!, rklb!]) {
        expect(binds.get('cum_ncp_at_fire')).toBeNull();
        expect(binds.get('cum_npp_at_fire')).toBeNull();
        expect(binds.get('score')).toBeNull();
      }

      const flowCaptures = mockSentryCaptureMessage.mock.calls.filter(
        (call) => call[0] === FLOW_FAILED_MSG,
      );
      expect(flowCaptures).toHaveLength(1);
      expect(flowCaptures[0]![1]).toMatchObject({
        level: 'warning',
        fingerprint: ['detect-lottery-fires', 'flow-series-failed'],
        extra: {
          flowSeriesFailures: 1,
          flowSeriesSkippedBreaker: 1,
          firstFlowSeriesError: {
            ticker: 'TSLA',
            date: '2026-05-01',
            error: flowError,
          },
        },
      });
      expect(
        vi
          .mocked(logger.warn)
          .mock.calls.filter((call) => call[1] === FLOW_FAILED_MSG),
      ).toHaveLength(1);

      const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
      for (const key of [
        'flowSeriesFailures',
        'flowSeriesSkippedBreaker',
        'flowSeriesGenuineFailures',
        'firstFlowSeriesError',
        'firstFlowSeriesGenuineError',
      ]) {
        expect(payload).toHaveProperty(key);
        expect(AXIOM_TOP_LEVEL_KEYS.has(key)).toBe(false);
      }
    });

    it('gives a stalled flow series 5 s, then opens the breaker so the next ticker is not fetched', async () => {
      mockTicks([
        ...fireableSndkStream(),
        ...streamFor('TSLA', 'TSLA260501C01175000'),
      ])
        .mockResolvedValueOnce([]) // prior fires
        .mockReturnValueOnce(new Promise(() => {})) // SNDK flow series: stalls
        // TSLA's flow series is skipped. Pass 2 per fire: flow_data,
        // spot_exposures, INSERT.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2 }]);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const res = mockResponse();
      const run = handler(authorizedReq(), res);
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 2,
        flowSeriesFailures: 1,
        flowSeriesSkippedBreaker: 1,
        firstFlowSeriesError: {
          ticker: 'SNDK',
          date: '2026-05-01',
          error: FLOW_DEADLINE,
        },
      });
      expect(
        sqlCalls().filter((c) => c.text.includes('ws_net_flow_per_ticker')),
      ).toHaveLength(1);
      for (const binds of extractAllInsertBinds(
        mockSql,
        'lottery_finder_fires',
      )) {
        expect(binds.get('cum_ncp_at_fire')).toBeNull();
        expect(binds.get('score')).toBeNull();
      }
      expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
        FLOW_FAILED_MSG,
        expect.objectContaining({
          extra: expect.objectContaining({
            flowSeriesFailures: 1,
            flowSeriesSkippedBreaker: 1,
          }),
        }),
      );
    });

    it('reports a genuine flow-series error at error level and fails the run, but still writes every fire and does not open the breaker', async () => {
      const flowError = new Error('column "net_call_prem" does not exist');
      mockTicks([
        ...fireableSndkStream(),
        ...streamFor('TSLA', 'TSLA260501C01175000'),
      ])
        .mockResolvedValueOnce([]) // prior fires
        .mockRejectedValueOnce(flowError) // SNDK flow series: broken query
        .mockResolvedValueOnce([]) // TSLA flow series: still asked
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2 }]);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      // A broken query is a bug: 'error' regardless of what was written.
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        inserted: 2,
        flowSeriesFailures: 0,
        flowSeriesSkippedBreaker: 0,
        flowSeriesGenuineFailures: 1,
        firstFlowSeriesGenuineError: {
          ticker: 'SNDK',
          date: '2026-05-01',
          error: 'column "net_call_prem" does not exist',
        },
      });
      expect(
        sqlCalls().filter((c) => c.text.includes('ws_net_flow_per_ticker')),
      ).toHaveLength(2);
      expect(
        extractInsertBinds(mockSql, 'lottery_finder_fires').get(
          'underlying_symbol',
        ),
      ).toBe('TSLA');

      const errorCaptures = vi
        .mocked(Sentry.captureException)
        .mock.calls.filter((call) => call[0] === flowError);
      expect(errorCaptures).toHaveLength(1);
      expect(errorCaptures[0]![1]).toMatchObject({
        level: 'error',
        fingerprint: ['detect-lottery-fires', 'flow-series-error'],
        extra: { flowSeriesGenuineFailures: 1 },
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: flowError,
          flowSeriesGenuineFailures: 1,
        }),
        FLOW_ERROR_MSG,
      );
      // Not the transient report.
      expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
        FLOW_FAILED_MSG,
        expect.anything(),
      );
    });

    it('reports no setup degradation on a clean run', async () => {
      mockTicks(fireableSndkStream())
        .mockResolvedValueOnce([]) // prior fires
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([]) // flow_data
        .mockResolvedValueOnce([]) // spot_exposures
        .mockResolvedValueOnce([{ id: 42 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        takeitPrefetchFailures: 0,
        takeitPrefetchError: null,
        takeitPrefetchFailureKind: null,
        flowSeriesFailures: 0,
        flowSeriesSkippedBreaker: 0,
        flowSeriesGenuineFailures: 0,
        firstFlowSeriesError: null,
        firstFlowSeriesGenuineError: null,
        candleFetchFailures: 0,
        candleFetchEmpty: 0,
        candleFetchSkippedBreaker: 0,
        macroSnapshotFailures: 0,
        gexLookupFailures: 0,
      });
      expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
        FLOW_FAILED_MSG,
        expect.anything(),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
