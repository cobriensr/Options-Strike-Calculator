/**
 * Fetchers for analyze-context — each function performs one data-source
 * fetch (DB or external API) and returns the formatted Claude block
 * (or a structured result when it has multiple outputs to thread back).
 *
 * Splitting the 1,500-line buildAnalysisContext into these focused
 * fetchers does three things:
 *   - Makes each data source independently replaceable (swap Schwab
 *     for IBKR, add a new calendar provider, etc.) without touching
 *     the orchestrator.
 *   - Keeps the orchestrator at ~400 LOC of wiring + template-literal
 *     assembly instead of a 1,500-line megafunction.
 *   - Isolates error-handling per source; one fetcher failing can't
 *     cascade into the others because the orchestrator wraps each call
 *     site separately.
 *
 * Every fetcher here catches its own errors and logs via `logger` +
 * Sentry `metrics.increment`, returning null on failure so the caller
 * can drop the section from the final prompt and record it in the
 * "unavailable" manifest.
 */

import type { DarkPoolCluster } from './darkpool.js';
import {
  clusterDarkPoolTrades,
  fetchDarkPoolBlocks,
  formatDarkPoolForClaude,
} from './darkpool.js';
import {
  formatAllExpiryStrikesForClaude,
  formatGreekFlowForClaude,
  formatNetGexHeatmapForClaude,
  formatStrikeExposuresForClaude,
  formatZeroGammaForClaude,
  getAllExpiryStrikeExposures,
  getNetGexHeatmap,
  getStrikeExposures,
} from './db-strike-helpers.js';
import { getMarketInternalsToday } from './db-flow.js';
import { getRecentNope, formatNopeForClaude } from './db-nope.js';
import { getOiChangeData, formatOiChangeForClaude } from './db-oi-change.js';
import {
  formatFlowDataForClaude,
  formatGreekExposureForClaude,
  formatSpotExposuresForClaude,
  getDb,
  getFlowData,
  getGreekExposure,
  getSpotExposures,
} from './db.js';
import { fetchMaxPain, formatMaxPainForClaude } from './max-pain.js';
import { formatOvernightForClaude } from './overnight-gap.js';
import { fetchSPXCandles, formatSPXCandlesForClaude } from './spx-candles.js';
import { metrics } from './sentry.js';
import { schwabFetch, uwFetch } from './api-helpers.js';
import {
  computeCrossAssetRegime,
  formatCrossAssetRegimeForClaude,
} from './cross-asset-regime.js';
import {
  computeVolumeProfile,
  formatVolumeProfileForClaude,
  priorTradeDate,
} from './volume-profile.js';
import {
  computeVixSpxDivergence,
  formatVixDivergenceForClaude,
} from './vix-divergence.js';
import {
  computeAllSymbolSignals,
  formatMicrostructureDualSymbolForClaude,
  type MicrostructureOfiRanks,
} from './microstructure-signals.js';
import { fetchTbboOfiPercentile } from './archive-sidecar.js';
import { computeUwDeltas, formatUwDeltasForClaude } from './uw-deltas.js';
import { formatFuturesForClaude } from './futures-context.js';
import { formatIvTermStructureForClaude } from '../iv-term-structure.js';
import type { IvTermRow } from '../iv-term-structure.js';
import type { PreMarketData } from '../pre-market.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { analyzeZeroGamma } from '../../src/utils/zero-gamma.js';
import logger from './logger.js';
import {
  formatEconomicCalendarForClaude,
  formatMarketInternalsForClaude,
  formatMlFindingsForClaude,
  formatPriorDayFlowForClaude,
  type EconomicEventRow,
} from './analyze-context-formatters.js';
import { numOrUndef } from './analyze-context-helpers.js';

// ── Schwab chain types (for 14 DTE directional fetch) ─────────────────

