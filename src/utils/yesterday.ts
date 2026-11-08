import type { DaySummary } from '../types/api';

/**
 * Yesterday's SPX open/high/low/close for the selected date, resolved once for
 * everything that reads it: the volatility-cluster multiplier, its put/call
 * tilt (useRegimeClassification) and the range analysis. They read one value,
 * so the multiplier and the tilt cannot disagree.
 *
 * The history snapshot's own previous day when the snapshot has one. Without
 * it, the live feed's yesterday only for today: that feed is the day before
 * TODAY, so a past date (history still loading, a slot with no candle, or a
 * history answer whose previousDay is null) gets null, not a borrowed day.
 */
export function resolveYesterday(
  snapshotYesterday: DaySummary | null | undefined,
  liveYesterday: DaySummary | null | undefined,
  selectedDateIsPast: boolean,
): DaySummary | null {
  if (snapshotYesterday) return snapshotYesterday;
  return selectedDateIsPast ? null : (liveYesterday ?? null);
}
