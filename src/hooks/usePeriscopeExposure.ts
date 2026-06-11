/**
 * usePeriscopeExposure — fetches the Periscope MM-attributed exposure
 * view for the panel. Routes between two endpoints based on whether the
 * user is in live or historical mode:
 *
 *   - LIVE (no date/time picker): /api/periscope-map — GEXBot 1-min,
 *     deterministic view computed from `gexbot_api_capture`. No Claude.
 *   - HISTORICAL (any picker set): /api/periscope-exposure — reads
 *     `periscope_snapshots`, which has the full ~6-month back-catalog
 *     (the adapter cron `populate-periscope-from-gexbot` writes the
 *     10-min slices).
 *
 * Owner or guest. Mirrors the live-polling pattern from `useNopeIntraday`.
 * Polls at POLL_INTERVALS.PERISCOPE (60s) during RTH; pauses outside
 * market hours.
 *
 * Returns the structured view + loading + error + asOf timestamp.
 * The view is null when GEXBot has no fresh capture for today's expiry
 * yet — the panel renders a "no GEXBot capture for today yet"
 * placeholder rather than crashing.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

// RankedRow, RankedRowSimple, PeriscopeView lifted to src/types/periscope.ts
// (Phase 3C). Re-exported here so existing callers keep working.
export type {
  RankedRow,
  RankedRowSimple,
  PeriscopeView,
} from '../types/periscope.js';

import type { PeriscopeView } from '../types/periscope.js';

interface PeriscopeExposureResponse {
  marketOpen: boolean;
  asOf: string;
  data: PeriscopeView | null;
  reason?: 'no_spot' | 'no_slot';
  availableSlots?: string[];
}

export interface UsePeriscopeExposureReturn {
  view: PeriscopeView | null;
  /** Reason the view is null, when known. Used by the panel for the
   *  "waiting for first slot" vs "no SPX spot yet" message. */
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  /** ISO captured_at timestamps for the picked date, ascending. Backs
   *  the prev/next stepper. Empty when the date has no slots. */
  availableSlots: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Picked-slot override. When `null` the hook follows live (latest
 *  slot, polling on during RTH). When set, the hook fetches that
 *  specific (date, time) slot and pauses polling. */
export interface PeriscopeSelectedSlot {
  /** YYYY-MM-DD CT trading date. */
  date: string;
  /** HH:MM CT wall clock. */
  time: string;
}

interface UsePeriscopeExposureOptions {
  marketOpen: boolean;
  /** Optional fresher SPX spot to send as a query param. Falls back to
   *  the server-side `index_candles_1m` lookup when omitted. */
  spotHint?: number | null;
  /** When set, the hook fetches that specific historical slot instead
   *  of latest, and pauses polling. */
  selectedSlot?: PeriscopeSelectedSlot | null;
}

export function usePeriscopeExposure({
  marketOpen,
  spotHint,
  selectedSlot,
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
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isHistorical = selectedSlot != null;
  const selectedDate = selectedSlot?.date;
  const selectedTime = selectedSlot?.time;

  const fetchView = useCallback(async () => {
    if (!canFetch) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (spotHint != null && Number.isFinite(spotHint) && spotHint > 0) {
        params.set('spot', String(spotHint));
      }
      if (selectedDate != null) params.set('date', selectedDate);
      if (selectedTime != null) params.set('time', selectedTime);
      const qs = params.toString();
      // Route: live "latest" reads (no date/time picker) hit the new
      // GEXBot-fed /api/periscope-map endpoint for 1-min freshness.
      // Historical replay (any date/time picker active) stays on
      // /api/periscope-exposure which reads periscope_snapshots and
      // has the full ~6-month back-catalog GEXBot capture doesn't.
      const isLive = selectedDate == null && selectedTime == null;
      const baseRoute = isLive
        ? '/api/periscope-map'
        : '/api/periscope-exposure';
      const url = qs ? `${baseRoute}?${qs}` : baseRoute;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PeriscopeExposureResponse;
      if (!mountedRef.current) return;
      setView(body.data);
      setEmptyReason(body.reason ?? null);
      setAsOf(body.asOf);
      setAvailableSlots(body.availableSlots ?? []);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [canFetch, spotHint, selectedDate, selectedTime]);

  // Initial fetch + refetch when selected slot changes.
  useEffect(() => {
    if (!canFetch) return;
    void fetchView();
  }, [canFetch, fetchView]);

  // Polling — RTH only AND only when on Live (no selectedSlot). When
  // viewing a historical slot the data is immutable; polling is wasted
  // bandwidth.
  usePolling(
    () => {
      void fetchView();
    },
    POLL_INTERVALS.PERISCOPE,
    [canFetch, marketOpen, !isHistorical],
  );

  // Stable `refresh` identity — wraps `fetchView` (which returns a
  // Promise) in a void-returning callback so the public signature stays
  // `() => void` and its identity only changes when `fetchView` does.
  const refresh = useCallback(() => {
    void fetchView();
  }, [fetchView]);

  // Memoize the returned object so its identity is stable across renders
  // when no field changed. A parent `useMemo` (App.tsx panelMap) keyed on
  // this object then holds, avoiding ~30 panel re-renders every poll tick.
  return useMemo(
    () => ({
      view,
      emptyReason,
      asOf,
      availableSlots,
      loading,
      error,
      refresh,
    }),
    [view, emptyReason, asOf, availableSlots, loading, error, refresh],
  );
}
