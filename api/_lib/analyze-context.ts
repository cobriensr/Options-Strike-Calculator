/**
 * Context builder for the /api/analyze endpoint.
 *
 * Fetches flow data, Greek exposure, strike exposures, SPX candles,
 * dark pool blocks, max pain, IV term structure, pre-market data,
 * positions, and lessons in parallel, then assembles the final user
 * message template for Claude.
 *
 * The original 1,500-line monolith was split into three files:
 *   - analyze-context-helpers.ts     Pure helpers (numOrUndef, parseEntryTimeAsUtc, types)
 *   - analyze-context-formatters.ts  Pure formatters (format* helpers, tests target these)
 *   - analyze-context-fetchers.ts    Each data source fetch + format
 *
 * This file is the orchestrator: calls each fetcher, assembles the
 * template literal, appends lessons/win-rate/similar-analyses, and
 * returns the final `AnalysisContextResult`.
 *
 * Public API (re-exported for backwards compatibility with callers and
 * the existing test suite): `numOrUndef`, `parseEntryTimeAsUtc`,
 * `formatEconomicCalendarForClaude`, `formatMarketInternalsForClaude`,
 * `formatPriorDayFlowForClaude`, `AnalysisContentBlock`,
 * `AnalysisContextResult`, `buildAnalysisContext`.
 */

import { getLatestPositions, getPreviousRecommendation } from './db.js';
import type { DarkPoolCluster } from './darkpool.js';
import {
  getActiveLessons,
  formatLessonsBlock,
  getHistoricalWinRate,
  formatWinRateForClaude,
} from './lessons.js';
import {
  buildAnalysisSummary,
  generateEmbedding,
  findSimilarAnalyses,
  formatSimilarAnalysesBlock,
} from './embeddings.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { metrics } from './sentry.js';
import type { ImageMediaType } from './analyze-prompts.js';
import logger from './logger.js';

import {
  type AnalysisContentBlock,
  formatOI,
  numOrUndef,
  parseEntryTimeAsUtc,
} from './analyze-context-helpers.js';
import {
  fetchCrossAssetRegimeBlock,
  fetchDarkPoolContext,
  fetchDirectionalChainContext,
  fetchEconomicCalendarContext,
  fetchFuturesContext,
  fetchSimilarDaysContext,
  fetchRangeForecastContext,
  fetchIvTermContext,
  fetchMainData,
  fetchMaxPainContext,
  fetchMicrostructureBlock,
  fetchMlCalibrationContext,
  fetchOiChangeContext,
  fetchPreMarketContext,
  fetchPriorDayFlowContext,
  fetchSpxCandlesContext,
  fetchUwDeltasBlock,
  fetchVixDivergenceBlock,
  fetchVolRealizedContext,
  fetchVolumeProfileBlock,
} from './analyze-context-fetchers.js';

// ── Re-exports for backwards compatibility ────────────────────────────

import {
  formatEconomicCalendarForClaude,
  formatMarketInternalsForClaude,
  formatPriorDayFlowForClaude,
  formatVolRealizedForClaude,
} from './analyze-context-formatters.js';

export { numOrUndef, parseEntryTimeAsUtc };
export type { AnalysisContentBlock };
export {
  formatEconomicCalendarForClaude,
  formatMarketInternalsForClaude,
  formatPriorDayFlowForClaude,
  formatVolRealizedForClaude,
};

/** Result of buildAnalysisContext — everything the handler needs. */
export interface AnalysisContextResult {
  /** The content array (images + context text) for the user message. */
  content: AnalysisContentBlock[];
  /** The analysis mode (entry / midday / review). */
  mode: string;
  /** Active lessons block for system prompt injection. */
  lessonsBlock: string;
  /** Similar past analyses block for system prompt injection. */
  similarAnalysesBlock: string;
  /** Clustered dark pool data for persistence (null if unavailable). */
  darkPoolClusters: DarkPoolCluster[] | null;
}

/**
 * Build the full analysis context by fetching data from multiple sources,
 * then assembling the user message template.
 */
