/**
 * useRangeAnalysis — Opening range classification, realized vol calculation
 * (Parkinson), RV/IV ratio, price context (OHLC, overnight gap), and event
 * detection.
 *
 * Extracted from useComputedSignals for composability.
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import { toETTime } from '../utils/calculator';
import { SIGNALS, DEFAULTS } from '../constants';
import { openingRangeSignal } from '../utils/opening-range-signal';
import { getEarlyCloseHourET } from '../data/marketHours';
import type { EventItem, QuoteSlice } from '../types/api';
import type { HistorySnapshot } from './useHistoryData';

// ============================================================
// TYPES
// ============================================================

/**
 * The live SPX quote's session fields: the day's open, high and low so far,
 * and the prior session's close.
 */
export type LiveSpxContext = Pick<
  QuoteSlice,
  'open' | 'high' | 'low' | 'prevClose'
>;

export interface RangeAnalysisSignals {
  // ET time (computed once, used everywhere)
  etHour: number;
  etMinute: number;

  // Opening range
  openingRangeAvailable: boolean;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  openingRangePctConsumed: number | null;
  openingRangeSignal: string | null;

  // Realized vol vs implied vol
  rvIvRatio: number | null;
  rvIvLabel: string | null;
  rvAnnualized: number | null;

  // Price context
  spxOpen: number | null;
  spxHigh: number | null;
  spxLow: number | null;
  prevClose: number | null;
  overnightGap: number | null;

