/**
 * Strike IV Anomaly Detector — Phase 2 detection module.
 *
 * Pure functions that consume Phase 1's `strike_iv_snapshots` rows
 * (ingested by `api/cron/fetch-strike-iv.ts`) and flag strikes whose
 * IV move meets at least one of:
 *
 *   1. **Cross-strike skew delta** — target strike IV minus the average
 *      IV of its 2 neighbors each side (same ticker / side / expiry,
 *      most recent sample). Removes the common charm/gamma factor so
 *      only idiosyncratic demand remains.
 *
 *   2. **Rolling Z-score** — target strike's iv_mid change vs its own
 *      Z_WINDOW_SIZE-sample history. Filters constant decay drift.
 *
 *   3. **Ask-mid IV divergence** — iv_ask − iv_mid. Tracked on every
 *      anomaly but NOT a standalone gate per spec (spec §Thresholds:
 *      "Tracked separately, not a gate"). It serves as a supporting
 *      signal when the other two fire.
 *
 * The module is side-effect-free: it takes samples + history in, and
 * emits a list of `AnomalyFlag` rows the caller persists into the
 * `iv_anomalies` table. Context capture lives in `anomaly-context.ts`.
 */

import {
  SKEW_DELTA_THRESHOLD,
  Z_SCORE_THRESHOLD,
  ASK_MID_DIV_THRESHOLD,
} from './constants.js';
import type { ContextSnapshot } from './anomaly-context.js';

// ── Public types ──────────────────────────────────────────────

export interface StrikeSample {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  /** ISO date (YYYY-MM-DD). */
  expiry: string;
  iv_mid: number | null;
  iv_bid: number | null;
  iv_ask: number | null;
  /** ISO timestamp (UTC). */
  ts: string;
}

export interface AnomalyFlag {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  spot_at_detect: number;
  iv_at_detect: number;
  /** Target IV − mean(IV of 2 neighbors each side). Null when < 4 neighbors. */
  skew_delta: number | null;
  /** Rolling Z over last Z_WINDOW_SIZE iv_mid samples. Null when < 10 history. */
  z_score: number | null;
  /** iv_ask − iv_mid. Null when bid/ask IV couldn't be inverted. */
  ask_mid_div: number | null;
  /** Non-empty; contains any combination of 'skew_delta', 'z_score'. */
  flag_reasons: string[];
  flow_phase: 'early' | 'mid' | 'reactive';
  /** Detection time (ISO UTC). */
  ts: string;
}

/** Minimum sample count before Z-score is considered reliable. */
const Z_MIN_SAMPLES = 10;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Stable composite key for indexing history maps + neighbor lookups.
 */
