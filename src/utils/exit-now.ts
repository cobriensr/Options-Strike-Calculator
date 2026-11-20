/**
 * exit-now — derived "you should be out" signal that composes the
 * cohort countdown (Phase 6) and Flow Inverted (Phase 5) into a
 * single high-visibility EXIT chip. The user wanted one indicator at
 * the far right of every row so a scan of the list immediately
 * surfaces alerts to close, regardless of which exit rule fired.
 *
 * Reasons:
 *   - 'expired'             — cohort P75 hold time has fully elapsed
 *   - 'inverted'            — ticker net flow has reversed since fire
 *   - 'expired_and_inverted'— both at once (the strongest case)
 *
 * `active === false` when neither rule has fired. The chip is hidden
 * in that case.
 */

export type ExitNowReason = 'expired' | 'inverted' | 'expired_and_inverted';

export type ExitNowResult =
  | { active: true; reason: ExitNowReason }
  | { active: false; reason: null };

const EXIT_REASON_TOOLTIPS: Record<ExitNowReason, string> = {
  expired: 'Cohort P75 hold elapsed — historical median peak has passed.',
  inverted: 'Ticker net flow inverted — strongest documented exit signal.',
  expired_and_inverted: 'Hold expired + flow inverted — both exit rules fired.',
};

/**
 * Hover text for the EXIT chip, and the same words for its hidden
 * screen-reader hint. One table so the Lottery and Silent Boom rows agree.
 */
export function exitReasonTooltip(reason: ExitNowReason): string {
  return EXIT_REASON_TOOLTIPS[reason];
}

interface ComputeExitNowArgs {
  /**
   * Minutes remaining vs the cohort P75. Null when no cohort stat is
   * available (no countdown was rendered). Negative or zero means
   * expired.
   */
  remainingMin: number | null;
  /** True ⇒ flow inverted relative to fire-time state. */
  flowInverted: boolean;
}

export function computeExitNow({
  remainingMin,
  flowInverted,
}: ComputeExitNowArgs): ExitNowResult {
  const expired = remainingMin != null && remainingMin <= 0;
  if (expired && flowInverted) {
    return { active: true, reason: 'expired_and_inverted' };
  }
  if (expired) return { active: true, reason: 'expired' };
  if (flowInverted) return { active: true, reason: 'inverted' };
  return { active: false, reason: null };
}
