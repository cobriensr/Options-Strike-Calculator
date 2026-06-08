/**
 * Flow Regime Recognition — pure evaluator (Phase 1 of flow-regime-badge spec,
 * docs/superpowers/specs/flow-regime-badge-2026-06-06.md).
 *
 * RECOGNITION ONLY — NOT a predictor. Scores the CURRENT intraday options-flow
 * bucket against the SAME time-of-day bucket historically. The 106-day
 * point-in-time backtest showed options flow has no forward edge; this badge
 * surfaces "today's flow is abnormal for this time of day, as it forms" for
 * sizing / not-fighting-the-tape — it does not forecast direction.
 *
 * No I/O. Shared by:
 *   - Phase 2 cron (capture-flow-regime): reads the current 30-min bucket from
 *     ws_option_trades, computes component sums via `computeFlowMetrics`, then
 *     scores them with `evaluateFlowRegime` against the baseline JSON.
 *   - Phase 2 endpoint / Phase 3 frontend: re-scoring stored snapshots.
 *
 * Two detrend-robust ratio metrics per 30-min slot:
 *   net_delta_tilt    = Σ(side_sign · delta · size) / Σ(|delta| · size)
 *   idx0dte_put_share = Σ(premium | 0DTE index put) / Σ(premium)
 *
 * Consistency rule (critical): the metric defs here MUST match
 * scripts/build-flow-regime-baseline.py — identical universe, side_sign map,
 * and premium = price·size·100 — or the percentiles are meaningless.
 */

import baselineJson from './flow-regime-baseline.json' with { type: 'json' };
import type {
  FlowRegime,
  FlowRegimeColor,
} from '../../src/types/flow-regime.js';

// Re-export the shared union types so existing `from './flow-regime.js'`
// importers (cron, store, tests) keep working — the single source of truth is
// src/types/flow-regime.ts (imported type-only by both api/ and src/).
export type { FlowRegime, FlowRegimeColor };

// ── Baseline artifact types ──────────────────────────────────────────────────

export interface FlowRegimeSlotBaseline {
  slot: number;
  n_days: number;
  /** Percentile breakpoints (one per `percentiles` entry), ascending. */
  nd_tilt_breakpoints: number[];
  idx0dte_put_share_breakpoints: number[];
}

export interface FlowRegimeBaseline {
  schema_version: number;
  generated_from: string;
  universe: string[];
  index_set: string[];
  bucket_minutes: number;
  rth_start_minute: number;
  rth_end_minute: number;
  slot_count: number;
  min_days_per_slot: number;
  side_sign_map: Record<string, number>;
  percentiles: number[];
  slots: FlowRegimeSlotBaseline[];
}

/** The committed baseline artifact, ready for the cron/endpoint to import. */
export const FLOW_REGIME_BASELINE = baselineJson as FlowRegimeBaseline;

// ── Public result types ──────────────────────────────────────────────────────

/**
 * Confidence discriminator for a scored bucket:
 *   - `ok`   — enough live trades AND enough baseline depth: percentiles are
 *              real and the regime/color carry meaning.
 *   - `low`  — suppressed to 'normal'/'gray' with null percentiles. Two
 *              mutually-exclusive reasons (see `confidenceReason`):
 *                'thin-bucket'    → live bucket has < MIN_BUCKET_TRADES trades
 *                'thin-baseline'  → this slot has < min_days_per_slot history
 */
export type FlowRegimeConfidence = 'ok' | 'low';

export type FlowRegimeConfidenceReason = null | 'thin-bucket' | 'thin-baseline';

/**
 * Minimum trades in the (in-progress) bucket before we attach a directional
 * regime/color. Below this the net-delta tilt is dominated by one or two
 * prints — early in a slot a single large bid-side put can push ndTilt ≈ −1
 * and flash a false "bearish/red". The baseline slots aggregate thousands of
 * trades, so a live bucket with < 50 trades is a thin/degraded window: the
 * evaluator suppresses the directional regime to 'normal'/'gray' and nulls the
 * percentiles. The raw ndTilt / idx0dtePutShare are still returned for
 * transparency (the cron persists them). During RTH the ~50-ticker universe
 * (incl. very active SPXW/QQQ) clears this within seconds of a slot opening,
 * so this only suppresses genuinely sparse windows.
 */
export const MIN_BUCKET_TRADES = 50;

