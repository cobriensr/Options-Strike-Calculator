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
import { schwabFetch } from './api-helpers.js';
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
    const ivRes = await fetch(
      `https://api.unusualwhales.com/api/stock/SPX/interpolated-iv?date=${ivDate}`,
      {
        headers: { Authorization: `Bearer ${uwKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!ivRes.ok) {
      logger.warn(
        { status: ivRes.status },
        'IV term structure API returned non-OK',
      );
      metrics.increment('analyze_context.iv_term_api_error');
      return null;
    }
    const ivBody: { data: IvTermRow[] } = await ivRes.json();
    return formatIvTermStructureForClaude(ivBody.data ?? [], sigma);
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch IV term structure');
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

    const trades = await fetchDarkPoolBlocks(uwKey, analysisDate);
    if (trades.length === 0) {
      return { darkPoolContext: null, darkPoolClusters: null };
    }
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

    const entries = await fetchMaxPain(uwKey, analysisDate);
    if (entries.length === 0) return null;
    const currentSpx = context.spx as number | undefined;
    return formatMaxPainForClaude(entries, analysisDate, currentSpx);
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
    const fromStr = from.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    const toStr = to.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

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
      const dte = Number.parseInt(key.split(':')[1] ?? '0');
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
