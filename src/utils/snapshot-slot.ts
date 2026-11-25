/**
 * What a `market_snapshots` row labelled with a slot may know about the SPX
 * price, under the as-of rule (server snapshot builder spec, G2: no
 * look-ahead). The backfill, the server builder and the page's backtest view
 * (`useHistoryData`) share this module, and `api/` imports it, so every
 * non-type relative import here needs `.js`.
 */

import {
  CASH_OPEN_MIN_ET,
  OPENING_RANGE_END_MIN_ET,
} from '../data/marketHours.js';
import type { HistoryCandle, HistoryResponse } from '../types/api.js';
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
  if (!allBarsPlaceable(candles)) return null;
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

/** The SPX state a snapshot slot may know, from bars ended by the slot. */
export interface SpxSlotState {
  readonly spot: number;
  readonly runningOHLC: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly last: number;
  };
  /** Null until the first opening-range bar has ended (8:30 CT). */
  readonly openingRange: {
    readonly high: number;
    readonly low: number;
    readonly rangePts: number;
    readonly complete: boolean;
  } | null;
  /** Index in `candles` of the last bar ended by the slot; -1 when none has. */
  readonly entryIndex: number;
}

/**
 * The SPX spot, running range, opening range and entry index at a snapshot
 * slot, from the bars that have ended by it.
 *
 * The as-of rule (server snapshot builder spec, call 1): "A row at slot T
 * uses only bars that end at or before T."
 * - Spot is the close of the bar ending at T, the last bar ended by the slot.
 *   At 8:30 CT no bar has ended, so spot is the first bar's open.
 * - The running high and low cover the bars ended by T. At 8:30 the open,
 *   high, low and last are all the first bar's open. `priceContextAsOf`
 *   supplies open, high and low.
 * - The opening range covers the bars that start before 10:00 ET and have
 *   ended by T: partial before 9:00 CT (10:00 ET), complete from then on.
 *   It is null until the first of them has ended, at 8:35 CT. It is null
 *   rather than a zero-width range because a range with high at or below low
 *   is flagged as an input error by the opening-range card.
 *
 * Null over a guessed value: `null` whenever `priceContextAsOf` is null (a
 * slot that is not finite or is before the open, no candles, a first bar not
 * at 9:30 ET, a bar with an invalid `datetime`, a bad price on a bar that has
 * ended), and when the spot is not a finite price above 0. It never throws:
 * it runs during App render.
 *
 * `candles` is one regular session of 5-minute bars, labelled by their start
 * and sorted ascending, as `/api/history` serves them. A missing bar does not
 * break it: `entryIndex` is the position, in this array, of the last bar that
 * ended by the slot.
 *
 * @param slotMinuteCT Minutes since midnight CT, as `parseEntryTimeMinutes`
 * returns them: 8:30 AM CT is 510. Any minute is accepted, not only the
 * 5-minute marks.
 */
export function spxSlotStateAsOf(
  candles: readonly SlotCandle[],
  slotMinuteCT: number,
): SpxSlotState | null {
  const range = priceContextAsOf(candles, slotMinuteCT);
  if (range == null) return null;

  const slotET = slotMinuteCT + ET_AHEAD_OF_CT_MIN;
  let entryIndex = -1;
  let openingBars = 0;
  let openingHigh = Number.NEGATIVE_INFINITY;
  let openingLow = Number.POSITIVE_INFINITY;
  for (const [index, candle] of candles.entries()) {
    const start = startMinuteET(candle);
    if (start + BAR_MINUTES > slotET) continue;
    entryIndex = index;
    if (start >= OPENING_RANGE_END_MIN_ET) continue;
    openingBars += 1;
    if (candle.high > openingHigh) openingHigh = candle.high;
    if (candle.low < openingLow) openingLow = candle.low;
  }

  const spot = entryIndex >= 0 ? candles[entryIndex]?.close : candles[0]?.open;
  if (spot == null || !isPrice(spot)) return null;

  return {
    spot,
    runningOHLC: {
      open: range.open,
      high: range.high,
      low: range.low,
      last: spot,
    },
    openingRange:
      openingBars === 0
        ? null
        : {
            high: openingHigh,
            low: openingLow,
            rangePts: Math.round((openingHigh - openingLow) * 100) / 100,
            complete: slotET >= OPENING_RANGE_END_MIN_ET,
          },
    entryIndex,
  };
}

/**
 * One symbol's price at a snapshot slot: SPX is not the only series the
 * as-of rule covers, "VIX, VIX1D, VIX9D and VVIX follow the same rule on
 * their own candles."
 *
 * The close of the last bar ended by the slot. When no bar has ended, the
 * open of the last bar that has started (at 8:30 CT, the first bar's open).
 * Otherwise null. A series may be sparse (VIX1D often is), so there is no
 * 9:30 first-bar requirement.
 *
 * Null over a guessed value, never another bar's: `null` when the slot is not
 * finite, there are no candles, any bar's `datetime` is invalid (no telling
 * whether it has ended, at any slot), or the chosen value is not a finite
 * price above 0. Bars the slot has not ended are not looked at, apart from
 * the open of a bar that has started.
 *
 * @param slotMinuteCT Minutes since midnight CT, as `parseEntryTimeMinutes`
 * returns them: 8:30 AM CT is 510.
 */
