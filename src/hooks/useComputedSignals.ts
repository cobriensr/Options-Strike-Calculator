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
import {
  calcBSDelta,
  calcScaledSkew,
  calcScaledCallSkew,
  toETTime,
} from '../utils/calculator';
import { SIGNALS } from '../constants';
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

const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const VIX_TO_SIGMA_MULT = 1.15;

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

/**
 * Classifies the VIX term structure shape from the three-point curve.
 * Returns both the shape name and actionable trading advice.
 *
 * Shapes:
 *   contango:       VIX1D < VIX < VIX9D  → near-term calm, premium selling sweet spot
 *   fear-spike:     VIX1D > VIX > VIX9D  → near-term fear, event-driven, IC dangerous
 *   flat:           all within ±5%       → no edge from term structure
 *   backwardation:  VIX1D > VIX          → near-term stress but longer-term calm
 *   front-calm:     VIX1D < VIX, 9D < VIX → near-term relief, longer-term worry
 */
function classifyTermShape(
  vix1d: number | undefined,
  vix9d: number | undefined,
  vix: number,
): { shape: string; advice: string } | null {
  // Need at least VIX1D to determine shape
  if (!vix1d || vix <= 0) return null;

  const r1d = vix1d / vix;
  const r9d = vix9d ? vix9d / vix : null;
  const lo = 1 - SIGNALS.TERM_SHAPE_THRESHOLD; // 0.97
  const hi = 1 + SIGNALS.TERM_SHAPE_THRESHOLD; // 1.03

  // Check for flat first: all ratios within ±TERM_FLAT_THRESHOLD
  const isFlat1d = Math.abs(r1d - 1) < SIGNALS.TERM_FLAT_THRESHOLD;
  const isFlat9d =
    r9d == null || Math.abs(r9d - 1) < SIGNALS.TERM_FLAT_THRESHOLD;
  if (isFlat1d && isFlat9d) {
    return {
      shape: 'flat',
      advice:
        'Term structure is flat — no directional edge from vol curve. Follow standard delta guide.',
    };
  }

  // With both VIX1D and VIX9D
  if (r9d != null) {
    // Contango: VIX1D < VIX < VIX9D (or VIX1D < VIX and VIX9D > VIX)
    if (r1d < lo && r9d > hi) {
      return {
        shape: 'contango',
        advice:
          'Full contango — near-term calm with longer-term uncertainty. Premium selling sweet spot. Full position size.',
      };
    }
    // Fear spike: VIX1D > VIX > VIX9D (or VIX1D > VIX and VIX9D < VIX)
    if (r1d > hi && r9d < lo) {
      return {
        shape: 'fear-spike',
        advice:
          'Near-term fear spike — likely event-driven. IC dangerous, but if the event passes, rapid mean-reversion creates opportunity. Wait for resolution or use single-side spreads only.',
      };
    }
    // Backwardation: VIX1D > VIX, VIX9D ≈ VIX or > VIX
    if (r1d > hi) {
      return {
        shape: 'backwardation',
        advice:
          'Short-term stress exceeding 30-day — elevated intraday risk. Reduce size or widen deltas. Watch for mean-reversion after event clears.',
      };
    }
    // Front-calm: VIX1D < VIX, VIX9D < VIX
    if (r1d < lo && r9d < lo) {
      return {
        shape: 'front-calm',
        advice:
          'Near-term calm but longer-term worry easing — transitional environment. Standard positioning with slight bullish tilt.',
      };
    }
  }

  // VIX1D only (no VIX9D)
  if (r1d > hi) {
    return {
      shape: 'backwardation',
      advice:
        'VIX1D above VIX — today expected hotter than average. Widen deltas or reduce size.',
    };
  }
  if (r1d < lo) {
    return {
      shape: 'contango',
      advice:
        'VIX1D below VIX — today expected calmer than average. Favorable for selling premium.',
    };
  }

  return {
    shape: 'flat',
    advice:
      'Term structure is roughly flat — no strong directional signal from vol curve.',
  };
}

