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
 * The Range Kill -3 score penalty (range_pos < 0.10) shipped on
 * 2026-05-16 was retired on the same day after the EDA rerun
 * (`ml/findings/eda-rerun-2026-05-16/`) showed the bottom-10%
 * cohort has lift50 = 0.97× — essentially baseline, not the 0.07×
 * the original EDA reported. The original finding was driven by a
 * dimensional bug in `ml/src/cross_section_eda.py` that divided
 * stock spots by SPX session range; only ~126 dimensional-accident
 * rows survived. The corrected 604K-row column shows no edge at
 * either tail of the equity-ticker session range, so we no longer
 * penalize on it.
 *
 * `rangePosAtTrigger` is still passed in for forward compatibility
 * (the cron writes it on every new fire) but it has no effect on
 * the score. The display-only "NEW HIGH" badge on saturated-1.0
 * fires still uses the column.
 */

/**
 * Apply empirical EDA-derived bonuses on top of the ML-trained base
 * score. Returns the adjusted integer score.
 *
 * Bonus inputs are nullable — when a feature isn't available for a
 * fire (e.g., trigger_vol_to_oi_window is null on a legacy row), the
 * bonus is simply not applied. This keeps historical rows scoring
 * with their original weights when re-read by the feed endpoint.
 */
export function applyEmpiricalBonuses(args: {
  baseScore: number;
  triggerVolToOiWindow: number | null;
}): number {
  const { baseScore, triggerVolToOiWindow } = args;
  let score = baseScore;
  if (
    triggerVolToOiWindow != null &&
    triggerVolToOiWindow >= VOL_TO_OI_WINDOW_BONUS_THRESHOLD
  ) {
    score += VOL_TO_OI_WINDOW_BONUS_POINTS;
  }
  return score;
}
