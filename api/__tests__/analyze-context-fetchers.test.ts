// @vitest-environment node

/**
 * Catch-fallback + key-branch coverage for analyze-context-fetchers.ts.
 *
 * The 21 fetchers in that file all wrap their data source in try/catch and
 * return null on failure so the orchestrator can drop the section instead of
 * cascading. Those silent fallbacks are exactly the kind of code that breaks
 * unnoticed in production — when a UW endpoint changes shape or the DB
 * connection pool exhausts, Claude analyzes blind and the only signal is a
 * Sentry blip. These tests pin every fallback so a regression that turns a
 * silent fallback into a thrown error is caught at PR time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────
// All dependencies of analyze-context-fetchers.ts are stubbed; the file
// itself is the unit under test.

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => vi.fn()),
  getFlowData: vi.fn(),
  getGreekExposure: vi.fn(),
  getSpotExposures: vi.fn(),
  formatFlowDataForClaude: vi.fn(() => 'flow'),
  formatGreekExposureForClaude: vi.fn(() => 'greeks'),
  formatSpotExposuresForClaude: vi.fn(() => 'spot'),
}));

vi.mock('../_lib/db-strike-helpers.js', () => ({
  getStrikeExposures: vi.fn(),
  getAllExpiryStrikeExposures: vi.fn(),
  getNetGexHeatmap: vi.fn(),
  formatStrikeExposuresForClaude: vi.fn(() => 'strikes'),
  formatAllExpiryStrikesForClaude: vi.fn(() => 'all-expiry'),
  formatNetGexHeatmapForClaude: vi.fn(() => 'heatmap'),
  formatGreekFlowForClaude: vi.fn(() => 'greek-flow'),
  formatZeroGammaForClaude: vi.fn(() => 'zero-gamma-block'),
}));

vi.mock('../_lib/db-flow.js', () => ({
  getMarketInternalsToday: vi.fn(),
}));

vi.mock('../_lib/db-nope.js', () => ({
  getRecentNope: vi.fn(),
  formatNopeForClaude: vi.fn(() => 'nope'),
}));

vi.mock('../_lib/db-oi-change.js', () => ({
  getOiChangeData: vi.fn(),
  formatOiChangeForClaude: vi.fn(() => 'oi-change'),
}));

vi.mock('../_lib/darkpool.js', () => ({
  fetchDarkPoolBlocks: vi.fn(),
  clusterDarkPoolTrades: vi.fn(() => []),
  formatDarkPoolForClaude: vi.fn(() => 'dark-pool'),
}));

vi.mock('../_lib/max-pain.js', () => ({
  fetchMaxPain: vi.fn(),
  formatMaxPainForClaude: vi.fn(() => 'max-pain'),
}));

vi.mock('../_lib/spx-candles.js', () => ({
  fetchSPXCandles: vi.fn(),
  formatSPXCandlesForClaude: vi.fn(() => 'candles'),
}));

vi.mock('../_lib/overnight-gap.js', () => ({
  formatOvernightForClaude: vi.fn(() => 'overnight'),
}));

vi.mock('../_lib/futures-context.js', () => ({
  formatFuturesForClaude: vi.fn(),
}));

vi.mock('../_lib/cross-asset-regime.js', () => ({
  computeCrossAssetRegime: vi.fn(),
  formatCrossAssetRegimeForClaude: vi.fn(() => 'cross-asset'),
}));

vi.mock('../_lib/volume-profile.js', () => ({
  computeVolumeProfile: vi.fn(),
  formatVolumeProfileForClaude: vi.fn(() => 'volume-profile'),
  priorTradeDate: vi.fn((d: string) => d),
}));

vi.mock('../_lib/vix-divergence.js', () => ({
  computeVixSpxDivergence: vi.fn(),
  formatVixDivergenceForClaude: vi.fn(() => 'vix-divergence'),
}));

vi.mock('../_lib/microstructure-signals.js', () => ({
  computeAllSymbolSignals: vi.fn(),
  formatMicrostructureDualSymbolForClaude: vi.fn(() => 'microstructure'),
}));

vi.mock('../_lib/uw-deltas.js', () => ({
  computeUwDeltas: vi.fn(),
  formatUwDeltasForClaude: vi.fn(() => 'uw-deltas'),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  schwabFetch: vi.fn(),
}));

vi.mock('../_lib/archive-sidecar.js', () => ({
  fetchTbboOfiPercentile: vi.fn(),
  fetchDaySummary: vi.fn(),
  fetchDayFeatures: vi.fn(),
}));

vi.mock('../_lib/analyze-context-formatters.js', () => ({
  formatEconomicCalendarForClaude: vi.fn(() => 'econ'),
  formatMarketInternalsForClaude: vi.fn(() => 'internals'),
  formatMlFindingsForClaude: vi.fn(() => 'ml'),
  formatPriorDayFlowForClaude: vi.fn(),
  formatSimilarDaysForClaude: vi.fn(() => 'similar'),
}));

vi.mock('../iv-term-structure.js', () => ({
  formatIvTermStructureForClaude: vi.fn(() => 'iv-term'),
}));

vi.mock('../../src/utils/zero-gamma.js', () => ({
  analyzeZeroGamma: vi.fn(() => ({ zeroGammaStrike: 6605, distance: 5 })),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../_lib/current-snapshot.js', () => ({
  fetchCurrentSnapshot: vi.fn(),
}));

vi.mock('../_lib/day-features.js', () => ({
  findSimilarDaysByFeatures: vi.fn(),
}));

vi.mock('../_lib/day-embeddings.js', () => ({
  findSimilarDaysForSummary: vi.fn(),
}));

vi.mock('../_lib/analog-range-forecast.js', () => ({
  getRangeForecast: vi.fn(),
  formatRangeForecast: vi.fn(() => 'range-forecast'),
  vixBucketOf: vi.fn(() => 'mid'),
}));

import {
  fetchMainData,
  fetchIvTermContext,
  fetchVolRealizedContext,
  fetchPreMarketContext,
  fetchSpxCandlesContext,
  fetchDarkPoolContext,
  fetchMaxPainContext,
  fetchOiChangeContext,
  fetchMlCalibrationContext,
  fetchFuturesContext,
  fetchPriorDayFlowContext,
  fetchEconomicCalendarContext,
  fetchDirectionalChainContext,
  fetchCrossAssetRegimeBlock,
  fetchVolumeProfileBlock,
  fetchVixDivergenceBlock,
  fetchMicrostructureBlock,
  fetchUwDeltasBlock,
  fetchSimilarDaysContext,
  fetchRangeForecastContext,
} from '../_lib/analyze-context-fetchers.js';
import { getFlowData, getDb } from '../_lib/db.js';
import { getOiChangeData } from '../_lib/db-oi-change.js';
import { fetchDarkPoolBlocks } from '../_lib/darkpool.js';
import { fetchMaxPain } from '../_lib/max-pain.js';
import { fetchSPXCandles } from '../_lib/spx-candles.js';
import { uwFetch, schwabFetch } from '../_lib/api-helpers.js';
import { formatFuturesForClaude } from '../_lib/futures-context.js';
import { formatPriorDayFlowForClaude } from '../_lib/analyze-context-formatters.js';
import { computeCrossAssetRegime } from '../_lib/cross-asset-regime.js';
import { computeVolumeProfile } from '../_lib/volume-profile.js';
import { computeVixSpxDivergence } from '../_lib/vix-divergence.js';
import { computeAllSymbolSignals } from '../_lib/microstructure-signals.js';
import { computeUwDeltas } from '../_lib/uw-deltas.js';
import { fetchCurrentSnapshot } from '../_lib/current-snapshot.js';
import { fetchDaySummary, fetchDayFeatures } from '../_lib/archive-sidecar.js';
import { findSimilarDaysForSummary } from '../_lib/day-embeddings.js';
import { findSimilarDaysByFeatures } from '../_lib/day-features.js';
import { getRangeForecast } from '../_lib/analog-range-forecast.js';
import { Sentry } from '../_lib/sentry.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.UW_API_KEY;
  delete process.env.DAY_ANALOG_BACKEND;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Catch-fallback tests — every fetcher returns null/empty on error ──

describe('analyze-context-fetchers — catch fallbacks', () => {
  it('fetchMainData returns the empty result when Promise.all rejects', async () => {
    vi.mocked(getFlowData).mockRejectedValue(new Error('DB down'));
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.marketTideContext).toBeNull();
    expect(result.greekExposureContext).toBeNull();
    expect(result.latestTideNcp).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('fetchIvTermContext returns null when uwFetch throws', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(uwFetch).mockRejectedValueOnce(new Error('UW 503'));
    expect(await fetchIvTermContext('2026-04-29', '0.15')).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('fetchVolRealizedContext returns null on DB error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('pool exhausted'));
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchVolRealizedContext('2026-04-29')).toBeNull();
  });

  it('fetchPreMarketContext returns defaults on DB error', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getDb).mockReturnValue(sql as never);
    const result = await fetchPreMarketContext('2026-04-29', {}, 6610, 6600);
    expect(result.preMarketRow).toBeNull();
    expect(result.overnightGapContext).toBeNull();
    // Initial cone values pass through unchanged
    expect(result.straddleConeUpper).toBe(6610);
    expect(result.straddleConeLower).toBe(6600);
  });

  it('fetchSpxCandlesContext returns nulls when fetchSPXCandles throws', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchSPXCandles).mockRejectedValueOnce(new Error('UW 502'));
    const result = await fetchSpxCandlesContext(
      { spx: 6605, spy: 660 },
      '2026-04-29',
      undefined,
      undefined,
    );
    expect(result.spxCandlesContext).toBeNull();
    expect(result.previousClose).toBeNull();
  });

  it('fetchDarkPoolContext returns nulls on fetcher throw', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchDarkPoolBlocks).mockRejectedValueOnce(new Error('UW down'));
    const result = await fetchDarkPoolContext({ spx: 6605 }, '2026-04-29');
    expect(result.darkPoolContext).toBeNull();
    expect(result.darkPoolClusters).toBeNull();
  });

  it('fetchMaxPainContext returns null on throw', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchMaxPain).mockRejectedValueOnce(new Error('UW 500'));
    expect(await fetchMaxPainContext({ spx: 6605 }, '2026-04-29')).toBeNull();
  });

  it('fetchOiChangeContext returns null on DB throw', async () => {
    vi.mocked(getOiChangeData).mockRejectedValueOnce(new Error('DB'));
    expect(await fetchOiChangeContext({ spx: 6605 }, '2026-04-29')).toBeNull();
  });

  it('fetchMlCalibrationContext returns null on DB throw', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('DB'));
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchMlCalibrationContext()).toBeNull();
  });

  it('fetchFuturesContext returns null on formatter throw', async () => {
    vi.mocked(formatFuturesForClaude).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchFuturesContext({ spx: 6605 }, '2026-04-29')).toBeNull();
  });

  it('fetchPriorDayFlowContext returns null on throw', async () => {
    vi.mocked(formatPriorDayFlowForClaude).mockRejectedValueOnce(
      new Error('DB'),
    );
    expect(await fetchPriorDayFlowContext('2026-04-29')).toBeNull();
  });

  it('fetchEconomicCalendarContext returns null on DB throw', async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error('DB'));
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchEconomicCalendarContext('2026-04-29')).toBeNull();
  });

  it('fetchDirectionalChainContext returns null on schwabFetch throw', async () => {
    vi.mocked(schwabFetch).mockRejectedValueOnce(new Error('Schwab down'));
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      100,
      50,
    );
    expect(result).toBeNull();
  });

  it('fetchCrossAssetRegimeBlock returns null on throw', async () => {
    vi.mocked(computeCrossAssetRegime).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchCrossAssetRegimeBlock()).toBeNull();
  });

  it('fetchVolumeProfileBlock returns null on throw', async () => {
    vi.mocked(computeVolumeProfile).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchVolumeProfileBlock('2026-04-29')).toBeNull();
  });

  it('fetchVixDivergenceBlock returns null on throw', async () => {
    vi.mocked(computeVixSpxDivergence).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchVixDivergenceBlock()).toBeNull();
  });

  it('fetchMicrostructureBlock returns null on throw', async () => {
    vi.mocked(computeAllSymbolSignals).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchMicrostructureBlock()).toBeNull();
  });

  it('fetchUwDeltasBlock returns null on throw', async () => {
    vi.mocked(computeUwDeltas).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchUwDeltasBlock()).toBeNull();
  });

  it('fetchSimilarDaysContext returns null on dynamic-import-side throw', async () => {
    vi.mocked(fetchCurrentSnapshot).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchSimilarDaysContext('2026-04-29')).toBeNull();
  });

  it('fetchRangeForecastContext returns null on throw', async () => {
    vi.mocked(fetchCurrentSnapshot).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchRangeForecastContext('2026-04-29', 18)).toBeNull();
  });
});

// ── Early-return / gate tests ─────────────────────────────────────────

describe('analyze-context-fetchers — early returns', () => {
  it('fetchIvTermContext returns null when UW_API_KEY is missing', async () => {
    expect(await fetchIvTermContext('2026-04-29', '0.15')).toBeNull();
    expect(uwFetch).not.toHaveBeenCalled();
  });

  it('fetchSpxCandlesContext returns nulls in backtest mode (no API call)', async () => {
    const result = await fetchSpxCandlesContext(
      { isBacktest: true },
      '2026-04-29',
      undefined,
      undefined,
    );
    expect(result.spxCandlesContext).toBeNull();
    expect(result.previousClose).toBeNull();
    expect(fetchSPXCandles).not.toHaveBeenCalled();
  });

  it('fetchDarkPoolContext returns nulls when UW_API_KEY is missing', async () => {
    const result = await fetchDarkPoolContext({}, '2026-04-29');
    expect(result.darkPoolContext).toBeNull();
    expect(fetchDarkPoolBlocks).not.toHaveBeenCalled();
  });

  it('fetchMaxPainContext returns null when UW_API_KEY is missing', async () => {
    expect(await fetchMaxPainContext({}, '2026-04-29')).toBeNull();
    expect(fetchMaxPain).not.toHaveBeenCalled();
  });

  it('fetchDirectionalChainContext returns null when mode is not midday', async () => {
    const result = await fetchDirectionalChainContext(
      'entry',
      { isBacktest: false },
      100,
      50,
    );
    expect(result).toBeNull();
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('fetchDirectionalChainContext returns null when in backtest mode', async () => {
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: true },
      100,
      50,
    );
    expect(result).toBeNull();
  });

  it('fetchDirectionalChainContext returns null when NCP/NPP are absent', async () => {
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      null,
      null,
    );
    expect(result).toBeNull();
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('fetchOiChangeContext returns null when no rows', async () => {
    vi.mocked(getOiChangeData).mockResolvedValueOnce([]);
    expect(await fetchOiChangeContext({}, '2026-04-29')).toBeNull();
  });

  it('fetchMlCalibrationContext returns null when no findings row', async () => {
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchMlCalibrationContext()).toBeNull();
  });

  it('fetchEconomicCalendarContext returns "no events" message when DB rows empty', async () => {
    const sql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(sql as never);
    const result = await fetchEconomicCalendarContext('2026-04-29');
    expect(result).toBe('No scheduled economic events today.');
  });
});

// ── Discriminated-outcome branches ────────────────────────────────────

describe('analyze-context-fetchers — outcome discrimination', () => {
  it('fetchDarkPoolContext surfaces "API error" string when fetcher returns kind:error', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValueOnce({
      kind: 'error',
      reason: 'UW 502',
    } as never);
    const result = await fetchDarkPoolContext({}, '2026-04-29');
    expect(result.darkPoolContext).toContain('Dark pool data unavailable');
    expect(result.darkPoolContext).toContain('UW 502');
    expect(result.darkPoolClusters).toBeNull();
  });

  it('fetchDarkPoolContext returns nulls when fetcher returns kind:empty', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValueOnce({
      kind: 'empty',
    } as never);
    const result = await fetchDarkPoolContext({}, '2026-04-29');
    expect(result.darkPoolContext).toBeNull();
  });

  it('fetchMaxPainContext surfaces "API error" when fetcher returns kind:error', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'error',
      reason: 'rate-limit',
    } as never);
    const result = await fetchMaxPainContext({}, '2026-04-29');
    expect(result).toContain('Max pain data unavailable');
    expect(result).toContain('rate-limit');
  });

  it('fetchMaxPainContext returns null on kind:empty', async () => {
    process.env.UW_API_KEY = 'k';
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'empty',
    } as never);
    expect(await fetchMaxPainContext({}, '2026-04-29')).toBeNull();
  });

  it('fetchDirectionalChainContext returns null when Schwab returns ok:false', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      100,
      50,
    );
    expect(result).toBeNull();
  });
});

// ── fetchSimilarDaysContext / fetchRangeForecastContext text-path ─────

describe('analyze-context-fetchers — analog backends', () => {
  it('fetchSimilarDaysContext returns null when no summary is available', async () => {
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce(null as never);
    vi.mocked(fetchDaySummary).mockResolvedValueOnce(null as never);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBeNull();
  });

  it('fetchSimilarDaysContext returns null when text-backend finds zero analogs', async () => {
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: null,
    } as never);
    vi.mocked(findSimilarDaysForSummary).mockResolvedValueOnce([]);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBeNull();
  });

  it('fetchSimilarDaysContext returns formatted block on text-backend success', async () => {
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: null,
    } as never);
    vi.mocked(findSimilarDaysForSummary).mockResolvedValueOnce([
      {
        date: '2024-09-15',
        symbol: 'SPX',
        distance: 0.12,
        summary: 'analog day',
      },
    ] as never);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBe('similar');
  });

  it('fetchRangeForecastContext returns null when no summary is available', async () => {
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce(null as never);
    vi.mocked(fetchDaySummary).mockResolvedValueOnce(null as never);
    expect(await fetchRangeForecastContext('2026-04-29')).toBeNull();
  });

  it('fetchRangeForecastContext returns formatted block on success', async () => {
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: null,
    } as never);
    vi.mocked(getRangeForecast).mockResolvedValueOnce({} as never);
    expect(await fetchRangeForecastContext('2026-04-29', 18)).toBe(
      'range-forecast',
    );
  });

  // ── Features-backend (DAY_ANALOG_BACKEND=features) ──────────────────

  it('features-backend returns null when no features are available', async () => {
    process.env.DAY_ANALOG_BACKEND = 'features';
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: null,
    } as never);
    vi.mocked(fetchDayFeatures).mockResolvedValueOnce(null as never);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBeNull();
  });

  it('features-backend returns null when nearest-neighbor search yields no rows', async () => {
    process.env.DAY_ANALOG_BACKEND = 'features';
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: [0.1, 0.2, 0.3],
    } as never);
    vi.mocked(findSimilarDaysByFeatures).mockResolvedValueOnce([]);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBeNull();
  });

  it('features-backend formats neighbors with summaries from day_embeddings', async () => {
    process.env.DAY_ANALOG_BACKEND = 'features';
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: [0.1, 0.2, 0.3],
    } as never);
    vi.mocked(findSimilarDaysByFeatures).mockResolvedValueOnce([
      { date: '2024-09-15', symbol: 'SPX', distance: 0.08 },
      { date: '2024-10-22', symbol: 'SPX', distance: 0.11 },
    ] as never);
    // The dynamic db.js import re-uses the same mocked getDb. The function
    // does `await sql\`SELECT date, summary FROM day_embeddings...\`` —
    // returning rows with date strings, mapped into the neighbor list.
    const sql = vi.fn().mockResolvedValueOnce([
      { date: '2024-09-15', summary: 'analog 1 summary' },
      { date: '2024-10-22', summary: 'analog 2 summary' },
    ]);
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBe('similar');
  });

  it('features-backend falls back to fetchDayFeatures when snapshot lacks features', async () => {
    process.env.DAY_ANALOG_BACKEND = 'features';
    vi.mocked(fetchCurrentSnapshot).mockResolvedValueOnce({
      summary: 'today summary',
      features: null,
    } as never);
    vi.mocked(fetchDayFeatures).mockResolvedValueOnce([0.5, 0.6, 0.7] as never);
    vi.mocked(findSimilarDaysByFeatures).mockResolvedValueOnce([
      { date: '2024-09-15', symbol: 'SPX', distance: 0.08 },
    ] as never);
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        { date: '2024-09-15', summary: 'analog summary' },
      ]);
    vi.mocked(getDb).mockReturnValue(sql as never);
    expect(await fetchSimilarDaysContext('2026-04-29')).toBe('similar');
    expect(fetchDayFeatures).toHaveBeenCalledOnce();
  });
});

// ── fetchMainData: 0DTE P/C premium ratio signal (lines 241-254) ──────
//
// When the zero_dte_index flow data has |NCP| > 0, the fetcher appends
// a "Put/Call Premium Ratio" tail line to zeroDteIndexContext. The three
// branches are: pcRatio > 1.5 (put-side hedging), pcRatio < 0.7
// (call-side speculation), otherwise balanced. Pin every branch so a
// future threshold edit can't silently change the trading signal.

describe('analyze-context-fetchers — 0DTE P/C premium ratio signal', () => {
  /**
   * Build a partial getFlowData mock where the 8th call (zero_dte_index)
   * resolves to the rows under test and every other call resolves to [].
   * getFlowData is called 9x inside the Promise.all (8 flow queries +
   * none for greek-flow which uses a different call). Order matches the
   * source: market_tide, market_tide_otm, spx_flow, spy_flow, qqq_flow,
   * spy_etf_tide, qqq_etf_tide, zero_dte_index, zero_dte_greek_flow.
   */
  function mockZeroDteRows(rows: Array<{ ncp: number; npp: number }>) {
    vi.mocked(getFlowData).mockImplementation(
      async (_d: string, kind: string) =>
        (kind === 'zero_dte_index' ? rows : []) as never,
    );
  }

  // Provide empty-array defaults for every other Promise.all leg so the
  // try-block doesn't throw on `undefined.length` and fall into the catch.
  beforeEach(async () => {
    const { getGreekExposure, getSpotExposures } =
      await import('../_lib/db.js');
    const {
      getStrikeExposures,
      getAllExpiryStrikeExposures,
      getNetGexHeatmap,
    } = await import('../_lib/db-strike-helpers.js');
    const { getRecentNope } = await import('../_lib/db-nope.js');
    const { getMarketInternalsToday } = await import('../_lib/db-flow.js');
    vi.mocked(getGreekExposure).mockResolvedValue([] as never);
    vi.mocked(getSpotExposures).mockResolvedValue([] as never);
    vi.mocked(getStrikeExposures).mockResolvedValue([] as never);
    vi.mocked(getAllExpiryStrikeExposures).mockResolvedValue([] as never);
    vi.mocked(getNetGexHeatmap).mockResolvedValue([] as never);
    vi.mocked(getRecentNope).mockResolvedValue([] as never);
    vi.mocked(getMarketInternalsToday).mockResolvedValue([] as never);
  });

  it('skips P/C ratio line when |NCP| is zero (guard fires)', async () => {
    mockZeroDteRows([{ ncp: 0, npp: 100 }]);
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toBe('flow');
    expect(result.zeroDteIndexContext).not.toContain('Put/Call Premium Ratio');
  });

  it('emits "Balanced" message when pcRatio is exactly 1.0', async () => {
    mockZeroDteRows([{ ncp: 100, npp: 100 }]);
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 1.00',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Balanced — no additional signal.',
    );
  });

  it('emits "Extreme call-side speculation" when pcRatio < 0.7', async () => {
    mockZeroDteRows([{ ncp: 100, npp: 50 }]); // ratio = 0.5
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 0.50',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Extreme call-side speculation',
    );
    expect(result.zeroDteIndexContext).toContain('CCS confidence');
  });

  it('emits "Extreme put-side hedging demand" when pcRatio > 1.5', async () => {
    mockZeroDteRows([{ ncp: 50, npp: 100 }]); // ratio = 2.0
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 2.00',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Extreme put-side hedging demand',
    );
    expect(result.zeroDteIndexContext).toContain('PCS confidence');
  });

  it('treats pcRatio === 0.7 (boundary) as Balanced (strict <)', async () => {
    mockZeroDteRows([{ ncp: 10, npp: 7 }]); // ratio = 0.7 exactly
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 0.70',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Balanced — no additional signal.',
    );
    expect(result.zeroDteIndexContext).not.toContain(
      'Extreme call-side speculation',
    );
  });

  it('treats pcRatio === 1.5 (boundary) as Balanced (strict >)', async () => {
    mockZeroDteRows([{ ncp: 10, npp: 15 }]); // ratio = 1.5 exactly
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 1.50',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Balanced — no additional signal.',
    );
    expect(result.zeroDteIndexContext).not.toContain(
      'Extreme put-side hedging demand',
    );
  });

  it('skips P/C ratio block when zero_dte_index rows are empty', async () => {
    // formatFlowDataForClaude is mocked to always return 'flow' regardless
    // of input — so zeroDteIndexContext IS truthy. But rows.length === 0
    // means the guard `zeroDteIndexRows.length > 0` is false and the
    // signal is skipped.
    vi.mocked(getFlowData).mockResolvedValue([] as never);
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toBe('flow');
    expect(result.zeroDteIndexContext).not.toContain('Put/Call Premium Ratio');
  });

  it('uses .at(-1) — latest row drives the ratio when multiple exist', async () => {
    // Earlier row would give a balanced ratio; latest row is extreme put.
    mockZeroDteRows([
      { ncp: 100, npp: 100 }, // 1.00 — balanced
      { ncp: 50, npp: 100 }, // 2.00 — extreme put
    ]);
    const result = await fetchMainData(
      '2026-04-29',
      undefined,
      undefined,
      undefined,
    );
    expect(result.zeroDteIndexContext).toContain(
      'Put/Call Premium Ratio: 2.00',
    );
    expect(result.zeroDteIndexContext).toContain(
      'Extreme put-side hedging demand',
    );
  });
});

