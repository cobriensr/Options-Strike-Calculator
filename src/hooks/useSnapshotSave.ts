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

interface SnapshotContext {
  // Identifiers
  selectedDate?: string;
  entryTime?: string;
  isBacktest?: boolean;

  // Prices
  spy?: number;
  spxOpen?: number;
  spxHigh?: number;
  spxLow?: number;
  prevClose?: number;

  // Volatility
  vix?: number;
  vix1d?: number;
  vix9d?: number;
  vvix?: number;

  // Calculator
  sigmaSource?: string;
  skewPct?: number;

  // Regime
  regimeZone?: string;
  clusterMult?: number;
  dowLabel?: string;

  // Delta guide (these come from results or parent)
  icCeiling?: number;
  putSpreadCeiling?: number;
  callSpreadCeiling?: number;

  // Opening range
  openingRangeAvailable?: boolean;
  openingRangeSignal?: string;

  // Term structure
  vixTermSignal?: string;

  // Overnight
  overnightGap?: number;

  // Events
  isEarlyClose?: boolean;
  isEventDay?: boolean;
  eventNames?: string[];
}

/**
 * Call this hook in App.tsx. It fires a POST to /api/snapshot
 * whenever results change with a new date+time combination.
 */
export function useSnapshotSave(
  results: CalculationResults | null,
  context: SnapshotContext,
  isOwner: boolean,
) {
  // Track what we've already saved to avoid redundant requests
  const savedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!results || !isOwner) return;
    if (!context.selectedDate || !context.entryTime) return;

    const key = `${context.selectedDate}|${context.entryTime}`;
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

    const payload = {
      date: context.selectedDate,
      entryTime: context.entryTime,

      spx: results.spot,
      spy: context.spy,
      spxOpen: context.spxOpen,
      spxHigh: context.spxHigh,
      spxLow: context.spxLow,
      prevClose: context.prevClose,

      vix: context.vix,
      vix1d: context.vix1d,
      vix9d: context.vix9d,
      vvix: context.vvix,

      sigma: results.sigma,
      sigmaSource: context.sigmaSource,
      tYears: results.T,
      hoursRemaining: results.hoursRemaining,
      skewPct: context.skewPct,

      regimeZone: context.regimeZone,
      clusterMult: context.clusterMult,
      dowLabel: context.dowLabel,

      icCeiling: context.icCeiling,
      putSpreadCeiling: context.putSpreadCeiling,
      callSpreadCeiling: context.callSpreadCeiling,

      openingRangeAvailable: context.openingRangeAvailable,
      openingRangeSignal: context.openingRangeSignal,

      vixTermSignal: context.vixTermSignal,
      overnightGap: context.overnightGap,

      strikes,

      isEarlyClose: context.isEarlyClose,
      isEventDay: context.isEventDay,
      eventNames: context.eventNames,

      isBacktest: context.isBacktest,
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
  }, [results, context, isOwner]);
}