interface SchwabContract {
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

interface SchwabChainData {
  underlying: { last: number };
  putExpDateMap: Record<string, Record<string, SchwabContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabContract[]>>;
}

// ── Main flow + greeks fetch (the Promise.all block) ──────────────────

export interface MainDataResult {
  marketTideContext: string | null;
  marketTideOtmContext: string | null;
  spxFlowContext: string | null;
  spyFlowContext: string | null;
  qqqFlowContext: string | null;
  spyEtfTideContext: string | null;
  qqqEtfTideContext: string | null;
  zeroDteIndexContext: string | null;
  greekExposureContext: string | null;
  spotGexContext: string | null;
  strikeExposureContext: string | null;
  allExpiryStrikeContext: string | null;
  greekFlowContext: string | null;
  netGexHeatmapContext: string | null;
  zeroGammaContext: string | null;
  nopeContext: string | null;
  marketInternalsContext: string | null;
  latestTideNcp: number | null;
  latestTideNpp: number | null;
}

/**
 * Runs the 16-way Promise.all to fetch all DB-backed flow/greek/internal
 * data in parallel and formats each block. The straddle-cone half-width
 * (when known) is fed through to zero-gamma formatting so the distance
 * is normalized into cone fractions.
 */
export async function fetchMainData(
  analysisDate: string,
  asOf: string | undefined,
  straddleConeUpper: number | undefined,
  straddleConeLower: number | undefined,
): Promise<MainDataResult> {
  const empty: MainDataResult = {
    marketTideContext: null,
    marketTideOtmContext: null,
    spxFlowContext: null,
    spyFlowContext: null,
    qqqFlowContext: null,
    spyEtfTideContext: null,
    qqqEtfTideContext: null,
    zeroDteIndexContext: null,
    greekExposureContext: null,
    spotGexContext: null,
    strikeExposureContext: null,
    allExpiryStrikeContext: null,
    greekFlowContext: null,
    netGexHeatmapContext: null,
    zeroGammaContext: null,
    nopeContext: null,
    marketInternalsContext: null,
    latestTideNcp: null,
    latestTideNpp: null,
  };

  try {
    const [
      tideRows,
      tideOtmRows,
      spxRows,
      spyRows,
      qqqRows,
      spyEtfRows,
      qqqEtfRows,
      zeroDteIndexRows,
      greekFlowRows,
      greekRows,
      spotGexRows,
      strikeRows,
      allExpiryStrikeRows,
      netGexRows,
      nopeRows,
      marketInternalsRows,
    ] = await Promise.all([
      getFlowData(analysisDate, 'market_tide', asOf),
      getFlowData(analysisDate, 'market_tide_otm', asOf),
      getFlowData(analysisDate, 'spx_flow', asOf),
      getFlowData(analysisDate, 'spy_flow', asOf),
      getFlowData(analysisDate, 'qqq_flow', asOf),
      getFlowData(analysisDate, 'spy_etf_tide', asOf),
      getFlowData(analysisDate, 'qqq_etf_tide', asOf),
      getFlowData(analysisDate, 'zero_dte_index', asOf),
      getFlowData(analysisDate, 'zero_dte_greek_flow', asOf),
      getGreekExposure(analysisDate),
      getSpotExposures(analysisDate, 'SPX', asOf),
      getStrikeExposures(analysisDate, 'SPX', asOf),
      getAllExpiryStrikeExposures(analysisDate, 'SPX', asOf),
      getNetGexHeatmap(analysisDate),
      getRecentNope('SPY', 60, asOf),
      getMarketInternalsToday(analysisDate),
    ]);

    const result: MainDataResult = { ...empty };

    result.marketTideContext = formatFlowDataForClaude(
      tideRows,
      'Market Tide (All-In)',
    );
    if (tideRows.length > 0) {
      const latest = tideRows.at(-1)!;
      result.latestTideNcp = latest.ncp;
      result.latestTideNpp = latest.npp;
    }
    result.marketTideOtmContext = formatFlowDataForClaude(
      tideOtmRows,
      'Market Tide (OTM Only)',
    );
    result.spxFlowContext = formatFlowDataForClaude(spxRows, 'SPX Net Flow');
    result.spyFlowContext = formatFlowDataForClaude(spyRows, 'SPY Net Flow');
    result.qqqFlowContext = formatFlowDataForClaude(qqqRows, 'QQQ Net Flow');
    result.spyEtfTideContext = formatFlowDataForClaude(
      spyEtfRows,
      'SPY ETF Tide (Holdings Flow)',
    );
    result.qqqEtfTideContext = formatFlowDataForClaude(
      qqqEtfRows,
      'QQQ ETF Tide (Holdings Flow)',
    );
    result.zeroDteIndexContext = formatFlowDataForClaude(
      zeroDteIndexRows,
      '0DTE Index-Only Net Flow',
    );

    // Append 0DTE P/C premium ratio from latest NCP/NPP
    if (result.zeroDteIndexContext && zeroDteIndexRows.length > 0) {
      const latest = zeroDteIndexRows.at(-1)!;
      const absNcp = Math.abs(latest.ncp);
      const absNpp = Math.abs(latest.npp);
      if (absNcp > 0) {
        const pcRatio = Math.round((absNpp / absNcp) * 100) / 100;
        let signal = '';
        if (pcRatio > 1.5)
          signal =
            'Extreme put-side hedging demand — potential intraday bottom. Increases PCS confidence.';
        else if (pcRatio < 0.7)
          signal =
            'Extreme call-side speculation — potential intraday top. Increases CCS confidence.';
        else signal = 'Balanced — no additional signal.';
        result.zeroDteIndexContext += `\n  0DTE Put/Call Premium Ratio: ${pcRatio.toFixed(2)} (|NPP|/|NCP|) — ${signal}`;
      }
    }

    result.greekExposureContext = formatGreekExposureForClaude(
      greekRows,
      analysisDate,
    );
    result.greekFlowContext = formatGreekFlowForClaude(greekFlowRows);
    result.spotGexContext = formatSpotExposuresForClaude(spotGexRows);
    result.strikeExposureContext = formatStrikeExposuresForClaude(strikeRows);
    result.netGexHeatmapContext = formatNetGexHeatmapForClaude(netGexRows);
    result.allExpiryStrikeContext = formatAllExpiryStrikesForClaude(
      allExpiryStrikeRows,
      strikeRows,
    );
    result.nopeContext = formatNopeForClaude(nopeRows);

    if (marketInternalsRows.length > 0) {
      result.marketInternalsContext =
        formatMarketInternalsForClaude(marketInternalsRows);
    }

    // Zero-gamma (GEX flip) analysis — ENH-SIGNAL-001. Uses the same
    // strikeRows already fetched; no extra DB round-trip.
    if (strikeRows.length > 0) {
      const spot = strikeRows[0]!.price;
      const coneHalfWidth =
        straddleConeUpper != null && straddleConeLower != null
          ? (straddleConeUpper - straddleConeLower) / 2
          : null;
      const zeroGamma = analyzeZeroGamma(
        strikeRows.map((r) => ({ strike: r.strike, netGamma: r.netGamma })),
        spot,
        coneHalfWidth,
      );
      result.zeroGammaContext = formatZeroGammaForClaude(zeroGamma, spot);
    }

    return result;
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch flow data for analysis');
    metrics.increment('analyze_context.parallel_fetch_error');
    return empty;
  }
}

// ── IV term structure ────────────────────────────────────────────────

export async function fetchIvTermContext(
  analysisDate: string,
  sigma: string | undefined,
): Promise<string | null> {
  const uwKey = process.env.UW_API_KEY;
  if (!uwKey) return null;

  try {
    const ivDate = analysisDate ?? getETDateStr(new Date());
    const rows = await uwFetch<IvTermRow>(
      uwKey,
      `/stock/SPX/interpolated-iv?date=${ivDate}`,
    );
    return formatIvTermStructureForClaude(rows, sigma);
  } catch (error_) {
    logger.warn({ err: error_ }, 'Failed to fetch IV term structure');
    metrics.increment('analyze_context.iv_term_fetch_error');
    return null;
  }
}

// ── Vol realized + IV rank ────────────────────────────────────────────

export async function fetchVolRealizedContext(
  analysisDate: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    const rvRows = await sql`
      SELECT iv_30d, rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
      FROM vol_realized
      WHERE date = ${analysisDate}
      LIMIT 1
    `;
    if (rvRows.length === 0) return null;

    const rv = rvRows[0]!;
    const iv30 =
      rv.iv_30d != null ? (Number(rv.iv_30d) * 100).toFixed(1) : null;
    const rv30 =
      rv.rv_30d != null ? (Number(rv.rv_30d) * 100).toFixed(1) : null;
    const spread =
      rv.iv_rv_spread != null
        ? (Number(rv.iv_rv_spread) * 100).toFixed(1)
        : null;
    const overpricing =
      rv.iv_overpricing_pct != null
        ? Number(rv.iv_overpricing_pct).toFixed(1)
        : null;
    const rank = rv.iv_rank != null ? Number(rv.iv_rank).toFixed(0) : null;

    const lines: string[] = [];
    if (iv30 && rv30) {
      lines.push(`30D Implied Vol: ${iv30}% | 30D Realized Vol: ${rv30}%`);
      if (spread) {
        const label = Number(spread) > 0 ? 'IV OVERPRICING' : 'IV UNDERPRICING';
        lines.push(`IV-RV Spread: ${spread} vol pts (${label})`);
      }
      if (overpricing) {
        lines.push(
          `Overpricing: ${overpricing}% — ${Number(overpricing) > 10 ? 'premium is rich, favorable for selling' : Number(overpricing) < -10 ? 'premium is cheap, caution selling' : 'fairly priced'}`,
        );
      }
    }
    if (rank) {
      lines.push(
        `IV Rank (1-year): ${rank}th percentile — ${Number(rank) > 70 ? 'elevated, rich premium' : Number(rank) < 30 ? 'low, cheap premium' : 'mid-range'}`,
      );
    }
    return lines.length > 0 ? lines.join('\n  ') : null;
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch vol realized data');
    metrics.increment('analyze_context.vol_realized_db_error');
    return null;
  }
}

