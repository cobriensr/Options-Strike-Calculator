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

export type FlowRegime = 'normal' | 'caution' | 'bearish' | 'bullish';

export type FlowRegimeColor = 'green' | 'amber' | 'red' | 'gray';

export interface FlowRegimeResult {
  /** net_delta_tilt for the current bucket (−1..+1). */
  ndTilt: number;
  /** idx0dte_put_share for the current bucket (0..1). */
  idx0dtePutShare: number;
  /**
   * Percentile (0..100) of ndTilt vs this slot's historical distribution,
   * or null when the slot lacks sufficient baseline depth.
   */
  ndPercentile: number | null;
  /** Percentile (0..100) of idx0dtePutShare, or null (insufficient baseline). */
  idxputPercentile: number | null;
  regime: FlowRegime;
  color: FlowRegimeColor;
  /**
   * False when this slot has < min_days_per_slot baseline days (regime is
   * forced to 'normal'/'gray' and percentiles are null).
   */
  hasBaseline: boolean;
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

// ── Metric computation from raw rows ─────────────────────────────────────────

function rowPremium(row: FlowTradeRow): number {
  if (row.premium != null) return row.premium;
  if (row.price != null) return row.price * row.size * 100;
  return 0;
}

function isPut(optionType: string): boolean {
  const c = optionType.toLowerCase();
  return c === 'p' || c === 'put';
}

/**
 * Reduce an array of trade rows (already filtered to the WS universe + one
 * 30-min bucket) into the component sums the evaluator needs. Mirrors the SQL
 * in scripts/build-flow-regime-baseline.py.
 */
export function computeFlowMetrics(
  rows: readonly FlowTradeRow[],
  indexSet: readonly string[] = FLOW_REGIME_BASELINE.index_set,
  sideSignMap: Record<string, number> = FLOW_REGIME_BASELINE.side_sign_map,
): FlowMetricSums {
  const indexTickers = new Set(indexSet);
  let ndNum = 0;
  let ndDen = 0;
  let idxPutPremium = 0;
  let totalPremium = 0;

  for (const row of rows) {
    const sign = sideSign(row.side, sideSignMap);
    ndNum += sign * row.delta * row.size;
    ndDen += Math.abs(row.delta) * row.size;

    const premium = rowPremium(row);
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
  baseline?: FlowRegimeBaseline;
}

/**
 * Score the current bucket's flow against its slot's historical distribution.
 *
 * Returns null percentiles + a forced 'normal'/'gray' regime (hasBaseline:
 * false) when the slot is unknown or has fewer than `min_days_per_slot`
 * baseline days — the percentile would be statistically meaningless.
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
  const insufficient =
    slotBaseline == null || slotBaseline.n_days < baseline.min_days_per_slot;

  if (insufficient) {
    return {
      ndTilt,
      idx0dtePutShare,
      ndPercentile: null,
      idxputPercentile: null,
      regime: 'normal',
      color: 'gray',
      hasBaseline: false,
    };
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
  };
}
