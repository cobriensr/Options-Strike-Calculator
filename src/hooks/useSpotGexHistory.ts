/**
 * useSpotGexHistory — fetches `/api/spot-gex-history` for the
 * FuturesGammaPlaybook regime timeline.
 *
 * Returns the intraday SPX spot-GEX series for a given trading date (or the
 * server's latest when `date` is `null`) plus the list of dates the server
 * has data for. Owner-only — skips polling entirely when the endpoint
 * returns 401.
 *
 * Polling policy:
 *   - Live, market open, document visible  → poll every 30s (matches edge
 *     cache TTL set by `/api/spot-gex-history`).
 *   - Market closed                         → single fetch, no polling (the
 *     day's series is frozen once the cron stops).
 *   - Document hidden                       → pause polling; resume on
 *     visibility (backgrounded tabs get throttled and the panel goes stale
 *     without this guard).
 *
 * Pattern deliberately mirrors `useGexPerStrike.ts`: plain fetch +
 * useEffect + AbortController. No SWR. The `refresh` return is for the
 * ScrubControls "refresh" button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsOwner } from './useIsOwner';
import { getErrorMessage } from '../utils/error';

/**
 * Cadence when actively polling. 30s matches the edge cache TTL the backend
 * sets during market hours — faster would return identical bytes from the
 * CDN; slower would dilute the timeline's freshness.
 */
const POLL_INTERVAL_MS = 30_000;

/** Request timeout — matches `useGexPerStrike` so both behave identically. */
const FETCH_TIMEOUT_MS = 5_000;

export interface SpotGexHistoryPoint {
  ts: string;
  netGex: number;
  spot: number;
}

export interface UseSpotGexHistoryReturn {
  series: SpotGexHistoryPoint[];
  availableDates: string[];
  timestamp: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

interface SpotGexHistoryResponseShape {
  date: string | null;
  timestamp: string | null;
  series: SpotGexHistoryPoint[];
  availableDates: string[];
}

/**
 * Fetch the spot-GEX history for `date` (or latest when null) with
 * configurable polling.
 *
 * @param date          — YYYY-MM-DD to target. When null/omitted the server
 *                        returns its latest-date series.
 * @param marketOpen    — when true we poll live; when false we single-shot.
 */
export function useSpotGexHistory(
  date: string | null,
  marketOpen: boolean,
): UseSpotGexHistoryReturn {
  const isOwner = useIsOwner();
  const [series, setSeries] = useState<SpotGexHistoryPoint[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Once the endpoint has returned 401 we stop re-trying for the rest of
  // the session. Mirrors useGexPerStrike's owner-gating but is stickier —
  // here we don't even have an `isOwner` flip to re-arm against.
  const unauthorizedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchData = useCallback(
    async (externalSignal: AbortSignal) => {
      if (!isOwner || unauthorizedRef.current) {
        if (mountedRef.current) setLoading(false);
        return;
      }

      try {
        const qs = new URLSearchParams();
        if (date) qs.set('date', date);
        const params = qs.size > 0 ? `?${qs}` : '';
        // Combine the effect's cleanup signal with a per-request timeout so
        // stale requests abort on deps change AND requests can't hang
        // forever.
        const signal = AbortSignal.any([
          externalSignal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ]);

        const res = await fetch(`/api/spot-gex-history${params}`, {
          credentials: 'same-origin',
          signal,
        });

        if (!mountedRef.current) return;

        if (res.status === 401) {
          unauthorizedRef.current = true;
          setError(new Error('Unauthorized — owner session required.'));
          setLoading(false);
          return;
        }

        if (!res.ok) {
          setError(
            new Error(`Failed to load spot-GEX history (${res.status})`),
          );
          setLoading(false);
          return;
        }

        const data = (await res.json()) as SpotGexHistoryResponseShape;
        if (!mountedRef.current) return;

        setSeries(data.series ?? []);
        setAvailableDates(data.availableDates ?? []);
        setTimestamp(data.timestamp);
        setError(null);
      } catch (err) {
        // Intentional abort from effect cleanup — not a user-facing error.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mountedRef.current) setError(new Error(getErrorMessage(err)));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [date, isOwner],
  );

  useEffect(() => {
    if (!isOwner || unauthorizedRef.current) {
      setLoading(false);
      return;
    }

    // Each effect run owns its own AbortController so date/marketOpen flips
    // abort any in-flight fetch before the next begins — prevents stale
    // responses from clobbering fresh state.
    const controller = new AbortController();
    const { signal } = controller;

    setLoading(true);
    void fetchData(signal);

    if (!marketOpen) {
      return () => controller.abort();
    }

    // Live polling — but only while the tab is visible. Backgrounded tabs
    // get their setInterval callbacks throttled (often to 1/min), which
    // makes the displayed timeline drift silently.
    let pollId: ReturnType<typeof setInterval> | undefined;

    const startPoll = () => {
      if (pollId != null) return;
      pollId = setInterval(() => {
        void fetchData(signal);
      }, POLL_INTERVAL_MS);
    };

    const stopPoll = () => {
      if (pollId != null) {
        clearInterval(pollId);
        pollId = undefined;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Kick an immediate fetch on re-focus so the user sees fresh data
        // without waiting for the next poll boundary.
        void fetchData(signal);
        startPoll();
      } else {
        stopPoll();
      }
    };

    if (document.visibilityState === 'visible') startPoll();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      controller.abort();
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // refreshTick is included so `refresh()` re-runs this effect end-to-end.
  }, [isOwner, marketOpen, fetchData, refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  return {
    series,
    availableDates,
    timestamp,
    loading,
    error,
    refresh,
  };
}