export async function buildAnalysisContext(
  images: Array<{
    data: string;
    mediaType: ImageMediaType;
    label?: string | undefined;
  }>,
  context: Record<string, unknown>,
): Promise<AnalysisContextResult> {
  const content: AnalysisContentBlock[] = [];

  // Add each image with its label
  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx]!;
    content.push(
      {
        type: 'text',
        text: `[Image ${idx + 1}: ${img.label ?? 'Unlabeled'}]`,
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data,
        },
      },
    );
  }

  const mode = (context.mode as string | undefined) ?? 'entry';
  const analysisDate =
    (context.selectedDate as string | undefined) ?? getETDateStr(new Date());

  // Parse entryTime ("2:55 PM CT" or "2:55 PM ET") into a UTC ISO cutoff for
  // time-bounded DB queries. When the user sets the calculator to 2:55 PM and
  // runs the review at 6 PM, Claude should only see data that existed at 2:55.
  // If parsing fails we fall back to unrestricted (asOf = undefined).
  const asOf = parseEntryTimeAsUtc(
    (context.entryTime as string | undefined) ?? null,
    analysisDate,
  );

  // Positions + previous recommendation (both DB-only, fast)
  let positionSummary: string | null = null;
  let previousRec: string | null = null;
  if (!context.isBacktest && mode !== 'review') {
    try {
      const posData = await getLatestPositions(analysisDate);
      if (posData && posData.summary !== 'No open SPX 0DTE positions.') {
        positionSummary = posData.summary;
      }
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch positions for analysis');
      metrics.increment('analyze_context.positions_fetch_error');
    }
  }
  if (mode === 'midday' || mode === 'review') {
    try {
      previousRec = await getPreviousRecommendation(analysisDate, mode);
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch previous recommendation');
      metrics.increment('analyze_context.prev_recommendation_error');
    }
  }
  const positionContext =
    mode === 'review'
      ? null
      : (positionSummary ??
        (context.currentPosition as string | undefined) ??
        null);
  const previousContext =
    previousRec ??
    (context.previousRecommendation as string | undefined) ??
    null;

  // Initial cone boundaries (from context), may be overwritten by pre-market
  let straddleConeUpper = numOrUndef(context.straddleConeUpper);
  let straddleConeLower = numOrUndef(context.straddleConeLower);

  // Core flow/greek/internals fetch (16-way Promise.all inside)
  const main = await fetchMainData(
    analysisDate,
    asOf,
    straddleConeUpper,
    straddleConeLower,
  );

  // IV term structure — direct UW API call
  const ivTermStructureContext = await fetchIvTermContext(
    analysisDate,
    context.sigma as string | undefined,
  );

  // Realized vol + IV rank — single DB row
  const volRealizedRow = await fetchVolRealizedContext(analysisDate);
  const volRealizedContext = volRealizedRow
    ? formatVolRealizedForClaude(volRealizedRow)
    : null;

  // Pre-market + overnight gap (updates cone boundaries if present)
  const preMarket = await fetchPreMarketContext(
    analysisDate,
    context,
    straddleConeUpper,
    straddleConeLower,
  );
  straddleConeUpper = preMarket.straddleConeUpper;
  straddleConeLower = preMarket.straddleConeLower;
  let overnightGapContext = preMarket.overnightGapContext;

  // SPX candles — depends on cone boundaries set above
  const candles = await fetchSpxCandlesContext(
    context,
    analysisDate,
    straddleConeUpper,
    straddleConeLower,
  );
  const spxCandlesContext = candles.spxCandlesContext;

  // Retry overnight gap if candles provided previousClose but pre-market
  // alone didn't have enough to produce the gap context
  if (!overnightGapContext && candles.previousClose && preMarket.preMarketRow) {
    const cashOpen = numOrUndef(context.spx);
    if (cashOpen) {
      const { formatOvernightForClaude } = await import('./overnight-gap.js');
      overnightGapContext = formatOvernightForClaude({
        preMarket: preMarket.preMarketRow,
        cashOpen,
        prevClose: candles.previousClose,
      });
    }
  }

  // Remaining single-source fetches run in parallel — no interdependencies
  const [
    darkPool,
    maxPainContext,
    oiChangeContext,
    mlCalibrationContext,
    futuresContext,
    priorDayFlowContext,
    economicCalendarContext,
    directionalChainContext,
    crossAssetRegimeContext,
    volumeProfileContext,
    vixDivergenceContext,
    microstructureContext,
    uwDeltasContext,
    similarDaysContext,
    rangeForecastContext,
  ] = await Promise.all([
    fetchDarkPoolContext(context, analysisDate),
    fetchMaxPainContext(context, analysisDate),
    fetchOiChangeContext(context, analysisDate),
    fetchMlCalibrationContext(),
    fetchFuturesContext(context, analysisDate),
    fetchPriorDayFlowContext(analysisDate),
    fetchEconomicCalendarContext(analysisDate),
    fetchDirectionalChainContext(
      mode,
      context,
      main.latestTideNcp,
      main.latestTideNpp,
    ),
    fetchCrossAssetRegimeBlock(),
    fetchVolumeProfileBlock(analysisDate),
    fetchVixDivergenceBlock(),
    fetchMicrostructureBlock(),
    fetchUwDeltasBlock(),
    fetchSimilarDaysContext(analysisDate),
    fetchRangeForecastContext(analysisDate, numOrUndef(context.vix) ?? null),
  ]);

  const marketTideOtmSection = main.marketTideOtmContext
    ? `\n${main.marketTideOtmContext}\n`
    : '';

  // Build data unavailability manifest so the model knows what failed to fetch
  const unavailable: string[] = [];
  if (!main.spxFlowContext) unavailable.push('SPX Net Flow');
  if (!main.marketTideContext) unavailable.push('Market Tide');
  if (!main.spotGexContext) unavailable.push('Aggregate GEX Panel');
  if (!main.greekExposureContext) unavailable.push('Greek Exposure (OI-based)');
  if (!main.strikeExposureContext) unavailable.push('Per-Strike Greek Profile');
  if (!main.netGexHeatmapContext) unavailable.push('Net GEX Heatmap');
  if (!main.greekFlowContext) unavailable.push('0DTE Delta Flow');
  if (!spxCandlesContext && !context.isBacktest)
    unavailable.push('SPX Intraday Candles');
  if (!darkPool.darkPoolContext) unavailable.push('Dark Pool Blocks');
  if (!maxPainContext) unavailable.push('Max Pain');
  if (!ivTermStructureContext) unavailable.push('IV Term Structure');
  if (!overnightGapContext) unavailable.push('Overnight Gap Analysis');
  if (!oiChangeContext) unavailable.push('OI Change Analysis');
  if (!futuresContext) unavailable.push('Futures Context');
  if (!priorDayFlowContext) unavailable.push('Prior-Day Flow Trend');
  if (!economicCalendarContext) unavailable.push('Economic Calendar');
  if (!main.nopeContext) unavailable.push('SPY NOPE');
  if (!main.marketInternalsContext) unavailable.push('NYSE Market Internals');
  if (!crossAssetRegimeContext) unavailable.push('Cross-Asset Regime');
  if (!volumeProfileContext) unavailable.push('Prior-Day Volume Profile (ES)');
  if (!vixDivergenceContext) unavailable.push('VIX/SPX Divergence');
  if (!microstructureContext)
    unavailable.push('Microstructure Signals (ES + NQ)');
  if (!uwDeltasContext)
    unavailable.push('UW Deltas (dark pool / GEX / whale / ETF tide)');
  if (!similarDaysContext) unavailable.push('Historical Analog Days');
  if (!rangeForecastContext)
    unavailable.push('Analog Range Forecast (cohort-conditional strikes)');
  if (!context.targetDeltaStrikes) unavailable.push('Chain Delta Rungs');
  const unavailableList = unavailable.map((s) => '- ' + s).join('\n');
  const unavailableSection =
    unavailable.length > 0
      ? `\n## ⚠️ Data Sources Unavailable (fetch failed or not applicable)\n${unavailableList}\nAdjust confidence per the missing data protocol in the system prompt.\n`
      : '';

  const contextText = `
## Analysis Mode: ${mode === 'review' ? 'END-OF-DAY REVIEW' : mode === 'midday' ? 'MID-DAY RE-ANALYSIS' : 'PRE-TRADE ENTRY'}
## Current Calculator Context
- Date: ${String(context.selectedDate ?? 'today')}
- Entry time: ${String(context.entryTime ?? 'N/A')} (analyze charts ONLY up to this time — ignore any data after it)
- SPX: ${String(context.spx ?? 'N/A')}
- SPY: ${String(context.spy ?? 'N/A')}
- VIX: ${String(context.vix ?? 'N/A')}
- VIX1D: ${String(context.vix1d ?? 'N/A')}
- VIX9D: ${String(context.vix9d ?? 'N/A')}
- VVIX: ${String(context.vvix ?? 'N/A')}
- σ (IV): ${String(context.sigma ?? 'N/A')} (source: ${String(context.sigmaSource ?? 'unknown')})
- T (time to expiry): ${String(context.T ?? 'N/A')}
- Hours remaining: ${String(context.hoursRemaining ?? 'N/A')}
- Delta Guide ceiling (IC): ${String(context.deltaCeiling ?? 'N/A')}Δ
- Put spread ceiling: ${String(context.putSpreadCeiling ?? 'N/A')}Δ
- Call spread ceiling: ${String(context.callSpreadCeiling ?? 'N/A')}Δ
- VIX regime zone: ${String(context.regimeZone ?? 'N/A')}
- Clustering multiplier: ${String(context.clusterMult ?? 'N/A')}
- Clustering put-side multiplier: ${numOrUndef(context.clusterPutMult)?.toFixed(3) ?? 'N/A'}
- Clustering call-side multiplier: ${numOrUndef(context.clusterCallMult)?.toFixed(3) ?? 'N/A'}
- Day of week: ${String(context.dowLabel ?? 'N/A')}
- Opening range signal: ${String(context.openingRangeSignal ?? 'N/A')}
- Opening range available: ${context.openingRangeAvailable ? 'YES (30-min data complete)' : 'NO (entry before 10:00 AM ET — range not yet established)'}
- Opening range high: ${numOrUndef(context.openingRangeHigh)?.toFixed(2) ?? 'N/A'}
- Opening range low: ${numOrUndef(context.openingRangeLow)?.toFixed(2) ?? 'N/A'}
- Opening range % of median consumed: ${numOrUndef(context.openingRangePctConsumed) != null ? `${numOrUndef(context.openingRangePctConsumed)!.toFixed(0)}%` : 'N/A'}
- VIX term structure signal: ${String(context.vixTermSignal ?? 'N/A')}
- RV/IV ratio: ${String(context.rvIvRatio ?? 'N/A')}
- Overnight gap: ${String(context.overnightGap ?? 'N/A')}
- Scheduled events: ${(() => {
    const events = context.events as
      | Array<{ event: string; time: string; severity: string }>
      | undefined;
    if (!events || events.length === 0) return 'NONE';
    return events
      .map((e) => `${e.event} at ${e.time} [${e.severity}]`)
      .join('; ');
  })()}
- Backtest mode: ${context.isBacktest ? 'YES — using historical data' : 'NO — live'}
${context.dataNote ? `\n⚠️ DATA NOTES: ${context.dataNote}\n` : ''}
${mlCalibrationContext ? `\n## ML Calibration Update (from latest EDA pipeline run)\nWhen these numbers differ from the static values in the system prompt rules, use THESE numbers — they are more recent.\n${mlCalibrationContext}\n` : ''}
${unavailableSection}
${economicCalendarContext ? `\n## Today's Economic Events (from DB)\n${economicCalendarContext}\n` : ''}
${priorDayFlowContext ? `\n${priorDayFlowContext}\n` : ''}
${main.marketTideContext ? `\n## Market Tide Data (from API — 5-min intervals)\nThis is exact data from the Unusual Whales API. Primary flow signal (Rule 8, 30% weight) — the highest-weighted single bucket in the flow consensus. Use these values instead of estimating from the Market Tide screenshot. If a Market Tide screenshot is also provided, use it for visual confirmation only — trust the API values for NCP/NPP readings.\n\n${main.marketTideContext}\n${marketTideOtmSection}` : ''}
${main.spxFlowContext ? `\n## SPX Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for SPX. Index-level directional read (Rule 8, 10% weight). Trust these values over screenshot estimates.\n\n${main.spxFlowContext}\n` : ''}
${main.spyFlowContext ? `\n## SPY Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for SPY. Confirmation signal (Rule 8, 15% weight).\n\n${main.spyFlowContext}\n` : ''}
${main.qqqFlowContext ? `\n## QQQ Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for QQQ. Secondary directional signal — tech-leadership read (Rule 8, 25% weight).\n\n${main.qqqFlowContext}\n` : ''}
${main.spyEtfTideContext ? `\n## SPY ETF Tide — Holdings Flow (from API — 5-min intervals)\nOptions flow on the individual stocks inside SPY (AAPL, MSFT, NVDA, etc), not on SPY itself. ETF Tide signal (Rule 8 ETF Tide bucket, 20% weight — combined with QQQ ETF Tide). When SPY Net Flow is bullish but SPY ETF Tide is bearish, the SPY call buying is likely hedging — the underlying stocks are seeing directional put buying. Use as a confirmation/divergence layer against SPY Net Flow.\n\n${main.spyEtfTideContext}\n` : ''}
${main.qqqEtfTideContext ? `\n## QQQ ETF Tide — Holdings Flow (from API — 5-min intervals)\nOptions flow on the individual stocks inside QQQ (AAPL, MSFT, NVDA, AMZN, etc), not on QQQ itself. ETF Tide signal (Rule 8 ETF Tide bucket, 20% weight — combined with SPY ETF Tide). Same divergence logic as SPY ETF Tide — when QQQ flow and QQQ ETF Tide disagree, the underlying holdings flow is more directionally reliable.\n\n${main.qqqEtfTideContext}\n` : ''}
${main.zeroDteIndexContext ? `\n## 0DTE Index-Only Net Flow (from API)\nPure 0DTE flow from index products (SPX, NDX) only — excludes weekly/monthly expirations and ETFs/equities. When this diverges from aggregate SPX Net Flow, the aggregate signal contains longer-dated hedging noise. Trust 0DTE index flow for same-session directional reads. When both agree, highest conviction.\n\n${main.zeroDteIndexContext}\n` : ''}
${main.nopeContext ? `\n## SPY NOPE — Net Options Pricing Effect (from API — 1-min resolution)\nIntraday dealer hedging pressure derived from options delta per unit of underlying stock volume. SPY is used as the SPX proxy because SPX has no tradeable shares. See <spy_nope> in the system prompt for full interpretation rules — the short version: positive NOPE = bullish tape pressure (dealers buying shares), negative NOPE = bearish tape pressure (dealers selling shares). Use this as a confirmation layer alongside Market Tide and SPX Net Flow.\n\n${main.nopeContext}\n` : ''}
${main.marketInternalsContext ? `\n## NYSE Market Internals — Session Regime Classification\nNYSE breadth indicators ($TICK, $ADD, $VOLD, $TRIN) classify the session as RANGE DAY, TREND DAY, or NEUTRAL. The regime adjusts how to weight other signals — see <market_internals_regime> in the system prompt. On range days, GEX walls are reliable and TICK extremes are fade candidates. On trend days, walls may fail and TICK extremes confirm the trend.\n\n${main.marketInternalsContext}\n` : ''}
${main.greekExposureContext ? `\n## SPX Greek Exposure (from API — OI-based)\nAggregate MM Greek exposure across all expirations. The OI Net Gamma number determines the Rule 16 regime. The 0DTE breakdown shows charm/delta specific to today's expiration. If an Aggregate GEX screenshot is also provided, this data provides the OI gamma number — the screenshot still adds Volume GEX and Directionalized Volume GEX which are not available from this API.\n\n${main.greekExposureContext}\n` : ''}
${main.greekFlowContext ? `\n## 0DTE SPX Delta Flow (from API)\nDelta flow measures directional exposure being added through 0DTE SPX options per minute. Unlike premium flow (NCP/NPP), delta flow captures exposure from spreads and complex structures where net premium is near-zero but directional exposure is significant. When delta flow diverges from premium flow, it reveals institutional positioning that premium alone misses.\n\n${main.greekFlowContext}\n` : ''}
${main.spotGexContext ? `\n## SPX Aggregate GEX Panel (from API — intraday time series)\nThis replaces the Aggregate GEX screenshot. Includes OI Net Gamma (Rule 16), Volume Net Gamma, and Directionalized Volume Net Gamma updated every 5 minutes. If an Aggregate GEX screenshot is also provided, trust the API values — the screenshot is visual confirmation only.\n\n${main.spotGexContext}\n` : ''}
${main.strikeExposureContext ? `\n## SPX 0DTE Per-Strike Greek Profile (from API)\nThis is the naive per-strike gamma and charm profile for today's 0DTE expiration. It replaces the Net Charm (naive) screenshot. The "Net Gamma" column shows the gamma bar values at each strike. The "Net Charm" column shows how each wall evolves with time. The "Dir Gamma/Charm" columns show directionalized (ask/bid) exposure which approximates confirmed MM positioning. Periscope screenshots still provide CONFIRMED MM exposure — use API data for the naive profile and Periscope for strike-level confirmation.\n\n${main.strikeExposureContext}\n` : ''}
${main.netGexHeatmapContext ? `\n## SPX 0DTE Net GEX Heatmap (from API — signed dollar GEX per strike)\nThis is the signed net GEX dollar amount at each strike from the greek_exposure_strike table, updated every minute. This is the same data shown in the UW Net GEX Heatmap UI. Positive net_gex = net long gamma (dealer mean-reverting hedging → price suppression, pin magnetism); negative net_gex = net short gamma (dealer momentum hedging → price acceleration, breakouts). The gamma flip zone (net_gex sign change) is the structural regime boundary between suppression and acceleration. Use this alongside the Per-Strike Greek Profile — this adds the dollar-scaled magnitude and call/put composition that the naive profile lacks.\n\n${main.netGexHeatmapContext}\n` : ''}
${main.zeroGammaContext ? `\n## SPX 0DTE Zero-Gamma Level (derived from per-strike gamma profile)\nThe zero-gamma strike is the approximate SPX level at which aggregate dealer gamma flips sign. Above the flip (positive gamma) dealers hedge mean-reverting and price movement is suppressed. Below the flip (negative gamma) dealers hedge momentum and price movement accelerates. Distance-to-flip in cone fractions tells you how close today's price is to a regime change in units that match the straddle cone.\n\n${main.zeroGammaContext}\n` : ''}
${context.gexLandscapeBias ? `\n## GEX Landscape Structural Bias (from live GEX panel)\nThis is the real-time structural bias verdict computed from the per-strike GEX panel, using 5-minute smoothing. It synthesizes gravity direction (where the largest GEX wall sits relative to spot), total net GEX regime (positive = dealer counter-cyclical; negative = dealer pro-cyclical), and 1m/5m GEX trends into a single directional verdict. Use this as the GEX structural summary — it is more reliable than a manual reading because it uses the full strike-level data and smooths out per-snapshot noise.\n\n${context.gexLandscapeBias as string}\n` : ''}
${main.allExpiryStrikeContext ? `\n## SPX All-Expiry Per-Strike Profile (from API)\nThis shows gamma/charm across ALL expirations (not just 0DTE). Multi-day gamma anchors from weekly/monthly/quarterly options create structural walls that persist beyond the 0DTE session. When a 0DTE wall aligns with an all-expiry wall, it has the highest reliability. When they diverge (0DTE wall but all-expiry danger zone), the wall may fail under sustained pressure.\n\n${main.allExpiryStrikeContext}\n` : ''}
${ivTermStructureContext ? `\n## IV Term Structure — σ Validation Layer (from API)\nInterpolated IV across the term structure from the options chain. The 0DTE row gives the ATM implied move directly from options pricing — compare this to the calculator's VIX1D-derived σ to check if the cone is wider or narrower than the market's actual pricing. The 30D row gives the longer-dated IV for term structure shape analysis. Steep contango (0DTE IV << 30D IV) confirms a normal vol regime. Inversion (0DTE IV >> 30D IV) confirms the VIX1D extreme inversion signal from a different angle and warns of elevated intraday risk.\n\n${ivTermStructureContext}\n` : ''}
${volRealizedContext ? `\n## Realized Vol & IV Rank (from API — daily)\n  ${volRealizedContext}\n` : ''}
${overnightGapContext ? `\n## ES Overnight Gap Analysis (from pre-market data)\nThe ES futures overnight session data provides pre-market context for the cash session. Gap fill probability, overnight range consumption, and VWAP positioning help calibrate the opening hour bias. On high gap fill probability days, the first 30 minutes are likely to see a reversal toward the previous close. On low fill probability days, the gap direction extends and aligns with the session trend.\n\n${overnightGapContext}\n` : ''}
${futuresContext ? `\n${futuresContext}\nFutures signals lead options flow by 10-30 minutes. When futures and flow disagree, futures are usually right — institutional desks execute in futures first. See <futures_context_rules> in the system prompt for interpretation guidance.\n` : ''}
${crossAssetRegimeContext ? `\n## Cross-Asset Risk Regime (from futures_bars — 5-min returns)\nComposite and per-symbol returns classifying the session as RISK-ON, RISK-OFF, MIXED, or MACRO-STRESS. See <cross_asset_regime_rules> for interpretation.\n  ${crossAssetRegimeContext}\n` : ''}
${volumeProfileContext ? `\n## Prior-Day Volume Profile (from futures_bars)\nPOC/VAH/VAL computed from the prior session's ES minute bars. Treat these as structural reference levels — see <volume_profile_rules> for interpretation.\n${volumeProfileContext}\n` : ''}
${similarDaysContext ? `\n## Historical Analog Days (16-year ES archive, embedding similarity)\nEach row is a deterministic one-liner: date symbol | open | 1h Δ | 2h Δ | 3h Δ | range | volume | close (net). These are NOT predictions — they are empirical priors sampled by cosine-similarity on the target day's summary text.\n${similarDaysContext}\n` : ''}
${rangeForecastContext ? `\n## Analog Range Forecast (cohort-conditional, for strike placement)\nValidated on 2024-2026 (n=563): text-embedding cohort p90 covers ~78% of actual daily ranges, and the cohort captures SPX's left-tail asymmetry (down p80 typically exceeds up p80). Use these numbers for 0DTE iron-condor strike sizing — they beat a fixed % of spot and dramatically beat pre-2024 global distribution, which is miscalibrated for current vol regime.\n${rangeForecastContext}\n` : ''}
${vixDivergenceContext ? `\n## VIX/SPX Divergence Flag (from market_snapshots + spx_candles_1m)\n5-minute paired return check: VIX rising while SPX is flat is the classic informed-positioning canary. See <vix_divergence_rules> for interpretation.\n  ${vixDivergenceContext}\n` : ''}
${microstructureContext ? `\n## Dual-Symbol Microstructure Signals (ES + NQ, from futures_trade_ticks + futures_top_of_book)\nOrder flow imbalance (OFI 1m/5m/1h), spread widening z-score, and top-of-book pressure derived from the Databento L1 book + trade stream for both ES and NQ front-month contracts. NQ 1h OFI is the empirically validated signal (Phase 4d: ρ=0.313, p_bonf<0.001, n=312 days). See <microstructure_signals_rules> for interpretation.\n${microstructureContext}\n` : ''}
${uwDeltasContext ? `\n## UW Deltas — Rate-of-Change Signals (from dark_pool_levels + spot_exposures + flow_alerts + flow_data)\nFour institutional-activity velocity / delta reads computed from data already ingested by UW crons. Dark pool print velocity (vs 60-min baseline), OI GEX intraday delta (vs RTH open), whale flow net call/put positioning, and SPY/QQQ ETF tide divergence. See <uw_deltas_rules> in the system prompt for interpretation; combine 3-of-4 agreement for highest-confidence reads.\n${uwDeltasContext}\n` : ''}
${
  straddleConeUpper && straddleConeLower && !spxCandlesContext
    ? `\n## Straddle Cone Boundaries (from Periscope)
  Upper: ${straddleConeUpper.toFixed(1)}
  Lower: ${straddleConeLower.toFixed(1)}
  Width: ${(straddleConeUpper - straddleConeLower).toFixed(0)} pts
`
    : ''
}
${darkPool.darkPoolContext ? `\n## SPY Dark Pool Institutional Blocks (from API)\nLarge ($5M+) dark pool block trades in SPY, translated to approximate SPX levels. Dark pool prints reveal where institutions are buying or selling in size off-exchange — these create structural support/resistance levels that options flow, gamma, and charm cannot see. When a dark pool buyer-initiated cluster aligns with a positive gamma wall, that level has the highest-confidence structural support. When a dark pool seller cluster aligns with negative gamma, that level is a confirmed ceiling.\n\n${darkPool.darkPoolContext}\n` : ''}
${(() => {
  const topOI = context.topOIStrikes as
    | Array<{
        strike: number;
        putOI: number;
        callOI: number;
        totalOI: number;
        distFromSpot: number;
        distPct: string;
        side: 'put' | 'call' | 'both';
      }>
    | undefined;
  if (!topOI || topOI.length === 0) return '';
  const lines = topOI.map(
    (s) =>
      `  ${s.strike} — Total: ${formatOI(s.totalOI)} (Put: ${formatOI(s.putOI)}, Call: ${formatOI(s.callOI)}) | ${s.distFromSpot >= 0 ? '+' : ''}${s.distFromSpot.toFixed(0)} pts (${s.distPct}%) | ${s.side}`,
  );
  return `\n## 0DTE OI Concentration — Pin Risk (from chain data)\nTop 5 strikes by total open interest. High-OI strikes act as gravitational magnets in the final 60-90 minutes. NEVER place a short strike at the #1 or #2 OI level — place short strikes 15-25 pts BEYOND a high-OI level so the gravity pulls price AWAY from your strike.\n\n${lines.join('\n')}\n`;
})()}
${(() => {
  const skew = context.skewMetrics as
    | {
        put25dIV: number;
        call25dIV: number;
        atmIV: number;
        putSkew25d: number;
        callSkew25d: number;
        skewRatio: number;
      }
    | undefined;
  if (!skew) return '';
  let signal: string;
  if (skew.putSkew25d > 8)
    signal =
      'STEEP — institutions pricing significant downside risk. PCS premium is rich but tail risk elevated.';
  else if (skew.putSkew25d > 4) signal = 'NORMAL — standard risk premium.';
  else signal = 'FLAT — unusually low hedging demand. Supports IC.';
  let ratioSignal: string;
  if (skew.skewRatio > 2)
    ratioSignal =
      'Strong put-over-call risk premium — market expects any large move to the downside.';
  else if (skew.skewRatio < 1.2)
    ratioSignal =
      'Unusually symmetric — market sees equal up/down risk. Supports IRON CONDOR.';
  else ratioSignal = 'Normal asymmetry.';
  return `\n## IV Skew Metrics (from chain data)\n  ATM IV: ${skew.atmIV.toFixed(1)}%\n  25Δ Put IV: ${skew.put25dIV.toFixed(1)}% (skew: +${skew.putSkew25d.toFixed(1)} vol pts)\n  25Δ Call IV: ${skew.call25dIV.toFixed(1)}% (skew: +${skew.callSkew25d.toFixed(1)} vol pts)\n  Skew Ratio (|put|/|call|): ${skew.skewRatio.toFixed(1)}x\n  Put Skew Signal: ${signal}\n  Skew Ratio Signal: ${ratioSignal}\n`;
})()}
${(() => {
  const rungs = context.targetDeltaStrikes as
    | {
        preferredDelta: number;
        floorDelta: number;
        puts: Array<{
          delta: number;
          strike: number;
          bid: number;
          ask: number;
          iv: number;
          oi: number;
        }>;
        calls: Array<{
          delta: number;
          strike: number;
          bid: number;
          ask: number;
          iv: number;
          oi: number;
        }>;
      }
    | undefined;
  if (!rungs) return '';
  if (rungs.puts.length === 0 && rungs.calls.length === 0) return '';
  const fmtRung = (r: {
    delta: number;
    strike: number;
    bid: number;
    ask: number;
    iv: number;
    oi: number;
  }) => {
    const mid = ((r.bid + r.ask) / 2).toFixed(2);
    const ivPct = (r.iv * 100).toFixed(1);
    const deltaPct = Math.round(r.delta * 100);
    return `${deltaPct}Δ → ${r.strike} ($${mid} mid, ${ivPct}% IV, ${formatOI(r.oi)} OI)`;
  };
  const putsLine =
    rungs.puts.length > 0
      ? `PUTS:  ${rungs.puts.map(fmtRung).join(' | ')}`
      : 'PUTS:  (none available)';
  const callsLine =
    rungs.calls.length > 0
      ? `CALLS: ${rungs.calls.map(fmtRung).join(' | ')}`
      : 'CALLS: (none available)';
  return `\n## Chain Delta Rungs (from live option chain, actual market strikes)\nPreferred entry delta: ${rungs.preferredDelta}Δ. Floor: ${rungs.floorDelta}Δ. Never go below floor on either IC side.\n${putsLine}\n${callsLine}\n`;
})()}
${maxPainContext ? `\n## SPX 0DTE Max Pain (from API)\nMax pain is the strike where total option holder losses are maximized — MMs profit most if SPX settles here. On neutral/low-gamma days, settlement gravitates toward max pain in the final 2 hours. On days with a dominant gamma wall (Rule 6) or deeply negative GEX (cone-lower settlement pattern), the gamma wall or cone boundary overrides max pain. Use max pain as a tiebreaker when gamma and flow signals are ambiguous — if max pain aligns with a gamma wall, that level has the highest settlement probability.\n\n${maxPainContext}\n` : ''}
${oiChangeContext ? `\n## SPX OI Change Analysis (from API — prior day positioning)\nShows where institutions opened or closed the most positions. Ask-dominated volume indicates aggressive new positioning; bid-dominated suggests defensive or closing activity. High multi-leg percentage (>50%) indicates institutional spread activity rather than directional bets.\n\n${oiChangeContext}\n` : ''}
${spxCandlesContext ? `\n## SPX Intraday Price Action (5-min candles)\nReal OHLCV price data for today's session. Use this to assess price structure: is SPX making higher lows (uptrend intact despite flow concerns), compressing into a range (IC-favorable), or printing wide-range bars (elevated volatility)? The session range relative to the straddle cone shows how much of the expected move has been consumed. VWAP acts as an institutional reference price — sustained trading below VWAP on a bearish flow day confirms the thesis, while price reclaiming VWAP on a bearish day is a warning.\n\n${spxCandlesContext}\n` : ''}
${directionalChainContext ? `\n${directionalChainContext}\nThis chain data is for the directional opportunity assessment. The trader buys 14 DTE ATM options at 50Δ minimum. Use bid/ask for entry price guidance. Do not vary strike or DTE — the trader sizes the position themselves.\n` : ''}
${
  positionContext
    ? `\n## Current Open Positions (live from Schwab)\nThese are the trader's ACTUAL open SPX 0DTE positions right now. Reference these specific strikes in your analysis — do not estimate or guess strike placement.\n\n${positionContext}\n`
    : mode !== 'review' && !context.isBacktest
      ? `\n## Current Open Positions\nNONE. No papermoney CSV uploaded for ${analysisDate} and no live Schwab positions\nwere returned. Treat the account as FLAT for this analysis.\nIMPORTANT: Any prior recommendation in this thread is NOT a filled position.\nDo not instruct the trader to close, roll, or manage strikes that were only\nrecommended — recommendations are advisory until the trader uploads a CSV\nor confirms a fill.\n`
      : ''
}
${previousContext ? `\n## Previous Recommendation (from earlier today)\nIMPORTANT: This is what YOU recommended earlier today. Be consistent with this analysis unless conditions have materially changed. If you are changing your recommendation, explicitly state WHAT changed and WHY.\n⚠️ STRIKE OVERRIDE: Any strike prices or position descriptions in this section are from the prior recommendation — they describe what the trader was ADVISED to enter, not necessarily what was filled at those exact strikes. If "Current Open Positions" is provided above, those Schwab-verified strikes are ground truth and OVERRIDE any strike estimates here. Use ONLY the actual positions for all cushion, risk, and management calculations.\n\n${previousContext}\n` : ''}
IMPORTANT: The trader is evaluating at ${String(context.entryTime ?? 'the specified time')}. Charts may show the full trading day — ONLY analyze data visible up to the entry time. Everything after does not exist yet.
Provide your complete analysis as JSON. Mode is "${mode}".`;

  // Fetch active lessons, historical win rate, and similar analyses
  let lessonsBlock = '';
  let similarAnalysesBlock = '';
  let winRateContext = '';
  const winRateConditions = {
    vix: context.vix != null ? Number(context.vix) : undefined,
    gexRegime:
      context.regimeZone != null ? String(context.regimeZone) : undefined,
    dayOfWeek: context.dowLabel != null ? String(context.dowLabel) : undefined,
  };

  try {
    const lessons = await getActiveLessons();
    lessonsBlock = formatLessonsBlock(lessons);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch lessons for injection');
  }

  try {
    const winRate = await getHistoricalWinRate(winRateConditions);
    if (winRate) {
      winRateContext = `\n## Historical Base Rate (from lessons database)\n${formatWinRateForClaude(winRate, winRateConditions)}\n`;
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch historical win rate');
  }

  // Retrieve similar past analyses by embedding similarity (entry mode only)
  if (mode === 'entry') {
    try {
      const todaySummary = buildAnalysisSummary({
        date: analysisDate,
        mode,
        vix: context.vix != null ? Number(context.vix) : null,
        vix1d: context.vix1d != null ? Number(context.vix1d) : null,
        spx: context.spx != null ? Number(context.spx) : null,
        structure: 'unknown',
        confidence: 'unknown',
        suggestedDelta: null,
        hedge: null,
        vixTermShape: (context.vixTermSignal as string) ?? null,
        gexRegime: (context.regimeZone as string) ?? null,
        dayOfWeek: (context.dowLabel as string) ?? null,
      });
      const queryEmbedding = await generateEmbedding(todaySummary);
      if (queryEmbedding) {
        const similar = await findSimilarAnalyses(
          queryEmbedding,
          analysisDate,
          3,
        );
        similarAnalysesBlock = formatSimilarAnalysesBlock(similar);
      }
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch similar analyses');
    }
  }

  // Append win rate to context (after main contextText, before sending)
  const finalContextText = contextText + winRateContext;
  content.push({ type: 'text', text: finalContextText });

  return {
    content,
    mode,
    lessonsBlock,
    similarAnalysesBlock,
    darkPoolClusters: darkPool.darkPoolClusters,
  };
}