// ── Pre-market + overnight gap ────────────────────────────────────────

export interface PreMarketContext {
  preMarketRow: PreMarketData | null;
  overnightGapContext: string | null;
  straddleConeUpper: number | undefined;
  straddleConeLower: number | undefined;
}

export async function fetchPreMarketContext(
  analysisDate: string,
  context: Record<string, unknown>,
  initialConeUpper: number | undefined,
  initialConeLower: number | undefined,
): Promise<PreMarketContext> {
  let straddleConeUpper = initialConeUpper;
  let straddleConeLower = initialConeLower;
  let overnightGapContext: string | null = null;
  let preMarketRow: PreMarketData | null = null;

  try {
    const db = getDb();
    const pmRows = await db`
      SELECT pre_market_data FROM market_snapshots
      WHERE date = ${analysisDate} AND pre_market_data IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `;

    if (pmRows.length > 0 && pmRows[0]?.pre_market_data) {
      const pm = pmRows[0].pre_market_data as PreMarketData;
      preMarketRow = pm;

      if (pm.straddleConeUpper != null && !straddleConeUpper)
        straddleConeUpper = pm.straddleConeUpper;
      if (pm.straddleConeLower != null && !straddleConeLower)
        straddleConeLower = pm.straddleConeLower;

      const cashOpen = numOrUndef(context.spx);
      const prevCloseVal = numOrUndef(context.prevClose);

      if (cashOpen && prevCloseVal) {
        overnightGapContext = formatOvernightForClaude({
          preMarket: pm,
          cashOpen,
          prevClose: prevCloseVal,
        });
      }
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch pre-market data');
  }

  return {
    preMarketRow,
    overnightGapContext,
    straddleConeUpper,
    straddleConeLower,
  };
}

// ── SPX candles ───────────────────────────────────────────────────────

export interface SpxCandlesContext {
  spxCandlesContext: string | null;
  previousClose: number | null;
}

export async function fetchSpxCandlesContext(
  context: Record<string, unknown>,
  analysisDate: string,
  straddleConeUpper: number | undefined,
  straddleConeLower: number | undefined,
): Promise<SpxCandlesContext> {
  if (context.isBacktest) {
    return { spxCandlesContext: null, previousClose: null };
  }

  try {
    const uwKey = process.env.UW_API_KEY;
    const currentSpxC = context.spx as number | undefined;
    const currentSpyC = context.spy as number | undefined;
    const candleRatio =
      currentSpxC && currentSpyC && currentSpyC > 0
        ? currentSpxC / currentSpyC
        : 10;
    const candleResult = uwKey
      ? await fetchSPXCandles(uwKey, analysisDate, candleRatio)
      : { candles: [], previousClose: null };
    if (candleResult.candles.length > 0) {
      return {
        previousClose: candleResult.previousClose,
        spxCandlesContext: formatSPXCandlesForClaude(
          candleResult.candles,
          candleResult.previousClose,
          straddleConeUpper,
          straddleConeLower,
        ),
      };
    }
    return { spxCandlesContext: null, previousClose: null };
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch SPX candles');
    return { spxCandlesContext: null, previousClose: null };
  }
}

// ── Dark pool ─────────────────────────────────────────────────────────

export interface DarkPoolContext {
  darkPoolContext: string | null;
  darkPoolClusters: DarkPoolCluster[] | null;
}

export async function fetchDarkPoolContext(
  context: Record<string, unknown>,
  analysisDate: string,
): Promise<DarkPoolContext> {
  try {
    const uwKey = process.env.UW_API_KEY;
    if (!uwKey) return { darkPoolContext: null, darkPoolClusters: null };

    const outcome = await fetchDarkPoolBlocks(uwKey, analysisDate);

    if (outcome.kind === 'error') {
      // Surface the API failure to Claude explicitly so the model can
      // distinguish "no institutional blocks today" from "the data
      // pipeline is broken."
      return {
        darkPoolContext: `Dark pool data unavailable: API error (${outcome.reason}). No institutional level context.`,
        darkPoolClusters: null,
      };
    }
    if (outcome.kind === 'empty') {
      return { darkPoolContext: null, darkPoolClusters: null };
    }

    const trades = outcome.data;
    const currentSpx = context.spx as number | undefined;
    const currentSpy = context.spy as number | undefined;
    const ratio =
      currentSpx && currentSpy && currentSpy > 0 ? currentSpx / currentSpy : 10;
    return {
      darkPoolClusters: clusterDarkPoolTrades(trades, ratio),
      darkPoolContext: formatDarkPoolForClaude(trades, currentSpx, ratio),
    };
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch dark pool data');
    return { darkPoolContext: null, darkPoolClusters: null };
  }
}

// ── Max pain ──────────────────────────────────────────────────────────

export async function fetchMaxPainContext(
  context: Record<string, unknown>,
  analysisDate: string,
): Promise<string | null> {
  try {
    const uwKey = process.env.UW_API_KEY;
    if (!uwKey) return null;

    const outcome = await fetchMaxPain(uwKey, analysisDate);

    if (outcome.kind === 'error') {
      return `Max pain data unavailable: API error (${outcome.reason}). No settlement attractor context.`;
    }
    if (outcome.kind === 'empty') return null;

    const currentSpx = context.spx as number | undefined;
    return formatMaxPainForClaude(outcome.data, analysisDate, currentSpx);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch max pain data');
    return null;
  }
}

// ── OI change ─────────────────────────────────────────────────────────

export async function fetchOiChangeContext(
  context: Record<string, unknown>,
  analysisDate: string,
): Promise<string | null> {
  try {
    const oiChangeRows = await getOiChangeData(analysisDate);
    if (oiChangeRows.length === 0) return null;
    const currentSpx = context.spx as number | undefined;
    return formatOiChangeForClaude(oiChangeRows, currentSpx ?? undefined);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch OI change data');
    return null;
  }
}

// ── ML calibration ────────────────────────────────────────────────────

export async function fetchMlCalibrationContext(): Promise<string | null> {
  try {
    const sql = getDb();
    const mlRows = await sql`
      SELECT findings, updated_at FROM ml_findings WHERE id = 1
    `;
    if (mlRows.length === 0) return null;
    const { findings, updated_at } = mlRows[0] as {
      findings?: Record<string, unknown>;
      updated_at?: Date;
    };
    if (!findings || !updated_at) return null;
    return formatMlFindingsForClaude(findings, updated_at);
  } catch (error_) {
    logger.warn(
      { err: error_ },
      'ML findings fetch failed — using static prompt values',
    );
    return null;
  }
}

// ── Futures ───────────────────────────────────────────────────────────

export async function fetchFuturesContext(
  context: Record<string, unknown>,
  analysisDate: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    const currentSpx = context.spx as number | undefined;
    return await formatFuturesForClaude(sql, analysisDate, currentSpx);
  } catch (error_) {
    logger.debug({ err: error_ }, 'Futures context fetch failed — skipping');
    return null;
  }
}

