// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import {
  expectAllGexBindsNull,
  extractAllInsertBinds,
  extractInsertBinds,
} from './insert-binds';

const mockSql = vi.fn();

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

// Take-It scoring is fail-open. mockScoreSilentBoom is hoisted so the
// same vi.fn() instance is both registered in the factory AND available
// for per-test mockReturnValueOnce overrides via vi.mocked(scoreSilentBoom).
const mockScoreSilentBoom = vi.hoisted(() =>
  vi.fn().mockReturnValue({ prob: null, version: null, features: null }),
);
vi.mock('../_lib/takeit-detect.js', () => ({
  loadTakeitDetectContext: () => Promise.resolve(null),
  scoreSilentBoom: mockScoreSilentBoom,
}));

// GexBot context lookup is fail-open (migration #180). Default the
// helper to return null so the INSERT writes NULL into the gex_*
// columns and the SQL call count stays stable. Real-world fixtures
// where a snapshot was found are tested in the gexbot-queries unit
// tests; here we only need the integration-level no-snapshot path.
const mockGetLatestGexbotSnapshotAt = vi.hoisted(() => vi.fn());
const mockMapToGexbotTicker = vi.hoisted(() => vi.fn());
vi.mock('../_lib/gexbot-queries.js', () => ({
  getLatestGexbotSnapshotAt: mockGetLatestGexbotSnapshotAt,
  mapToGexbotTicker: mockMapToGexbotTicker,
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
    // Default: ticker stays in its raw form (SPY/QQQ) so the lookup
    // fires; the lookup itself returns null so the gex_* binds are
    // NULL. Tests that exercise the populated path override.
    mockMapToGexbotTicker.mockImplementation((t: string) => t);
    mockGetLatestGexbotSnapshotAt.mockResolvedValue(null);
    process.env.CRON_SECRET = 'test-secret';
    // vi.resetAllMocks() clears the default return value set on the
    // hoisted vi.fn(). Restore the null-prob default so tests that
    // don't override scoreSilentBoom still get null takeit_* columns.
    mockScoreSilentBoom.mockReturnValue({
      prob: null,
      version: null,
      features: null,
    });
  });

  it('returns skipped + warns when no ticks are in the scan window (active session)', async () => {
    // Fake only the clock to a clearly-active session time (11:00 ET) so
    // the isPastCashOpen() gate on the empty-window warning is satisfied
    // deterministically regardless of when CI runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-29T15:00:00Z')); // 11:00 ET, active
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
    // Empty bucket window during active market hours is anomalous — emit
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
    vi.useRealTimers();
  });

  it('returns skipped WITHOUT warning when the empty window is pre-open', async () => {
    // 13:29 UTC = 9:29 ET = 8:29 CT — inside the isMarketHours 5-min
    // pre-open buffer but before the cash open. An empty scan here is
    // normal (the tape has not started), so the anomaly warning must be
    // suppressed (Sentry DESERT-97 false alarm).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-29T13:29:00Z')); // 9:29 ET, pre-open
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
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
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
    // Named-bind extraction keeps the test stable across future column
    // adds (see api/__tests__/insert-binds.ts). Earlier versions used
    // `insertCall.at(-N)` which needed a coordinated shift every time
    // a migration tacked another column onto the tail.
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('takeit_prob')).toBeNull();
    expect(binds.get('takeit_model_version')).toBeNull();
    expect(binds.get('takeit_features')).toBeNull();
    expect(binds.get('mkt_tide_diff')).toBe(6000);
    expect(binds.get('mkt_tide_otm_diff')).toBe(3000);
    expect(binds.get('zero_dte_diff')).toBe(300);
    expect(binds.get('spx_spot_gamma_oi')).toBe(12345);
    // Single-leg-only stream: multi_leg_size=0 → share=0.
    expect(binds.get('multi_leg_share')).toBe(0);
    // Fixture buckets don't set underlyingPrice → null at the boundary.
    expect(binds.get('underlying_price_at_spike')).toBeNull();
    // Default mock returns null classification → all four multileg
    // columns bind as null.
    expect(binds.get('inferred_structure')).toBeNull();
    expect(binds.get('is_isolated_leg')).toBeNull();
    expect(binds.get('match_confidence')).toBeNull();
    expect(binds.get('pattern_group_id')).toBeNull();
    // bucketRow fixture doesn't set bucket_gamma → null in INSERT.
    expect(binds.get('gamma_at_trigger')).toBeNull();
    // pre_trade_count mock returned { cnt: 0 } → 0 propagates.
    expect(binds.get('pre_trade_count')).toBe(0);
    // Single-fire fixture → no adjacent strike fires this cron-tick →
    // adj_cofire stays false.
    expect(binds.get('adj_cofire')).toBe(false);
    // bucketRow fixture doesn't set first_min_share / spread_in_bucket
    // (#171) → null in INSERT.
    expect(binds.get('first_min_share')).toBeNull();
    expect(binds.get('spread_in_bucket')).toBeNull();
    // Migration #180: 8 gex_* binds at the tail. Default test mocks
    // return null from getLatestGexbotSnapshotAt, so every gex_* bind
    // is null.
    expect(binds.get('gex_one_cvroflow')).toBeNull();
    expect(binds.get('gex_net_put_dex')).toBeNull();
    expect(binds.get('gex_one_dexoflow')).toBeNull();
    expect(binds.get('gex_one_gexoflow')).toBeNull();
    expect(binds.get('gex_zcvr')).toBeNull();
    expect(binds.get('gex_zero_gamma')).toBeNull();
    expect(binds.get('gex_spot')).toBeNull();
    expect(binds.get('gex_captured_at')).toBeNull();
  });

  it('binds GexBot snapshot values when getLatestGexbotSnapshotAt returns a row', async () => {
    // Override the helper to return a populated snapshot. The detect
    // cron should flow every field into the INSERT tail.
    const capturedAt = new Date('2026-05-07T13:19:45Z');
    mockGetLatestGexbotSnapshotAt.mockResolvedValue({
      oneCvroflow: 1.42,
      netPutDex: -1_500_000,
      oneDexoflow: 0.18,
      oneGexoflow: -0.05,
      zcvr: 1.1,
      zeroGamma: 5990,
      spot: 5985.2,
      capturedAt,
    });

    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);

    expect(mockMapToGexbotTicker).toHaveBeenCalledWith('SNDK');
    expect(mockGetLatestGexbotSnapshotAt).toHaveBeenCalled();

    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('gex_one_cvroflow')).toBe(1.42);
    expect(binds.get('gex_net_put_dex')).toBe(-1_500_000);
    expect(binds.get('gex_one_dexoflow')).toBe(0.18);
    expect(binds.get('gex_one_gexoflow')).toBe(-0.05);
    expect(binds.get('gex_zcvr')).toBe(1.1);
    expect(binds.get('gex_zero_gamma')).toBe(5990);
    expect(binds.get('gex_spot')).toBe(5985.2);
    expect(binds.get('gex_captured_at')).toBe(capturedAt.toISOString());
  });

  it('skips GexBot lookup when ticker is outside the GexBot universe', async () => {
    // mapToGexbotTicker returns null → lookup MUST be skipped and all
    // gex_* binds stay null.
    mockMapToGexbotTicker.mockReturnValue(null);
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);

    expect(mockGetLatestGexbotSnapshotAt).not.toHaveBeenCalled();
    expectAllGexBindsNull(extractInsertBinds(mockSql, 'silent_boom_alerts'));
  });

  it('fails open and binds NULL gex_* when the snapshot lookup throws', async () => {
    // Fail-open contract: a thrown error from getLatestGexbotSnapshotAt
    // MUST NOT block the INSERT. Sentry should capture, and all 8 gex_*
    // binds should resolve to NULL.
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    // Sentry capture invoked with the expected tags.
    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          cron: 'detect-silent-boom',
          op: 'getLatestGexbotSnapshotAt',
        }),
      }),
    );

    // INSERT still landed; gex_* binds are all NULL.
    expectAllGexBindsNull(extractInsertBinds(mockSql, 'silent_boom_alerts'));
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

    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    // Single-leg stream → multi_leg_share=0; all four macro fields are
    // null (every tick stale); underlyingPrice not set in fixture →
    // null at the boundary.
    expect(binds.get('spread_in_bucket')).toBeNull();
    expect(binds.get('first_min_share')).toBeNull();
    expect(binds.get('adj_cofire')).toBe(false); // single fire
    expect(binds.get('pre_trade_count')).toBe(0); // mock cnt=0
    expect(binds.get('gamma_at_trigger')).toBeNull();
    expect(binds.get('underlying_price_at_spike')).toBeNull();
    expect(binds.get('multi_leg_share')).toBe(0);
    expect(binds.get('spx_spot_gamma_oi')).toBeNull();
    expect(binds.get('zero_dte_diff')).toBeNull();
    expect(binds.get('mkt_tide_otm_diff')).toBeNull();
    expect(binds.get('mkt_tide_diff')).toBeNull();
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
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBe(150_000_000);
    expect(binds.get('direction_gated')).toBe(true);
    expect(binds.get('score_tier')).toBe('tier3');
  });

  it('preserves original score_tier when gated AND takeit_prob >= 0.70 (TAKE-IT exemption)', async () => {
    // Phase 4 gate exemption (spec:
    // docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md):
    // when takeit_prob >= 0.70 the gate demotion is skipped so the
    // alert keeps its real tier. direction_gated stays true for UI/audit.
    //
    // IMPORTANT: the fixture must NOT use ask_pct=1.0 (all-ask side)
    // because ASK_PCT_SATURATED_PENALTY (-38) forces raw tier to tier3
    // regardless of gating, making the exemption unobservable. Use
    // askSize=90%, bidSize=10% so ask_pct=0.9 (0.85–0.95 bucket) → +1,
    // yielding a score of ~28 (tier1) before any gate is applied.
    mockScoreSilentBoom.mockReturnValueOnce({
      prob: 0.78,
      version: 'test',
      features: { dummy: 0 },
    });
    const putStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      option_type: 'P' as const,
      option_chain: 'SNDK260507P01175000',
      // Override ask/bid split to avoid saturated-ask penalty
      ask_size: Math.round(b.size * 0.9),
      bid_size: Math.round(b.size * 0.1),
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
    // Verify mock was actually called (diagnose if 0 calls → real fn used)
    expect(mockScoreSilentBoom).toHaveBeenCalledTimes(1);
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBe(150_000_000);
    expect(binds.get('direction_gated')).toBe(true); // flag preserved
    expect(binds.get('takeit_prob')).toBe(0.78); // must be 0.78 for exemption to fire
    expect(binds.get('score_tier')).not.toBe('tier3'); // NOT demoted
  });

  it('still demotes to tier3 when gated AND takeit_prob < 0.70', async () => {
    // Below the exemption threshold — standard demotion applies.
    // Same non-saturated fixture as the exemption test (ask_pct=0.9
    // so raw tier is tier1), confirming that sub-threshold TAKE-IT
    // still gates down to tier3.
    mockScoreSilentBoom.mockReturnValueOnce({
      prob: 0.6,
      version: 'test',
      features: { dummy: 0 },
    });
    const putStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      option_type: 'P' as const,
      option_chain: 'SNDK260507P01175000',
      ask_size: Math.round(b.size * 0.9),
      bid_size: Math.round(b.size * 0.1),
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
    expect(mockScoreSilentBoom).toHaveBeenCalledTimes(1);
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('direction_gated')).toBe(true);
    expect(binds.get('score_tier')).toBe('tier3');
    expect(binds.get('takeit_prob')).toBe(0.6);
  });

  it('still demotes to tier3 when gated AND takeit_prob is null (no exemption on null)', async () => {
    // Explicit null — no exemption. Same non-saturated fixture as the
    // exemption test so raw tier is tier1 before any gate; with null
    // prob the standard gate-applied tier3 must still win.
    mockScoreSilentBoom.mockReturnValueOnce({
      prob: null,
      version: null,
      features: null,
    });
    const putStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      option_type: 'P' as const,
      option_chain: 'SNDK260507P01175000',
      ask_size: Math.round(b.size * 0.9),
      bid_size: Math.round(b.size * 0.1),
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
    expect(mockScoreSilentBoom).toHaveBeenCalledTimes(1);
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('direction_gated')).toBe(true);
    expect(binds.get('score_tier')).toBe('tier3');
    expect(binds.get('takeit_prob')).toBeNull();
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
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('inferred_structure')).toBe('vertical');
    expect(binds.get('is_isolated_leg')).toBe(false);
    expect(binds.get('match_confidence')).toBe(0.83);
    expect(binds.get('pattern_group_id')).toBe('pg-abc-123');
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
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
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
   * Build N independent firing chains by varying strike on the silent
   * boom fixture. Each chain produces one fire when its INSERT mock
   * returns a row. Used by the null-rate tests below to cross the
   * `inserted > 10` threshold without writing bespoke per-chain fixtures.
   */
  function manyFireableSilentBoomStreams(count: number) {
    const all: ReturnType<typeof bucketRow>[] = [];
    for (let i = 0; i < count; i += 1) {
      const strike = 1175 + i;
      const chain = `SNDK260507C0${String(strike * 1000).padStart(7, '0')}`;
      const stream = fireableSilentBoomStream().map((b) => ({
        ...b,
        option_chain: chain,
        strike,
      }));
      all.push(...stream);
    }
    return all;
  }

  /**
   * Queue per-fire SQL mocks after the four (tide/tide_otm/zero_dte/
   * spx_gamma) macro lookups. Per-fire shape: pre_trade_count + INSERT.
   * The ticker_flow_snapshot lookup is cached per (ticker, date), so
   * only the FIRST fire on a given ticker issues that query — every
   * subsequent fire on SNDK in the same tick hits the cache.
   */
  function queueSilentBoomPerFireMocks(count: number, inserted: boolean) {
    for (let i = 0; i < count; i += 1) {
      mockSql.mockResolvedValueOnce([{ cnt: 0 }]); // pre_trade_count
      if (i === 0) {
        mockSql.mockResolvedValueOnce([]); // ticker_flow_snapshot (cache miss only on fire 0)
      }
      mockSql.mockResolvedValueOnce(inserted ? [{ id: 200 + i }] : []); // INSERT
    }
  }

  it('counts multilegHits when every classify call returns a populated result (no Sentry alert)', async () => {
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue({
      id: 'anchor',
      inferredStructure: 'vertical',
      isIsolatedLeg: false,
      matchConfidence: 0.85,
      patternGroupId: 'pg-1',
    });
    mockSql
      .mockResolvedValueOnce(manyFireableSilentBoomStreams(3)) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]); // spx_gamma
    queueSilentBoomPerFireMocks(3, true);

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
    expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
      'multileg.classify.high_null_rate',
      expect.anything(),
    );
  });

  it('captures Sentry warning when inserted>10 AND multileg hit-rate<50%', async () => {
    // 11 fires, all classify return null → hits=0, misses=11.
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue(null);
    mockSql
      .mockResolvedValueOnce(manyFireableSilentBoomStreams(11))
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]); // spx_gamma
    queueSilentBoomPerFireMocks(11, true);

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
          cron: 'detect-silent-boom',
          multilegHits: 0,
          multilegMisses: 11,
          inserted: 11,
        }),
      }),
    );
  });

  it('does NOT capture Sentry warning at exactly 50% hit-rate (threshold is strict <)', async () => {
    // 12 fires, alternating hit/miss → ratio == 0.5 (not <). No alert.
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
    mockSql
      .mockResolvedValueOnce(manyFireableSilentBoomStreams(12))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    queueSilentBoomPerFireMocks(12, true);

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
    mockSentryCaptureMessage.mockClear();
    mockClassifyAlertMultileg.mockResolvedValue(null);
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]) // spx_gamma
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count
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

    // Both INSERTs should have adj_cofire=true. Use the multi-call
    // extractor (the pre_trade_count COUNT query interleaves with the
    // INSERTs so a plain `mockSql.mock.calls.at(-N)` walk would catch
    // the wrong row).
    const allBinds = extractAllInsertBinds(mockSql, 'silent_boom_alerts');
    expect(allBinds).toHaveLength(2);
    expect(allBinds[0]!.get('adj_cofire')).toBe(true);
    expect(allBinds[1]!.get('adj_cofire')).toBe(true);
  });

  it('stamps date + dte from the fire bucket timestamp, not the cron run clock', async () => {
    // Late / retried run: the cron wall-clock ET date (ctx.today) has
    // rolled to 2026-05-08, but the spike bucket fired on the prior
    // session (09:20 ET on 2026-05-07). The row must be filed under the
    // fire's OWN ET session day (2026-05-07) and dte computed from THAT
    // day — otherwise the alert lands on the wrong day and dte is off by
    // one relative to what the read endpoints (which filter date::date)
    // expect. Expiry 2026-05-09:
    //   bucket-day dte (correct): daysBetween('2026-05-07','2026-05-09') = 2
    //   run-clock  dte (buggy):   daysBetween('2026-05-08','2026-05-09') = 1
    mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-05-08' });

    // Rebuild the fireable stream on a custom expiry (2026-05-09) while
    // keeping the 2026-05-07 bucket timestamps.
    const chain = 'SNDK260507C01175000';
    const exp = '2026-05-09';
    const rows: ReturnType<typeof bucketRow>[] = [];
    for (let b = 0; b < 4; b += 1) {
      const minute = b * 5;
      const iso = `2026-05-07T13:${String(minute).padStart(2, '0')}:00Z`;
      rows.push(bucketRow(chain, 'SNDK', 'C', 1175, exp, iso, { size: 100 }));
    }
    rows.push(
      bucketRow(chain, 'SNDK', 'C', 1175, exp, '2026-05-07T13:20:00Z', {
        size: 2000,
      }),
    );

    mockSql
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    // Filed under the fire's own ET session day, NOT the run clock.
    expect(binds.get('date')).toBe('2026-05-07');
    // dte computed from the fire-day date, not ctx.today.
    expect(binds.get('dte')).toBe(2);
  });

  it('snapshots macro at EACH fire’s own bucket_ct, not a single cron-tick wall-clock', async () => {
    // The recent per-fire as-of fix: the macro lookups (tideDiffAt etc.)
    // binary-search the batch-fetched tick series against THIS fire's
    // f.bucketTs.getTime() — NOT a shared cron-tick timestamp. Two chains
    // spike in the SAME cron tick at DIFFERENT buckets (chain A @ 13:20,
    // chain B @ 14:00, 40 min apart). A single market_tide tick at 13:18
    // is within the 30-min staleness window for A's 13:20 bucket but
    // 42 min stale for B's 14:00 bucket. If the as-of were a shared
    // wall-clock both fires would resolve identically; the per-fire
    // bucket as-of gives A the diff and B null.
    const chainA = 'SNDK260507C01175000';
    const chainB = 'SNDK260507C01180000';
    const exp = '2026-05-07';
    const mk = (chain: string, strike: number, spikeIso: string) => {
      const rows: ReturnType<typeof bucketRow>[] = [];
      // 4 silent baseline buckets ending just before the spike, then the
      // spike bucket. Baselines are placed 5-min apart immediately before
      // the spike so the detector's baseline window is satisfied.
      const spikeMs = Date.parse(spikeIso);
      for (let b = 4; b >= 1; b -= 1) {
        const iso = new Date(spikeMs - b * 5 * 60_000).toISOString();
        rows.push(
          bucketRow(chain, 'SNDK', 'C', strike, exp, iso, { size: 100 }),
        );
      }
      rows.push(
        bucketRow(chain, 'SNDK', 'C', strike, exp, spikeIso, { size: 2000 }),
      );
      return rows;
    };
    const aStream = mk(chainA, 1175, '2026-05-07T13:20:00Z');
    const bStream = mk(chainB, 1180, '2026-05-07T14:00:00Z');
    const tideTickMs = Date.parse('2026-05-07T13:18:00Z');

    mockSql
      .mockResolvedValueOnce([...aStream, ...bStream]) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        // Single tide tick at 13:18 — in-window for A (13:20), stale for B (14:00).
        { ts_ms: String(tideTickMs), ncp: '9000', npp: '3000' }, // diff +6000
      ]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      // Fire A (bucket 13:20): pre_trade_count + ticker_flow_snapshot
      // (cache miss, first SNDK fire) + INSERT.
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count A
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (once, shared per ticker+date)
      .mockResolvedValueOnce([{ id: 1 }]) // INSERT A
      // Fire B (bucket 14:00): pre_trade_count + INSERT (flow snapshot cached).
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count B
      .mockResolvedValueOnce([{ id: 2 }]); // INSERT B

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      totalFires: 2,
      inserted: 2,
    });

    const allBinds = extractAllInsertBinds(mockSql, 'silent_boom_alerts');
    expect(allBinds).toHaveLength(2);
    // Fires are processed in Map-insertion order — chain A first, chain B
    // second. A's 13:20 bucket is within 30 min of the 13:18 tick → diff
    // +6000. B's 14:00 bucket is 42 min past the tick → out of window → null.
    const aBind = allBinds.find((b) => b.get('strike') === 1175);
    const bBind = allBinds.find((b) => b.get('strike') === 1180);
    expect(aBind?.get('mkt_tide_diff')).toBe(6000);
    expect(bBind?.get('mkt_tide_diff')).toBeNull();
  });

  it('fails open on a macro-series fetch failure — the tick still detects + inserts with NULL macro (mirrors lottery EMPTY_MACRO)', async () => {
    // Parity with detect-lottery-fires: macro (tide / tide_otm / zero_dte /
    // spx_gamma) is display-only per the spec, so a transient
    // flow_data/spot_exposures outage MUST NOT drop the whole tick. The four
    // macro-series fetches are wrapped in a single try/catch: a rejection is
    // logged + Sentry-captured at level 'warning' (tags cron
    // 'detect-silent-boom', stage 'macro_fetch') and the tick arrays fall
    // back to empty — identical to "no ticks in window", so every per-fire
    // as-of yields NULL macro. Detection + INSERT proceed unchanged.
    //
    // Because the catch fires the instant the FIRST macro query rejects, the
    // remaining three macro SELECTs are short-circuited (not drained) — the
    // next real SQL calls are pre_trade_count, ticker_flow_snapshot, INSERT.
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockRejectedValueOnce(new Error('flow_data boom')) // tide ticks REJECTS → catch
      .mockResolvedValueOnce([{ cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // The tick is NOT dropped: success envelope, the fire still inserted.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', inserted: 1 });

    // INSERT landed with all four macro fields NULL (empty tick arrays →
    // every as-of lookup returns null).
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBeNull();
    expect(binds.get('mkt_tide_otm_diff')).toBeNull();
    expect(binds.get('zero_dte_diff')).toBeNull();
    expect(binds.get('spx_spot_gamma_oi')).toBeNull();

    // Sentry warning captured with the lottery-style tags.
    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'detect-silent-boom',
          stage: 'macro_fetch',
        }),
      }),
    );
  });
});
