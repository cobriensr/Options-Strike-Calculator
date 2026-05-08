/**
 * usePeriscopeExposure — fetches /api/periscope-exposure for the
 * Periscope MM-attributed exposure panel.
 *
 * Owner-only. Mirrors the live-polling pattern from `useNopeIntraday`.
 *
 * UW publishes Periscope slots every 10 min during RTH. We poll at
 * 60s so a fresh slot lands in the UI within ≤1 min of the scraper
 * inserting it. Outside market hours we keep the last-known view but
 * don't poll.
 *
 * Returns the structured view + loading + error + asOf timestamp.
 * The view is null when the scraper hasn't ingested any slot for
 * today's expiry yet — the panel renders a "waiting for first slot"
 * placeholder rather than crashing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

export interface RankedRow {
  strike: number;
  value: number;
  ptsFromSpot: number;
}

export interface RankedRowSimple {
  strike: number;
  value: number;
}

export interface PeriscopeView {
  capturedAt: string;
  priorCapturedAt: string | null;
  expiry: string;
  spot: number;
  gamma: {
    ceiling: RankedRow | null;
    floor: RankedRow | null;
    accelTop: RankedRow[];
    topByAbsNear: RankedRowSimple[];
  };
  charm: {
    tallyNear50: number;
    tallyWide100: number;
    topByAbs: RankedRowSimple[];
    charmZeroStrike: number | null;
  };
  vanna: {
    topByAbs: RankedRowSimple[];
  };
  signFlips: Array<{ strike: number; from: number; to: number }>;
  cone: {
    coneUpper: number;
    coneLower: number;
    coneWidth: number;
    asymmetryPts: number;
    spotAtCalc: number;
  } | null;
  breaches: Array<{
    direction: 'upper' | 'lower';
    breachTime: string;
    spotAtBreach: number;
    ptsPastBound: number;
  }>;
}

interface PeriscopeExposureResponse {
  marketOpen: boolean;
  asOf: string;
  data: PeriscopeView | null;
  reason?: 'no_spot' | 'no_slot';
}

export interface UsePeriscopeExposureReturn {
  view: PeriscopeView | null;
  /** Reason the view is null, when known. Used by the panel for the
   *  "waiting for first slot" vs "no SPX spot yet" message. */
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

interface UsePeriscopeExposureOptions {
  marketOpen: boolean;
  /** Optional fresher SPX spot to send as a query param. Falls back to
   *  the server-side `index_candles_1m` lookup when omitted. */
  spotHint?: number | null;
}

export function usePeriscopeExposure({
  marketOpen,
  spotHint,
}: UsePeriscopeExposureOptions): UsePeriscopeExposureReturn {
  // Owner OR guest — periscope-exposure is a read-only data endpoint
  // gated by guardOwnerOrGuestEndpoint server-side. The previous
  // checkIsOwner() gate matched the useNopeIntraday pattern but
  // unnecessarily blocked guest keys from seeing the panel data.
  const accessMode = getAccessMode();
  const canFetch = accessMode === 'owner' || accessMode === 'guest';
  const [view, setView] = useState<PeriscopeView | null>(null);
  const [emptyReason, setEmptyReason] = useState<'no_spot' | 'no_slot' | null>(
    null,
  );
  const [asOf, setAsOf] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchView = useCallback(async () => {
    if (!canFetch) return;
    setIsLoading(true);
    try {
      const url =
        spotHint != null && Number.isFinite(spotHint) && spotHint > 0
          ? `/api/periscope-exposure?spot=${spotHint}`
          : '/api/periscope-exposure';
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PeriscopeExposureResponse;
      if (!mountedRef.current) return;
      setView(body.data);
      setEmptyReason(body.reason ?? null);
      setAsOf(body.asOf);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [canFetch, spotHint]);

  // Initial fetch.
  useEffect(() => {
    if (!canFetch) return;
    void fetchView();
  }, [canFetch, fetchView]);

  // Polling — RTH only.
  useEffect(() => {
    if (!canFetch || !marketOpen) return;
    const id = setInterval(() => {
      void fetchView();
    }, POLL_INTERVALS.PERISCOPE);
    return () => clearInterval(id);
  }, [canFetch, marketOpen, fetchView]);

  return {
    view,
    emptyReason,
    asOf,
    isLoading,
    error,
    refresh: () => {
      void fetchView();
    },
  };
}