// ── Prior-day flow ────────────────────────────────────────────────────

export async function fetchPriorDayFlowContext(
  analysisDate: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    return await formatPriorDayFlowForClaude(sql, analysisDate);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch prior-day flow data');
    metrics.increment('analyze_context.prior_flow_error');
    return null;
  }
}

// ── Economic calendar ─────────────────────────────────────────────────

export async function fetchEconomicCalendarContext(
  analysisDate: string,
): Promise<string | null> {
  try {
    const sql = getDb();
    const calRows = await sql`
      SELECT event_name, event_time, event_type, forecast, previous,
             reported_period
      FROM economic_events
      WHERE date = ${analysisDate}
      ORDER BY event_time ASC
    `;
    if (calRows.length === 0) return 'No scheduled economic events today.';
    return formatEconomicCalendarForClaude(calRows as EconomicEventRow[]);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch economic calendar from DB');
    metrics.increment('analyze_context.economic_calendar_error');
    return null;
  }
}

// ── 14 DTE directional chain ──────────────────────────────────────────

export async function fetchDirectionalChainContext(
  mode: string,
  context: Record<string, unknown>,
  latestTideNcp: number | null,
  latestTideNpp: number | null,
): Promise<string | null> {
  if (mode !== 'midday' || context.isBacktest) return null;

  try {
    const flowDirection: 'bullish' | 'bearish' | null =
      latestTideNcp != null && latestTideNpp != null
        ? latestTideNcp < latestTideNpp
          ? 'bearish'
          : 'bullish'
        : null;

    if (!flowDirection) return null;

    const contractType = flowDirection === 'bullish' ? 'CALL' : 'PUT';
    // Target 14 DTE: window of 12-16 days out
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() + 12);
    const to = new Date(now);
    to.setDate(to.getDate() + 16);
    const fromStr = getETDateStr(from);
    const toStr = getETDateStr(to);

    const chainResult = await schwabFetch<SchwabChainData>(
      `/chains?symbol=$SPX&contractType=${contractType}` +
        `&includeUnderlyingQuote=true&strategy=SINGLE&range=NTM` +
        `&fromDate=${fromStr}&toDate=${toStr}&strikeCount=20`,
    );

    if (!chainResult.ok) {
      logger.warn(
        { status: chainResult.status },
        '14 DTE chain fetch failed — Schwab auth may be unavailable',
      );
      return null;
    }

    const expMap =
      flowDirection === 'bullish'
        ? chainResult.data.callExpDateMap
        : chainResult.data.putExpDateMap;

    let bestExpKey: string | null = null;
    let bestDteDiff = Infinity;
    for (const key of Object.keys(expMap)) {
      const dte = Number.parseInt(key.split(':')[1] ?? '0', 10);
      const diff = Math.abs(dte - 14);
      if (diff < bestDteDiff) {
        bestDteDiff = diff;
        bestExpKey = key;
      }
    }

    if (!bestExpKey) return null;

    const strikes = expMap[bestExpKey]!;
    const contracts: SchwabContract[] = [];
    for (const strikeKey of Object.keys(strikes)) {
      const list = strikes[strikeKey]!;
      if (list.length > 0) contracts.push(list[0]!);
    }

    // Filter to |delta| between 0.40 and 0.65 (50Δ zone)
    const filtered = contracts.filter((c) => {
      const absDelta = Math.abs(c.delta);
      return absDelta >= 0.4 && absDelta <= 0.65;
    });

    if (filtered.length === 0) return null;

    filtered.sort((a, b) => a.strikePrice - b.strikePrice);
    const expDate = bestExpKey.split(':')[0];
    const dte = bestExpKey.split(':')[1];
    const side = flowDirection === 'bullish' ? 'Call' : 'Put';
    const tag = side[0];
    const fmtOI = (n: number) =>
      n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
    const lines = filtered.map(
      (c) =>
        `  ${c.strikePrice}${tag}  Bid $${c.bid.toFixed(2)}  Ask $${c.ask.toFixed(2)}  Mid $${((c.bid + c.ask) / 2).toFixed(2)}  Δ ${c.delta.toFixed(2)}  IV ${c.volatility.toFixed(1)}%  OI ${fmtOI(c.openInterest)}  Vol ${fmtOI(c.totalVolume)}`,
    );
    return (
      `## ${dte} DTE SPX ${side} Chain (${expDate} expiry, 40-65Δ range)\n` +
      `Flow direction: ${flowDirection.toUpperCase()} (from Market Tide NCP). ` +
      `Showing ${side.toLowerCase()}s only.\n` +
      lines.join('\n')
    );
  } catch (error_) {
    logger.error(
      { err: error_ },
      'Failed to fetch 14 DTE chain for directional opportunity',
    );
    return null;
  }
}