export interface FlowRegimeResult {
  /** net_delta_tilt for the current bucket (−1..+1). */
  ndTilt: number;
  /** idx0dte_put_share for the current bucket (0..1). */
  idx0dtePutShare: number;
  /**
   * Percentile (0..100) of ndTilt vs this slot's historical distribution, or
   * null whenever the read is suppressed (confidence 'low' — thin live bucket
   * OR insufficient baseline depth).
   */
  ndPercentile: number | null;
  /** Percentile (0..100) of idxputPercentile, or null when suppressed. */
  idxputPercentile: number | null;
  regime: FlowRegime;
  color: FlowRegimeColor;
  /**
   * False when this slot has < min_days_per_slot baseline days (regime is
   * forced to 'normal'/'gray' and percentiles are null). Note: a bucket can
   * have a baseline (`hasBaseline: true`) but still be suppressed because the
   * LIVE bucket is too thin — check `confidence` for the combined verdict.
   */
  hasBaseline: boolean;
  /**
   * Combined confidence verdict. 'low' whenever the regime was suppressed to
   * 'normal'/'gray' with null percentiles — either because the live bucket is
   * too thin (< MIN_BUCKET_TRADES) or the slot lacks baseline depth.
   */
  confidence: FlowRegimeConfidence;
  /** Why confidence is 'low' (null when confidence is 'ok'). */
  confidenceReason: FlowRegimeConfidenceReason;
}

// ── Metric component sums (the cron computes these from raw rows) ─────────────

export interface FlowMetricSums {
  /** Σ(side_sign · delta · size). */
  ndNum: number;
  /** Σ(|delta| · size). */
  ndDen: number;
  /** Σ(premium | 0DTE index put). */
  idxPutPremium: number;
  /** Σ(premium) — all trades in the bucket. */
  totalPremium: number;
}

/**
 * One option-trade row, shaped to match BOTH ws_option_trades (live) and the
 * Desktop full-tape (baseline) so the cron and the offline builder agree.
 *
 * - `optionType`: 'C'/'P' (ws) or 'call'/'put' (tape) — both accepted.
 * - `side`: ws_option_trades.side ('ask'/'bid'/'mid'/'no_side'); for the tape,
 *   derive it from the `tags` string before calling ('ask_side'→'ask', etc.).
 * - `premium`: pass the tape's `premium` column directly, OR omit it and pass
 *   `price` so this module computes price·size·100 (the ws path).
 * - `expiry` / `tradeDateEt`: both ET calendar dates ('YYYY-MM-DD') so 0DTE is
 *   `expiry === tradeDateEt`.
 */
export interface FlowTradeRow {
  ticker: string;
  optionType: string;
  expiry: string;
  /** ET trade date for this row ('YYYY-MM-DD'), used for the 0DTE test. */
  tradeDateEt: string;
  side: string;
  delta: number;
  size: number;
  price?: number;
  premium?: number;
}

// ── side_sign mapping ────────────────────────────────────────────────────────

/**
 * Map a ws_option_trades.side string to {+1, −1, 0}. Unknown values map to 0
 * (treated as no aggressor). The tape's 'ask_side'/'bid_side' tags should be
 * pre-mapped to 'ask'/'bid' by the caller.
 */
export function sideSign(
  side: string,
  map: Record<string, number> = FLOW_REGIME_BASELINE.side_sign_map,
): number {
  return map[side] ?? 0;
}

// ── Slot derivation ──────────────────────────────────────────────────────────

/**
 * 30-min slot index from an ET minute-of-day, or null when outside RTH.
 * slot = (etMinuteOfDay − rth_start) / bucket; RTH = [09:30, 16:00) ET.
 */
export function slotForEtMinute(
  etMinuteOfDay: number,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): number | null {
  if (
    etMinuteOfDay < baseline.rth_start_minute ||
    etMinuteOfDay >= baseline.rth_end_minute
  ) {
    return null;
  }
  return Math.floor(
    (etMinuteOfDay - baseline.rth_start_minute) / baseline.bucket_minutes,
  );
}

/**
 * Inverse of `slotForEtMinute`: the ET minute-of-day at which `slot` begins.
 * slotStart = rth_start + slot * bucket. Deduped here so callers don't re-derive
 * the slot↔minute inverse inline (the two must stay consistent).
 */
export function slotStartEtMinute(
  slot: number,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): number {
  return baseline.rth_start_minute + slot * baseline.bucket_minutes;
}

// ── Metric computation from raw rows ─────────────────────────────────────────

/**
 * Resolve a row's premium, or null when price/premium is missing or non-finite.
 * A non-finite value (NaN/Infinity from a malformed row) must be EXCLUDED from
 * the put-share ratio — including it would POISON the sums (NaN propagates),
 * not merely dilute them. This is a defensive guard: on the live cron path
 * price is already coerced to a finite number via parsedOrFallback, so a
 * genuinely-missing price arrives as a finite 0 (harmless — contributes 0 to
 * both numerator and denominator); the null path fires for direct/future
 * callers that pass a nullable/NaN price. The row may still contribute to
 * net_delta_tilt if its delta/size are valid.
 */
