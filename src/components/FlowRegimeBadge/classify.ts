/**
 * FlowRegimeBadge — pure presentation helpers (classifier + copy).
 *
 * Split out from the component so the recognition copy + slot-label math
 * are unit-testable in isolation and the component file only exports a
 * component (react-refresh / fast-refresh friendly). Mirrors the
 * GexLandscape/classify.ts + PreTradeSignals/classifiers.ts convention.
 *
 * RECOGNITION ONLY — every string here is past/present-tense recognition
 * language. NEVER predictive ("will" / "expect" / "forecast"): the
 * 106-day point-in-time backtest found options flow has no forward edge.
 */

import { theme } from '../../themes';
import type {
  FlowRegime,
  FlowRegimeColor,
  FlowRegimeSnapshot,
} from '../../hooks/useFlowRegime';

/** RTH (09:30 ET) start in minutes-of-day; 30-min slots from there. */
const RTH_START_MIN = 9 * 60 + 30;
const SLOT_MINUTES = 30;

/** FlowRegimeColor → theme CSS color. Gray = muted/neutral. */
export const COLOR_MAP: Record<FlowRegimeColor, string> = {
  red: theme.red,
  amber: theme.caution,
  green: theme.green,
  gray: theme.textMuted,
};

/** Human, NON-predictive label per regime. */
export const REGIME_LABEL: Record<FlowRegime, string> = {
  bearish: 'ABNORMAL BEARISH',
  bullish: 'ABNORMAL BULLISH',
  caution: 'LEANING',
  normal: 'NORMAL',
};

/**
 * Static aria/tooltip text that makes the recognition-not-forecast
 * framing unmistakable to screen-reader + hover users alike.
 */
export const RECOGNITION_NOTE =
  'Real-time recognition, not a forecast. This compares today’s options flow to the same time of day historically as it forms — it does not predict direction.';

/** Format a slot index into its ET clock label, e.g. slot 2 → "10:30 ET". */
export function slotToEtLabel(slot: number): string {
  const minutes = RTH_START_MIN + slot * SLOT_MINUTES;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;
}

function ordinal(n: number): string {
  const r = Math.round(n);
  const mod100 = r % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${r}th`;
  switch (r % 10) {
    case 1:
      return `${r}st`;
    case 2:
      return `${r}nd`;
    case 3:
      return `${r}rd`;
    default:
      return `${r}th`;
  }
}

/**
 * Build the human one-liner describing what's recognized RIGHT NOW. Always
 * recognition language — never "will" / "expect" / "forecast". When
 * percentiles are absent (insufficient baseline) we state the raw metric
 * without any percentile claim.
 */
export function describeRegime(s: FlowRegimeSnapshot): string {
  const time = slotToEtLabel(s.slot);
  const hasPctile = s.ndPercentile != null || s.idxputPercentile != null;

  if (!hasPctile) {
    // Insufficient baseline depth — no percentile claim is honest.
    const putShare =
      s.idx0dtePutShare != null
        ? `0DTE-index put share ${(s.idx0dtePutShare * 100).toFixed(0)}%`
        : 'flow';
    return `${putShare} at ${time} — still building a baseline for this slot, so no abnormality read yet.`;
  }

  // Lead with the more-extreme metric (low nd = bearish, high put-share =
  // bearish). Both are recognition reads of how today's slot compares to
  // the same slot historically.
  const ndPct = s.ndPercentile;
  const putPct = s.idxputPercentile;

  if (putPct != null && putPct >= 75) {
    return `0DTE-index put flow at the ${ordinal(putPct)} pct for ${time} — heavier put buying than usual at this point in the day.`;
  }
  if (ndPct != null && ndPct <= 25) {
    return `Net delta tilt at the ${ordinal(ndPct)} pct for ${time} — aggressors leaning net-short delta vs a typical ${time} slot.`;
  }
  if (ndPct != null && ndPct >= 90 && putPct != null && putPct <= 10) {
    return `Net delta tilt at the ${ordinal(ndPct)} pct for ${time} — aggressors leaning net-long delta vs a typical ${time} slot.`;
  }
  return `Flow tracking near its usual range for ${time} — nothing abnormal so far today.`;
}