// ── Cross-asset regime ────────────────────────────────────────

export async function fetchCrossAssetRegimeBlock(): Promise<string | null> {
  try {
    const result = await computeCrossAssetRegime(new Date());
    return formatCrossAssetRegimeForClaude(result);
  } catch (err) {
    logger.error({ err }, 'cross-asset regime fetch failed');
    metrics.increment('analyze_context.cross_asset_regime_error');
    return null;
  }
}

// ── Prior-day volume profile (ES) ─────────────────────────────

export async function fetchVolumeProfileBlock(
  analysisDate: string,
): Promise<string | null> {
  try {
    const prior = priorTradeDate(analysisDate);
    const result = await computeVolumeProfile('ES', prior);
    return formatVolumeProfileForClaude(result);
  } catch (err) {
    logger.error({ err }, 'volume profile fetch failed');
    metrics.increment('analyze_context.volume_profile_error');
    return null;
  }
}

// ── VIX/SPX divergence ────────────────────────────────────────

export async function fetchVixDivergenceBlock(): Promise<string | null> {
  try {
    const result = await computeVixSpxDivergence(new Date());
    return formatVixDivergenceForClaude(result);
  } catch (err) {
    logger.error({ err }, 'VIX/SPX divergence fetch failed');
    metrics.increment('analyze_context.vix_divergence_error');
    return null;
  }
}