// ── fetchDirectionalChainContext: 14DTE 50Δ strike picker (lines 685-715)
//
// The picker iterates Object.keys(expMap), parses DTE out of "YYYY-MM-DD:N"
// keys, picks the expiry closest to 14 DTE, then filters contracts to
// |delta| ∈ [0.4, 0.65] and sorts ascending by strikePrice. These tests
// drive the picker via the public fetchDirectionalChainContext entry —
// schwabFetch is mocked so we can hand in synthetic expiry maps and
// verify selection without crossing a real network boundary.

describe('analyze-context-fetchers — 14DTE 50Δ chain picker', () => {
  // NCP=100, NPP=50 → NCP > NPP → flowDirection 'bullish' → uses callExpDateMap.
  function setupBullishFlow() {
    return { ncp: 100, npp: 50 };
  }

  function makeContract(
    strike: number,
    delta: number,
    overrides: Partial<SchwabContractShape> = {},
  ): SchwabContractShape {
    return {
      strikePrice: strike,
      bid: 5,
      ask: 6,
      delta,
      volatility: 20,
      totalVolume: 100,
      openInterest: 1000,
      daysToExpiration: 14,
      symbol: `SPXW_${strike}`,
      ...overrides,
    };
  }

  interface SchwabContractShape {
    strikePrice: number;
    bid: number;
    ask: number;
    delta: number;
    volatility: number;
    totalVolume: number;
    openInterest: number;
    daysToExpiration: number;
    symbol: string;
  }

  it('returns null when expMap is empty', async () => {
    const { ncp, npp } = setupBullishFlow();
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {},
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).toBeNull();
  });

  it('picks single expiration when only one exists at exactly 14 DTE', async () => {
    const { ncp, npp } = setupBullishFlow();
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {
          '2026-05-13:14': {
            '6600.0': [makeContract(6600, 0.5)],
          },
        },
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).toContain('14 DTE SPX Call');
    expect(result).toContain('2026-05-13');
    expect(result).toContain('6600');
  });

  it('picks the expiration with smallest |dte - 14| when multiple exist', async () => {
    const { ncp, npp } = setupBullishFlow();
    // 10 DTE → diff 4; 18 DTE → diff 4 — first-seen wins (10 DTE).
    // 12 DTE → diff 2 should beat both 10 and 18.
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {
          '2026-05-09:10': {
            '6600.0': [makeContract(6600, 0.5)],
          },
          '2026-05-11:12': {
            '6605.0': [makeContract(6605, 0.5)],
          },
          '2026-05-17:18': {
            '6610.0': [makeContract(6610, 0.5)],
          },
        },
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).toContain('12 DTE');
    expect(result).toContain('2026-05-11');
    // The closer expiry's strike is in the output; the others are NOT.
    expect(result).toContain('6605');
    expect(result).not.toContain('6610C');
  });

  it('returns null when every contract is filtered out by delta range', async () => {
    const { ncp, npp } = setupBullishFlow();
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {
          '2026-05-13:14': {
            '6500.0': [makeContract(6500, 0.85)], // >0.65 — filtered
            '6700.0': [makeContract(6700, 0.2)], // <0.4 — filtered
          },
        },
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).toBeNull();
  });

  it('keeps only |delta| ∈ [0.4, 0.65] and sorts ascending by strikePrice', async () => {
    const { ncp, npp } = setupBullishFlow();
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {
          '2026-05-13:14': {
            '6500.0': [makeContract(6500, 0.85)], // dropped (>0.65)
            '6580.0': [makeContract(6580, 0.6)], // kept
            '6600.0': [makeContract(6600, 0.5)], // kept
            '6620.0': [makeContract(6620, 0.4)], // kept (boundary)
            '6700.0': [makeContract(6700, 0.2)], // dropped (<0.4)
          },
        },
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).not.toBeNull();
    const text = result!;
    // Kept strikes appear; dropped strikes do not.
    expect(text).toContain('6580C');
    expect(text).toContain('6600C');
    expect(text).toContain('6620C');
    expect(text).not.toContain('6500C');
    expect(text).not.toContain('6700C');
    // Ascending order: 6580 before 6600 before 6620
    const idx6580 = text.indexOf('6580C');
    const idx6600 = text.indexOf('6600C');
    const idx6620 = text.indexOf('6620C');
    expect(idx6580).toBeLessThan(idx6600);
    expect(idx6600).toBeLessThan(idx6620);
  });

  it('returns formatted block for a single eligible contract with correct DTE/expDate split', async () => {
    const { ncp, npp } = setupBullishFlow();
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        underlying: { last: 6600 },
        callExpDateMap: {
          '2026-05-13:14': {
            '6600.0': [
              makeContract(6600, 0.5, {
                bid: 12.5,
                ask: 13.5,
                volatility: 22.4,
                openInterest: 1234,
                totalVolume: 5678,
              }),
            ],
          },
        },
        putExpDateMap: {},
      },
    } as never);
    const result = await fetchDirectionalChainContext(
      'midday',
      { isBacktest: false },
      ncp,
      npp,
    );
    expect(result).not.toBeNull();
    expect(result).toContain(
      '## 14 DTE SPX Call Chain (2026-05-13 expiry, 40-65Δ range)',
    );
    expect(result).toContain('Flow direction: BULLISH');
    expect(result).toContain('6600C');
    expect(result).toContain('Bid $12.50');
    expect(result).toContain('Ask $13.50');
    expect(result).toContain('Mid $13.00');
    expect(result).toContain('Δ 0.50');
    expect(result).toContain('IV 22.4%');
    // OI 1234 → "1.2K"; Vol 5678 → "5.7K"
    expect(result).toContain('OI 1.2K');
    expect(result).toContain('Vol 5.7K');
  });
});