export function symbolPriceAsOf(
  candles: readonly SlotCandle[],
  slotMinuteCT: number,
): number | null {
  if (!Number.isFinite(slotMinuteCT)) return null;
  if (candles.length === 0 || !allBarsPlaceable(candles)) return null;

  const slotET = slotMinuteCT + ET_AHEAD_OF_CT_MIN;
  let lastEnded = -1;
  let lastStarted = -1;
  for (const [index, candle] of candles.entries()) {
    const start = startMinuteET(candle);
    if (start <= slotET) lastStarted = index;
    if (start + BAR_MINUTES <= slotET) lastEnded = index;
  }

  let price: number | undefined;
  if (lastEnded >= 0) {
    price = candles[lastEnded]?.close;
  } else if (lastStarted >= 0) {
    price = candles[lastStarted]?.open;
  }
  return price != null && isPrice(price) ? price : null;
}

/** What the page's backtest view knows at one slot of one session. */
export interface HistorySnapshot {
  /**
   * SPX price at the slot: the close of the last bar ended by it; the first
   * bar's open at the open.
   */
  spot: number;
  /** SPY-equivalent price (spot / 10) */
  spy: number;
  /** Running SPX OHLC over the bars ended by the slot. */
  runningOHLC: {
    open: number;
    high: number;
    low: number;
    last: number;
  };
  /**
   * The 9:30-10:00 ET bars ended by the slot: null until the first has,
   * partial before 10:00 ET and complete from 10:00 ET.
   */
  openingRange: {
    high: number;
    low: number;
    rangePts: number;
    complete: boolean;
  } | null;
  /** Previous trading day's SPX OHLC for clustering */
  yesterday: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    rangePct: number;
    rangePts: number;
  } | null;
  /** VIX value at the slot, as of it. */
  vix: number | null;
  /** VIX previous close (for RV/IV calculation) */
  vixPrevClose: number | null;
  /** VIX1D value at the slot, as of it. */
  vix1d: number | null;
  /** VIX9D value at the slot, as of it. */
  vix9d: number | null;
  /** VVIX value at the slot, as of it. */
  vvix: number | null;
  /** SPX previous close */
  previousClose: number;
  /**
   * Identifies the as-of position, for React keys. It is the last bar ended by
   * the slot, or the first bar at the open. Its `time` is that bar's start, a
   * bar before the slot (the 10:00 ET slot reads the 9:55 bar), so it is not
   * the entry time: label the entry with the slot's own text. At the open its
   * high, low and close are not yet known, so never read its prices: use
   * `spot`, `runningOHLC` and `openingRange`.
   */
  candle: HistoryCandle;
  /** Index of the last bar ended by the slot; -1 at the open. */
  candleIndex: number;
  /** Total candles for the day */
  totalCandles: number;
}

/**
 * The page's whole backtest snapshot at a slot, from the bars that have ended
 * by it. This is `useHistoryData.getStateAtTime` without React, so the server
 * builder reads the same values the page does.
 *
 * The as-of rule (server snapshot builder spec, call 1): "A row at slot T
 * uses only bars that end at or before T." SPX comes from `spxSlotStateAsOf`
 * (spot, running OHLC, opening range and the entry index), and VIX, VIX1D,
 * VIX9D and VVIX each from `symbolPriceAsOf` on their own candles. Yesterday,
 * the previous close and the VIX previous close pass through (a VIX previous
 * close of 0, which `/api/history` sends for an unknown one, is null).
 *
 * Null over a guessed value: `null` whenever `spxSlotStateAsOf` is null (no
 * SPX candles, a slot that is not finite or is before the open, a first bar
 * not at 9:30 ET, and the other cases it lists). It never throws: it runs
 * during App render.
 *
 * @param slotMinuteCT Minutes since midnight CT, as `parseEntryTimeMinutes`
 * returns them: 8:30 AM CT is 510.
 */
export function historySnapshotAt(
  history: HistoryResponse,
  slotMinuteCT: number,
): HistorySnapshot | null {
  const candles = history.spx.candles;
  const state = spxSlotStateAsOf(candles, slotMinuteCT);
  if (state == null) return null;

  // At the open no bar has ended, and the first one stands in for the position.
  const candle = candles[Math.max(state.entryIndex, 0)];
  if (candle == null) return null;

  return {
    spot: state.spot,
    spy: Math.round((state.spot / 10) * 100) / 100,
    runningOHLC: state.runningOHLC,
    openingRange: state.openingRange,
    yesterday: history.spx.previousDay,
    vix: symbolPriceAsOf(history.vix.candles, slotMinuteCT),
    vixPrevClose: history.vix.previousClose || null,
    vix1d: symbolPriceAsOf(history.vix1d.candles, slotMinuteCT),
    vix9d: symbolPriceAsOf(history.vix9d.candles, slotMinuteCT),
    vvix: symbolPriceAsOf(history.vvix.candles, slotMinuteCT),
    previousClose: history.spx.previousClose,
    candle,
    candleIndex: state.entryIndex,
    totalCandles: candles.length,
  };
}

/**
 * True when every bar's start is a time a Date can hold. A bar with no usable
 * start time can't be placed on the clock, so there is no telling whether it
 * has ended. The ET formatter throws on an invalid Date, which covers NaN,
 * infinities and values past the Date range, so this runs before any bar is
 * placed on the clock.
 */
function allBarsPlaceable(candles: readonly SlotCandle[]): boolean {
  return candles.every((c) => !Number.isNaN(new Date(c.datetime).getTime()));
}

function startMinuteET(candle: SlotCandle): number {
  return getETTotalMinutes(new Date(candle.datetime));
}

/** An index price is a finite number above 0. */
function isPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
