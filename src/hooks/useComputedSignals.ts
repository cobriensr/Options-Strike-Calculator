/**
 * useComputedSignals — Lifts all derived trading signals to App.tsx.
 *
 * Extracts computation logic that was previously inside child components
 * (DeltaRegimeGuide, OpeningRangeCheck, VIXTermStructure, EventDayWarning)
 * so App.tsx can feed the same values to:
 *   1. Display components (MarketRegimeSection, ChartAnalysis)
 *   2. Snapshot database writer (useSnapshotSave)
 *   3. Analysis context (ChartAnalysis → /api/analyze)
 *
 * Composes three sub-hooks:
 *   - useRegimeClassification (regime zone, DOW, ranges, deltas, clusters)
 *   - useTermStructure (VIX term structure shape & signal)
 *   - useRangeAnalysis (opening range, RV/IV, price context, events)
 *
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import { useRegimeClassification } from './useRegimeClassification';
import { useTermStructure } from './useTermStructure';
import { useRangeAnalysis } from './useRangeAnalysis';
import type { EventItem } from '../types/api';
import type { HistorySnapshot } from './useHistoryData';

// ============================================================
// TYPES
// ============================================================

export interface ComputedSignals {
  // Resolved volatility values (backtest-safe: snapshot first, live fallback)
  vix1d: number | undefined;
  vix9d: number | undefined;
  vvix: number | undefined;
  sigmaSource: string;

  // ET time (computed once, used everywhere)
  etHour: number;
  etMinute: number;

  // Regime
  regimeZone: string | null;

  // Day of week
  dowLabel: string | null;
  dowMultHL: number | null;
  dowMultOC: number | null;

  // Delta guide ceilings
  icCeiling: number | null;
  putSpreadCeiling: number | null;
  callSpreadCeiling: number | null;
  moderateDelta: number | null;
  conservativeDelta: number | null;

  // Range thresholds
  medianOcPct: number | null;
  medianHlPct: number | null;
  p90OcPct: number | null;
  p90HlPct: number | null;
  p90OcPts: number | null;
  p90HlPts: number | null;

  // Opening range
  openingRangeAvailable: boolean;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  openingRangePctConsumed: number | null;
  openingRangeSignal: string | null;

  // VIX term structure
  vixTermSignal: string | null;
  /** Shape of the VIX term structure curve */
  vixTermShape: string | null; // 'contango' | 'fear-spike' | 'flat' | 'backwardation' | 'front-calm'
  /** Actionable advice based on term structure shape */
  vixTermShapeAdvice: string | null;

  // Directional cluster multipliers (asymmetric put/call)
  clusterPutMult: number | null;
  clusterCallMult: number | null;

  // Realized vol vs implied vol
  rvIvRatio: number | null;
  rvIvLabel: string | null; // 'IV Rich' | 'Fair Value' | 'IV Cheap'
  rvAnnualized: number | null; // yesterday's Parkinson RV (annualized decimal)

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

  // Data availability note for Claude
  dataNote: string | undefined;
}

// ============================================================
// HELPERS
// ============================================================

function buildDataNote(
  vix1d: number | undefined,
  vix: number | undefined,
  openingRangeAvailable: boolean,
  isBacktest: boolean,
): string | undefined {
  const notes: string[] = [];
  if (!vix1d && vix)
    notes.push(
      'VIX1D unavailable — σ derived from VIX × 1.15. Actual per-strike IV may differ.',
    );
  if (!openingRangeAvailable)
    notes.push(
      'Entry is before 10:00 AM ET — 30-min opening range not yet complete.',
    );
  if (isBacktest)
    notes.push(
      'Backtesting: data is from historical candles, not live quotes.',
    );
  return notes.length > 0 ? notes.join(' | ') : undefined;
}

// ============================================================
// HOOK
// ============================================================

interface HookInputs {
  // Raw prices & vol
  vix: number | undefined;
  spot: number | undefined;
  T: number | undefined;
  skewPct: number;
  clusterMult: number;
  selectedDate: string | undefined;

  // Time (12-hour format from UI)
  timeHour: string;
  timeMinute: string;
  timeAmPm: string;
  timezone: string;

  // IV mode for sigma source determination
  ivMode: string;
  ivModeVix: string; // constant for VIX mode

