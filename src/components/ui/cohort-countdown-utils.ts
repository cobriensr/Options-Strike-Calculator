/**
 * Pure helpers for the CohortCountdown chip. Extracted from
 * CohortCountdown.tsx so that file only exports React components —
 * Fast Refresh requires that to preserve component state across edits
 * (react-refresh/only-export-components).
 */

/**
 * Returns minutes remaining vs the cohort's P75 minutes-to-peak.
 * Negative values mean the cohort window has elapsed. Returns the
 * P75 verbatim when the trigger ISO can't be parsed (defensive
 * fallback — never NaN).
 */
export function computeCountdownRemaining(
  triggerTimeCt: string,
  p75MinutesToPeak: number,
  nowMs: number,
): number {
  const triggerMs = Date.parse(triggerTimeCt);
  if (!Number.isFinite(triggerMs)) return p75MinutesToPeak;
  const elapsedMin = Math.floor((nowMs - triggerMs) / 60_000);
  return p75MinutesToPeak - elapsedMin;
}
