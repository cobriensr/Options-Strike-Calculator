/**
 * market-regime — pure utility functions for regime classification and
 * TICK band detection.
 *
 * Why this exists
 * ---------------
 * Phase 1 shipped a live badge showing raw market internals. Phase 2 turns
 * the raw readout into a regime classifier (range day vs trend day) and
 * provides the extracted `classifyTickBand` that the badge (and soon the
 * panel) both depend on.
 *
 * The classifier combines TICK mean-reversion rate, ADD flatness, TICK
 * extreme-pin percentage, and VOLD directionality into three scores
 * (range, trend, neutral) and picks the argmax as the regime.
 *
 * Pure module — no React, no fetch, no side effects.
 */

import { MARKET_INTERNALS_THRESHOLDS } from '../constants/market-internals';
import type {
  InternalBandState,
  InternalBar,
  InternalSymbol,
  RegimeResult,
  RegimeType,
} from '../types/market-internals';

// ============================================================
// TICK BAND CLASSIFICATION
// ============================================================

/**
 * Classify a $TICK close into one of four bands by absolute magnitude.
 * Direction doesn't change the band — TICK at -650 is just as "extreme"
 * as +650.
 */
export function classifyTickBand(tick: number): InternalBandState {
  if (!Number.isFinite(tick)) return 'neutral';
  const mag = Math.abs(tick);
  const { elevated, extreme, blowoff } = MARKET_INTERNALS_THRESHOLDS.tick;
  if (mag >= blowoff) return 'blowoff';
  if (mag >= extreme) return 'extreme';
  if (mag >= elevated) return 'elevated';
  return 'neutral';
}

// ============================================================
// HELPERS
// ============================================================

/** Split bars by symbol for independent analysis. */
function partitionBySymbol(
  bars: InternalBar[],
): Map<InternalSymbol, InternalBar[]> {
  const map = new Map<InternalSymbol, InternalBar[]>();
  for (const bar of bars) {
    const arr = map.get(bar.symbol);
    if (arr) {
      arr.push(bar);
    } else {
      map.set(bar.symbol, [bar]);
    }
  }
  return map;
}

const EMPTY_RESULT: RegimeResult = {
  regime: 'neutral',
  confidence: 0,
  evidence: ['No bars available'],
  scores: { range: 0, trend: 0, neutral: 1 },
};

// ============================================================
// REGIME CLASSIFICATION
// ============================================================

/**
 * Classify the current session as range, trend, or neutral from today's
 * intraday bars for all symbols.
 *
 * Scoring:
 *   range_score  = tick_mean_reversion_rate * add_flatness
 *   trend_score  = pct_time_tick_extreme * vold_directional
 *   neutral_score = max(0, 1 - range_score - trend_score)
 *   regime       = argmax of the three
 *   confidence   = max_score / sum_of_scores
 */
export function classifyRegime(bars: InternalBar[]): RegimeResult {
  if (bars.length === 0) return EMPTY_RESULT;

  const bySymbol = partitionBySymbol(bars);
  const tickBars = bySymbol.get('$TICK') ?? [];
  const addBars = bySymbol.get('$ADD') ?? [];
  const voldBars = bySymbol.get('$VOLD') ?? [];

  const evidence: string[] = [];

  // Minimum data gate — need at least 10 TICK bars for meaningful
  // regime classification.
  if (tickBars.length < 10) {
    return {
      regime: 'neutral',
      confidence: 0,
      evidence: [`Insufficient data (${tickBars.length} TICK bars)`],
      scores: { range: 0, trend: 0, neutral: 1 },
    };
  }

  // Note missing symbols so downstream consumers know the signal is
  // degraded.
  const missing: InternalSymbol[] = [];
  if (addBars.length === 0) missing.push('$ADD');
  if (voldBars.length === 0) missing.push('$VOLD');
  if (missing.length > 0) {
    evidence.push(`Missing symbols: ${missing.join(', ')}`);
  }

  // ------------------------------------------------------------------
  // range_score components
  // ------------------------------------------------------------------

  // tick_mean_reversion_rate: fraction of consecutive TICK bars that
  // flip sign (+ to - or vice versa).
  let signFlips = 0;
  for (let i = 1; i < tickBars.length; i++) {
    const prev = tickBars[i - 1]?.close ?? 0;
    const curr = tickBars[i]?.close ?? 0;
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) {
      signFlips++;
    }
  }
  const tickMeanReversionRate = signFlips / (tickBars.length - 1);
  evidence.push(
    `TICK oscillating, mean-reversion rate ${tickMeanReversionRate.toFixed(2)}`,
  );

  // add_flatness: 1 - |add_last - add_first| / max(|add_values|).
  // Falls back to 0.5 (agnostic) when ADD bars are absent.
  let addFlatness = 0.5;
  if (addBars.length >= 2) {
    const addFirst = addBars[0]?.close ?? 0;
    const addLast = addBars.at(-1)?.close ?? 0;
    const addMax = Math.max(...addBars.map((b) => Math.abs(b.close)), 1);
    addFlatness = 1 - Math.abs(addLast - addFirst) / addMax;
    addFlatness = Math.max(0, Math.min(1, addFlatness));
    evidence.push(`ADD flatness ${addFlatness.toFixed(2)}`);
  }

  const rangeScore = tickMeanReversionRate * addFlatness;

  // ------------------------------------------------------------------
  // trend_score components
  // ------------------------------------------------------------------

  // pct_time_tick_extreme: fraction of TICK bars where |close| >= 600.
  const extremeThreshold = MARKET_INTERNALS_THRESHOLDS.tick.extreme;
  const extremeCount = tickBars.filter(
    (b) => Math.abs(b.close) >= extremeThreshold,
  ).length;
  const pctTimeTickExtreme = extremeCount / tickBars.length;
  evidence.push(
    `TICK pinned extreme ${(pctTimeTickExtreme * 100).toFixed(0)}% of session`,
  );

  // vold_directional: |vold_last - vold_first| / max(|vold_values|).
  // Falls back to 0.5 (agnostic) when VOLD bars are absent.
  let voldDirectional = 0.5;
  if (voldBars.length >= 2) {
    const voldFirst = voldBars[0]?.close ?? 0;
    const voldLast = voldBars.at(-1)?.close ?? 0;
    const voldMax = Math.max(...voldBars.map((b) => Math.abs(b.close)), 1);
    voldDirectional = Math.abs(voldLast - voldFirst) / voldMax;
    voldDirectional = Math.max(0, Math.min(1, voldDirectional));
    evidence.push(
      `VOLD directional (normalized slope ${voldDirectional.toFixed(2)})`,
    );
  }

  const trendScore = pctTimeTickExtreme * voldDirectional;

  // ------------------------------------------------------------------
  // neutral_score + regime selection
  // ------------------------------------------------------------------
  const neutralScore = Math.max(0, 1 - rangeScore - trendScore);
  const scores = {
    range: rangeScore,
    trend: trendScore,
    neutral: neutralScore,
  };

  const maxScore = Math.max(rangeScore, trendScore, neutralScore);
  const sumScores = rangeScore + trendScore + neutralScore;
  const confidence = sumScores > 0 ? maxScore / sumScores : 0;

  let regime: RegimeType = 'neutral';
  if (maxScore === rangeScore) regime = 'range';
  else if (maxScore === trendScore) regime = 'trend';

  return { regime, confidence, evidence, scores };
}
