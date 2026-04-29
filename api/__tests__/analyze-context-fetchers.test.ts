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
