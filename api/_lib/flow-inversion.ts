/**
 * Pure-function port of the flow-inversion exit policy.
 *
 * Mirrors `simulate_flow_inversion` in
 * `ml/experiments/lottery-net-flow-eda/exit_simulation.py` exactly so
 * the post-close enrich cron computes the same `realized_flow_inversion_pct`
 * the EDA wrote to the column on the parquet window.
 *
 * Algorithm:
 *   1. Restrict matched-side flow to (trigger_ts, eod_ct] and require ≥5 rows.
 *   2. Cumsum the flow series. Reject if range ≤ 0 (no peak possible).
 *   3. Find the most-prominent peak with prominence ≥ 5 % × range.
 *   4. From peak onward, compute 5-min slope of cumulative flow.
 *   5. First index where slope < 0 for ≥3 consecutive minutes is the
 *      inversion timestamp. Fallback to EOD if none found / window too short.
 *   6. Exit pct = (mid_at_or_after_inversion − entry_price) / entry_price × 100.
 *
 * Constants are frozen — do not retune in this port.
 */

import { getCtParts } from './flow-alert-derive.js';

export const PEAK_PROMINENCE_RATIO = 0.05;
export const INVERSION_SLOPE_WINDOW_MIN = 5;
export const INVERSION_NEG_PERSIST_MIN = 3;
const EOD_CT_HOUR = 15;
const EOD_CT_MINUTE = 0;

export type FlowInversionStatus =
  | 'inversion'
  | 'eod_no_inversion_window'
  | 'eod_no_inversion_found'
  | 'eod_no_inversion_window_eod_fallback'
  | 'eod_no_inversion_found_eod_fallback'
  | 'inversion_eod_fallback'
  | 'no_post_trigger_prices'
  | 'insufficient_flow_data'
  | 'flat_flow_no_peak'
  | 'no_flow_peak_detected';

export interface MinutePrice {
  ts: Date;
  mid: number;
}

export interface FlowMinute {
  ts: Date;
  /** Matched-side flow value (net_call_prem for C, net_put_prem for P). */
  value: number;
}

export interface FlowInversionResult {
  exitPct: number | null;
  exitTs: Date | null;
  status: FlowInversionStatus;
}

/**
 * 15:00 CT on the trigger's CT calendar day, returned as a UTC Date.
 * DST-aware via Intl TZ lookup (matches `session-windows.ts` pattern).
 */
export function eodCtForTrigger(triggerTs: Date): Date {
  const ctParts = getCtParts(triggerTs.toISOString());
  const [y, m, d] = ctParts.dateStr
    .split('-')
    .map((p) => Number.parseInt(p, 10));
  // 15:00 CT is 20:00 UTC during CDT, 21:00 UTC during CST.
  for (const utcHour of [20, 21]) {
    const cand = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, EOD_CT_MINUTE, 0, 0),
    );
    const parts = getCtParts(cand.toISOString());
    if (
      parts.dateStr === ctParts.dateStr &&
      parts.hour === EOD_CT_HOUR &&
      parts.minute === EOD_CT_MINUTE
    ) {
      return cand;
    }
  }
  // Fallback (unreachable for any real CT trigger): assume CDT.
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 20, EOD_CT_MINUTE, 0, 0));
}

/**
 * Compute prominence-filtered peaks of a 1-D series.
 *
 * Local maximum = strictly greater than both neighbours. Prominence is
 * the bidirectional walk: from the peak, walk left and right until a
 * value ≥ peak (or array boundary) is found, tracking the minimum along
 * each direction; prominence = peak − max(left_min, right_min). This
 * mirrors `scipy.signal.find_peaks(prominence=...)` for the unimodal
 * cumulative-flow signals we evaluate (no plateau handling — cumulative
 * flow with non-zero deltas does not produce flat peaks in practice).
 */
export function findProminentPeaks(
  values: readonly number[],
  minProminence: number,
): { idx: number; prominence: number }[] {
  const out: { idx: number; prominence: number }[] = [];
  const n = values.length;
  for (let i = 1; i < n - 1; i++) {
    const v = values[i]!;
    if (!(v > values[i - 1]! && v > values[i + 1]!)) continue;
    let leftMin = v;
    for (let j = i - 1; j >= 0; j--) {
      if (values[j]! >= v) break;
      if (values[j]! < leftMin) leftMin = values[j]!;
    }
    let rightMin = v;
    for (let k = i + 1; k < n; k++) {
      if (values[k]! >= v) break;
      if (values[k]! < rightMin) rightMin = values[k]!;
    }
    const base = Math.max(leftMin, rightMin);
    const prominence = v - base;
    if (prominence >= minProminence) out.push({ idx: i, prominence });
  }
  return out;
}