// ── Microstructure signals (dual-symbol: ES + NQ) ─────────────
//
// Phase 5a widens this from ES-only to both symbols. The validated
// signal is NQ 1h OFI (Phase 4d: ρ=0.313, p_bonf<0.001, n=312); ES
// microstructure is retained as qualitative tape flavor and as the
// cross-asset confirmation leg. See `microstructure-signals.ts` for
// why we keep ES here even though it's not a validated predictor.

export async function fetchMicrostructureBlock(): Promise<string | null> {
  try {
    const result = await computeAllSymbolSignals(new Date());
    const ranks = await fetchPercentileRanks(result);
    return formatMicrostructureDualSymbolForClaude(result, ranks);
  } catch (err) {
    logger.error({ err }, 'microstructure signals fetch failed');
    metrics.increment('analyze_context.microstructure_error');
    return null;
  }
}

/**
 * Enrich the live Phase 5a dual-symbol signals with each symbol's 1h
 * OFI historical percentile rank from the sidecar's TBBO archive
 * (Phase 4b). Returns null when both symbols lack a 1h OFI value or
 * when the sidecar is unreachable — the formatter gracefully drops the
 * Historical rank line.
 *
 * Per-symbol fetches run in parallel via `Promise.allSettled` so one
 * side failing (archive doesn't have ES history yet, transient 5xx,
 * whatever) never suppresses the other side's rank. Non-finite 1h OFI
 * values short-circuit without a fetch.
 */
