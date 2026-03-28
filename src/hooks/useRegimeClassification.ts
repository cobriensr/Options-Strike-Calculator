/**
 * useRegimeClassification — Regime zone, DOW multipliers, range thresholds,
 * delta guide ceilings, and directional cluster multipliers.
 *
 * Extracted from useComputedSignals for composability.
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import {
  calcBSDelta,
  calcScaledSkew,
  calcScaledCallSkew,
} from '../utils/calculator';
import { SIGNALS, DEFAULTS } from '../constants';
import { parseDow } from '../utils/time';
import {
  findBucket,
  estimateRange,
  getDowMultiplier,
} from '../data/vixRangeStats';
import type { HistorySnapshot } from './useHistoryData';

// ============================================================
// TYPES
// ============================================================

export interface RegimeClassification {
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

  // Directional cluster multipliers (asymmetric put/call)
  clusterPutMult: number | null;
  clusterCallMult: number | null;
}

// ============================================================
// HELPERS
// ============================================================

const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ============================================================
// HOOK
// ============================================================

interface RegimeInputs {
  vix: number | undefined;
  spot: number | undefined;
  T: number | undefined;
  skewPct: number;
  clusterMult: number;
  selectedDate: string | undefined;

  // Yesterday OHLC for directional clustering
  liveYesterdayOpen?: number;
  liveYesterdayClose?: number;

  // History (null when viewing today)
  historySnapshot: HistorySnapshot | null;
}

export function useRegimeClassification(
  inputs: RegimeInputs,
): RegimeClassification {
  const {
    vix,
    spot,
    T,
    skewPct,
    clusterMult,
    selectedDate,
    liveYesterdayOpen,
    liveYesterdayClose,
    historySnapshot,
  } = inputs;

  return useMemo(() => {
    // ── Initialize result ────────────────────────────────────
    const result: RegimeClassification = {
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
      clusterPutMult: null,
      clusterCallMult: null,
    };

    if (!vix || !spot || !T) return result;

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
    const sigma = (vix * DEFAULTS.IV_PREMIUM_FACTOR) / 100;
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

    return result;
  }, [
    vix,
    spot,
    T,
    skewPct,
    clusterMult,
    selectedDate,
    liveYesterdayOpen,
    liveYesterdayClose,
    historySnapshot,
  ]);
}