  // Live quotes (undefined when not authenticated)
  liveVix1d: number | undefined;
  liveVix9d: number | undefined;
  liveVvix: number | undefined;
  liveOpeningRange: { high: number; low: number } | undefined;

  // Yesterday's SPX OHLC for RV/IV and clustering (live mode)
  liveYesterdayHigh?: number;
  liveYesterdayLow?: number;
  liveYesterdayOpen?: number;
  liveYesterdayClose?: number;

  // Prior 5 trading days (for rolling Parkinson RV)
  livePriorDays?: ReadonlyArray<{ high: number; low: number }>;

  // Live events from /api/events
  liveEvents?: readonly EventItem[];

  // History (null when viewing today)
  historySnapshot: HistorySnapshot | null;
}

export function useComputedSignals(inputs: HookInputs): ComputedSignals {
  const {
    vix,
    spot,
    T,
    skewPct,
    clusterMult,
    selectedDate,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    ivMode,
    ivModeVix,
    liveVix1d,
    liveVix9d,
    liveVvix,
    liveOpeningRange,
    liveYesterdayHigh,
    liveYesterdayLow,
    liveYesterdayOpen,
    liveYesterdayClose,
    livePriorDays,
    liveEvents,
    historySnapshot,
  } = inputs;

  // ── Resolve volatility (backtest vs live) ────────────────
  const vix1d = historySnapshot
    ? (historySnapshot.vix1d ?? undefined)
    : liveVix1d;
  const vix9d = historySnapshot
    ? (historySnapshot.vix9d ?? undefined)
    : liveVix9d;
  const vvix = historySnapshot
    ? (historySnapshot.vvix ?? undefined)
    : liveVvix;

  const sigmaSource = vix1d
    ? 'VIX1D'
    : ivMode === ivModeVix
      ? 'VIX × 1.15'
      : 'manual';

  // ── Sub-hooks ──────────────────────────────────────────────
  const regime = useRegimeClassification({
    vix,
    spot,
    T,
    skewPct,
    clusterMult,
    selectedDate,
    liveYesterdayOpen,
    liveYesterdayClose,
    historySnapshot,
  });

  const termStructure = useTermStructure({ vix, vix1d, vix9d, vvix });

  const rangeAnalysis = useRangeAnalysis({
    vix,
    spot,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    selectedDate,
    vix1d,
    medianHlPct: regime.medianHlPct,
    liveOpeningRange,
    liveYesterdayHigh,
    liveYesterdayLow,
    livePriorDays,
    liveEvents,
    historySnapshot,
  });

  // ── Merge into ComputedSignals ─────────────────────────────
  return useMemo(
    () => ({
      // Resolved volatility
      vix1d,
      vix9d,
      vvix,
      sigmaSource,

      // ET time
      etHour: rangeAnalysis.etHour,
      etMinute: rangeAnalysis.etMinute,

      // Regime classification
      ...regime,

      // Term structure
      ...termStructure,

      // Range analysis (opening range, RV/IV, price context, events)
      openingRangeAvailable: rangeAnalysis.openingRangeAvailable,
      openingRangeHigh: rangeAnalysis.openingRangeHigh,
      openingRangeLow: rangeAnalysis.openingRangeLow,
      openingRangePctConsumed: rangeAnalysis.openingRangePctConsumed,
      openingRangeSignal: rangeAnalysis.openingRangeSignal,
      rvIvRatio: rangeAnalysis.rvIvRatio,
      rvIvLabel: rangeAnalysis.rvIvLabel,
      rvAnnualized: rangeAnalysis.rvAnnualized,
      spxOpen: rangeAnalysis.spxOpen,
      spxHigh: rangeAnalysis.spxHigh,
      spxLow: rangeAnalysis.spxLow,
      prevClose: rangeAnalysis.prevClose,
      overnightGap: rangeAnalysis.overnightGap,
      isEarlyClose: rangeAnalysis.isEarlyClose,
      isEventDay: rangeAnalysis.isEventDay,
      eventNames: rangeAnalysis.eventNames,

      // Data note
      dataNote: buildDataNote(
        vix1d,
        vix,
        rangeAnalysis.openingRangeAvailable,
        !!historySnapshot,
      ),
    }),
    [
      vix1d,
      vix9d,
      vvix,
      sigmaSource,
      vix,
      historySnapshot,
      regime,
      termStructure,
      rangeAnalysis,
    ],
  );
}
