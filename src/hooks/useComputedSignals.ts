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
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import { calcBSDelta, calcScaledSkew } from '../utils/calculator';
import {
  findBucket,
  estimateRange,
  getDowMultiplier,
} from '../data/vixRangeStats';
import { getEventsForDate, getEarlyCloseHourET } from '../data/eventCalendar';
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

const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const VIX_TO_SIGMA_MULT = 1.15;

function parseDow(selectedDate?: string): number | null {
  if (selectedDate) {
    const parts = selectedDate.split('-');
    if (parts.length === 3) {
      const d = new Date(
        Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
      );
      const jsDay = d.getUTCDay();
      if (jsDay >= 1 && jsDay <= 5) return jsDay - 1; // 0=Mon..4=Fri
      return null;
    }
  }
  const now = new Date();
  const etStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  });
  const dayMap: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
  };
  return dayMap[etStr] ?? null;
}

function classifyOpeningRange(pctOfMedian: number): string {
  if (pctOfMedian < 0.4) return 'GREEN';
  if (pctOfMedian < 0.65) return 'MODERATE';
  return 'RED';
}

function classifyTermStructure(
  vix1d: number | undefined,
  vix9d: number | undefined,
  vvix: number | undefined,
  vix: number,
): string | null {
  const signals: string[] = [];

  if (vix1d && vix > 0) {
    const ratio = vix1d / vix;
    if (ratio < 0.75) signals.push('calm');
    else if (ratio < 1.0) signals.push('normal');
    else if (ratio < 1.25) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vix9d && vix > 0) {
    const ratio = vix9d / vix;
    if (ratio > 1.1) signals.push('calm');
    else if (ratio > 0.95) signals.push('normal');
    else if (ratio > 0.85) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vvix) {
    if (vvix < 85) signals.push('calm');
    else if (vvix < 100) signals.push('normal');
    else if (vvix < 120) signals.push('elevated');
    else signals.push('extreme');
  }

  if (signals.length === 0) return null;

  const order = ['calm', 'normal', 'elevated', 'extreme'];
  return signals.reduce(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    'calm',
  );
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

  // History (null when viewing today)
  historySnapshot: HistorySnapshot | null;
}

