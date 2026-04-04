/**
 * Context builder for the /api/analyze endpoint.
 *
 * Fetches flow data, Greek exposure, strike exposures, SPX candles,
 * dark pool blocks, max pain, IV term structure, pre-market data,
 * positions, and lessons in parallel, then assembles the final user
 * message template for Claude.
 */

import {
  getDb,
  getLatestPositions,
  getPreviousRecommendation,
  getFlowData,
  formatFlowDataForClaude,
  getGreekExposure,
  formatGreekExposureForClaude,
  getSpotExposures,
  formatSpotExposuresForClaude,
} from './db.js';
import {
  getStrikeExposures,
  formatStrikeExposuresForClaude,
  getAllExpiryStrikeExposures,
  formatAllExpiryStrikesForClaude,
  formatGreekFlowForClaude,
} from './db-strike-helpers.js';
import { fetchSPXCandles, formatSPXCandlesForClaude } from './spx-candles.js';
import {
  fetchDarkPoolBlocks,
  clusterDarkPoolTrades,
  formatDarkPoolForClaude,
} from './darkpool.js';
import type { DarkPoolCluster } from './darkpool.js';
import { fetchMaxPain, formatMaxPainForClaude } from './max-pain.js';
import { getOiChangeData, formatOiChangeForClaude } from './db-oi-change.js';
import logger from './logger.js';
import {
  getActiveLessons,
  formatLessonsBlock,
  getHistoricalWinRate,
  formatWinRateForClaude,
} from './lessons.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import type { IvTermRow } from '../iv-term-structure.js';
import { formatIvTermStructureForClaude } from '../iv-term-structure.js';
import type { PreMarketData } from '../pre-market.js';
import { formatOvernightForClaude } from './overnight-gap.js';
import { schwabFetch } from './api-helpers.js';
import type { ImageMediaType } from './analyze-prompts.js';

// Minimal Schwab chain types for 14 DTE directional chain fetch
interface SchwabContract {
  strikePrice: number;
  bid: number;
  ask: number;
  delta: number;
  volatility: number; // IV as percentage (e.g. 25.5)
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

/** Safely extract a numeric value from the untyped context object. */
export function numOrUndef(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

/** Shape of the content blocks sent to the Anthropic API. */
export type AnalysisContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: ImageMediaType;
        data: string;
      };
    };

/** Result of buildAnalysisContext — everything the handler needs. */
export interface AnalysisContextResult {
  /** The content array (images + context text) for the user message. */
  content: AnalysisContentBlock[];
  /** The analysis mode (entry / midday / review). */
  mode: string;
  /** Active lessons block for system prompt injection. */
  lessonsBlock: string;
  /** Clustered dark pool data for persistence (null if unavailable). */
  darkPoolClusters: DarkPoolCluster[] | null;
}

