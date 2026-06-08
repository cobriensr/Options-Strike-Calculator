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
import baseline from '../../../api/_lib/flow-regime-baseline.json';
import type { FlowRegimeSnapshot } from '../../hooks/useFlowRegime';
import type { FlowRegime, FlowRegimeColor } from '../../types/flow-regime';

// RTH start + slot width come from the committed baseline artifact (single
// source of truth) so the badge's clock labels always match the slots the
// evaluator/cron scored against — no re-hardcoded 9*60+30 / 30.
const RTH_START_MIN = baseline.rth_start_minute;
const SLOT_MINUTES = baseline.bucket_minutes;

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
 * recognition language — never "will" / "expect" / "forecast".
 *
 * The evaluator OWNS the low-confidence floor: whenever the read is suppressed
 * — too few live trades in this slot so far, OR not enough baseline history for
 * this slot — it nulls BOTH percentiles (and forces regime 'normal'/'gray').
 * So a null-percentile state is the single, authoritative "no abnormality read
 * yet" signal, and keying off it here guarantees the detail copy can never
 * contradict the gray NORMAL pill. The neutral copy is worded to be accurate
 * for both suppression reasons (thin live data vs thin baseline history).
 */
export function describeRegime(s: FlowRegimeSnapshot): string {
  const time = slotToEtLabel(s.slot);
  const suppressed = s.ndPercentile == null && s.idxputPercentile == null;

  if (suppressed) {
    // Low-confidence (thin live bucket OR thin baseline) — no percentile claim
    // is honest, so we state the raw metric only.
    const putShare =
      s.idx0dtePutShare != null
        ? `0DTE-index put share ${(s.idx0dtePutShare * 100).toFixed(0)}%`
        : 'flow';
    return `${putShare} at ${time} — not enough data yet to read this slot, so no abnormality call.`;
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