async function fetchPercentileRanks(
  result: Awaited<ReturnType<typeof computeAllSymbolSignals>>,
): Promise<MicrostructureOfiRanks | null> {
  const esOfi1h = result.es?.ofi1h ?? null;
  const nqOfi1h = result.nq?.ofi1h ?? null;
  if (
    !(esOfi1h != null && Number.isFinite(esOfi1h)) &&
    !(nqOfi1h != null && Number.isFinite(nqOfi1h))
  ) {
    return null;
  }
  const [esRank, nqRank] = await Promise.allSettled([
    esOfi1h != null && Number.isFinite(esOfi1h)
      ? fetchTbboOfiPercentile('ES', esOfi1h, '1h')
      : Promise.resolve(null),
    nqOfi1h != null && Number.isFinite(nqOfi1h)
      ? fetchTbboOfiPercentile('NQ', nqOfi1h, '1h')
      : Promise.resolve(null),
  ]);
  return {
    es:
      esRank.status === 'fulfilled' && esRank.value != null
        ? {
            percentile: esRank.value.percentile,
            mean: esRank.value.mean,
            std: esRank.value.std,
            count: esRank.value.count,
          }
        : null,
    nq:
      nqRank.status === 'fulfilled' && nqRank.value != null
        ? {
            percentile: nqRank.value.percentile,
            mean: nqRank.value.mean,
            std: nqRank.value.std,
            count: nqRank.value.count,
          }
        : null,
  };
}

// ── UW deltas (Phase 5b: DP velocity, GEX delta, whale, ETF) ──
//
// Pure compute-on-demand layer over existing UW data already in Neon.
// Four parallel signals with Promise.allSettled fault isolation inside
// computeUwDeltas itself — this wrapper only needs the usual catch-all
// to log + metric the rare case where the orchestrator throws (empty
// object literal, unexpected null, DB connection pool exhaustion).

export async function fetchUwDeltasBlock(): Promise<string | null> {
  try {
    const result = await computeUwDeltas(new Date());
    return formatUwDeltasForClaude(result);
  } catch (err) {
    logger.error({ err }, 'UW deltas fetch failed');
    metrics.increment('analyze_context.uw_deltas_error');
    return null;
  }
}

// ── Historical analogs (day embeddings) ───────────────────────────────

/**
 * Retrieve a cohort of historical analog days for `analysisDate`.
 *
 * Backend is selected by `DAY_ANALOG_BACKEND`:
 *   'features' → engineered 60-dim path-shape vector (Phase C)
 *   anything else (or unset) → OpenAI text embedding (Phase B, default)
 *
 * Both paths return pre-formatted Claude block text. Absence of data
 * (backfill hasn't reached this date, sidecar down, etc.) returns null
 * so the orchestrator can log it to the unavailable manifest.
 */