function formatMlFindingsForClaude(
  findings: Record<string, unknown>,
  updatedAt: Date,
): string {
  if (!findings?.dataset) {
    return `Latest ML pipeline run: ${updatedAt.toISOString().slice(0, 10)} (data unavailable)`;
  }
  const d = findings.dataset as {
    total_days: number;
    labeled_days: number;
    date_range: string[];
    overall_accuracy: number;
  };
  const conf = findings.confidence_calibration as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const flow = findings.flow_reliability as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const structAcc = findings.structure_accuracy as Record<
    string,
    { correct: number; total: number; rate: number }
  >;
  const majority = findings.majority_baseline as {
    structure: string;
    rate: number;
  };
  const topPredictors = (
    findings.top_correctness_predictors as Array<{
      feature: string;
      r: number;
      p: number;
    }>
  )?.slice(0, 5);

  const lines: string[] = [
    `Latest ML pipeline run: ${updatedAt.toISOString().slice(0, 10)} (${d.total_days} days, ${d.labeled_days} labeled, ${d.date_range[0]} to ${d.date_range[1]})`,
    `Overall accuracy: ${(d.overall_accuracy * 100).toFixed(1)}%`,
    '',
    'Structure accuracy:',
  ];

  for (const [struct, acc] of Object.entries(structAcc)) {
    lines.push(
      `  ${struct}: ${acc.correct}/${acc.total} (${(acc.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push('', 'Confidence calibration:');
  for (const [level, cal] of Object.entries(conf)) {
    lines.push(
      `  ${level}: ${cal.correct}/${cal.total} (${(cal.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push('', 'Flow source accuracy (settlement direction):');
  for (const [source, rel] of Object.entries(flow)) {
    lines.push(
      `  ${source}: ${rel.correct}/${rel.total} (${(rel.rate * 100).toFixed(0)}%)`,
    );
  }

  lines.push(
    '',
    `Previous-day baseline: always repeat yesterday = ${(majority.rate * 100).toFixed(0)}% (structure: ${majority.structure})`,
  );

  if (topPredictors?.length) {
    lines.push('', 'Top correctness predictors:');
    for (const pred of topPredictors) {
      const dir =
        pred.r > 0 ? 'higher = MORE correct' : 'higher = LESS correct';
      lines.push(`  ${pred.feature}: r=${pred.r.toFixed(3)} (${dir})`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the full analysis context by fetching data from multiple sources
 * in parallel, then assembling the user message template.
 */
export async function buildAnalysisContext(
  images: Array<{
    data: string;
    mediaType: ImageMediaType;
    label?: string;
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

  // Add context as text
  const mode = (context.mode as string | undefined) ?? 'entry';
  // Auto-fetch open positions from DB for this date (if any)
  let positionSummary: string | null = null;
  // Auto-fetch previous recommendation from DB for continuity
  let previousRec: string | null = null;
  const analysisDate =
    (context.selectedDate as string | undefined) ?? getETDateStr(new Date());
  if (!context.isBacktest && mode !== 'review') {
    try {
      const posData = await getLatestPositions(analysisDate);
      if (posData && posData.summary !== 'No open SPX 0DTE positions.') {
        positionSummary = posData.summary;
      }
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch positions for analysis');
    }
  }
  // Always fetch previous recommendation (works for both live and backtest)
  if (mode === 'midday' || mode === 'review') {
    try {
      previousRec = await getPreviousRecommendation(analysisDate, mode);
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch previous recommendation');
    }
  }
  // Use DB positions if available, fall back to manually provided currentPosition
  // Review mode doesn't need positions — it evaluates the recommendation, not trades
  const positionContext =
    mode === 'review'
      ? null
      : (positionSummary ??
        (context.currentPosition as string | undefined) ??
        null);
  // Use DB previous recommendation if available, fall back to manually provided
  const previousContext =
    previousRec ??
    (context.previousRecommendation as string | undefined) ??
    null;
  // Auto-fetch flow data from DB (populated by crons)
  let marketTideContext: string | null = null;
  let marketTideOtmContext: string | null = null;
  let spxFlowContext: string | null = null;
  let spyFlowContext: string | null = null;
  let qqqFlowContext: string | null = null;
  let spyEtfTideContext: string | null = null;
  let qqqEtfTideContext: string | null = null;
  let zeroDteIndexContext: string | null = null;
  let greekExposureContext: string | null = null;
  let spotGexContext: string | null = null;
  let strikeExposureContext: string | null = null;
  let allExpiryStrikeContext: string | null = null;
  let greekFlowContext: string | null = null;
  let ivTermStructureContext: string | null = null;
  let overnightGapContext: string | null = null;
  // Latest Market Tide NCP for directional chain fetch (hoisted for scope)
  let latestTideNcp: number | null = null;
  let latestTideNpp: number | null = null;
  let spxCandlesContext: string | null = null;
  let darkPoolContext: string | null = null;
  let darkPoolClusters: DarkPoolCluster[] | null = null;
  let maxPainContext: string | null = null;
  let oiChangeContext: string | null = null;
  let volRealizedContext: string | null = null;
  let mlCalibrationContext: string | null = null;

  // Cone boundaries — populated from pre-market data or context
  let straddleConeUpper = numOrUndef(context.straddleConeUpper);
  let straddleConeLower = numOrUndef(context.straddleConeLower);

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
    ] = await Promise.all([
      getFlowData(analysisDate, 'market_tide'),
      getFlowData(analysisDate, 'market_tide_otm'),
      getFlowData(analysisDate, 'spx_flow'),
      getFlowData(analysisDate, 'spy_flow'),
      getFlowData(analysisDate, 'qqq_flow'),
      getFlowData(analysisDate, 'spy_etf_tide'),
      getFlowData(analysisDate, 'qqq_etf_tide'),
      getFlowData(analysisDate, 'zero_dte_index'),
      getFlowData(analysisDate, 'zero_dte_greek_flow'),
      getGreekExposure(analysisDate),
      getSpotExposures(analysisDate),
      getStrikeExposures(analysisDate),
      getAllExpiryStrikeExposures(analysisDate),
    ]);
    marketTideContext = formatFlowDataForClaude(
      tideRows,
      'Market Tide (All-In)',
    );
    // Capture latest tide for directional chain direction
    if (tideRows.length > 0) {
      const latest = tideRows.at(-1)!;
      latestTideNcp = latest.ncp;
      latestTideNpp = latest.npp;
    }
    marketTideOtmContext = formatFlowDataForClaude(
      tideOtmRows,
      'Market Tide (OTM Only)',
    );
    spxFlowContext = formatFlowDataForClaude(spxRows, 'SPX Net Flow');
    spyFlowContext = formatFlowDataForClaude(spyRows, 'SPY Net Flow');
    qqqFlowContext = formatFlowDataForClaude(qqqRows, 'QQQ Net Flow');
    spyEtfTideContext = formatFlowDataForClaude(
      spyEtfRows,
      'SPY ETF Tide (Holdings Flow)',
    );
    qqqEtfTideContext = formatFlowDataForClaude(
      qqqEtfRows,
      'QQQ ETF Tide (Holdings Flow)',
    );
    zeroDteIndexContext = formatFlowDataForClaude(
      zeroDteIndexRows,
      '0DTE Index-Only Net Flow',
    );
    // Append 0DTE P/C premium ratio from latest NCP/NPP
    if (zeroDteIndexContext && zeroDteIndexRows.length > 0) {
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
        zeroDteIndexContext += `\n  0DTE Put/Call Premium Ratio: ${pcRatio.toFixed(2)} (|NPP|/|NCP|) — ${signal}`;
      }
    }
    greekExposureContext = formatGreekExposureForClaude(
      greekRows,
      analysisDate,
    );
    greekFlowContext = formatGreekFlowForClaude(greekFlowRows);
    spotGexContext = formatSpotExposuresForClaude(spotGexRows);
    strikeExposureContext = formatStrikeExposuresForClaude(strikeRows);
    allExpiryStrikeContext = formatAllExpiryStrikesForClaude(
      allExpiryStrikeRows,
      strikeRows,
    );
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch flow data for analysis');
  }

  // On-demand IV term structure fetch (not from DB — direct UW API call)
  try {
    const uwKey = process.env.UW_API_KEY;
    if (uwKey) {
      const ivDate = analysisDate ?? getETDateStr(new Date());
      const ivRes = await fetch(
        `https://api.unusualwhales.com/api/stock/SPX/interpolated-iv?date=${ivDate}`,
        {
          headers: { Authorization: `Bearer ${uwKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (ivRes.ok) {
        const ivBody: { data: IvTermRow[] } = await ivRes.json();
        ivTermStructureContext = formatIvTermStructureForClaude(
          ivBody.data ?? [],
          context.sigma as string | undefined,
        );
      } else {
        logger.warn(
          { status: ivRes.status },
          'IV term structure API returned non-OK',
        );
      }
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch IV term structure');
  }

  // Realized vol + IV rank from daily vol_realized table
  try {
    const sql = getDb();
    const rvRows = await sql`
      SELECT iv_30d, rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
      FROM vol_realized
      WHERE date = ${analysisDate}
      LIMIT 1
    `;
    if (rvRows.length > 0) {
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
          const label =
            Number(spread) > 0 ? 'IV OVERPRICING' : 'IV UNDERPRICING';
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
      if (lines.length > 0) {
        volRealizedContext = lines.join('\n  ');
      }
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch vol realized data');
  }

  // On-demand pre-market data (ES overnight + straddle cone from manual input)
  let previousClose: number | null = null;
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

      // Extract cone boundaries for candles + overnight formatters
      if (pm.straddleConeUpper != null && !straddleConeUpper)
        straddleConeUpper = pm.straddleConeUpper;
      if (pm.straddleConeLower != null && !straddleConeLower)
        straddleConeLower = pm.straddleConeLower;

      // Format overnight gap analysis if we have cash open + prev close
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

  // On-demand SPX candles from UW (fetches SPY, translates via ratio)
  if (!context.isBacktest) {
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
        previousClose = candleResult.previousClose;
        spxCandlesContext = formatSPXCandlesForClaude(
          candleResult.candles,
          candleResult.previousClose,
          straddleConeUpper,
          straddleConeLower,
        );
      }
    } catch (error_) {
      logger.error({ err: error_ }, 'Failed to fetch SPX candles');
    }
  }

  // If we got previousClose from candles and have pre-market but no gap context yet, retry
  if (!overnightGapContext && previousClose && preMarketRow) {
    const cashOpen = numOrUndef(context.spx);
    if (cashOpen) {
      overnightGapContext = formatOvernightForClaude({
        preMarket: preMarketRow,
        cashOpen,
        prevClose: previousClose,
      });
    }
  }

  // On-demand dark pool blocks
  try {
    const uwKey = process.env.UW_API_KEY;
    if (uwKey) {
      const trades = await fetchDarkPoolBlocks(uwKey, analysisDate);
      if (trades.length > 0) {
        const currentSpx = context.spx as number | undefined;
        const currentSpy = context.spy as number | undefined;
        const ratio =
          currentSpx && currentSpy && currentSpy > 0
            ? currentSpx / currentSpy
            : 10;
        darkPoolClusters = clusterDarkPoolTrades(trades, ratio);
        darkPoolContext = formatDarkPoolForClaude(trades, currentSpx, ratio);
      }
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch dark pool data');
  }

  // On-demand max pain
  try {
    const uwKey = process.env.UW_API_KEY;
    if (uwKey) {
      const entries = await fetchMaxPain(uwKey, analysisDate);
      if (entries.length > 0) {
        const currentSpx = context.spx as number | undefined;
        maxPainContext = formatMaxPainForClaude(
          entries,
          analysisDate,
          currentSpx,
        );
      }
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch max pain data');
  }

  // On-demand OI change data (prior day positioning)
  try {
    const oiChangeRows = await getOiChangeData(analysisDate);
    if (oiChangeRows.length > 0) {
      const currentSpx = context.spx as number | undefined;
      oiChangeContext = formatOiChangeForClaude(
        oiChangeRows,
        currentSpx ?? undefined,
      );
    }
  } catch (error_) {
    logger.error({ err: error_ }, 'Failed to fetch OI change data');
  }

  // ML calibration — latest validated ML findings from EDA pipeline
  try {
    const sql = getDb();
    const mlRows = await sql`
      SELECT findings, updated_at FROM ml_findings WHERE id = 1
    `;
    if (mlRows.length > 0) {
      const { findings, updated_at } = mlRows[0] as {
        findings?: Record<string, unknown>;
        updated_at?: Date;
      };
      if (findings && updated_at) {
        mlCalibrationContext = formatMlFindingsForClaude(findings, updated_at);
      }
    }
  } catch (error_) {
    logger.warn(
      { err: error_ },
      'ML findings fetch failed — using static prompt values',
    );
  }

  // On-demand 14 DTE directional chain (midday only, not backtests)
  let directionalChainContext: string | null = null;
  if (mode === 'midday' && !context.isBacktest) {
    try {
      // Determine flow direction from latest Market Tide NCP
      const flowDirection: 'bullish' | 'bearish' | null =
        latestTideNcp != null && latestTideNpp != null
          ? latestTideNcp < latestTideNpp
            ? 'bearish'
            : 'bullish'
          : null;

      if (flowDirection) {
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

        if (chainResult.ok) {
          const expMap =
            flowDirection === 'bullish'
              ? chainResult.data.callExpDateMap
              : chainResult.data.putExpDateMap;

          // Pick expiration closest to 14 DTE
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

          if (bestExpKey) {
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

            if (filtered.length > 0) {
              filtered.sort((a, b) => a.strikePrice - b.strikePrice);
              const expDate = bestExpKey.split(':')[0];
              const dte = bestExpKey.split(':')[1];
              const side = flowDirection === 'bullish' ? 'Call' : 'Put';
              const tag = side[0]; // C or P
              const fmtOI = (n: number) =>
                n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
              const lines = filtered.map(
                (c) =>
                  `  ${c.strikePrice}${tag}  Bid $${c.bid.toFixed(2)}  Ask $${c.ask.toFixed(2)}  Mid $${((c.bid + c.ask) / 2).toFixed(2)}  Δ ${c.delta.toFixed(2)}  IV ${c.volatility.toFixed(1)}%  OI ${fmtOI(c.openInterest)}  Vol ${fmtOI(c.totalVolume)}`,
              );
              directionalChainContext =
                `## ${dte} DTE SPX ${side} Chain (${expDate} expiry, 40-65Δ range)\n` +
                `Flow direction: ${flowDirection.toUpperCase()} (from Market Tide NCP). ` +
                `Showing ${side.toLowerCase()}s only.\n` +
                lines.join('\n');
            }
          }
        } else {
          logger.warn(
            { status: chainResult.status },
            '14 DTE chain fetch failed — Schwab auth may be unavailable',
          );
        }
      }
    } catch (error_) {
      logger.error(
        { err: error_ },
        'Failed to fetch 14 DTE chain for directional opportunity',
      );
    }
  }

  const marketTideOtmSection = marketTideOtmContext
    ? `\n${marketTideOtmContext}\n`
    : '';

  // Build data unavailability manifest so the model knows what failed to fetch
  const unavailable: string[] = [];
  if (!spxFlowContext) unavailable.push('SPX Net Flow');
  if (!marketTideContext) unavailable.push('Market Tide');
  if (!spotGexContext) unavailable.push('Aggregate GEX Panel');
  if (!greekExposureContext) unavailable.push('Greek Exposure (OI-based)');
  if (!strikeExposureContext) unavailable.push('Per-Strike Greek Profile');
  if (!greekFlowContext) unavailable.push('0DTE Delta Flow');
  if (!spxCandlesContext && !context.isBacktest)
    unavailable.push('SPX Intraday Candles');
  if (!darkPoolContext) unavailable.push('Dark Pool Blocks');
  if (!maxPainContext) unavailable.push('Max Pain');
  if (!ivTermStructureContext) unavailable.push('IV Term Structure');
  if (!overnightGapContext) unavailable.push('Overnight Gap Analysis');
  if (!oiChangeContext) unavailable.push('OI Change Analysis');
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
${marketTideContext ? `\n## Market Tide Data (from API — 5-min intervals)\nThis is exact data from the Unusual Whales API. Use these values instead of estimating from the Market Tide screenshot. If a Market Tide screenshot is also provided, use it for visual confirmation only — trust the API values for NCP/NPP readings.\n\n${marketTideContext}\n${marketTideOtmSection}` : ''}
${spxFlowContext ? `\n## SPX Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for SPX. These are the primary flow signal (Rule 8, 50% weight). Trust these values over screenshot estimates.\n\n${spxFlowContext}\n` : ''}
${spyFlowContext ? `\n## SPY Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for SPY. Secondary confirmation signal (Rule 8, 15% weight).\n\n${spyFlowContext}\n` : ''}
${qqqFlowContext ? `\n## QQQ Net Flow Data (from API — 5-min intervals)\nExact cumulative NCP/NPP values for QQQ. Tech divergence check (Rule 8, 10% weight).\n\n${qqqFlowContext}\n` : ''}
${spyEtfTideContext ? `\n## SPY ETF Tide — Holdings Flow (from API — 5-min intervals)\nOptions flow on the individual stocks inside SPY (AAPL, MSFT, NVDA, etc), not on SPY itself. When SPY Net Flow is bullish but SPY ETF Tide is bearish, the SPY call buying is likely hedging — the underlying stocks are seeing directional put buying. Use as a confirmation/divergence layer against SPY Net Flow.\n\n${spyEtfTideContext}\n` : ''}
${qqqEtfTideContext ? `\n## QQQ ETF Tide — Holdings Flow (from API — 5-min intervals)\nOptions flow on the individual stocks inside QQQ (AAPL, MSFT, NVDA, AMZN, etc), not on QQQ itself. Same divergence logic as SPY ETF Tide — when QQQ flow and QQQ ETF Tide disagree, the underlying holdings flow is more directionally reliable.\n\n${qqqEtfTideContext}\n` : ''}
${zeroDteIndexContext ? `\n## 0DTE Index-Only Net Flow (from API)\nPure 0DTE flow from index products (SPX, NDX) only — excludes weekly/monthly expirations and ETFs/equities. When this diverges from aggregate SPX Net Flow, the aggregate signal contains longer-dated hedging noise. Trust 0DTE index flow for same-session directional reads. When both agree, highest conviction.\n\n${zeroDteIndexContext}\n` : ''}
${greekExposureContext ? `\n## SPX Greek Exposure (from API — OI-based)\nAggregate MM Greek exposure across all expirations. The OI Net Gamma number determines the Rule 16 regime. The 0DTE breakdown shows charm/delta specific to today's expiration. If an Aggregate GEX screenshot is also provided, this data provides the OI gamma number — the screenshot still adds Volume GEX and Directionalized Volume GEX which are not available from this API.\n\n${greekExposureContext}\n` : ''}
${greekFlowContext ? `\n## 0DTE SPX Delta Flow (from API)\nDelta flow measures directional exposure being added through 0DTE SPX options per minute. Unlike premium flow (NCP/NPP), delta flow captures exposure from spreads and complex structures where net premium is near-zero but directional exposure is significant. When delta flow diverges from premium flow, it reveals institutional positioning that premium alone misses.\n\n${greekFlowContext}\n` : ''}
${spotGexContext ? `\n## SPX Aggregate GEX Panel (from API — intraday time series)\nThis replaces the Aggregate GEX screenshot. Includes OI Net Gamma (Rule 16), Volume Net Gamma, and Directionalized Volume Net Gamma updated every 5 minutes. If an Aggregate GEX screenshot is also provided, trust the API values — the screenshot is visual confirmation only.\n\n${spotGexContext}\n` : ''}
${strikeExposureContext ? `\n## SPX 0DTE Per-Strike Greek Profile (from API)\nThis is the naive per-strike gamma and charm profile for today's 0DTE expiration. It replaces the Net Charm (naive) screenshot. The "Net Gamma" column shows the gamma bar values at each strike. The "Net Charm" column shows how each wall evolves with time. The "Dir Gamma/Charm" columns show directionalized (ask/bid) exposure which approximates confirmed MM positioning. Periscope screenshots still provide CONFIRMED MM exposure — use API data for the naive profile and Periscope for strike-level confirmation.\n\n${strikeExposureContext}\n` : ''}
${allExpiryStrikeContext ? `\n## SPX All-Expiry Per-Strike Profile (from API)\nThis shows gamma/charm across ALL expirations (not just 0DTE). Multi-day gamma anchors from weekly/monthly/quarterly options create structural walls that persist beyond the 0DTE session. When a 0DTE wall aligns with an all-expiry wall, it has the highest reliability. When they diverge (0DTE wall but all-expiry danger zone), the wall may fail under sustained pressure.\n\n${allExpiryStrikeContext}\n` : ''}
${ivTermStructureContext ? `\n## IV Term Structure — σ Validation Layer (from API)\nInterpolated IV across the term structure from the options chain. The 0DTE row gives the ATM implied move directly from options pricing — compare this to the calculator's VIX1D-derived σ to check if the cone is wider or narrower than the market's actual pricing. The 30D row gives the longer-dated IV for term structure shape analysis. Steep contango (0DTE IV << 30D IV) confirms a normal vol regime. Inversion (0DTE IV >> 30D IV) confirms the VIX1D extreme inversion signal from a different angle and warns of elevated intraday risk.\n\n${ivTermStructureContext}\n` : ''}
${volRealizedContext ? `\n## Realized Vol & IV Rank (from API — daily)\n  ${volRealizedContext}\n` : ''}
${overnightGapContext ? `\n## ES Overnight Gap Analysis (from pre-market data)\nThe ES futures overnight session data provides pre-market context for the cash session. Gap fill probability, overnight range consumption, and VWAP positioning help calibrate the opening hour bias. On high gap fill probability days, the first 30 minutes are likely to see a reversal toward the previous close. On low fill probability days, the gap direction extends and aligns with the session trend.\n\n${overnightGapContext}\n` : ''}
${
  straddleConeUpper && straddleConeLower && !spxCandlesContext
    ? `\n## Straddle Cone Boundaries (from Periscope)
  Upper: ${straddleConeUpper.toFixed(1)}
  Lower: ${straddleConeLower.toFixed(1)}
  Width: ${(straddleConeUpper - straddleConeLower).toFixed(0)} pts
`
    : ''
}
${darkPoolContext ? `\n## SPY Dark Pool Institutional Blocks (from API)\nLarge ($5M+) dark pool block trades in SPY, translated to approximate SPX levels. Dark pool prints reveal where institutions are buying or selling in size off-exchange — these create structural support/resistance levels that options flow, gamma, and charm cannot see. When a dark pool buyer-initiated cluster aligns with a positive gamma wall, that level has the highest-confidence structural support. When a dark pool seller cluster aligns with negative gamma, that level is a confirmed ceiling.\n\n${darkPoolContext}\n` : ''}
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
  const fmtOI = (n: number) =>
    n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const lines = topOI.map(
    (s) =>
      `  ${s.strike} — Total: ${fmtOI(s.totalOI)} (Put: ${fmtOI(s.putOI)}, Call: ${fmtOI(s.callOI)}) | ${s.distFromSpot >= 0 ? '+' : ''}${s.distFromSpot.toFixed(0)} pts (${s.distPct}%) | ${s.side}`,
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
  let signal = '';
  if (skew.putSkew25d > 8)
    signal =
      'STEEP — institutions pricing significant downside risk. PCS premium is rich but tail risk elevated.';
  else if (skew.putSkew25d > 4) signal = 'NORMAL — standard risk premium.';
  else signal = 'FLAT — unusually low hedging demand. Supports IC.';
  let ratioSignal = '';
  if (skew.skewRatio > 2)
    ratioSignal =
      'Strong put-over-call risk premium — market expects any large move to the downside.';
  else if (skew.skewRatio < 1.2)
    ratioSignal =
      'Unusually symmetric — market sees equal up/down risk. Supports IRON CONDOR.';
  else ratioSignal = 'Normal asymmetry.';
  return `\n## IV Skew Metrics (from chain data)\n  ATM IV: ${skew.atmIV.toFixed(1)}%\n  25Δ Put IV: ${skew.put25dIV.toFixed(1)}% (skew: +${skew.putSkew25d.toFixed(1)} vol pts)\n  25Δ Call IV: ${skew.call25dIV.toFixed(1)}% (skew: +${skew.callSkew25d.toFixed(1)} vol pts)\n  Skew Ratio (|put|/|call|): ${skew.skewRatio.toFixed(1)}x\n  Put Skew Signal: ${signal}\n  Skew Ratio Signal: ${ratioSignal}\n`;
})()}
${maxPainContext ? `\n## SPX 0DTE Max Pain (from API)\nMax pain is the strike where total option holder losses are maximized — MMs profit most if SPX settles here. On neutral/low-gamma days, settlement gravitates toward max pain in the final 2 hours. On days with a dominant gamma wall (Rule 6) or deeply negative GEX (cone-lower settlement pattern), the gamma wall or cone boundary overrides max pain. Use max pain as a tiebreaker when gamma and flow signals are ambiguous — if max pain aligns with a gamma wall, that level has the highest settlement probability.\n\n${maxPainContext}\n` : ''}
${oiChangeContext ? `\n## SPX OI Change Analysis (from API — prior day positioning)\nShows where institutions opened or closed the most positions. Ask-dominated volume indicates aggressive new positioning; bid-dominated suggests defensive or closing activity. High multi-leg percentage (>50%) indicates institutional spread activity rather than directional bets.\n\n${oiChangeContext}\n` : ''}
${spxCandlesContext ? `\n## SPX Intraday Price Action (5-min candles)\nReal OHLCV price data for today's session. Use this to assess price structure: is SPX making higher lows (uptrend intact despite flow concerns), compressing into a range (IC-favorable), or printing wide-range bars (elevated volatility)? The session range relative to the straddle cone shows how much of the expected move has been consumed. VWAP acts as an institutional reference price — sustained trading below VWAP on a bearish flow day confirms the thesis, while price reclaiming VWAP on a bearish day is a warning.\n\n${spxCandlesContext}\n` : ''}
${directionalChainContext ? `\n${directionalChainContext}\nThis chain data is for the directional opportunity assessment. The trader buys 14 DTE ATM options at 50Δ minimum. Use bid/ask for entry price guidance. Do not vary strike or DTE — the trader sizes the position themselves.\n` : ''}
${positionContext ? `\n## Current Open Positions (live from Schwab)\nThese are the trader's ACTUAL open SPX 0DTE positions right now. Reference these specific strikes in your analysis — do not estimate or guess strike placement.\n\n${positionContext}\n` : ''}
${previousContext ? `\n## Previous Recommendation (from earlier today)\nIMPORTANT: This is what YOU recommended earlier today. Be consistent with this analysis unless conditions have materially changed. If you are changing your recommendation, explicitly state WHAT changed and WHY.\n⚠️ STRIKE OVERRIDE: Any strike prices or position descriptions in this section are from the prior recommendation — they describe what the trader was ADVISED to enter, not necessarily what was filled at those exact strikes. If "Current Open Positions" is provided above, those Schwab-verified strikes are ground truth and OVERRIDE any strike estimates here. Use ONLY the actual positions for all cushion, risk, and management calculations.\n\n${previousContext}\n` : ''}
IMPORTANT: The trader is evaluating at ${String(context.entryTime ?? 'the specified time')}. Charts may show the full trading day — ONLY analyze data visible up to the entry time. Everything after does not exist yet.
Provide your complete analysis as JSON. Mode is "${mode}".`;

  // Fetch active lessons and historical win rate in parallel
  let lessonsBlock = '';
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

  // Append win rate to context (after main contextText, before sending)
  const finalContextText = contextText + winRateContext;
  content.push({ type: 'text', text: finalContextText });

  return { content, mode, lessonsBlock, darkPoolClusters };
}
