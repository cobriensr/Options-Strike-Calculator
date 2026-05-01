/**
 * Pure stat helpers for the TRACE Live calibration panel. Extracted from
 * `TRACELiveCalibrationPanel.tsx` so they're testable in isolation and
 * reusable across any panel that wants the same axis-tick / bias-classifier
 * primitives.
 *
 * No React imports here — these are deterministic numeric utilities.
 */

/**
 * Pick "nice" numeric tick values across [lo, hi]. Step size is rounded
 * to 1/2/5 × 10^k so the labels read cleanly (7100, 7150, 7200) instead
 * of arbitrary fractions. Returns 1+ ticks; the actual count drifts around
 * `target` based on the rounded step.
 *
 * Edge cases:
 *   - lo === hi (or hi < lo): returns `[lo]`.
 *   - target < 2: still returns a sensible single-step ladder.
 */
export function niceTicks(lo: number, hi: number, target: number): number[] {
  const range = hi - lo;
  if (range <= 0) return [lo];
  const rawStep = range / (target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const frac = rawStep / mag;
  let step: number;
  if (frac < 1.5) step = mag;
  else if (frac < 3) step = 2 * mag;
  else if (frac < 7) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/**
 * Median of a numeric array. Returns 0 for an empty input (matches the
 * panel's convention — empty regimes already short-circuit upstream so
 * the sentinel is never user-facing).
 *
 * Does not mutate the input — sorts a copy.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

export type RegimeStatus = 'good' | 'biased' | 'broken' | 'thin';

/**
 * Status thresholds. The cron's MIN_SAMPLES_FOR_CALIBRATION is 5; we use
 * the same gate for "trustworthy" stats. Below that the regime stat is
 * shown but flagged as thin (n < 5).
 *
 *   |median| ≤ 3  → good
 *   |median| ≤ 10 → biased
 *   else          → broken
 */
export function classifyRegime(n: number, med: number): RegimeStatus {
  if (n < 5) return 'thin';
  const abs = Math.abs(med);
  if (abs <= 3) return 'good';
  if (abs <= 10) return 'biased';
  return 'broken';
}
