import type { TrafficSignal } from '../types/index.js';
import { classifyOpeningRange } from './classifiers.js';

/**
 * The opening range's grade as the database, the API and the tests spell it:
 * `classifyOpeningRange`'s traffic light, in the legacy labels.
 */
export type OpeningRangeLabel = 'GREEN' | 'MODERATE' | 'RED';

const SIGNAL_LABELS: Record<TrafficSignal, OpeningRangeLabel> = {
  green: 'GREEN',
  yellow: 'MODERATE',
  red: 'RED',
};

/** What an opening range comes to against the day's expected range. */
export interface OpeningRangeReading {
  /**
   * The range as a percent of spot, over the median high-low percent. The
   * unrounded float: 0.4 and 0.65 are `classifyOpeningRange`'s thresholds.
   */
  readonly consumed: number;
  readonly signal: OpeningRangeLabel;
}

/**
 * How much of the day's expected range the opening range has used, and the
 * signal that grades it. One function for the live hook (`useRangeAnalysis`)
 * and for recomputing a stored row from its own range, spot and median, so the
 * formula exists once.
 *
 * `consumed` is `(high - low) / spot * 100 / medianHlPct`. A missing median
 * (null or undefined) is read as 1, as the live code has always done, and a
 * median that is 0 or negative consumes nothing (0), never an infinite or
 * negative reading. A zero-width range consumes 0, and a reversed one (high
 * under low) reads negative and grades GREEN: this is the live code's
 * behaviour, kept as it was.
 *
 * Null when the inputs are not a price: a `high` or `low` that is not above 0
 * (null-ish, 0, negative or NaN), or a `spot` that is 0 or NaN. The live hook
 * never reaches the formula with those, so nothing changes for it. It is how a
 * caller reading a stored row is told there is nothing to grade. It never
 * throws.
 *
 * @param medianHlPct The day's median high-low range, as a percent of spot
 * (the `medianHlPct` of the regime classification, or a row's
 * `median_hl_pct`).
 */
export function openingRangeSignal(
  high: number,
  low: number,
  spot: number,
  medianHlPct: number | null | undefined,
): OpeningRangeReading | null {
  // `> 0` rather than `<= 0`: a NaN is not a price either.
  const isPrice = high > 0 && low > 0 && !!spot;
  if (!isPrice) return null;

  const rangePct = ((high - low) / spot) * 100;
  const median = medianHlPct ?? 1;
  const consumed = median > 0 ? rangePct / median : 0;
  return {
    consumed,
    signal: SIGNAL_LABELS[classifyOpeningRange(consumed).signal],
  };
}
