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

// withDbRetry is stubbed to call the thunk ONCE (no retry/backoff in
// tests) and let its rejection propagate raw. The REAL isRetryableDbError
// + TransientDbError are imported so the handler's per-query macro
// fail-open classifier (transient → fall open, genuine → throw) is
// exercised against the actual DB_RETRYABLE_RX, not a stub. This is the
// regression guard for the "genuine macro error must propagate" contract.
// withDbRetry is a spy so tests can pin the retry arguments a query is
// given (vi.fn(impl) keeps impl across resetAllMocks).
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
    // The handler classifies macro failures via the real settleDegradable
    // (transient vs genuine) against the actual DB_RETRYABLE_RX — keep the
    // real impl so the fail-open contract is exercised, not stubbed.
    settleDegradable: actual.settleDegradable,
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

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

// The migration #160 columns the classifier used to fill. The cron no
// longer writes them; they stay NULL on new rows.
const OLD_MULTILEG_COLUMNS = [
  'inferred_structure',
  'is_isolated_leg',
  'match_confidence',
  'pattern_group_id',
] as const;

// The exchange multi-leg anchor lookup that replaced the classifier, mocked
// at the module boundary: its SQL has its own PGlite tests, and keeping it
// off mockSql leaves every query sequence in this file unchanged. The
// default (set in beforeEach) answers DEFAULT_ANCHOR, a single-leg anchor,
// for every alert, as on a live tick: the spike bucket's own prints always
// include one that qualifies as the anchor.
const DEFAULT_ANCHOR: AnchorLegs = {
  anchorWsTradeId: '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c',
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

// Take-It scoring is fail-open. mockScoreSilentBoom is hoisted so the
// same vi.fn() instance is both registered in the factory AND available
// for per-test mockReturnValueOnce overrides via vi.mocked(scoreSilentBoom).
const mockScoreSilentBoom = vi.hoisted(() =>
  vi.fn().mockReturnValue({ prob: null, version: null, features: null }),
);
// loadTakeitDetectContext resolves null by default (set in beforeEach); the
// Take-It tests below override it to run the cron's prefetch closures or to
// report a prefetch failure. The win-rate day cache resolves [] without SQL
// by default (it is kicked before the bucket scan, so a real loader would
// shift every mock sequence); the warm-up tests swap in the real cache.
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
import { reportCronRun } from '../_lib/axiom.js';
import { AXIOM_TOP_LEVEL_KEYS } from '../_lib/axiom-fields.js';
import { TransientDbError } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-07' };

const authorizedReq = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

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
    // Default: every alert finds its (single-leg) anchor, as on a live tick.
    mockLookupAnchorLegs.mockImplementation(
      async (requests) =>
        new Map(
          requests.map((r): [string, AnchorLegs | null] => [
            r.key,
            DEFAULT_ANCHOR,
          ]),
        ),
    );
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
    mockLoadTakeitDetectContext.mockResolvedValue(null);
    mockPriorSessionWinRatesForDay.mockResolvedValue([]);
    mockAwaitWinRateWarmup.mockResolvedValue(undefined);
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
    // INSERT is the last call. Named-bind extraction keeps the test stable
    // across column adds and removals (see api/__tests__/insert-binds.ts).
    // Earlier versions used `insertCall.at(-N)`, which needed a
    // coordinated shift every time a migration changed the column list.
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
    // Default anchor mock: a single-leg trigger print, so its id, code and
    // kind are bound and the spread columns stay null.
    expect(binds.get('anchor_ws_trade_id')).toBe(
      DEFAULT_ANCHOR.anchorWsTradeId,
    );
    expect(binds.get('anchor_trade_code')).toBe('auto');
    expect(binds.get('anchor_leg_kind')).toBe('single');
    expect(binds.get('spread_shape')).toBeNull();
    expect(binds.get('spread_legs')).toBeNull();
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }])
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

  it('fails open and binds NULL gex_* when the snapshot lookup throws, and reports partial', async () => {
    // Fail-open contract: a thrown error from getLatestGexbotSnapshotAt
    // MUST NOT block the INSERT. Sentry should capture, and all 8 gex_*
    // binds should resolve to NULL. The written row is missing its GexBot
    // context, so the run is 'partial', not 'success' (R4).
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert: written

    const res = mockResponse();
    await handler(authorizedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 1,
      inserted: 1,
      // A thrown lookup is counted as a miss, never a hit, and also as a
      // lookup failure (the subset of misses that threw).
      gexHits: 0,
      gexMisses: 1,
      gexOutOfUniverse: 0,
      gexLookupFailures: 1,
    });

    // Sentry capture invoked with the expected tags.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon timeout' }),
      expect.objectContaining({
        tags: expect.objectContaining({
          cron: 'detect-silent-boom',
          op: 'getLatestGexbotSnapshotAt',
          ticker: 'SNDK',
        }),
      }),
    );

    // INSERT still landed; gex_* binds are all NULL.
    expectAllGexBindsNull(extractInsertBinds(mockSql, 'silent_boom_alerts'));

    expect(reportCronRun).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
    expect(payload).toMatchObject({ status: 'partial', gexLookupFailures: 1 });
    // The counter lands in Axiom `meta`, not as a new top-level column.
    expect(AXIOM_TOP_LEVEL_KEYS.has('gexLookupFailures')).toBe(false);
  });

  it('stays success when the GexBot lookup throws but no alert is written, and still reports the failure', async () => {
    mockGetLatestGexbotSnapshotAt.mockRejectedValue(new Error('neon timeout'));
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([]); // insert: ON CONFLICT, nothing written

    const res = mockResponse();
    await handler(authorizedReq(), res);

    // No row lost its GexBot context, so the run stays 'success'; the
    // counter and the Sentry event still show the failure.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
      gexMisses: 1,
      gexLookupFailures: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon timeout' }),
      expect.objectContaining({
        tags: expect.objectContaining({ op: 'getLatestGexbotSnapshotAt' }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportCronRun).mock.calls[0]![1]).toMatchObject({
      status: 'success',
      gexLookupFailures: 1,
    });
  });

  it('stays success on a plain GexBot miss (no fresh snapshot): a miss is not a failure', async () => {
    // beforeEach default: the lookup resolves null (no snapshot in the
    // freshness window). gex_* stay NULL, gexMisses tracks it, and the
    // run is not degraded.
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 42 }]); // insert: written

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(200);
    expect(mockGetLatestGexbotSnapshotAt).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      inserted: 1,
      gexHits: 0,
      gexMisses: 1,
      gexLookupFailures: 0,
    });
    expectAllGexBindsNull(extractInsertBinds(mockSql, 'silent_boom_alerts'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportCronRun).mock.calls[0]![1]).toMatchObject({
      status: 'success',
      gexLookupFailures: 0,
    });
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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

  // ──────────────────────────────────────────────────────────────────────
  // Multileg classifier removed from the Silent Boom cron (spec
  // 2026-10-28-classifier-replacement-design.md, phase 4); the exchange
  // multi-leg anchor lookup below replaces it. The cron no longer calls
  // the classifier, no longer writes the four migration #160 columns (they
  // stay NULL), and dropped the multilegHits / multilegMisses counters and
  // the multileg.classify.high_null_rate warning with it.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Build N independent firing chains by varying strike on the silent
   * boom fixture. Each chain produces one fire when paired with
   * queueSilentBoomPerFireMocks(N, ...).
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
   * Queue the SQL mocks that follow the four (tide/tide_otm/zero_dte/
   * spx_gamma) macro lookups. First the ONE grouped pre_trade_count
   * (AUD-M7) covering all `count` fires (distinct chains → `count`
   * ordinals), then per-fire: ticker_flow_snapshot (cached per
   * (ticker, date), so only the FIRST fire on SNDK issues it) + INSERT.
   */
  function queueSilentBoomPerFireMocks(count: number, inserted: boolean) {
    mockSql.mockResolvedValueOnce(
      Array.from({ length: count }, (_, i) => ({ ord: i + 1, cnt: 0 })),
    ); // grouped pre_trade_count (all fires)
    for (let i = 0; i < count; i += 1) {
      if (i === 0) {
        mockSql.mockResolvedValueOnce([]); // ticker_flow_snapshot (cache miss only on fire 0)
      }
      mockSql.mockResolvedValueOnce(inserted ? [{ id: 200 + i }] : []); // INSERT
    }
  }

  /** The bucket scan, prior fires and the four macro series. */
  function queueScanAndMacro(buckets: ReturnType<typeof bucketRow>[]) {
    mockSql
      .mockResolvedValueOnce(buckets) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // tide
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]); // spx_gamma
  }

  it('leaves the four old columns out of the INSERT', async () => {
    queueScanAndMacro(fireableSilentBoomStream());
    queueSilentBoomPerFireMocks(1, true);

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      inserted: 1,
    });

    const insertCalls = mockSql.mock.calls.filter((call) =>
      Boolean(
        (call[0] as readonly string[] | undefined)?.[0]?.includes(
          'INSERT INTO silent_boom_alerts',
        ),
      ),
    );
    expect(insertCalls).toHaveLength(1);
    const insertCall = insertCalls[0]!;
    const insertSql = (insertCall[0] as readonly string[]).join('$');
    for (const column of OLD_MULTILEG_COLUMNS) {
      expect(insertSql).not.toContain(column);
    }
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
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

  it('writes every alert on a busy tick with no multileg counters and no high-null-rate warning', async () => {
    // 11 alerts. Before the removal this tick made 11 serial classifier
    // calls, and an all-null result raised multileg.classify.high_null_rate
    // (inserted > 10, hit rate < 50%).
    queueScanAndMacro(manyFireableSilentBoomStreams(11));
    queueSilentBoomPerFireMocks(11, true);

    const res = mockResponse();
    await handler(authorizedReq(), res);

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

    const allBinds = extractAllInsertBinds(mockSql, 'silent_boom_alerts');
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
        (call) => (call as unknown[])[1] === 'detect-silent-boom completed',
      );
    expect(completedLog).toBeDefined();
    expect(completedLog![0]).toMatchObject({ inserted: 11 });
    expect(completedLog![0]).not.toHaveProperty('multilegHits');
    expect(completedLog![0]).not.toHaveProperty('multilegMisses');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Anchor legs from the exchange multi-leg flag (spec
  // 2026-10-28-classifier-replacement-design.md, migration #197): one
  // batched lookupAnchorLegs call per tick, before the INSERTs. The
  // anchor is the top price × size print on the alert's chain inside its
  // 5-min bucket, [bucket_ct, bucket_ct + 5 min).
  // ──────────────────────────────────────────────────────────────────────
  describe('anchor legs from the exchange multi-leg flag', () => {
    const SNDK_CHAIN = 'SNDK260507C01175000';
    const SPIKE_BUCKET = '2026-05-07T13:20:00.000Z';
    const ANCHOR_FAILED = 'anchor_legs.lookup_failed';
    const ANCHOR_MISSING_MSG =
      'detect-silent-boom: no anchor print found for a fresh alert; anchor columns left null';
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
        expiry: '2026-05-07',
        size: 150,
        price: 0.5,
        tradeCode: 'mlet',
      },
      {
        optionType: 'C',
        strike: 1180,
        expiry: '2026-05-07',
        size: 150,
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

    /** No alert found its anchor: null for every request. */
    function answerNoAnchors() {
      mockLookupAnchorLegs.mockImplementation(
        async (requests) =>
          new Map(
            requests.map((r): [string, AnchorLegs | null] => [r.key, null]),
          ),
      );
    }

    /** One SNDK alert: scan, macro, pre_trade_count, flow series, INSERT. */
    function queueOneSndkAlert(insertedId: number | null) {
      queueScanAndMacro(fireableSilentBoomStream());
      mockSql
        .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
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

    function completedLog() {
      const call = vi
        .mocked(logger.info)
        .mock.calls.find(
          (c) => (c as unknown[])[1] === 'detect-silent-boom completed',
        );
      expect(call).toBeDefined();
      return (call as unknown[])[0];
    }

    it('looks the anchor up once, before the INSERT, over the alert’s 5-min bucket, and writes a spread leg’s five columns', async () => {
      answerAnchorsByChain({ [SNDK_CHAIN]: SPREAD_LEG_ANCHOR });
      queueOneSndkAlert(42);

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

      const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
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
      // spread_legs is cast to jsonb in the SQL text.
      const insertCall = mockSql.mock.calls.find((call) =>
        Boolean(
          (call[0] as readonly string[] | undefined)?.[0]?.includes(
            'INSERT INTO silent_boom_alerts',
          ),
        ),
      )!;
      const strings = insertCall[0] as readonly string[];
      const legsIdx = insertCall.indexOf(binds.get('spread_legs'));
      expect(strings[legsIdx]!.startsWith('::jsonb')).toBe(true);
      for (const column of OLD_MULTILEG_COLUMNS) {
        expect(binds.has(column)).toBe(false);
      }

      // One request for the one alert: its ticker and chain as the bucket
      // scan read them from ws_option_trades, window [bucket_ct,
      // bucket_ct + 5 min).
      expect(binds.get('bucket_ct')).toBe(SPIKE_BUCKET);
      expect(mockLookupAnchorLegs).toHaveBeenCalledTimes(1);
      expect(mockLookupAnchorLegs.mock.calls[0]![0]).toEqual([
        {
          key: expect.any(String),
          ticker: 'SNDK',
          optionChain: SNDK_CHAIN,
          windowStart: new Date(SPIKE_BUCKET),
          windowEnd: new Date(Date.parse(SPIKE_BUCKET) + 5 * 60_000),
        },
      ]);
      // Through the DB retry helper: one retry, 5 s per attempt.
      expect(mockWithDbRetry).toHaveBeenCalledWith(
        expect.any(Function),
        1,
        5_000,
      );
      // Before the INSERT, not after it.
      const insertIdx = mockSql.mock.calls.indexOf(insertCall);
      expect(mockLookupAnchorLegs.mock.invocationCallOrder[0]).toBeLessThan(
        mockSql.mock.invocationCallOrder[insertIdx]!,
      );
      expect(anchorFailedCaptures()).toHaveLength(0);
      // Every alert found its anchor: no anchor-missing warning.
      expect(anchorMissingCaptures()).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        ANCHOR_MISSING_MSG,
      );
    });

    it('makes one batched lookup for every alert on a tick and writes each alert its own anchor', async () => {
      answerAnchorsByChain({
        SNDK260507C01175000: SPREAD_LEG_ANCHOR,
        SNDK260507C01176000: SINGLE_ANCHOR,
        SNDK260507C01177000: STOCK_TIED_ANCHOR,
        // SNDK260507C01178000: no anchor print in its window.
      });
      queueScanAndMacro(manyFireableSilentBoomStreams(4));
      queueSilentBoomPerFireMocks(4, true);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'success',
        inserted: 4,
        anchorsFound: 3,
        anchorsMissing: 1,
        anchorLookupFailures: 0,
      });

      // R5: one call for the tick, one request per alert, keys unique.
      expect(mockLookupAnchorLegs).toHaveBeenCalledTimes(1);
      const requests = mockLookupAnchorLegs.mock.calls[0]![0];
      expect(requests.map((r) => r.optionChain)).toEqual([
        'SNDK260507C01175000',
        'SNDK260507C01176000',
        'SNDK260507C01177000',
        'SNDK260507C01178000',
      ]);
      expect(new Set(requests.map((r) => r.key)).size).toBe(4);

      const byChain = new Map(
        extractAllInsertBinds(mockSql, 'silent_boom_alerts').map((b) => [
          b.get('option_chain_id'),
          anchorBinds(b),
        ]),
      );
      expect(byChain.get('SNDK260507C01175000')).toMatchObject({
        anchor_leg_kind: 'multi_leg',
        spread_shape: 'vertical',
      });
      expect(byChain.get('SNDK260507C01176000')).toEqual({
        anchor_ws_trade_id: '7a2b3c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
        anchor_trade_code: 'auto',
        anchor_leg_kind: 'single',
        spread_shape: null,
        spread_legs: null,
      });
      expect(byChain.get('SNDK260507C01177000')).toEqual({
        anchor_ws_trade_id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        anchor_trade_code: 'tlet',
        anchor_leg_kind: 'stock_tied',
        spread_shape: null,
        spread_legs: null,
      });
      expect(byChain.get('SNDK260507C01178000')).toEqual(ALL_NULL);

      // One missing anchor among four alerts: one warning for the run.
      const missing = anchorMissingCaptures();
      expect(missing).toHaveLength(1);
      expect(missing[0]![1]).toMatchObject({
        level: 'warning',
        extra: { anchorsMissing: 1, anchorsFound: 3 },
      });
    });

    it('writes NULL anchor columns and stays success when a fresh alert finds no anchor print, and warns once per run', async () => {
      answerNoAnchors();
      queueOneSndkAlert(42);

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
        anchorBinds(extractInsertBinds(mockSql, 'silent_boom_alerts')),
      ).toEqual(ALL_NULL);
      // Not a lookup failure: no anchor_legs.lookup_failed event or line.
      expect(anchorFailedCaptures()).toHaveLength(0);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(ANCHOR_FAILED),
      );
      // But the spike bucket's own prints always include a qualifying
      // anchor, so the miss is raised once for the run as a warning.
      const missing = anchorMissingCaptures();
      expect(missing).toHaveLength(1);
      expect(missing[0]![1]).toEqual({
        level: 'warning',
        fingerprint: ['detect-silent-boom', 'anchor-missing'],
        tags: {
          'cron.job': 'detect-silent-boom',
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

    it('still writes the alert with NULL anchor columns when the lookup fails, names anchor_legs.lookup_failed in Sentry and the log, and reports partial', async () => {
      const broken = new Error('column "trade_code" does not exist');
      mockLookupAnchorLegs.mockRejectedValue(broken);
      queueOneSndkAlert(42);

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
        anchorBinds(extractInsertBinds(mockSql, 'silent_boom_alerts')),
      ).toEqual(ALL_NULL);

      const captures = anchorFailedCaptures();
      expect(captures).toHaveLength(1);
      expect(captures[0]![0]).toBe(broken);
      expect(captures[0]![1]).toMatchObject({
        level: 'error',
        fingerprint: ['detect-silent-boom', ANCHOR_FAILED],
        tags: {
          'cron.job': 'detect-silent-boom',
          'cron.anomaly': ANCHOR_FAILED,
        },
        extra: { alerts: 1 },
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: broken, alerts: 1 }),
        expect.stringContaining(ANCHOR_FAILED),
      );
      // A failed lookup is not reported as missing anchors.
      expect(anchorMissingCaptures()).toHaveLength(0);
      expect(completedLog()).toMatchObject({
        anchorsFound: 0,
        anchorsMissing: 0,
        anchorLookupFailures: 1,
      });

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
      queueOneSndkAlert(42);

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 1,
        anchorLookupFailures: 1,
        anchorLookupError: 'fetch failed',
      });
      expect(
        anchorBinds(extractInsertBinds(mockSql, 'silent_boom_alerts')),
      ).toEqual(ALL_NULL);
      const captures = anchorFailedCaptures();
      expect(captures).toHaveLength(1);
      expect(captures[0]![0]).toBe(blip);
      expect(captures[0]![1]).toMatchObject({ level: 'warning' });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: blip, alerts: 1 }),
        expect.stringContaining(ANCHOR_FAILED),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('stays success when the lookup fails but every alert hit ON CONFLICT (no row lost its anchor), and still raises the failure', async () => {
      mockLookupAnchorLegs.mockRejectedValue(new Error('boom'));
      queueOneSndkAlert(null);

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

    it('keeps status error for a genuine macro error when the lookup also fails', async () => {
      // 'partial' from the failed lookup must not mask the genuine error.
      mockLookupAnchorLegs.mockRejectedValue(new Error('boom'));
      mockSql
        .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
        .mockResolvedValueOnce([]) // prior fires
        .mockRejectedValueOnce(new Error('column "ncp" does not exist')) // tide
        .mockResolvedValueOnce([]) // tide_otm
        .mockResolvedValueOnce([]) // zero_dte
        .mockResolvedValueOnce([]) // spx_gamma
        .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([{ id: 5 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({
        status: 'error',
        inserted: 1,
        macroGenuineFailures: 1,
        anchorLookupFailures: 1,
      });
      expect(anchorFailedCaptures()).toHaveLength(1);
    });

    it('fails the run when the alert INSERT rejects, e.g. before migration #197 adds the anchor columns', async () => {
      // The likeliest rollout failure: this code deployed before #197 is
      // applied makes every INSERT throw. The write error is not swallowed:
      // the wrapper answers 500, reports 'error' to Axiom and Sentry.
      const writeError = new Error(
        'column "anchor_ws_trade_id" of relation "silent_boom_alerts" does not exist',
      );
      queueScanAndMacro(fireableSilentBoomStream());
      mockSql
        .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockRejectedValueOnce(writeError); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(500);
      expect(reportCronRun).toHaveBeenCalledWith(
        'detect-silent-boom',
        expect.objectContaining({
          status: 'error',
          message: writeError.message,
        }),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(writeError);
      // The anchor lookup itself succeeded, so nothing is blamed on it.
      expect(mockLookupAnchorLegs).toHaveBeenCalledTimes(1);
      expect(anchorFailedCaptures()).toHaveLength(0);
    });
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
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
      // Two fires (distinct adjacent chains) → ONE grouped pre_trade_count
      // (AUD-M7) covering both keys, run once before the score loop, then
      // per-fire: two ticker_flow_snapshot (cache hit on the 2nd — same
      // ticker + date — so only one DB call) + two INSERTs.
      .mockResolvedValueOnce([
        { ord: 1, cnt: 0 },
        { ord: 2, cnt: 0 },
      ]) // grouped pre_trade_count (both fires)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (once, shared)
      .mockResolvedValueOnce([{ id: 100 }]) // insert fire #1
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
    // extractor to pull the named binds from each INSERT regardless of
    // surrounding query order.
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
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
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
      // ONE grouped pre_trade_count (AUD-M7) covering both fires (distinct
      // chains/buckets → two ordinals), run once before the score loop.
      .mockResolvedValueOnce([
        { ord: 1, cnt: 0 },
        { ord: 2, cnt: 0 },
      ]) // grouped pre_trade_count (A + B)
      // Fire A (bucket 13:20): ticker_flow_snapshot (cache miss, first SNDK
      // fire) + INSERT.
      .mockResolvedValueOnce([]) // ticker_flow_snapshot (once, shared per ticker+date)
      .mockResolvedValueOnce([{ id: 1 }]) // INSERT A
      // Fire B (bucket 14:00): INSERT (flow snapshot cached).
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

  it('fails open on a TRANSIENT macro-series fetch failure — tick still inserts with NULL macro and the run reports status:partial', async () => {
    // Parity with detect-lottery-fires: macro (tide / tide_otm / zero_dte /
    // spx_gamma) is display-only per the spec, so a TRANSIENT
    // flow_data/spot_exposures outage MUST NOT drop the whole tick. The four
    // macro series are fetched in parallel (Promise.allSettled); a transient
    // rejection (matches DB_RETRYABLE_RX — here 'fetch failed') falls open to
    // [] for THAT query, sets macroDegraded, and is logged + Sentry-captured
    // at level 'warning' (tags cron 'detect-silent-boom', stage
    // 'macro_fetch'). Empty arrays make every per-fire as-of yield NULL macro
    // — identical to "no ticks in window" — so detection + INSERT proceed,
    // and the handler returns status:'partial' (observably degraded, NOT a
    // silent green 'success').
    //
    // allSettled drains all four macro SELECTs even when one rejects, so all
    // four macro mocks must be provided (no sequential short-circuit).
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockRejectedValueOnce(new Error('fetch failed')) // tide ticks REJECTS (transient)
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // The tick is NOT dropped: the fire still inserted, but the run is
    // reported as 'partial' with macroDegraded surfaced in the metadata.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      inserted: 1,
      macroDegraded: true,
      macroSeriesFailed: 1,
      macroGenuineFailures: 0,
    });

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

  it('fails open on a TransientDbError (the wrapper production emits) — status:partial + warning', async () => {
    // FIX #6: production does not reject with a raw 'fetch failed' string —
    // withDbRetry re-throws a `TransientDbError` after exhausting retries.
    // This exercises isRetryableDbError's `instanceof TransientDbError`
    // short-circuit (which does NOT depend on the message matching
    // DB_RETRYABLE_RX). settleDegradable must classify it 'transient' so the
    // series falls open to [], the alert lands with NULL macro, and the run
    // reports status:'partial' with a warning-level capture.
    const { TransientDbError } = await import('../_lib/db.js');
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      // The production transient wrapper — message is arbitrary, the
      // instanceof check classifies it transient regardless.
      .mockRejectedValueOnce(new TransientDbError(new Error('whatever'))) // tide
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert STILL lands

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      inserted: 1,
      macroDegraded: true,
      macroSeriesFailed: 1,
      macroGenuineFailures: 0,
    });
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBeNull();
    // Warning-level (transient), not error-level.
    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(TransientDbError),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'detect-silent-boom',
          stage: 'macro_fetch',
        }),
      }),
    );
  });

  it('stays status:success when a TRANSIENT macro failure hits a 0-fire tick (zero blast radius — do NOT escalate to partial)', async () => {
    // FIX #9: a transient blip is only 'partial' when fires actually
    // landed. On a quiet tick with no fires, the macro degradation touched
    // nothing — escalating to 'partial' would page on a non-event. The
    // shortStream is below the 5-bucket detector minimum so no fire/insert
    // happens; the transient tide rejection must keep status:'success'.
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    const shortStream = fireableSilentBoomStream().slice(0, 3); // too short
    mockSql
      .mockResolvedValueOnce(shortStream) // ticks
      .mockRejectedValueOnce(new Error('fetch failed')) // tide REJECTS (transient)
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
      status: 'success', // NOT 'partial' — no fires, zero blast radius
      inserted: 0,
      skippedShort: 1,
      macroDegraded: true,
      macroSeriesFailed: 1,
      macroGenuineFailures: 0,
    });
    // Still observable: a warning capture fires even with no blast radius.
    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ stage: 'macro_fetch' }),
      }),
    );
  });

  it('LANDS the alert but reports status:error on a GENUINE (non-transient) macro error — loud, no dropped alerts', async () => {
    // New contract (FIX #1/#9): the macro fetch NEVER drops alerts — it
    // ALWAYS fails open (null macro). A GENUINE error — e.g. a renamed/
    // missing column that does NOT match DB_RETRYABLE_RX → settleDegradable
    // classifies 'genuine' — must NOT be swallowed as a warning (that would
    // turn a permanent breakage into indefinite silent macro degradation).
    // Instead the alert STILL inserts with NULL macro, an ERROR-level Sentry
    // capture fires (tag stage:'macro_fetch'), and the handler returns
    // status:'error' (HTTP 200, NOT 500) so the cron monitor goes red while
    // no alert is dropped.
    const sentryModule = await import('../_lib/sentry.js');
    const mockedSentryCapture = vi.mocked(sentryModule.Sentry.captureException);
    mockedSentryCapture.mockClear();
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      // GENUINE error: 'column "ncp" does not exist' does NOT match
      // DB_RETRYABLE_RX → isRetryableDbError false → classified 'genuine'.
      .mockRejectedValueOnce(new Error('column "ncp" does not exist')) // tide
      .mockResolvedValueOnce([]) // tide_otm ticks (allSettled drains all four)
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count (#169)
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 99 }]); // insert STILL lands

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Loud but no drop: 200 with status:'error', alert inserted.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      inserted: 1,
      macroDegraded: true,
      macroSeriesFailed: 1,
      macroGenuineFailures: 1,
    });
    // The alert landed with NULL macro for the broken series.
    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBeNull();
    expect(extractAllInsertBinds(mockSql, 'silent_boom_alerts')).toHaveLength(
      1,
    );
    // ERROR-level macro_fetch capture (this is the page).
    expect(mockedSentryCapture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'detect-silent-boom',
          stage: 'macro_fetch',
        }),
        extra: expect.objectContaining({ genuineFailures: 1 }),
      }),
    );
    // A returned status:'error' makes the cron-monitor check-in 'error'
    // (FIX #2 in cron-instrumentation maps it). Asserted here at the
    // result level — the wrapper mapping is covered in its own suite.
    expect((res._json as { status: string }).status).toBe('error');
  });

  it('retains PARTIAL macro data — one series fails transiently while the others succeed (per-query fail-open)', async () => {
    // Finding #5: per-query (not whole-block) fail-open means a transient
    // failure on ONE series does not discard the three already-fetched
    // series. Here spx_gamma fails transiently but market_tide succeeds, so
    // mkt_tide_diff is still populated on the fire while spx_spot_gamma_oi is
    // NULL — and macroDegraded is true. This also proves the direction gate
    // (which needs only market_tide) survives a non-tide outage.
    // Default fireable stream spikes at 13:20:00Z; a tide tick at 13:18 is
    // within the 30-min as-of window.
    const tideTickMs = Date.parse('2026-05-07T13:18:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(tideTickMs), ncp: '9000', npp: '3000' }, // tide diff +6000
      ]) // tide ticks SUCCEED
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockRejectedValueOnce(new Error('fetch failed')) // spx_gamma REJECTS (transient)
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 7 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      inserted: 1,
      macroDegraded: true,
      macroSeriesFailed: 1,
    });

    const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    // market_tide survived → diff bound; spx_gamma fell open → NULL.
    expect(binds.get('mkt_tide_diff')).toBe(6000);
    expect(binds.get('spx_spot_gamma_oi')).toBeNull();
  });

  it('direction gate demotes a counter-trend fire under healthy macro, but CANNOT demote when the tide series fails open', async () => {
    // Finding #8: the direction gate keys on mkt_tide_diff (all-in
    // NCP-NPP) at fire time, strict > +DIRECTION_GATE_T (100M) for a PUT.
    // A put fired with tide diff +200M is counter-trend → direction_gated
    // true. The REAL consequence of a tide outage: with the tide series
    // failed open (NULL macro), the gate's `mktTideDiff == null` short-
    // circuit returns false — the gate cannot demote during a tide outage.
    const tideTickMs = Date.parse('2026-05-07T13:18:00Z');
    // Default fireable stream spikes at 13:20:00Z; remap to a PUT chain.
    const putStream = fireableSilentBoomStream().map((b) => ({
      ...b,
      option_type: 'P' as const,
      option_chain: 'SNDK260507P01175000',
    }));

    // (a) Healthy macro: tide diff +200M (>100M) → PUT counter-trend → gated.
    mockSql
      .mockResolvedValueOnce(putStream) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        // ncp - npp = 200_000_000 > DIRECTION_GATE_T (100M)
        { ts_ms: String(tideTickMs), ncp: '200000000', npp: '0' },
      ]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    let req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    let res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    let binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('direction_gated')).toBe(true);

    // (b) Same counter-trend put, but the tide series fails open (transient).
    // mktTideDiff is null → the gate short-circuits to false: it cannot
    // demote during a tide outage.
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockSql
      .mockResolvedValueOnce(putStream) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockRejectedValueOnce(new Error('fetch failed')) // tide REJECTS (transient)
      .mockResolvedValueOnce([]) // tide_otm ticks
      .mockResolvedValueOnce([]) // zero_dte ticks
      .mockResolvedValueOnce([]) // spx_gamma ticks
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 2 }]); // insert

    req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'partial', macroDegraded: true });
    binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('direction_gated')).toBe(false);
    expect(binds.get('mkt_tide_diff')).toBeNull();
  });

  it('lookupAt staleness boundary is exact: a tick at exactly 30:00 is still valid; one at 30:01 is out of window', async () => {
    // Finding #9: the as-of staleness guard is `targetMs - tickMs > 30min`
    // (STRICT >). A tick placed EXACTLY at the 30-min boundary
    // (diff == 30*60*1000) is NOT greater-than the limit → still VALID. A
    // tick one minute older (diff == 31 min) IS greater → out of window →
    // null. Two single-tick runs pin the off-by-one on either side.
    // Default fireable stream spikes at 13:20:00Z — that bucket time is the
    // fire's as-of target.
    const spikeMs = Date.parse('2026-05-07T13:20:00Z');
    const exactlyAtBoundaryMs = spikeMs - 30 * 60 * 1000; // diff == 30:00
    const justPastBoundaryMs = spikeMs - 31 * 60 * 1000; // diff == 31:00

    // (a) Tick EXACTLY at the 30-min boundary → still valid (diff bound).
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(exactlyAtBoundaryMs), ncp: '5000', npp: '1000' }, // diff +4000
      ]) // tide ticks
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]) // spx_gamma
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    let req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    let res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    let binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBe(4000);

    // (b) Tick one minute OLDER (diff 31:00) → out of window → null.
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockSql
      .mockResolvedValueOnce(fireableSilentBoomStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([
        { ts_ms: String(justPastBoundaryMs), ncp: '5000', npp: '1000' },
      ]) // tide ticks (too stale)
      .mockResolvedValueOnce([]) // tide_otm
      .mockResolvedValueOnce([]) // zero_dte
      .mockResolvedValueOnce([]) // spx_gamma
      .mockResolvedValueOnce([{ ord: 1, cnt: 0 }]) // pre_trade_count
      .mockResolvedValueOnce([]) // ticker_flow_snapshot
      .mockResolvedValueOnce([{ id: 2 }]); // insert

    req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
    expect(binds.get('mkt_tide_diff')).toBeNull();
  });

  // Spec lottery-cron-timeouts-2026-10-28.md, Phase A: the setup phase
  // must not time the run out, and each degraded path is surfaced.
  describe('setup-phase degradation', () => {
    const TAKEIT_TIMEOUT = 'Take-It prefetch passed its 5000 ms deadline';
    const FLOW_FAILED_MSG =
      'detect-silent-boom: ticker flow series failed; alerts written without flow features';
    const FLOW_ERROR_MSG =
      'detect-silent-boom: ticker flow series query error; alerts written without flow features';
    const FLOW_DEADLINE = 'ticker flow series passed its 5000 ms deadline';

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
    const flowSeriesQueries = () =>
      sqlCalls().filter((c) => c.text.includes('ws_net_flow_per_ticker'));

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

    // ticks → prior fires → 4 macro series → pre_trade_count, then the
    // per-fire ticker flow series and INSERT staged by the caller.
    function stageUpToFlowSeries(
      buckets = fireableSilentBoomStream(),
      fires = 1,
    ) {
      return mockSql
        .mockResolvedValueOnce(buckets) // ticks
        .mockResolvedValueOnce([]) // prior fires
        .mockResolvedValueOnce([]) // tide ticks
        .mockResolvedValueOnce([]) // tide_otm ticks
        .mockResolvedValueOnce([]) // zero_dte ticks
        .mockResolvedValueOnce([]) // spx_gamma ticks
        .mockResolvedValueOnce(
          Array.from({ length: fires }, (_, i) => ({ ord: i + 1, cnt: 0 })),
        ); // pre_trade_count
    }

    // The SNDK fixture plus the same pattern on an NVDA chain: two fires,
    // two ticker-days, SNDK first.
    function twoTickerBuckets() {
      return [
        ...fireableSilentBoomStream(),
        ...fireableSilentBoomStream().map((r) => ({
          ...r,
          ticker: 'NVDA',
          option_chain: 'NVDA260507C01175000',
        })),
      ];
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('bounds both recent-fire prefetch queries to ET today and yesterday, and loads win rates once for the early kick and the prefetch', async () => {
      const today = '2026-06-03';
      await useRealWinRateCache(today);
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
      mockSql
        .mockResolvedValueOnce([]) // win-rate load, kicked before the bucket scan
        .mockResolvedValueOnce(fireableSilentBoomStream());

      await handler(authorizedReq(), mockResponse());

      const sameType = sqlCall(
        'FROM silent_boom_alerts',
        'bucket_ct AS fire_time',
      );
      expect(sameType.text).toMatch(
        /WHERE date >= \$\{\}::date - 1\s+AND bucket_ct >= NOW\(\)/,
      );
      expect(sameType.params).toEqual([today, 35]);

      // The lottery-side cofire lookup walked the whole lottery_finder_fires
      // (date, trigger_time_ct) index before the bound.
      const otherType = sqlCall(
        'FROM lottery_finder_fires',
        'trigger_time_ct AS fire_time',
      );
      expect(otherType.text).toMatch(
        /WHERE date >= \$\{\}::date - 1\s+AND trigger_time_ct >= NOW\(\)/,
      );
      expect(otherType.params).toEqual([today, 10]);

      // Kicked first, then joined by the prefetch: one query.
      expect(mockPriorSessionWinRatesForDay).toHaveBeenCalledTimes(2);
      const [kick, prefetch] = mockPriorSessionWinRatesForDay.mock.calls;
      expect(kick).toEqual(['silentboom', today, expect.any(Function)]);
      expect(prefetch).toEqual(['silentboom', today, kick![2]]);
      const winRate = sqlCall('AVG(daily_rate)', 'FROM silent_boom_alerts');
      expect(winRate.text).toContain('AND date < ${}::date');
      expect(winRate.params).toEqual([today]);
      expect(sqlCalls()[0]!.text).toContain('AVG(daily_rate)');

      // Both recent-fire queries get one retry and no per-attempt cap: the
      // 5 s prefetch deadline bounds the total.
      expect(mockWithDbRetry).toHaveBeenCalledWith(expect.any(Function), 1);
      expect(
        mockWithDbRetry.mock.calls.filter(
          (call) => call.length === 2 && call[1] === 1,
        ),
      ).toHaveLength(2);
    });

    it('starts the win-rate load on an empty pre-open scan and waits for it, so the cache is warm at the open', async () => {
      const today = '2026-06-04';
      await useRealWinRateCache(today);
      mockSql
        .mockResolvedValueOnce([{ underlying_symbol: 'SNDK', win_rate: 0.3 }]) // win-rate warm-up
        .mockResolvedValueOnce([]); // empty bucket scan

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._json).toMatchObject({ status: 'skipped' });
      expect(
        sqlCall('AVG(daily_rate)', 'FROM silent_boom_alerts').params,
      ).toEqual([today]);
      const warmup = mockPriorSessionWinRatesForDay.mock.results[0]!.value;
      // The wait is budgeted from the run's own start time.
      expect(mockAwaitWinRateWarmup).toHaveBeenCalledExactlyOnceWith(
        warmup,
        expect.any(Number),
      );
      const startTimeMs = mockAwaitWinRateWarmup.mock.calls[0]![1] as number;
      expect(Date.now() - startTimeMs).toBeGreaterThanOrEqual(0);
      expect(Date.now() - startTimeMs).toBeLessThan(10_000);
      await expect(warmup).resolves.toEqual([
        { underlying_symbol: 'SNDK', win_rate: 0.3 },
      ]);
    });

    // The cron's onPrefetchFailure callback, fed a failure of `kind`.
    function failPrefetch(reason: string, kind: 'timeout' | 'error') {
      mockLoadTakeitDetectContext.mockImplementation(
        async (
          _alertType: string,
          _deps: unknown,
          onPrefetchFailure: (failure: {
            reason: string;
            kind: string;
          }) => void,
        ) => {
          onPrefetchFailure({ reason, kind });
          return null;
        },
      );
    }

    it('stays success when the Take-It prefetch fails but every alert was already written (no row lost its score)', async () => {
      failPrefetch(TAKEIT_TIMEOUT, 'timeout');
      // The INSERT hits ON CONFLICT and returns no id.
      stageUpToFlowSeries()
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([]); // insert

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
        'detect-silent-boom: Take-It prefetch failed; takeit_prob left null',
      );
    });

    it('fails the run when the Take-It prefetch hits a genuine query error, and still writes the alert', async () => {
      const broken = 'column "bucket_ct" does not exist';
      failPrefetch(broken, 'error');
      stageUpToFlowSeries()
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([{ id: 11 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      // A bug, not Neon being slow: red check-in, whatever was written.
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        inserted: 1,
        takeitPrefetchFailures: 1,
        takeitPrefetchError: broken,
        takeitPrefetchFailureKind: 'error',
      });
      expect(
        extractInsertBinds(mockSql, 'silent_boom_alerts').get('takeit_prob'),
      ).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        { takeitPrefetchError: broken, takeitPrefetchFailureKind: 'error' },
        'detect-silent-boom: Take-It prefetch query error; takeit_prob left null',
      );
    });

    it('writes the alert with takeit_prob NULL and reports partial with a counter when the Take-It prefetch fails', async () => {
      failPrefetch(TAKEIT_TIMEOUT, 'timeout');
      stageUpToFlowSeries()
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([{ id: 7 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 1,
        takeitPrefetchFailures: 1,
        takeitPrefetchError: TAKEIT_TIMEOUT,
      });
      expect(
        extractInsertBinds(mockSql, 'silent_boom_alerts').get('takeit_prob'),
      ).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          takeitPrefetchError: TAKEIT_TIMEOUT,
          takeitPrefetchFailureKind: 'timeout',
        },
        'detect-silent-boom: Take-It prefetch failed; takeit_prob left null',
      );
      const payload = vi.mocked(reportCronRun).mock.calls[0]![1];
      for (const key of [
        'takeitPrefetchFailures',
        'takeitPrefetchError',
        'takeitPrefetchFailureKind',
      ]) {
        expect(payload).toHaveProperty(key);
        expect(AXIOM_TOP_LEVEL_KEYS.has(key)).toBe(false);
      }
    });

    it('writes the alert without flow features when its flow series fails transiently, and reports it once', async () => {
      const flowError = 'db attempt timeout';
      stageUpToFlowSeries()
        .mockRejectedValueOnce(new Error(flowError)) // ticker_flow_snapshot
        .mockResolvedValueOnce([{ id: 8 }]); // insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        inserted: 1,
        flowSeriesFailures: 1,
        flowSeriesGenuineFailures: 0,
        firstFlowSeriesError: {
          ticker: 'SNDK',
          date: '2026-05-07',
          error: flowError,
        },
      });
      const binds = extractInsertBinds(mockSql, 'silent_boom_alerts');
      expect(binds.get('cum_ncp_at_fire')).toBeNull();
      expect(binds.get('cum_npp_at_fire')).toBeNull();
      // The score doesn't use flow, so it is still computed.
      expect(typeof binds.get('score')).toBe('number');

      const flowCaptures = mockSentryCaptureMessage.mock.calls.filter(
        (call) => call[0] === FLOW_FAILED_MSG,
      );
      expect(flowCaptures).toHaveLength(1);
      expect(flowCaptures[0]![1]).toMatchObject({
        level: 'warning',
        fingerprint: ['detect-silent-boom', 'flow-series-failed'],
        extra: { flowSeriesFailures: 1 },
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
      stageUpToFlowSeries(twoTickerBuckets(), 2)
        .mockReturnValueOnce(new Promise(() => {})) // SNDK flow series: stalls
        .mockResolvedValueOnce([{ id: 1 }]) // SNDK insert
        // NVDA's flow series is skipped by the breaker.
        .mockResolvedValueOnce([{ id: 2 }]); // NVDA insert

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
          date: '2026-05-07',
          error: FLOW_DEADLINE,
        },
      });
      expect(flowSeriesQueries()).toHaveLength(1);
      const inserts = extractAllInsertBinds(mockSql, 'silent_boom_alerts');
      expect(inserts.map((b) => b.get('underlying_symbol'))).toEqual([
        'SNDK',
        'NVDA',
      ]);
      for (const binds of inserts) {
        expect(binds.get('cum_ncp_at_fire')).toBeNull();
        expect(binds.get('cum_npp_at_fire')).toBeNull();
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

    it('reports a genuine flow-series error at error level and fails the run, but still writes every alert and does not open the breaker', async () => {
      const flowError = new Error('column "net_call_prem" does not exist');
      stageUpToFlowSeries(twoTickerBuckets(), 2)
        .mockRejectedValueOnce(flowError) // SNDK flow series: broken query
        .mockResolvedValueOnce([{ id: 1 }]) // SNDK insert
        .mockResolvedValueOnce([]) // NVDA flow series: still asked
        .mockResolvedValueOnce([{ id: 2 }]); // NVDA insert

      const res = mockResponse();
      await handler(authorizedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        inserted: 2,
        flowSeriesFailures: 0,
        flowSeriesSkippedBreaker: 0,
        flowSeriesGenuineFailures: 1,
        firstFlowSeriesGenuineError: {
          ticker: 'SNDK',
          date: '2026-05-07',
          error: 'column "net_call_prem" does not exist',
        },
      });
      expect(flowSeriesQueries()).toHaveLength(2);

      const sentryModule = await import('../_lib/sentry.js');
      const errorCaptures = vi
        .mocked(sentryModule.Sentry.captureException)
        .mock.calls.filter((call) => call[0] === flowError);
      expect(errorCaptures).toHaveLength(1);
      expect(errorCaptures[0]![1]).toMatchObject({
        level: 'error',
        fingerprint: ['detect-silent-boom', 'flow-series-error'],
        extra: { flowSeriesGenuineFailures: 1 },
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: flowError,
          flowSeriesGenuineFailures: 1,
        }),
        FLOW_ERROR_MSG,
      );
      expect(mockSentryCaptureMessage).not.toHaveBeenCalledWith(
        FLOW_FAILED_MSG,
        expect.anything(),
      );
    });

    it('reports no setup degradation on a clean run', async () => {
      stageUpToFlowSeries()
        .mockResolvedValueOnce([]) // ticker_flow_snapshot
        .mockResolvedValueOnce([{ id: 9 }]); // insert

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
        anchorsFound: 1,
        anchorsMissing: 0,
        anchorLookupFailures: 0,
        anchorLookupError: null,
        gexLookupFailures: 0,
      });
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
