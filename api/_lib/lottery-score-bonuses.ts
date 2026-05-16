/**
 * Empirical score bonuses for lottery fires — separate from the
 * ML-trained `lottery-score-weights.ts` so the refit pipeline doesn't
 * wipe these hand-derived adjustments.
 *
 * Each bonus is a small additive component derived from the
 * `docs/tmp/lottery-silentboom-eda-findings-2026-05-15.md` cross-section
 * EDA: features with statistically powered lift on win50/win100 that
 * the ML weights file does NOT already capture.
 *
 * Applied AFTER `computeLotteryScore()` in `detect-lottery-fires.ts`:
 *
 *   const baseScore = computeLotteryScore({ ... });
 *   const score = applyEmpiricalBonuses({ baseScore, ... });
 *
 * The resulting score can exceed the 0-25 range documented in
 * lottery-score-weights.ts. Tier boundaries (≥18 / ≥12) still apply.
 */

/**
 * +1 when the trigger window's vol/OI is ≥ 0.5. Captures the broad
 * "committed flow" effect: across N=107K rows in this bucket the
 * win50 lift is 1.10× and win100 lift is up to 1.35× (≥5 tail). We
 * stop at +1 rather than +2 because the 2-5 bucket regresses to 0.99×
 * baseline — the signal isn't monotonic — and a +2 would over-credit
 * the tail.
 *
 * Source: cross-section EDA 2026-05-15, "BONUS: vol_to_oi_window" row.
 */
export const VOL_TO_OI_WINDOW_BONUS_THRESHOLD = 0.5;
export const VOL_TO_OI_WINDOW_BONUS_POINTS = 1;

/**
 * -3 when the fire's position in the session range is < 0.10 at
 * trigger time (bottom-10%). The 2026-05-15 EDA found this cohort
 * has a 2.4% win50 rate vs the 35.7% LF baseline (0.07× lift) — a
 * hard kill, not a soft preference. -3 pulls every bottom-10% fire
 * out of the tier-2 floor (12), effectively suppressing them from
 * conviction filters.
 *
 * Source: cross-section EDA 2026-05-15, Finding 1 "Range Kill".
 */
export const RANGE_KILL_THRESHOLD = 0.1;
export const RANGE_KILL_PENALTY_POINTS = 3;

/**
 * Apply empirical EDA-derived bonuses on top of the ML-trained base
 * score. Returns the adjusted integer score.
 *
 * Bonus inputs are nullable — when a feature isn't available for a
 * fire (e.g., trigger_vol_to_oi_window is null on a legacy row, or
 * UW candle fetch failed at insert time), the bonus is simply not
 * applied. This keeps historical rows scoring with their original
 * weights when re-read by the feed endpoint.
 */
export function applyEmpiricalBonuses(args: {
  baseScore: number;
  triggerVolToOiWindow: number | null;
  rangePosAtTrigger?: number | null;
}): number {
  const { baseScore, triggerVolToOiWindow, rangePosAtTrigger } = args;
  let score = baseScore;
  if (
    triggerVolToOiWindow != null &&
    triggerVolToOiWindow >= VOL_TO_OI_WINDOW_BONUS_THRESHOLD
  ) {
    score += VOL_TO_OI_WINDOW_BONUS_POINTS;
  }
  if (rangePosAtTrigger != null && rangePosAtTrigger < RANGE_KILL_THRESHOLD) {
    score -= RANGE_KILL_PENALTY_POINTS;
  }
  return score;
}