export async function fetchSimilarDaysContext(
  analysisDate: string,
  k: number = 15,
): Promise<string | null> {
  const backend = process.env.DAY_ANALOG_BACKEND?.toLowerCase() ?? 'text';
  try {
    const { fetchDaySummary, fetchDayFeatures } =
      await import('./archive-sidecar.js');
    const { formatSimilarDaysForClaude } =
      await import('./analyze-context-formatters.js');
    const { fetchCurrentSnapshot } = await import('./current-snapshot.js');

    // Fast path: refresh-current-snapshot cron materializes today's
    // summary + features into Neon every 5 min during market hours.
    // Hit that first so the analyze endpoint never pays the sidecar's
    // DuckDB-cold-scan penalty on the hot path.
    const snapshot = await fetchCurrentSnapshot(analysisDate);
    let summary: string | null = snapshot?.summary ?? null;
    let features: number[] | null = snapshot?.features ?? null;

    if (!summary) summary = await fetchDaySummary(analysisDate);
    if (!summary) return null;

    if (backend === 'features') {
      const { findSimilarDaysByFeatures } = await import('./day-features.js');
      if (!features) features = await fetchDayFeatures(analysisDate);
      if (!features) return null;
      const neighbors = await findSimilarDaysByFeatures(
        features,
        k,
        analysisDate,
      );
      if (neighbors.length === 0) return null;
      // Neighbor summaries come from day_embeddings (stored per
      // historical row) — no sidecar round-trip per neighbor.
      const { getDb } = await import('./db.js');
      const sql = getDb();
      const dates = neighbors.map((n) => n.date);
      const rows = dates.length
        ? await sql`
            SELECT date, summary FROM day_embeddings
            WHERE date = ANY(${dates})
          `
        : [];
      const byDate = new Map(
        rows.map((r) => [
          r.date instanceof Date
            ? r.date.toISOString().slice(0, 10)
            : String(r.date).slice(0, 10),
          r.summary as string,
        ]),
      );
      const analogs = neighbors.map((n) => ({
        date: n.date,
        symbol: n.symbol,
        distance: n.distance,
        summary: byDate.get(n.date) ?? `${n.date} ${n.symbol}`,
      }));
      return formatSimilarDaysForClaude(summary, analogs);
    }

    // Default: text-embedding backend.
    const { findSimilarDaysForSummary } = await import('./day-embeddings.js');
    const analogs = await findSimilarDaysForSummary(summary, k, analysisDate);
    if (analogs.length === 0) return null;

    return formatSimilarDaysForClaude(summary, analogs);
  } catch (err) {
    logger.warn({ err, backend }, 'similar-days context fetch failed');
    metrics.increment('analyze_context.similar_days_error');
    return null;
  }
}

/**
 * Cohort-conditional range + asymmetric excursion forecast for the
 * analyze prompt. Same analog retrieval as fetchSimilarDaysContext, but
 * the payload is the cohort's expected daily-range quantiles and
 * up/down excursion numbers — the inputs for 0DTE iron-condor strike
 * placement at ~30Δ / ~12Δ.
 *
 * Validated on 2024-2026 (n=563): text-cohort p90 hits 78% of actual
 * ranges, and cohort correctly reflects SPX's left-tail asymmetry
 * (down p80 > up p80 by ~13%). The global unconditional distribution
 * is dangerously miscalibrated for 2024+ — this fetcher's output is
 * the cohort-conditional replacement.
 */
export async function fetchRangeForecastContext(
  analysisDate: string,
  vixClose?: number | null,
): Promise<string | null> {
  try {
    const { fetchDaySummary } = await import('./archive-sidecar.js');
    const { fetchCurrentSnapshot } = await import('./current-snapshot.js');
    const { getRangeForecast, formatRangeForecast, vixBucketOf } =
      await import('./analog-range-forecast.js');

    const snapshot = await fetchCurrentSnapshot(analysisDate);
    const summary = snapshot?.summary ?? (await fetchDaySummary(analysisDate));
    if (!summary) return null;

    // VIX bucket drives the Phase-4 regime-matched cohort. Null → the
    // forecast module skips the regime-matched query and returns the
    // unstratified cohort only. Cheap lookup; no external call.
    const vixBucket = vixBucketOf(vixClose);

    const forecast = await getRangeForecast(analysisDate, summary, vixBucket);
    return formatRangeForecast(forecast);
  } catch (err) {
    logger.warn({ err }, 'range-forecast context fetch failed');
    metrics.increment('analyze_context.range_forecast_error');
    return null;
  }
}