function exitAtOrAfter(
  minutes: readonly MinutePrice[],
  targetTs: Date,
  entryPrice: number,
  status: FlowInversionStatus,
): FlowInversionResult {
  const target = targetTs.getTime();
  for (const m of minutes) {
    if (m.ts.getTime() >= target) {
      return {
        exitPct: ((m.mid - entryPrice) / entryPrice) * 100,
        exitTs: m.ts,
        status,
      };
    }
  }
  // Fall back to the last minute if no row at-or-after target.
  const last = minutes.at(-1);
  if (!last) return { exitPct: null, exitTs: null, status };
  return {
    exitPct: ((last.mid - entryPrice) / entryPrice) * 100,
    exitTs: last.ts,
    status: `${status}_eod_fallback` as FlowInversionStatus,
  };
}

/**
 * Simulate the flow-inversion exit for one fire.
 *
 * @param minutes      Per-minute mids of the option contract. Caller may
 *                     pass the entire day; we filter to ts > triggerTs.
 * @param flow         Per-minute matched-side flow (e.g. net_call_prem
 *                     for a call fire). Caller does the side selection.
 * @param entryPrice   Fire entry price (used to express exit as a %).
 * @param triggerTs    Fire trigger timestamp (UTC).
 */
export function simulateFlowInversion(
  minutes: readonly MinutePrice[],
  flow: readonly FlowMinute[],
  entryPrice: number,
  triggerTs: Date,
): FlowInversionResult {
  const triggerMs = triggerTs.getTime();
  const post = minutes.filter((m) => m.ts.getTime() > triggerMs);
  if (post.length === 0) {
    return { exitPct: null, exitTs: null, status: 'no_post_trigger_prices' };
  }

  const eodTs = eodCtForTrigger(triggerTs);
  const eodMs = eodTs.getTime();

  // Restrict matched-side flow to the post-trigger, pre-EOD window.
  const flowPost = flow.filter((f) => {
    const t = f.ts.getTime();
    return t > triggerMs && t <= eodMs;
  });
  if (flowPost.length < 5) {
    return { exitPct: null, exitTs: null, status: 'insufficient_flow_data' };
  }

  // Cumulative sum of matched-side flow.
  const cum: number[] = new Array(flowPost.length);
  let running = 0;
  for (let i = 0; i < flowPost.length; i++) {
    running += flowPost[i]!.value;
    cum[i] = running;
  }
  const max = Math.max(...cum);
  const min = Math.min(...cum);
  const rng = max - min;
  if (rng <= 0) {
    return { exitPct: null, exitTs: null, status: 'flat_flow_no_peak' };
  }

  const peaks = findProminentPeaks(cum, rng * PEAK_PROMINENCE_RATIO);
  if (peaks.length === 0) {
    return { exitPct: null, exitTs: null, status: 'no_flow_peak_detected' };
  }
  // Most-prominent peak (matches scipy `np.argmax(props["prominences"])`).
  let peakIdx = peaks[0]!.idx;
  let peakProm = peaks[0]!.prominence;
  for (let p = 1; p < peaks.length; p++) {
    if (peaks[p]!.prominence > peakProm) {
      peakProm = peaks[p]!.prominence;
      peakIdx = peaks[p]!.idx;
    }
  }

  const flowAfterPeak = flowPost.slice(peakIdx);
  const minRequired = INVERSION_SLOPE_WINDOW_MIN + INVERSION_NEG_PERSIST_MIN;
  if (flowAfterPeak.length < minRequired) {
    return exitAtOrAfter(post, eodTs, entryPrice, 'eod_no_inversion_window');
  }

  // Recompute cumulative flow restricted to post-peak (matches the Python
  // `flow_after_peak[matched_side].cumsum()`). This re-bases the cumsum at
  // 0 at the peak; slope is invariant to the constant offset, so the
  // negative-streak detector is identical either way.
  const cumAfter: number[] = new Array(flowAfterPeak.length);
  running = 0;
  for (let i = 0; i < flowAfterPeak.length; i++) {
    running += flowAfterPeak[i]!.value;
    cumAfter[i] = running;
  }

  let negStreak = 0;
  let inversionIdx: number | null = null;
  for (let i = INVERSION_SLOPE_WINDOW_MIN; i < cumAfter.length; i++) {
    const slope =
      (cumAfter[i]! - cumAfter[i - INVERSION_SLOPE_WINDOW_MIN]!) /
      INVERSION_SLOPE_WINDOW_MIN;
    if (slope < 0) {
      negStreak++;
      if (negStreak >= INVERSION_NEG_PERSIST_MIN) {
        inversionIdx = i;
        break;
      }
    } else {
      negStreak = 0;
    }
  }

  if (inversionIdx == null) {
    return exitAtOrAfter(post, eodTs, entryPrice, 'eod_no_inversion_found');
  }

  const inversionTs = flowAfterPeak[inversionIdx]!.ts;
  return exitAtOrAfter(post, inversionTs, entryPrice, 'inversion');
}
