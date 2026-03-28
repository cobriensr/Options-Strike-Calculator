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
import { classifyOpeningRange } from '../utils/classifiers';
import { getEarlyCloseHourET } from '../data/marketHours';
import type { EventItem } from '../types/api';
import type { HistorySnapshot } from './useHistoryData';

// ============================================================
// TYPES
// ============================================================

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
    if (historySnapshot) {
      result.spxOpen = historySnapshot.runningOHLC?.open ?? null;
      result.spxHigh = historySnapshot.runningOHLC?.high ?? null;
      result.spxLow = historySnapshot.runningOHLC?.low ?? null;
      result.prevClose = historySnapshot.previousClose ?? null;
      if (result.spxOpen && result.prevClose && result.prevClose > 0) {
        result.overnightGap =
          ((result.spxOpen - result.prevClose) / result.prevClose) * 100;
      }
    }

    if (!vix || !spot) return result;

    // ── Opening range ────────────────────────────────────────
    const etMinutes = etHour * 60 + etMinute;
    result.openingRangeAvailable = etMinutes >= 600; // 10:00 AM ET

    const orData = historySnapshot?.openingRange ?? liveOpeningRange;
    if (orData && orData.high > 0 && orData.low > 0) {
      result.openingRangeHigh = orData.high;
      result.openingRangeLow = orData.low;
      const rangePts = orData.high - orData.low;
      const rangePct = (rangePts / spot) * 100;
      const medHL = medianHlPct ?? 1;
      const consumed = medHL > 0 ? rangePct / medHL : 0;
      result.openingRangePctConsumed = consumed;
      const orClassification = classifyOpeningRange(consumed);
      // Map traffic signal to legacy label expected by DB / API / tests
      const signalToLabel: Record<string, string> = {
        green: 'GREEN',
        yellow: 'MODERATE',
        red: 'RED',
      };
      result.openingRangeSignal =
        signalToLabel[orClassification.signal] ?? 'RED';
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
      const iv =
        vix1d ? vix1d / 100 : (vix * DEFAULTS.IV_PREMIUM_FACTOR) / 100;
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
    liveYesterdayHigh,
    liveYesterdayLow,
    livePriorDays,
    liveEvents,
    historySnapshot,
  ]);
}