function rowPremium(row: FlowTradeRow): number | null {
  if (row.premium != null && Number.isFinite(row.premium)) return row.premium;
  if (row.price != null && Number.isFinite(row.price)) {
    const prem = row.price * row.size * 100;
    return Number.isFinite(prem) ? prem : null;
  }
  return null;
}

function isPut(optionType: string): boolean {
  const c = optionType.toLowerCase();
  return c === 'p' || c === 'put';
}

/**
 * Reduce an array of trade rows (one 30-min bucket) into the component sums the
 * evaluator needs. Mirrors the SQL in scripts/build-flow-regime-baseline.py.
 *
 * ALL sums are restricted to the baseline `universe` (default: the committed
 * artifact's universe). This keeps the live metrics scored on the SAME
 * population the baseline was built on even if ws_option_trades' subscription
 * widens beyond the baseline universe — otherwise the percentiles would be
 * meaningless (consistency rule). Rows outside the universe are skipped
 * entirely (neither numerator nor denominator).
 */
export function computeFlowMetrics(
  rows: readonly FlowTradeRow[],
  indexSet: readonly string[] = FLOW_REGIME_BASELINE.index_set,
  sideSignMap: Record<string, number> = FLOW_REGIME_BASELINE.side_sign_map,
  universe: readonly string[] = FLOW_REGIME_BASELINE.universe,
): FlowMetricSums {
  const universeTickers = new Set(universe);
  const indexTickers = new Set(indexSet);
  let ndNum = 0;
  let ndDen = 0;
  let idxPutPremium = 0;
  let totalPremium = 0;

  for (const row of rows) {
    if (!universeTickers.has(row.ticker)) continue;

    const sign = sideSign(row.side, sideSignMap);
    ndNum += sign * row.delta * row.size;
    ndDen += Math.abs(row.delta) * row.size;

    // A row with no resolvable/finite premium is excluded from the put-share
    // ratio entirely (it never reaches the denominator). It already
    // contributed to net_delta_tilt above when its delta/size are valid.
    const premium = rowPremium(row);
    if (premium === null) continue;
    totalPremium += premium;

    if (
      indexTickers.has(row.ticker) &&
      isPut(row.optionType) &&
      row.expiry === row.tradeDateEt
    ) {
      idxPutPremium += premium;
    }
  }

  return { ndNum, ndDen, idxPutPremium, totalPremium };
}

function ratio(num: number, den: number): number {
  return den !== 0 ? num / den : 0;
}

// ── Percentile interpolation ─────────────────────────────────────────────────

/**
 * Percentile (0..100) of `value` against ascending `breakpoints` measured at
 * `percentiles` (e.g. [1,5,...,99]). Linear interpolation between the bracketing
 * breakpoints; clamps to [pmin, pmax] outside the known range. Matches the
 * numpy-'linear' breakpoint math the builder uses.
 */
export function percentileOf(
  value: number,
  breakpoints: readonly number[],
  percentiles: readonly number[],
): number {
  const n = breakpoints.length;
  if (n === 0 || n !== percentiles.length) return 50;
  const first = breakpoints[0] as number;
  const last = breakpoints[n - 1] as number;
  const pFirst = percentiles[0] as number;
  const pLast = percentiles[n - 1] as number;
  // Below the smallest / above the largest known breakpoint → clamp.
  if (value <= first) return pFirst;
  if (value >= last) return pLast;
  for (let i = 1; i < n; i++) {
    const hi = breakpoints[i] as number;
    if (value <= hi) {
      const lo = breakpoints[i - 1] as number;
      const pLo = percentiles[i - 1] as number;
      const pHi = percentiles[i] as number;
      const span = hi - lo;
      const frac = span === 0 ? 0 : (value - lo) / span;
      return pLo + frac * (pHi - pLo);
    }
  }
  return pLast;
}

// ── Regime classification ────────────────────────────────────────────────────

/**
 * Classify a (nd_percentile, idxput_percentile) pair into a regime + color.
 *
 * Thresholds (spec — recognition, tunable):
 *   - bearish (red):  nd ≤10  OR  idxput ≥90
 *   - bullish (green): nd ≥90  AND idxput ≤10   (both must confirm)
 *   - caution (amber): nd ≤25  OR  idxput ≥75
 *   - normal (gray):   otherwise
 *
 * bearish is checked first (asymmetric: a single extreme triggers it), then
 * bullish (requires both metrics to confirm, since put-share alone can't be
 * "bullish"), then caution, then normal.
 */
