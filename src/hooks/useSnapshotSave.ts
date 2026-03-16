/**
 * useSnapshotSave — Automatically saves market snapshots to Postgres
 * whenever the calculator produces results.
 *
 * Owner-gated: the /api/snapshot endpoint rejects non-owners,
 * so public visitors never trigger writes.
 *
 * Deduplication: the DB has a UNIQUE(date, entry_time) constraint,
 * so duplicate submissions are silently skipped.
 */

import { useEffect, useRef } from 'react';
import type { CalculationResults } from '../types';
import type { ComputedSignals } from './useComputedSignals';

export interface SnapshotMeta {
  selectedDate?: string;
  entryTime?: string;
  isBacktest?: boolean;
  spy?: number;
  vix?: number;
  skewPct?: number;
  clusterMult?: number;
}

/**
 * Call this hook in App.tsx. It fires a POST to /api/snapshot
 * whenever results change with a new date+time combination.
 */
export function useSnapshotSave(
  results: CalculationResults | null,
  signals: ComputedSignals,
  meta: SnapshotMeta,
  isOwner: boolean,
) {
  // Track what we've already saved to avoid redundant requests
  const savedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!results || !isOwner) return;
    if (!meta.selectedDate || !meta.entryTime) return;

    const key = `${meta.selectedDate}|${meta.entryTime}`;
    if (savedRef.current.has(key)) return;
    savedRef.current.add(key);

    // Build the strikes JSONB from allDeltas
    const strikes: Record<string, Record<string, unknown>> = {};
    for (const d of results.allDeltas) {
      if ('error' in d) continue;
      strikes[String(d.delta)] = {
        put: d.putSnapped,
        call: d.callSnapped,
        putPct: d.putPct,
        callPct: d.callPct,
      };
    }

    // Derive ivAccelMult from first valid delta row
    const firstRow = results.allDeltas.find((r) => !('error' in r));
    const ivAccelMult =
      firstRow && !('error' in firstRow) ? firstRow.ivAccelMult : undefined;

    const payload = {
      date: meta.selectedDate,
      entryTime: meta.entryTime,

      // From results
      spx: results.spot,
      sigma: results.sigma,
      tYears: results.T,
      hoursRemaining: results.hoursRemaining,

      // From meta (App-level state not in signals)
      spy: meta.spy,
      vix: meta.vix,
      skewPct: meta.skewPct,
      clusterMult: meta.clusterMult,
      isBacktest: meta.isBacktest,

      // From signals (all computed trading signals)
      spxOpen: signals.spxOpen,
      spxHigh: signals.spxHigh,
      spxLow: signals.spxLow,
      prevClose: signals.prevClose,
      vix1d: signals.vix1d,
      vix9d: signals.vix9d,
      vvix: signals.vvix,
      sigmaSource: signals.sigmaSource,
      regimeZone: signals.regimeZone,
      dowLabel: signals.dowLabel,
      dowMultHL: signals.dowMultHL,
      dowMultOC: signals.dowMultOC,
      icCeiling: signals.icCeiling,
      putSpreadCeiling: signals.putSpreadCeiling,
      callSpreadCeiling: signals.callSpreadCeiling,
      moderateDelta: signals.moderateDelta,
      conservativeDelta: signals.conservativeDelta,
      medianOcPct: signals.medianOcPct,
      medianHlPct: signals.medianHlPct,
      p90OcPct: signals.p90OcPct,
      p90HlPct: signals.p90HlPct,
      p90OcPts: signals.p90OcPts,
      p90HlPts: signals.p90HlPts,
      openingRangeAvailable: signals.openingRangeAvailable,
      openingRangeHigh: signals.openingRangeHigh,
      openingRangeLow: signals.openingRangeLow,
      openingRangePctConsumed: signals.openingRangePctConsumed,
      openingRangeSignal: signals.openingRangeSignal,
      vixTermSignal: signals.vixTermSignal,
      vixTermShape: signals.vixTermShape,
      clusterPutMult: signals.clusterPutMult,
      clusterCallMult: signals.clusterCallMult,
      rvIvRatio: signals.rvIvRatio,
      rvIvLabel: signals.rvIvLabel,
      rvAnnualized: signals.rvAnnualized,
      ivAccelMult,
      overnightGap: signals.overnightGap,
      isEarlyClose: signals.isEarlyClose,
      isEventDay: signals.isEventDay,
      eventNames: signals.eventNames,

      strikes,
    };

    // Fire-and-forget — don't block the UI
    fetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Silently ignore — snapshot save is best-effort
      // Remove from saved set so it retries next render
      savedRef.current.delete(key);
    });
  }, [
    results,
    signals,
    meta.selectedDate,
    meta.entryTime,
    meta.isBacktest,
    meta.spy,
    meta.vix,
    meta.skewPct,
    meta.clusterMult,
    isOwner,
  ]);
}