export function strikeKey(
  ticker: string,
  strike: number,
  side: 'call' | 'put',
  expiry: string,
): string {
  return `${ticker}:${strike}:${side}:${expiry}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ── Skew delta ───────────────────────────────────────────────

/**
 * Target strike IV minus the average IV of 2 neighbors each side.
 *
 * Neighbors must be the same ticker / side / expiry; the caller is
 * responsible for the filtering. Expects exactly up to 4 neighbors —
 * if fewer than 4 are provided (edge of the OTM band), returns null
 * rather than fabricating a delta from a lopsided window.
 *
 * Convention: the returned value is in percentage points of IV (e.g.
 * iv_mid is 0.42 for 42% vol). Thresholds compare to `SKEW_DELTA_THRESHOLD`
 * expressed in **vol points**, i.e. 0.015 for 1.5 vol pts.
 */
export function computeSkewDelta(
  target: StrikeSample,
  neighbors: StrikeSample[],
): number | null {
  if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) return null;

  const usable = neighbors
    .filter((n) => n.iv_mid != null && isFiniteNumber(n.iv_mid))
    .map((n) => n.iv_mid as number);

  // Require the full 4-neighbor window to avoid edge-of-band false positives.
  if (usable.length < 4) return null;

  const mean = usable.reduce((s, v) => s + v, 0) / usable.length;
  return target.iv_mid - mean;
}

// ── Rolling Z ────────────────────────────────────────────────

/**
 * Target strike's iv_mid Z-score vs its own rolling baseline.
 *
 * `history` is the last N iv_mid samples for this same strike/side/
 * expiry/ticker, ordered DESC by ts (newest first) with the target
 * sample EXCLUDED. We require ≥ `Z_MIN_SAMPLES` usable iv_mid values
 * before emitting a number — low-sample sessions return null and the
 * detector falls back to skew delta alone.
 *
 * Uses population stddev (divide by N, not N-1). For N=60 the
 * difference is negligible and population is what we want when the
 * window IS our "baseline population" (vs treating it as a sample of
 * some larger distribution).
 */
export function computeRollingZ(
  target: StrikeSample,
  history: StrikeSample[],
): number | null {
  if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) return null;

  const series = history
    .map((h) => h.iv_mid)
    .filter((v): v is number => v != null && isFiniteNumber(v));

  if (series.length < Z_MIN_SAMPLES) return null;

  const mean = series.reduce((s, v) => s + v, 0) / series.length;
  const variance =
    series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length;
  const stddev = Math.sqrt(variance);

  // Guard against zero-variance history (all samples identical). Floating-
  // point math leaves a tiny positive stddev in that case, so use an
  // epsilon rather than a strict `> 0` check — a stddev below 1e-6 means
  // the strike has been pinned and the z-score is not informative.
  if (!Number.isFinite(stddev) || stddev < 1e-6) return null;

  return (target.iv_mid - mean) / stddev;
}

// ── Ask-mid divergence ───────────────────────────────────────

function computeAskMidDiv(sample: StrikeSample): number | null {
  if (
    sample.iv_ask == null ||
    sample.iv_mid == null ||
    !isFiniteNumber(sample.iv_ask) ||
    !isFiniteNumber(sample.iv_mid)
  ) {
    return null;
  }
  return sample.iv_ask - sample.iv_mid;
}

// ── detectAnomalies ──────────────────────────────────────────

/**
 * Scan the latest per-strike snapshot and emit a flag for every
 * strike whose skew delta or rolling Z exceeds threshold.
 *
 * Neighbors are picked from `latestSnapshot` by sorting same-side /
 * same-expiry / same-ticker samples by strike, finding the target,
 * then taking up to 2 above + 2 below. No guarantee all 4 exist at
 * the band edges — see `computeSkewDelta` for the null-fallback.
 *
 * `historyByStrike` keys are `ticker:strike:side:expiry` (see
 * `strikeKey()`). Values are history arrays DESC-sorted by ts and
 * MUST NOT include the target sample (the caller's SQL query
 * should WHERE ts < target.ts).
 *
 * The returned flags omit `flow_phase` (populated later by
 * `classifyFlowPhase` once the ContextSnapshot is assembled). A
 * placeholder value is set here so the type stays non-optional;
 * callers overwrite it before INSERT.
 */
export function detectAnomalies(
  latestSnapshot: StrikeSample[],
  historyByStrike: Map<string, StrikeSample[]>,
  spot: number,
): AnomalyFlag[] {
  if (!isFiniteNumber(spot) || spot <= 0) return [];

  // Group latestSnapshot by (ticker, side, expiry) so we can pick
  // neighbors on the same axis in O(n log n).
  const groups = new Map<string, StrikeSample[]>();
  for (const s of latestSnapshot) {
    const key = `${s.ticker}:${s.side}:${s.expiry}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.strike - b.strike);
  }

  const flags: AnomalyFlag[] = [];

  for (const target of latestSnapshot) {
    if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) continue;

    const groupKey = `${target.ticker}:${target.side}:${target.expiry}`;
    const group = groups.get(groupKey) ?? [];
    const idx = group.findIndex(
      (s) => s.strike === target.strike && s.ts === target.ts,
    );
    // If the target isn't in the snapshot (shouldn't happen), skip.
    if (idx < 0) continue;

    const neighbors = [
      ...group.slice(Math.max(0, idx - 2), idx),
      ...group.slice(idx + 1, idx + 3),
    ];

    const skewDelta = computeSkewDelta(target, neighbors);
    const history =
      historyByStrike.get(
        strikeKey(target.ticker, target.strike, target.side, target.expiry),
      ) ?? [];
    const zScore = computeRollingZ(target, history);
    const askMidDiv = computeAskMidDiv(target);

    const reasons: string[] = [];
    if (skewDelta != null && Math.abs(skewDelta) > SKEW_DELTA_THRESHOLD / 100) {
      reasons.push('skew_delta');
    }
    if (zScore != null && Math.abs(zScore) > Z_SCORE_THRESHOLD) {
      reasons.push('z_score');
    }

    if (reasons.length === 0) continue;

    flags.push({
      ticker: target.ticker,
      strike: target.strike,
      side: target.side,
      expiry: target.expiry,
      spot_at_detect: spot,
      iv_at_detect: target.iv_mid,
      skew_delta: skewDelta,
      z_score: zScore,
      ask_mid_div: askMidDiv,
      flag_reasons: reasons,
      // Placeholder — overwritten by classifyFlowPhase once context is ready.
      flow_phase: 'mid',
      ts: target.ts,
    });
  }

  return flags;
}