export function classifyRegime(
  ndPercentile: number,
  idxputPercentile: number,
): { regime: FlowRegime; color: FlowRegimeColor } {
  if (ndPercentile <= 10 || idxputPercentile >= 90) {
    return { regime: 'bearish', color: 'red' };
  }
  if (ndPercentile >= 90 && idxputPercentile <= 10) {
    return { regime: 'bullish', color: 'green' };
  }
  if (ndPercentile <= 25 || idxputPercentile >= 75) {
    return { regime: 'caution', color: 'amber' };
  }
  return { regime: 'normal', color: 'gray' };
}

// ── Main evaluator ───────────────────────────────────────────────────────────

export interface EvaluateFlowRegimeArgs {
  /**
   * Component sums for the current bucket (from `computeFlowMetrics`), OR the
   * already-computed ratio metrics. Provide `sums` for the live path; `ndTilt`
   * + `idx0dtePutShare` are accepted for re-scoring stored snapshots.
   */
  sums?: FlowMetricSums;
  ndTilt?: number;
  idx0dtePutShare?: number;
  /** Active 30-min slot index (0..slot_count−1). */
  slot: number;
  /**
   * Number of trades in the live bucket. When provided AND below
   * MIN_BUCKET_TRADES the result is suppressed to low-confidence
   * 'normal'/'gray' with null percentiles. Omit it (e.g. when re-scoring a
   * stored snapshot) to skip the thin-bucket gate.
   */
  nTrades?: number;
  baseline?: FlowRegimeBaseline;
}

/** The suppressed (low-confidence) result shape — single source of truth. */
function suppressedResult(
  ndTilt: number,
  idx0dtePutShare: number,
  hasBaseline: boolean,
  reason: Exclude<FlowRegimeConfidenceReason, null>,
): FlowRegimeResult {
  return {
    ndTilt,
    idx0dtePutShare,
    ndPercentile: null,
    idxputPercentile: null,
    regime: 'normal',
    color: 'gray',
    hasBaseline,
    confidence: 'low',
    confidenceReason: reason,
  };
}

/**
 * Score the current bucket's flow against its slot's historical distribution.
 *
 * The evaluator OWNS the low-confidence floor so the regime/color can never
 * disagree with the percentiles. It returns a suppressed result
 * (regime 'normal'/color 'gray', null percentiles, confidence 'low') when:
 *   - the live bucket is too thin (`nTrades` < MIN_BUCKET_TRADES) — a couple
 *     of prints can flash a false extreme; reason 'thin-bucket'; or
 *   - the slot is unknown or has fewer than `min_days_per_slot` baseline days
 *     — the percentile would be statistically meaningless; reason
 *     'thin-baseline'.
 *
 * The raw ndTilt / idx0dtePutShare are always returned for transparency.
 */
export function evaluateFlowRegime(
  args: EvaluateFlowRegimeArgs,
): FlowRegimeResult {
  const baseline = args.baseline ?? FLOW_REGIME_BASELINE;

  const ndTilt =
    args.ndTilt ?? (args.sums ? ratio(args.sums.ndNum, args.sums.ndDen) : 0);
  const idx0dtePutShare =
    args.idx0dtePutShare ??
    (args.sums ? ratio(args.sums.idxPutPremium, args.sums.totalPremium) : 0);

  const slotBaseline = baseline.slots.find((s) => s.slot === args.slot);
  const hasBaseline =
    slotBaseline != null && slotBaseline.n_days >= baseline.min_days_per_slot;

  // Thin live bucket — suppress before scoring (even when the baseline is
  // healthy). A single large print could otherwise classify bearish/red.
  if (args.nTrades != null && args.nTrades < MIN_BUCKET_TRADES) {
    return suppressedResult(
      ndTilt,
      idx0dtePutShare,
      hasBaseline,
      'thin-bucket',
    );
  }

  // Thin baseline history — percentile is meaningless.
  if (!hasBaseline) {
    return suppressedResult(ndTilt, idx0dtePutShare, false, 'thin-baseline');
  }

  const ndPercentile = percentileOf(
    ndTilt,
    slotBaseline.nd_tilt_breakpoints,
    baseline.percentiles,
  );
  const idxputPercentile = percentileOf(
    idx0dtePutShare,
    slotBaseline.idx0dte_put_share_breakpoints,
    baseline.percentiles,
  );

  const { regime, color } = classifyRegime(ndPercentile, idxputPercentile);

  return {
    ndTilt,
    idx0dtePutShare,
    ndPercentile,
    idxputPercentile,
    regime,
    color,
    hasBaseline: true,
    confidence: 'ok',
    confidenceReason: null,
  };
}
