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

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
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
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped when no ticks are in the scan window', async () => {
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
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(7);
    // INSERT is the last call. Bound order ends with mkt_tide_diff,
    // mkt_tide_otm_diff, zero_dte_diff, spx_spot_gamma_oi, multi_leg_share.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const multiLegShare = insertCall.at(-1);
    const spxGamma = insertCall.at(-2);
    const zeroDteDiff = insertCall.at(-3);
    const tideOtmDiff = insertCall.at(-4);
    const tideDiff = insertCall.at(-5);
    expect(tideDiff).toBe(6000);
    expect(tideOtmDiff).toBe(3000);
    expect(zeroDteDiff).toBe(300);
    expect(spxGamma).toBe(12345);
    // Single-leg-only stream: multi_leg_size=0 → share=0.
    expect(multiLegShare).toBe(0);
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
      .mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    // multi_leg_share trails the four macro fields. Single-leg stream
    // → multi_leg_share = 0; all four macro fields (tide, tide_otm,
    // zero_dte, spx_gamma) should be null because every tick was stale.
    expect(insertCall.at(-1)).toBe(0);
    expect(insertCall.at(-2)).toBeNull();
    expect(insertCall.at(-3)).toBeNull();
    expect(insertCall.at(-4)).toBeNull();
    expect(insertCall.at(-5)).toBeNull();
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
    // spx_spot_gamma_oi, multi_leg_share. So:
    //   at(-1) = multi_leg_share
    //   at(-5) = mkt_tide_diff
    //   at(-6) = direction_gated
    //   at(-7) = score_tier (effective — demoted to 'tier3')
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    expect(insertCall.at(-5)).toBe(150_000_000);
    expect(insertCall.at(-6)).toBe(true);
    expect(insertCall.at(-7)).toBe('tier3');
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
});
