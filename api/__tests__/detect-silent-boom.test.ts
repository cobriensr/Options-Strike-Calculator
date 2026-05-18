// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

// Phase 2 multileg classifier — fail-open by design. Default to null so
// the four migration #160 columns (inferred_structure, is_isolated_leg,
// match_confidence, pattern_group_id) bind as null on the INSERT. Tests
// that exercise the populated path override per-case via mockResolvedValue.
const mockClassifyAlertMultileg = vi.hoisted(() => vi.fn());
vi.mock('../_lib/multileg-classify-batch.js', () => ({
  classifyAlertMultileg: mockClassifyAlertMultileg,
}));

// Take-It scoring is fail-open. Mock loadTakeitDetectContext to return
// null so no Blob fetch happens; scoreSilentBoom returns nulls; INSERT
// gets null takeit_prob + takeit_model_version + takeit_features at the
// tail (Phase 3d tail-append). Use plain functions inside the factory —
// chained vi.fn().mockReturnValue can lose the return value through
// vi.mock factory resolution.
vi.mock('../_lib/takeit-detect.js', () => ({
  loadTakeitDetectContext: () => Promise.resolve(null),
  scoreSilentBoom: () => ({ prob: null, version: null, features: null }),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/detect-silent-boom.js';

const GUARD = { apiKey: '', today: '2026-05-07' };

// ============================================================
// Fixture builders — generate the SQL-aggregated bucket rows the
// handler now consumes (raw-tick projection was replaced with
// in-Postgres date_bin aggregation to stay under Neon's 64 MB HTTP
// cap). Detector spec: 4 silent baseline buckets (≤500 vol each)
// followed by a spike bucket with size ≥1000, ratio ≥5×, ask% ≥0.7,
// vol/OI ≥0.25, OI ≥100.
// ============================================================

interface BucketOverrides {
  size?: number;
  askSize?: number;
  bidSize?: number;
  multiLegSize?: number;
  vwap?: number;
  lastPrice?: number;
  bucketMaxOi?: number | null;
  /**
   * Volume-weighted underlying spot for the bucket. Drives the
   * underlying_price_at_spike INSERT bind (migration #152). Default
   * null mirrors a bucket where no underlying_price column was
   * available — the detector passes null through.
   */
  underlyingPrice?: number | null;
}

function bucketRow(
  optionChain: string,
  ticker: string,
  optionType: 'C' | 'P',
  strike: number,
  expiry: string,
  bucketTsIso: string,
  overrides: BucketOverrides = {},
) {
  const size = overrides.size ?? 100;
  const vwap = overrides.vwap ?? 0.5;
  const underlyingPrice =
    overrides.underlyingPrice === undefined ? null : overrides.underlyingPrice;
  return {
    ticker,
    option_chain: optionChain,
    option_type: optionType,
    strike,
    expiry,
    bucket_ts: bucketTsIso,
    size,
    ask_size: overrides.askSize ?? size, // default: all ask-side
    bid_size: overrides.bidSize ?? 0,
    multi_leg_size: overrides.multiLegSize ?? 0,
    notional: vwap * size,
    bucket_max_oi:
      overrides.bucketMaxOi === undefined ? 5000 : overrides.bucketMaxOi,
    last_price: overrides.lastPrice ?? vwap,
    underlying_notional:
      underlyingPrice != null ? underlyingPrice * size : null,
  };
}

/**
 * 5 buckets on chain SNDK260507C01175000:
 *   - 4 silent baseline buckets at 13:00, 13:05, 13:10, 13:15 — 100
 *     contracts each (well under baselineMedianMax=500).
 *   - 1 spike bucket at 13:20 — 2000 contracts, all ask-side, OI=5000
 *     so vol/OI = 0.4 (above 0.25 floor).
 *
 * The spike's ratio vs baseline median (100) is 20×, well above 5×.
 */
function fireableSilentBoomStream() {
  const chain = 'SNDK260507C01175000';
  const ticker = 'SNDK';
  const opt = 'C' as const;
  const strike = 1175;
  const exp = '2026-05-07';

  const rows: ReturnType<typeof bucketRow>[] = [];
  for (let b = 0; b < 4; b += 1) {
    const minute = b * 5;
    const iso = `2026-05-07T13:${String(minute).padStart(2, '0')}:00Z`;
    rows.push(bucketRow(chain, ticker, opt, strike, exp, iso, { size: 100 }));
  }
  rows.push(
    bucketRow(chain, ticker, opt, strike, exp, '2026-05-07T13:20:00Z', {
      size: 2000,
    }),
  );
  return rows;
}

describe('detect-silent-boom handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    // Default: classifier returns null — INSERT binds the four multileg
    // columns as null. Tests that exercise the populated path override.
    mockClassifyAlertMultileg.mockResolvedValue(null);
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped when no ticks are in the scan window', async () => {
    mockSentryCaptureMessage.mockClear();
    mockSql.mockResolvedValueOnce([]);

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
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Empty bucket window during market hours is anomalous (the cron-
    // instrumentation gate guarantees we're inside open hours) — emit
    // a Sentry warning so silent stalls like the 2026-05-18 Neon blip
    // surface as alerts instead of zero-row DB hours.
    expect(mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('empty bucket scan during market hours'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': 'empty-window',
        }),
      }),
    );
  });

  it('inserts an alert when the silent-boom pattern matches', async () => {
    // Sequence: SELECT ticks → SELECT prior fires (empty) →
    // SELECT market_tide ticks (empty) → INSERT.
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
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
      // withCronInstrumentation spreads metadata flat into the response.
      chains: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('skips chains with fewer than baselineBuckets+1 buckets', async () => {
    // Only 3 buckets — below the 5-bucket detector minimum. Handler
    // bails with skippedShort before any prior-fires lookup or insert.
    const shortStream = fireableSilentBoomStream().slice(0, 3);
    mockSql.mockResolvedValueOnce(shortStream);
    mockSql.mockResolvedValueOnce([]); // tide ticks (always queried)
    mockSql.mockResolvedValueOnce([]); // tide_otm ticks (always queried)
    mockSql.mockResolvedValueOnce([]); // zero_dte ticks
    mockSql.mockResolvedValueOnce([]); // spx_gamma ticks

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
    // ticks SELECT + tide / tide_otm / zero_dte / spx_gamma SELECTs
    // (always queried). No eligible chains so the prior-fires query
    // is skipped; no fires so no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('skips chains whose max OI is below the minOi floor', async () => {
    // Same shape as the fireable stream but with bucket_max_oi=50 on
    // every bucket — below MIN_OI=100. Handler bails with skippedNoOi.
    const lowOiStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      bucket_max_oi: 50,
    }));
    mockSql
      .mockResolvedValueOnce(lowOiStream) // ticks
      .mockResolvedValueOnce([]) // prior fires (chain passed bucket-count gate)
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]); // spx_gamma ticks

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      skippedNoOi: 1,
      totalFires: 0,
      inserted: 0,
    });
  });

  it('honors ON CONFLICT (returns 0 inserted when DB returns no rows)', async () => {
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
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

  it('seeds detector cooldown from prior-fire SELECT — no duplicate fire when within 60-min cooldown', async () => {
    // Spike bucket is at 13:20:00Z. Seed prior fire at 12:30:00Z
    // (50 min before). Cooldown is 60 min, so the detector must
    // suppress the new fire.
    const priorMs = Date.parse('2026-05-07T12:30:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260507C01175000',
          last_ms: String(priorMs),
        },
      ]) // prior fire — cooldown active
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]); // spx_gamma ticks

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
    // Six SQL calls — ticks SELECT, prior-fires lookup, four macro
    // snapshot SELECTs (tide / tide_otm / zero_dte / spx_gamma).
    // No insert because the cooldown gate suppressed the fire entirely.
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('binds the latest market_tide tick (NCP - NPP) to the INSERT', async () => {
    // Spike bucket at 13:20:00Z. Seed a market_tide tick at 13:18Z
    // (2 min before, inside the 30-min staleness window) with
    // NCP=8000, NPP=2000 — diff +6000. tide_otm at the same instant
    // with NCP=4000, NPP=1000 → diff +3000.
    const tickMs = Date.parse('2026-05-07T13:18:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(tickMs), ncp: '8000', npp: '2000' },
      ]) // tide ticks
      .mockResolvedValueOnce([
        { ts_ms: String(tickMs), ncp: '4000', npp: '1000' },
      ]) // tide_otm ticks → diff +3000
      .mockResolvedValueOnce([
        { ts_ms: String(tickMs), ncp: '500', npp: '200' },
      ]) // zero_dte ticks → diff +300
      .mockResolvedValueOnce([{ ts_ms: String(tickMs), gamma_oi: '12345' }]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Migration #158 added a per-fire ticker_flow_snapshot query between
    // spx_gamma and INSERT (+1); migration #169 added a per-fire
    // pre_trade_count COUNT before the INSERT (+1) — this path is now
    // 9 calls.
    expect(mockSql).toHaveBeenCalledTimes(9);
    // INSERT is the last call. Migration #158 tail-appended
    // cum_ncp_at_fire + cum_npp_at_fire before takeit_*; combined with
    // Phase 3d's takeit_features tail-append and migration #160's four
    // multileg columns inserted BETWEEN cum_npp_at_fire and takeit_*,
    // the tail layout is now:
    //   ...mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff,
    //   spx_spot_gamma_oi, multi_leg_share, underlying_price_at_spike,
    //   cum_ncp_at_fire, cum_npp_at_fire,
    //   inferred_structure, is_isolated_leg, match_confidence, pattern_group_id,
    //   takeit_prob, takeit_model_version, takeit_features.
    // takeit_* indices unchanged; everything before the multileg insert
    // shifted by -4.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // Migration #168 appended gamma_at_trigger, #169 appended
    // pre_trade_count, #170 appended adj_cofire, and #171 appended
    // (first_min_share, spread_in_bucket). Combined shift from the
    // pre-#168 layout is −5 (more negative).
    const spreadInBucket = insertCall.at(-1);
    const firstMinShare = insertCall.at(-2);
    const adjCofire = insertCall.at(-3);
    const preTradeCount = insertCall.at(-4);
    const gammaAtTrigger = insertCall.at(-5);
    const takeitFeatures = insertCall.at(-6);
    const takeitVersion = insertCall.at(-7);
    const takeitProb = insertCall.at(-8);
    const patternGroupId = insertCall.at(-9);
    const matchConfidence = insertCall.at(-10);
    const isIsolatedLeg = insertCall.at(-11);
    const inferredStructure = insertCall.at(-12);
    const underlyingAtSpike = insertCall.at(-15);
    const multiLegShare = insertCall.at(-16);
    const spxGamma = insertCall.at(-17);
    const zeroDteDiff = insertCall.at(-18);
    const tideOtmDiff = insertCall.at(-19);
    const tideDiff = insertCall.at(-20);
    expect(takeitProb).toBeNull(); // mocked context returns null
    expect(takeitVersion).toBeNull();
    expect(takeitFeatures).toBeNull();
    expect(tideDiff).toBe(6000);
    expect(tideOtmDiff).toBe(3000);
    expect(zeroDteDiff).toBe(300);
    expect(spxGamma).toBe(12345);
    // Single-leg-only stream: multi_leg_size=0 → share=0.
    expect(multiLegShare).toBe(0);
    // Fixture buckets don't set underlyingPrice → null at the boundary.
    expect(underlyingAtSpike).toBeNull();
    // Default mock returns null classification → all four multileg
    // columns bind as null.
    expect(inferredStructure).toBeNull();
    expect(isIsolatedLeg).toBeNull();
    expect(matchConfidence).toBeNull();
    expect(patternGroupId).toBeNull();
    // bucketRow fixture doesn't set bucket_gamma → null in INSERT.
    expect(gammaAtTrigger).toBeNull();
    // pre_trade_count mock returned { cnt: 0 } → 0 propagates.
    expect(preTradeCount).toBe(0);
    // Single-fire fixture → no adjacent strike fires this cron-tick →
    // adj_cofire stays false.
    expect(adjCofire).toBe(false);
    // bucketRow fixture doesn't set first_min_share / spread_in_bucket
    // (#171) → null in INSERT.
    expect(firstMinShare).toBeNull();
    expect(spreadInBucket).toBeNull();
  });

  it('binds null tide diff when the latest tick is older than 30 minutes', async () => {
    // Spike bucket at 13:20:00Z. Tide tick at 12:00Z — 80 min before,
    // outside the 30-min staleness window, so tide diff should be null.
    const staleTickMs = Date.parse('2026-05-07T12:00:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ts_ms: String(staleTickMs), ncp: '8000', npp: '2000' },
      ]) // tide tick — stale
      .mockResolvedValueOnce([
        { ts_ms: String(staleTickMs), ncp: '4000', npp: '1000' },
      ]) // tide_otm tick — also stale
      .mockResolvedValueOnce([
        { ts_ms: String(staleTickMs), ncp: '500', npp: '200' },
      ]) // zero_dte tick — also stale
      .mockResolvedValueOnce([
        { ts_ms: String(staleTickMs), gamma_oi: '12345' },
      ]) // spx_gamma tick — also stale
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // Bind tail layout post-#168/#169/#170 tail-appends: every
    // pre-#168 index shifts by −3 vs the prior layout. Single-leg
    // stream → multi_leg_share=0; all four macro fields are null
    // (every tick stale); underlyingPrice not set in fixture → null
    // at the boundary.
    expect(insertCall.at(-1)).toBeNull(); // spread_in_bucket
    expect(insertCall.at(-2)).toBeNull(); // first_min_share
    expect(insertCall.at(-3)).toBe(false); // adj_cofire (single fire)
    expect(insertCall.at(-4)).toBe(0); // pre_trade_count (mock cnt=0)
    expect(insertCall.at(-5)).toBeNull(); // gamma_at_trigger
    expect(insertCall.at(-15)).toBeNull(); // underlying_price_at_spike
    expect(insertCall.at(-16)).toBe(0); // multi_leg_share
    expect(insertCall.at(-17)).toBeNull(); // spx_spot_gamma_oi
    expect(insertCall.at(-18)).toBeNull(); // zero_dte_diff
    expect(insertCall.at(-19)).toBeNull(); // mkt_tide_otm_diff
    expect(insertCall.at(-20)).toBeNull(); // mkt_tide_diff
  });

  it('flags direction_gated=true and demotes score_tier to tier3 on a counter-trend put fire (mkt_tide_diff > +100M)', async () => {
    // Phase 4 direction gate (spec
    // silent-boom-direction-gate-and-trail-ui-2026-05-14.md): a PUT
    // fire with all-in mkt_tide_diff > +100M is bullish-counter-trend
    // and should be demoted regardless of the underlying score. The
    // fixture swaps the call stream for a put stream and seeds tide at
    // ncp=200M, npp=50M → diff = +150_000_000 (above T=±100M).
    const putStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      option_type: 'P' as const,
      option_chain: 'SNDK260507P01175000',
    }));
    const tickMs = Date.parse('2026-05-07T13:18:00Z');
    mockSql
      .mockResolvedValueOnce(putStream) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(tickMs), ncp: '200000000', npp: '50000000' },
      ]) // tide ticks → diff +150_000_000 (counter-trend for puts)
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
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
    // Bind order ends with score, score_tier, direction_gated,
    // mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff,
    // spx_spot_gamma_oi, multi_leg_share, underlying_price_at_spike,
    // cum_ncp_at_fire, cum_npp_at_fire,
    // inferred_structure, is_isolated_leg, match_confidence, pattern_group_id,
    // takeit_prob, takeit_model_version, takeit_features,
    // gamma_at_trigger, pre_trade_count, adj_cofire,
    // first_min_share, spread_in_bucket. Post-#171 layout:
    //   at(-1) = spread_in_bucket  at(-2) = first_min_share
    //   at(-3) = adj_cofire  at(-4) = pre_trade_count
    //   at(-5) = gamma_at_trigger  at(-6) = takeit_features
    //   at(-7) = takeit_model_version  at(-8) = takeit_prob
    //   at(-9) = pattern_group_id  at(-10) = match_confidence
    //   at(-11) = is_isolated_leg  at(-12) = inferred_structure
    //   at(-13) = cum_npp_at_fire  at(-14) = cum_ncp_at_fire
    //   at(-15) = underlying_price_at_spike
    //   at(-20) = mkt_tide_diff  at(-21) = direction_gated
    //   at(-22) = score_tier (demoted to 'tier3')
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    expect(insertCall.at(-20)).toBe(150_000_000);
    expect(insertCall.at(-21)).toBe(true);
    expect(insertCall.at(-22)).toBe('tier3');
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
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
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
    // Post-#171 tail layout: ..., inferred_structure(-12),
    //              is_isolated_leg(-11), match_confidence(-10),
    //              pattern_group_id(-9), takeit_*(-8..-6),
    //              gamma_at_trigger(-5), pre_trade_count(-4),
    //              adj_cofire(-3), first_min_share(-2),
    //              spread_in_bucket(-1).
    expect(insertCall.at(-12)).toBe('vertical');
    expect(insertCall.at(-11)).toBe(false);
    expect(insertCall.at(-10)).toBe(0.83);
    expect(insertCall.at(-9)).toBe('pg-abc-123');
    // Helper was called once with the alert's anchor coordinates.
    expect(mockClassifyAlertMultileg).toHaveBeenCalledTimes(1);
    const [, , ticker, optionChain] = mockClassifyAlertMultileg.mock.calls[0]!;
    expect(ticker).toBe('SNDK');
    expect(optionChain).toBe('SNDK260507C01175000');
  });

  it('inserts with null multileg columns when classifier returns null (graceful degradation)', async () => {
    // Default mock returns null — INSERT still happens, four multileg
    // columns bind as null. Confirms fail-open semantics: a sidecar
    // outage does NOT block alert insertion (the columns are NULLABLE
    // by migration #160 design).
    mockClassifyAlertMultileg.mockResolvedValue(null);
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
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
    // Post-#171 tail: inferred_structure(-12), is_isolated_leg(-11),
    // match_confidence(-10), pattern_group_id(-9).
    expect(insertCall.at(-12)).toBeNull(); // inferred_structure
    expect(insertCall.at(-11)).toBeNull(); // is_isolated_leg
    expect(insertCall.at(-10)).toBeNull(); // match_confidence
    expect(insertCall.at(-9)).toBeNull(); // pattern_group_id
  });

  it('still fires when prior-fire is older than the 60-min cooldown', async () => {
    // Spike at 13:20:00Z, prior at 12:00:00Z (80 min before — outside
    // the 60-min cooldown). The detector lets the new fire through.
    const priorMs = Date.parse('2026-05-07T12:00:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260507C01175000',
          last_ms: String(priorMs),
        },
      ])
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert

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

  it('flags adj_cofire=TRUE on both rows when two adjacent-strike chains fire in the same bucket (Phase B / migration #170)', async () => {
    // Build two chains on SNDK $1 apart (1175C and 1176C) where both
    // fire at the same bucket_ts. The intra-cron keyset should
    // populate from both fires, and the strike±1 lookup should flip
    // adj_cofire=TRUE on each row.
    const baseStream = fireableSilentBoomStream(); // strike 1175C
    const altStream = baseStream.map((b) => ({
      ...b,
      option_chain: 'SNDK260507C01176000',
      strike: 1176, // adjacent ($1 step for non-index ticker)
    }));
    mockSql
      .mockResolvedValueOnce([...baseStream, ...altStream]) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      // Two fires → two pre_trade_count + two ticker_flow_snapshot
      // (ticker_flow_snapshot cache hit on the 2nd one — same ticker
      // + date) + two INSERTs. ticker_flow_snapshot only fires once
      // because cache shares across chains on the same (ticker, date).
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count fire #1
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (once, shared)
      .mockResolvedValueOnce([{ id: 100 }]) // insert fire #1
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count fire #2
      .mockResolvedValueOnce([{ id: 101 }]); // insert fire #2

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

    // Both INSERTs should have adj_cofire=true. Filter to INSERT
    // calls specifically — the pre_trade_count COUNT query
    // interleaves with the INSERTs so slice(-2) picks up
    // pre_trade_count #2 instead of the INSERTs. Post-#171,
    // adj_cofire is at at(-3) (first_min_share, spread_in_bucket
    // sit at -2/-1).
    const insertCalls = mockSql.mock.calls.filter((c) => {
      const strings = c[0] as readonly string[];
      return strings[0]?.includes('INSERT INTO silent_boom_alerts');
    });
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]!.at(-3)).toBe(true); // adj_cofire fire #1
    expect(insertCalls[1]!.at(-3)).toBe(true); // adj_cofire fire #2
  });
});