export function useComputedSignals(inputs: HookInputs): ComputedSignals {
  return useMemo(() => {
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
      historySnapshot,
    } = inputs;

    // ── ET time (computed once) ──────────────────────────────
    const h24raw =
      Number.parseInt(timeHour) +
      (timeAmPm === 'PM' && timeHour !== '12' ? 12 : 0) -
      (timeAmPm === 'AM' && timeHour === '12' ? 12 : 0);
    const etHour = timezone === 'CT' ? h24raw + 1 : h24raw;
    const etMinute = Number.parseInt(timeMinute) || 0;

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

    // ── Initialize result ────────────────────────────────────
    const result: ComputedSignals = {
      vix1d,
      vix9d,
      vvix,
      sigmaSource,
      etHour,
      etMinute,
      regimeZone: null,
      dowLabel: null,
      dowMultHL: null,
      dowMultOC: null,
      icCeiling: null,
      putSpreadCeiling: null,
      callSpreadCeiling: null,
      moderateDelta: null,
      conservativeDelta: null,
      medianOcPct: null,
      medianHlPct: null,
      p90OcPct: null,
      p90HlPct: null,
      p90OcPts: null,
      p90HlPts: null,
      openingRangeAvailable: false,
      openingRangeHigh: null,
      openingRangeLow: null,
      openingRangePctConsumed: null,
      openingRangeSignal: null,
      vixTermSignal: null,
      spxOpen: null,
      spxHigh: null,
      spxLow: null,
      prevClose: null,
      overnightGap: null,
      isEarlyClose: false,
      isEventDay: false,
      eventNames: [],
      dataNote: undefined,
    };

    // ── Events ───────────────────────────────────────────────
    if (selectedDate) {
      const events = getEventsForDate(selectedDate);
      result.isEventDay = events.length > 0;
      result.eventNames = events.map((e) => e.event);
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

    if (!vix || !spot || !T) {
      // Build data note even without full data
      result.dataNote = buildDataNote(
        vix1d,
        vix,
        result.openingRangeAvailable,
        !!historySnapshot,
      );
      return result;
    }

    // ── Regime zone ──────────────────────────────────────────
    const bucket = findBucket(vix);
    if (bucket) result.regimeZone = bucket.zone;

    // ── Day of week ──────────────────────────────────────────
    const dow = parseDow(selectedDate);
    if (dow != null) {
      result.dowLabel = DOW_NAMES[dow] ?? null;
      const dowMult = getDowMultiplier(vix, dow);
      if (dowMult) {
        result.dowMultHL = dowMult.multHL;
        result.dowMultOC = dowMult.multOC;
      }
    }

    // ── Range thresholds ─────────────────────────────────────
    const range = estimateRange(vix);
    const cMult = clusterMult > 0 ? clusterMult : 1;
    const dowMult = dow == null ? null : getDowMultiplier(vix, dow);
    const hlAdj = (dowMult?.multHL ?? 1) * cMult;
    const ocAdj = (dowMult?.multOC ?? 1) * cMult;

    result.medianOcPct = range.medOC * ocAdj;
    result.medianHlPct = range.medHL * hlAdj;
    result.p90OcPct = range.p90OC * ocAdj;
    result.p90HlPct = range.p90HL * hlAdj;
    result.p90OcPts = Math.round((result.p90OcPct / 100) * spot);
    result.p90HlPts = Math.round((result.p90HlPct / 100) * spot);

    // ── Delta guide ceilings ─────────────────────────────────
    // Uses VIX × 1.15 for consistency with historical calibration
    const sigma = (vix * VIX_TO_SIGMA_MULT) / 100;
    const skew = skewPct / 100;
    const sqrtT = Math.sqrt(T);

    // 90th O→C: IC ceiling (settlement survival)
    const p90OcDist = result.p90OcPct / 100;
    if (p90OcDist > 0) {
      const putStrike = spot * (1 - p90OcDist);
      const callStrike = spot * (1 + p90OcDist);
      const approxZ = p90OcDist / (sigma * sqrtT);
      const sk = calcScaledSkew(skew, Math.min(approxZ, 3));
      const putDelta =
        calcBSDelta(spot, putStrike, sigma * (1 + sk), T, 'put') * 100;
      const callDelta =
        calcBSDelta(spot, callStrike, sigma * (1 - sk), T, 'call') * 100;
      result.icCeiling = Math.floor(Math.min(putDelta, callDelta));
      result.putSpreadCeiling = Math.floor(putDelta);
      result.callSpreadCeiling = Math.floor(callDelta);
      result.conservativeDelta = Math.max(
        1,
        Math.floor(result.icCeiling * 0.6),
      );
    }

    // 90th H-L: moderate (intraday) delta
    const p90HlDist = result.p90HlPct / 100;
    if (p90HlDist > 0) {
      const putStrike = spot * (1 - p90HlDist);
      const callStrike = spot * (1 + p90HlDist);
      const approxZ = p90HlDist / (sigma * sqrtT);
      const sk = calcScaledSkew(skew, Math.min(approxZ, 3));
      const putDelta =
        calcBSDelta(spot, putStrike, sigma * (1 + sk), T, 'put') * 100;
      const callDelta =
        calcBSDelta(spot, callStrike, sigma * (1 - sk), T, 'call') * 100;
      result.moderateDelta = Math.floor(Math.min(putDelta, callDelta));
    }

    // ── Opening range ────────────────────────────────────────
    const etMinutes = etHour * 60 + etMinute;
    result.openingRangeAvailable = etMinutes >= 600; // 10:00 AM ET

    const orData = historySnapshot?.openingRange ?? liveOpeningRange;
    if (orData && orData.high > 0 && orData.low > 0) {
      result.openingRangeHigh = orData.high;
      result.openingRangeLow = orData.low;
      const rangePts = orData.high - orData.low;
      const rangePct = (rangePts / spot) * 100;
      const medHL = result.medianHlPct ?? 1;
      const consumed = medHL > 0 ? rangePct / medHL : 0;
      result.openingRangePctConsumed = consumed;
      result.openingRangeSignal = classifyOpeningRange(consumed);
    }

    // ── VIX term structure ───────────────────────────────────
    result.vixTermSignal = classifyTermStructure(vix1d, vix9d, vvix, vix);

    // ── Data note ────────────────────────────────────────────
    result.dataNote = buildDataNote(
      vix1d,
      vix,
      result.openingRangeAvailable,
      !!historySnapshot,
    );

    return result;
  }, [inputs]);
}

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
