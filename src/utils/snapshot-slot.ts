/**
 * What a `market_snapshots` row labelled with a slot may know about the SPX
 * price, under the as-of rule (server snapshot builder spec, G2: no
 * look-ahead). The backfill and the server builder share this module, and
 * `api/` imports it, so every non-type relative import here needs `.js`.
 */

import { CASH_OPEN_MIN_ET } from '../data/marketHours.js';
import { ET_AHEAD_OF_CT_MIN } from './entry-time.js';
import { getETTotalMinutes } from './timezone.js';

/** Length of a history candle, labelled by its start. */
const BAR_MINUTES = 5;

export interface SlotCandle {
  /** Bar start, epoch milliseconds. */
  readonly datetime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * The SPX open, high and low known at a snapshot slot.
 *
 * A bar counts only once it has ended: it starts at ET minute s and ends at
 * s + 5, and counts when s + 5 is at or before the slot's ET minute. At 8:30
 * CT (the 9:30 ET open) the first bar has started but not ended, so open, high
 * and low are all that bar's open.
 *
 * Null over a guessed value, because callers store NULL. It is `null` when:
 * - `slotMinuteCT` is not finite (`parseEntryTimeMinutes` returns NaN for
 *   "pre-market" and other free-form labels);
 * - there are no candles, or the first one does not start at 9:30 ET (a late
 *   or early feed would make another bar's open the day's open);
 * - any candle's `datetime` is not a valid time (NaN, infinite, or past the
 *   range a Date holds): that bar can't be placed on the clock, so there is
 *   no telling whether it has ended, at any slot;
 * - the first open is not a finite price above 0;
 * - the slot is before the 9:30 ET open;
 * - a bar that has ended by the slot has a high or low that is not a finite
 *   price above 0. A bar that has not ended yet is not looked at.
 *
 * `candles` is one regular session of 5-minute bars, labelled by their start
 * and sorted by `datetime` ascending, the way `/api/history` serves them. The
 * function does not sort: the first element is the session open. High and low
 * read every bar, so the order of the bars after the first does not change
 * them.
 *
 * @param slotMinuteCT Minutes since midnight CT, as `parseEntryTimeMinutes`
 * returns them: 8:30 AM CT is 510.
 */
export function priceContextAsOf(
  candles: readonly SlotCandle[],
  slotMinuteCT: number,
): { open: number; high: number; low: number } | null {
  if (!Number.isFinite(slotMinuteCT)) return null;

  const first = candles[0];
  if (first == null) return null;
  // A bar with no usable start time can't be placed on the clock, so there is
  // no telling whether it has ended. The ET formatter throws on an invalid
  // Date, which covers NaN, infinities and values past the Date range.
  if (!candles.every((c) => !Number.isNaN(new Date(c.datetime).getTime()))) {
    return null;
  }
  if (startMinuteET(first) !== CASH_OPEN_MIN_ET) return null;
  if (!isPrice(first.open)) return null;

  const slotET = slotMinuteCT + ET_AHEAD_OF_CT_MIN;
  if (slotET < CASH_OPEN_MIN_ET) return null;

  // The open is a print, so it bounds the range even before a bar has ended.
  let high = first.open;
  let low = first.open;
  for (const candle of candles) {
    if (startMinuteET(candle) + BAR_MINUTES > slotET) continue;
    if (!isPrice(candle.high) || !isPrice(candle.low)) return null;
    if (candle.high > high) high = candle.high;
    if (candle.low < low) low = candle.low;
  }
  return { open: first.open, high, low };
}

function startMinuteET(candle: SlotCandle): number {
  return getETTotalMinutes(new Date(candle.datetime));
}

/** An index price is a finite number above 0. */
function isPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