  // Events
  isEarlyClose: boolean;
  isEventDay: boolean;
  eventNames: string[];
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Parkinson realized volatility estimator (single day, annualized).
 * Uses high-low range which is ~5× more efficient than close-to-close.
 * σ_parkinson = sqrt(1 / (4·ln2)) × |ln(H/L)| × sqrt(252)
 */
function parkinsonRV(high: number, low: number): number {
  if (high <= 0 || low <= 0 || high <= low) return 0;
  const logHL = Math.log(high / low);
  return Math.sqrt(1 / (4 * Math.LN2)) * logHL * Math.sqrt(252);
}

/**
 * A price worth storing: finite and above zero, else null. The live quote may
 * carry 0 or a stale value before SPX's first print (assumed, not captured),
 * and /api/history sends previousClose 0 for a session it can't name. A 0
 * stored as a price would read as a −100% gap, and `prev_close = 0` would
 * overwrite a good stored value on the snapshot upsert. A stale value passes
 * this check; the caller keeps the quote out of the rows outside the session.
 */
function positivePrice(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * N-day rolling Parkinson RV estimator (annualized).
 * Averages the variance (not σ) across days, then takes the square root.
 * This is the correct way to combine Parkinson estimates — averaging σ
 * directly would underweight high-vol days.
 */
function rollingParkinsonRV(
  days: ReadonlyArray<{ high: number; low: number }>,
): number {
  if (days.length === 0) return 0;
  const factor = 1 / (4 * Math.LN2);
  let sumVariance = 0;
  let validDays = 0;
  for (const d of days) {
    if (d.high > 0 && d.low > 0 && d.high > d.low) {
      const logHL = Math.log(d.high / d.low);
      sumVariance += factor * logHL * logHL;
      validDays++;
    }
  }
  if (validDays === 0) return 0;
  return Math.sqrt((sumVariance / validDays) * 252);
}

// ============================================================
// HOOK
// ============================================================

interface RangeAnalysisInputs {
  vix: number | undefined;
  spot: number | undefined;

  // Time (12-hour format from UI)
  timeHour: string;
  timeMinute: string;
  timeAmPm: string;
  timezone: string;

  selectedDate: string | undefined;

  // Resolved VIX1D (after snapshot/live resolution)
  vix1d: number | undefined;

  // Median H-L pct from regime classification (for opening range consumed %)
  medianHlPct: number | null;

  // Live quotes
  liveOpeningRange: { high: number; low: number } | undefined;

  // The live SPX quote's open, high, low and prior close. The caller passes
  // it for today only: a past date's price context is its history's.
  liveSpx?: LiveSpxContext;

  // Yesterday's SPX OHLC for RV/IV (live mode)
  liveYesterdayHigh?: number;
  liveYesterdayLow?: number;

  // Prior 5 trading days (for rolling Parkinson RV)
  livePriorDays?: ReadonlyArray<{ high: number; low: number }>;

  // Live events from /api/events
  liveEvents?: readonly EventItem[];

  // History (null when viewing today)
  historySnapshot: HistorySnapshot | null;
}

export function useRangeAnalysis(
  inputs: RangeAnalysisInputs,
): RangeAnalysisSignals {
  const {
    vix,
    spot,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    selectedDate,
    vix1d,
    medianHlPct,
    liveOpeningRange,
    liveSpx,
    liveYesterdayHigh,
    liveYesterdayLow,
    livePriorDays,
    liveEvents,
    historySnapshot,
  } = inputs;

  return useMemo(() => {
    // ── ET time (computed once) ──────────────────────────────
    const { etHour, etMinute } = toETTime(
      timeHour,
      timeMinute,
      timeAmPm as 'AM' | 'PM',
      timezone as 'ET' | 'CT',
    );

    // ── Initialize result ────────────────────────────────────
    const result: RangeAnalysisSignals = {
      etHour,
      etMinute,
      openingRangeAvailable: false,
      openingRangeHigh: null,
      openingRangeLow: null,
      openingRangePctConsumed: null,
      openingRangeSignal: null,
      rvIvRatio: null,
      rvIvLabel: null,
      rvAnnualized: null,
      spxOpen: null,
      spxHigh: null,
      spxLow: null,
      prevClose: null,
      overnightGap: null,
      isEarlyClose: false,
      isEventDay: false,
      eventNames: [],
    };

    // ── Events ───────────────────────────────────────────────
    if (selectedDate) {
      const eventsForDate =
        liveEvents?.filter((e) => e.date === selectedDate) ?? [];
      result.isEventDay = eventsForDate.length > 0;
      result.eventNames = eventsForDate.map((e) => e.event);
      result.isEarlyClose = getEarlyCloseHourET(selectedDate) != null;
    }

    // ── Price context ────────────────────────────────────────
    // The history snapshot wins; without one, the live SPX quote.
    if (historySnapshot) {
      result.spxOpen = historySnapshot.runningOHLC?.open ?? null;
      result.spxHigh = historySnapshot.runningOHLC?.high ?? null;
      result.spxLow = historySnapshot.runningOHLC?.low ?? null;
      result.prevClose = positivePrice(historySnapshot.previousClose);
    } else if (liveSpx) {
      result.spxOpen = positivePrice(liveSpx.open);
      result.spxHigh = positivePrice(liveSpx.high);
      result.spxLow = positivePrice(liveSpx.low);
      result.prevClose = positivePrice(liveSpx.prevClose);
    }
    if (result.spxOpen && result.prevClose && result.prevClose > 0) {
      result.overnightGap =
        ((result.spxOpen - result.prevClose) / result.prevClose) * 100;
    }

    if (!vix || !spot) return result;

    // ── Opening range ────────────────────────────────────────
    const etMinutes = etHour * 60 + etMinute;
    result.openingRangeAvailable = etMinutes >= 600; // 10:00 AM ET

    // With a history snapshot, its range is the whole answer. It is null at
    // the open, before the first opening-range bar has ended, and falling back
    // to the live range then would grade a past date on today's.
    const orData = historySnapshot
      ? historySnapshot.openingRange
      : liveOpeningRange;
    // The formula and its grade live in openingRangeSignal, which the stale-row
    // repair (scripts/repair-stale-opening-range.ts) calls too. It reads null
    // for a range that is not a price.
    const reading = orData
      ? openingRangeSignal(orData.high, orData.low, spot, medianHlPct)
      : null;
    if (orData && reading) {
      result.openingRangeHigh = orData.high;
      result.openingRangeLow = orData.low;
      result.openingRangePctConsumed = reading.consumed;
      result.openingRangeSignal = reading.signal;
    }

    // ── RV/IV ratio ──────────────────────────────────────────
    // 5-day rolling Parkinson RV (more stable than single-day estimate)
    // Falls back to single-day when prior days data is unavailable
    const ydayHigh = historySnapshot?.yesterday?.high ?? liveYesterdayHigh;
    const ydayLow = historySnapshot?.yesterday?.low ?? liveYesterdayLow;
    if (ydayHigh && ydayLow && ydayHigh > ydayLow) {
      const rv =
        livePriorDays && livePriorDays.length >= 2
          ? rollingParkinsonRV(livePriorDays)
          : parkinsonRV(ydayHigh, ydayLow);
      // IV: prefer VIX1D, fall back to VIX × 1.15
      const iv = vix1d ? vix1d / 100 : (vix * DEFAULTS.IV_PREMIUM_FACTOR) / 100;
      if (iv > 0) {
        result.rvAnnualized = Math.round(rv * 10000) / 10000;
        result.rvIvRatio = Math.round((rv / iv) * 100) / 100;
        if (result.rvIvRatio < SIGNALS.RVIV_RICH_BELOW) {
          result.rvIvLabel = 'IV Rich';
        } else if (result.rvIvRatio > SIGNALS.RVIV_CHEAP_ABOVE) {
          result.rvIvLabel = 'IV Cheap';
        } else {
          result.rvIvLabel = 'Fair Value';
        }
      }
    }

    return result;
  }, [
    vix,
    spot,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    selectedDate,
    vix1d,
    medianHlPct,
    liveOpeningRange,
    liveSpx,
    liveYesterdayHigh,
    liveYesterdayLow,
    livePriorDays,
    liveEvents,
    historySnapshot,
  ]);
}