function classifyOpeningRange(pctOfMedian: number): string {
  if (pctOfMedian < SIGNALS.OPENING_RANGE_GREEN) return 'GREEN';
  if (pctOfMedian < SIGNALS.OPENING_RANGE_MODERATE) return 'MODERATE';
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
    if (ratio < SIGNALS.VIX1D_RATIO_CALM) signals.push('calm');
    else if (ratio < SIGNALS.VIX1D_RATIO_NORMAL) signals.push('normal');
    else if (ratio < SIGNALS.VIX1D_RATIO_ELEVATED) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vix9d && vix > 0) {
    const ratio = vix9d / vix;
    if (ratio > SIGNALS.VIX9D_RATIO_CALM) signals.push('calm');
    else if (ratio > SIGNALS.VIX9D_RATIO_NORMAL) signals.push('normal');
    else if (ratio > SIGNALS.VIX9D_RATIO_ELEVATED) signals.push('elevated');
    else signals.push('extreme');
  }

  if (vvix) {
    if (vvix < SIGNALS.VVIX_CALM) signals.push('calm');
    else if (vvix < SIGNALS.VVIX_NORMAL) signals.push('normal');
    else if (vvix < SIGNALS.VVIX_ELEVATED) signals.push('elevated');
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

  // Yesterday's SPX OHLC for RV/IV and clustering (live mode)
  liveYesterdayHigh?: number;
  liveYesterdayLow?: number;
  liveYesterdayOpen?: number;
  liveYesterdayClose?: number;

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
      vixTermShape: null,
      vixTermShapeAdvice: null,
      clusterPutMult: null,
      clusterCallMult: null,
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

    // ── Directional cluster multipliers ───────────────────────
    // After a big down day, put-side range expands more than call-side.
    // After a big up day, the asymmetry is weaker (upside rallies cluster less).
    // When cluster mult ≈ 1 (no clustering), both sides are equal.
    const ydayOpen = historySnapshot?.yesterday?.open ?? liveYesterdayOpen;
    const ydayClose = historySnapshot?.yesterday?.close ?? liveYesterdayClose;
    if (cMult !== 1 && ydayOpen && ydayClose && ydayOpen > 0) {
      const ydayReturn = (ydayClose - ydayOpen) / ydayOpen;
      const excess = cMult - 1; // how much above/below 1.0 (e.g. 0.15 for 1.15x)
      if (excess > 0) {
        // Clustering is active (mult > 1)
        if (ydayReturn < -SIGNALS.CLUSTER_DIRECTION_THRESHOLD) {
          // Down day: put side gets 70% of excess, call side 30%
          result.clusterPutMult = 1 + excess * SIGNALS.CLUSTER_DOWN_PUT_WEIGHT;
          result.clusterCallMult =
            1 + excess * SIGNALS.CLUSTER_DOWN_CALL_WEIGHT;
        } else if (ydayReturn > SIGNALS.CLUSTER_DIRECTION_THRESHOLD) {
          // Up day: call side gets 60% of excess, put side 40% (weaker asymmetry)
          result.clusterPutMult = 1 + excess * SIGNALS.CLUSTER_UP_PUT_WEIGHT;
          result.clusterCallMult = 1 + excess * SIGNALS.CLUSTER_UP_CALL_WEIGHT;
        } else {
          // Flat day: symmetric
          result.clusterPutMult = cMult;
          result.clusterCallMult = cMult;
        }
      } else {
        // Tailwind (mult < 1): symmetric — calm days don't have directional bias
        result.clusterPutMult = cMult;
        result.clusterCallMult = cMult;
      }
    } else {
      result.clusterPutMult = cMult;
      result.clusterCallMult = cMult;
    }

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
      const cappedZ = Math.min(approxZ, 3);
      const putDelta =
        calcBSDelta(
          spot,
          putStrike,
          sigma * (1 + calcScaledSkew(skew, cappedZ)),
          T,
          'put',
        ) * 100;
      const callDelta =
        calcBSDelta(
          spot,
          callStrike,
          sigma * (1 - calcScaledCallSkew(skew, cappedZ)),
          T,
          'call',
        ) * 100;
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
      const cappedZhl = Math.min(approxZ, 3);
      const putDelta =
        calcBSDelta(
          spot,
          putStrike,
          sigma * (1 + calcScaledSkew(skew, cappedZhl)),
          T,
          'put',
        ) * 100;
      const callDelta =
        calcBSDelta(
          spot,
          callStrike,
          sigma * (1 - calcScaledCallSkew(skew, cappedZhl)),
          T,
          'call',
        ) * 100;
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
    const termShape = classifyTermShape(vix1d, vix9d, vix);
    if (termShape) {
      result.vixTermShape = termShape.shape;
      result.vixTermShapeAdvice = termShape.advice;
    }

    // ── RV/IV ratio ──────────────────────────────────────────
    // Parkinson RV from yesterday's SPX high-low vs today's IV
    const ydayHigh = historySnapshot?.yesterday?.high ?? liveYesterdayHigh;
    const ydayLow = historySnapshot?.yesterday?.low ?? liveYesterdayLow;
    if (ydayHigh && ydayLow && ydayHigh > ydayLow) {
      const rv = parkinsonRV(ydayHigh, ydayLow);
      // IV: prefer VIX1D, fall back to VIX × 1.15
      const iv = vix1d ? vix1d / 100 : (vix * VIX_TO_SIGMA_MULT) / 100;
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

    // ── Data note ────────────────────────────────────────────
    result.dataNote = buildDataNote(
      vix1d,
      vix,
      result.openingRangeAvailable,
      !!historySnapshot,
    );

    return result;
  }, [
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
    historySnapshot,
  ]);
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
