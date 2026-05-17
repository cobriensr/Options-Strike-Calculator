/**
 * CohortCountdown — "Nm left" chip ticking every minute, showing time
 * remaining vs. the cohort's P75 minutes-to-peak for an alert. Used by
 * Lottery + SilentBoom rows so the user can scan a list and see which
 * trades are still in their historical hold window and which have
 * blown through it.
 *
 * Color thresholds:
 *   - default: neutral chip ("Nm left")
 *   - ≤15 min remaining: amber ("12m left")
 *   - ≤0 min remaining: red ("expired")
 *
 * Implementation notes:
 *   - Internal `setInterval(60_000)` keeps the chip ticking. One
 *     timer per visible row is acceptable (≤50 visible at a time);
 *     a future optimization could lift the clock to a context provider
 *     if profiling shows churn. For v1 the per-row pattern matches
 *     the existing avgHoldMinutes chip and keeps the component
 *     drop-in.
 *   - `triggerTimeCt` is the ISO timestamp of alert fire. We don't
 *     parse to CT — Date.parse + Date.now() in ms is timezone-agnostic
 *     for elapsed-minute math.
 *   - `p75MinutesToPeak` null (no cohort stat) renders nothing —
 *     a missing cohort is more honest than a default-zero countdown.
 */

import { memo, useEffect, useState } from 'react';

interface CohortCountdownProps {
  /** ISO timestamp when the alert triggered. */
  triggerTimeCt: string;
  /** Historical P75 minutes-to-peak for this (tier, ticker) cohort. */
  p75MinutesToPeak: number | null;
}

const COUNTDOWN_TICK_MS = 60_000;
const COUNTDOWN_WARNING_MIN = 15;

function chipClass(remainingMin: number): string {
  if (remainingMin <= 0) {
    return 'border-red-500/60 bg-red-950/40 text-red-200';
  }
  if (remainingMin <= COUNTDOWN_WARNING_MIN) {
    return 'border-amber-500/60 bg-amber-950/40 text-amber-200';
  }
  return 'border-neutral-700 bg-neutral-900 text-neutral-300';
}

function formatRemaining(remainingMin: number): string {
  if (remainingMin <= 0) return 'expired';
  return `${remainingMin}m left`;
}

function computeRemainingMin(
  triggerTimeCt: string,
  p75MinutesToPeak: number,
  nowMs: number,
): number {
  const triggerMs = Date.parse(triggerTimeCt);
  if (!Number.isFinite(triggerMs)) return p75MinutesToPeak;
  const elapsedMin = Math.floor((nowMs - triggerMs) / 60_000);
  return p75MinutesToPeak - elapsedMin;
}

export const CohortCountdown = memo(function CohortCountdown({
  triggerTimeCt,
  p75MinutesToPeak,
}: CohortCountdownProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (p75MinutesToPeak == null) return;
    const id = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [p75MinutesToPeak]);

  if (p75MinutesToPeak == null) return null;

  const remaining = computeRemainingMin(
    triggerTimeCt,
    p75MinutesToPeak,
    nowMs,
  );
  const label = formatRemaining(remaining);
  const cls = chipClass(remaining);
  const tooltip =
    remaining <= 0
      ? `Cohort P75 hold time (${p75MinutesToPeak} min) elapsed — by this point the historical median peak has passed. Consider exiting.`
      : `${remaining} min until cohort P75 hold time (${p75MinutesToPeak} min) is up. Use as a typical exit-window expectation, not a hard rule.`;

  return (
    <span
      data-testid="cohort-countdown"
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold ${cls}`}
      title={tooltip}
      aria-label={tooltip}
    >
      {label}
    </span>
  );
});

/**
 * Pure helper exported for testing. Returns the remaining minutes
 * vs the cohort P75, given the trigger ISO + a wall-clock ms value.
 */
export function computeCountdownRemaining(
  triggerTimeCt: string,
  p75MinutesToPeak: number,
  nowMs: number,
): number {
  return computeRemainingMin(triggerTimeCt, p75MinutesToPeak, nowMs);
}