// ── Flow phase classification ────────────────────────────────

/**
 * Label the anomaly as `early | mid | reactive` for ML slicing.
 *
 * Separates tradeable alpha (`early` — flow arrives before the tape
 * moves) from chase / hedge noise (`reactive` — flow follows price
 * and VIX expansion). Heuristic is intentionally simple — each axis
 * contributes one point; the final label is the category with the
 * highest score, ties broken toward `mid`.
 *
 * Axes:
 *   - **Spot-vs-strike distance**: far OTM = early, near ATM = reactive.
 *     Threshold: < 0.5% of spot = reactive, > 2% = early, else mid.
 *   - **VIX delta (15m)**: quiet = early, spiking = reactive.
 *     Threshold: |Δ| < 0.3 pts = early, |Δ| > 0.8 = reactive, else mid.
 *   - **ASK-skew persistence proxy**: we don't have a time-series for
 *     ask_mid_div here, so we use the current value. Large ask-mid
 *     divergence AT detect = "fresh" (early). We weight this axis
 *     less — 0.5 point — because it's a single-snapshot proxy.
 */
export function classifyFlowPhase(
  anomaly: AnomalyFlag,
  contextSnapshot: ContextSnapshot,
): 'early' | 'mid' | 'reactive' {
  let earlyScore = 0;
  let reactiveScore = 0;

  // Spot-vs-strike distance.
  const distPct = Math.abs(
    (anomaly.strike - anomaly.spot_at_detect) / anomaly.spot_at_detect,
  );
  if (distPct > 0.02) earlyScore += 1;
  else if (distPct < 0.005) reactiveScore += 1;

  // VIX expansion.
  const vixDelta15m = contextSnapshot.vix_delta_15m;
  if (vixDelta15m != null && Number.isFinite(vixDelta15m)) {
    const absVix = Math.abs(vixDelta15m);
    if (absVix < 0.3) earlyScore += 1;
    else if (absVix > 0.8) reactiveScore += 1;
  }

  // Ask-mid divergence as a fresh-flow proxy.
  if (
    anomaly.ask_mid_div != null &&
    anomaly.ask_mid_div > ASK_MID_DIV_THRESHOLD / 100
  ) {
    earlyScore += 0.5;
  }

  if (earlyScore > reactiveScore) return 'early';
  if (reactiveScore > earlyScore) return 'reactive';
  return 'mid';
}
