/**
 * useOptionsFlow — React hook for the options flow top-strikes endpoint.
 *
 * Polls `GET /api/options-flow/top-strikes` every 60s during market hours
 * and exposes the ranked strikes + directional rollup to consumers.
 *
 * Gated on `marketOpen`:
 *   - Off hours: no fetch, `data === null`, no interval running.
 *   - On hours: initial fetch on mount, then poll at `pollIntervalMs`.
 *
 * Transitions:
 *   - `marketOpen: false → true` — immediate fetch + start polling.
 *   - `marketOpen: true → false` — stop polling, preserve last-fetched `data`.
 *
 * Errors surface via `error` but do not clear `data` — stale data is more
 * useful than an empty panel. The next polling tick re-attempts the fetch.
 *
 * Unmount: clears the interval and aborts any in-flight request.
 */

import { useEffect, useRef, useState } from 'react';

// ============================================================
// TYPES — Mirror of api/_lib/flow-scoring.ts — keep in sync
// ============================================================

export interface RankedStrike {
  strike: number;
  type: 'call' | 'put';
  distance_from_spot: number;
  distance_pct: number;
  total_premium: number;
  ask_side_ratio: number;
  volume_oi_ratio: number;
  hit_count: number;
  has_ascending_fill: boolean;
  has_descending_fill: boolean;
  has_multileg: boolean;
  is_itm: boolean;
  score: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DirectionalRollup {
  bullish_count: number;
  bearish_count: number;
  bullish_premium: number;
  bearish_premium: number;
  lean: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  top_bullish_strike: number | null;
  top_bearish_strike: number | null;
}

// ============================================================
// HOOK PUBLIC TYPES
// ============================================================

export interface OptionsFlowData {
  strikes: RankedStrike[];
  rollup: DirectionalRollup;
  spot: number | null;
  windowMinutes: number;
  lastUpdated: string | null;
  alertCount: number;
}

export interface UseOptionsFlowOptions {
  marketOpen: boolean;
  limit?: number;
  windowMinutes?: 5 | 15 | 30 | 60;
  pollIntervalMs?: number;
}

export interface UseOptionsFlowResult {
  data: OptionsFlowData | null;
  isLoading: boolean;
  error: Error | null;
  lastFetchedAt: Date | null;
}

// ============================================================
// RAW API RESPONSE SHAPE (snake_case)
// ============================================================

interface TopStrikesApiResponse {
  strikes: RankedStrike[];
  rollup: DirectionalRollup;
  spot: number | null;
  window_minutes: number;
  last_updated: string | null;
  alert_count: number;
}

// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

// ============================================================
// HOOK
// ============================================================

export function useOptionsFlow(
  options: UseOptionsFlowOptions,
): UseOptionsFlowResult {
  const {
    marketOpen,
    limit = DEFAULT_LIMIT,
    windowMinutes = DEFAULT_WINDOW_MINUTES,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const [data, setData] = useState<OptionsFlowData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Track mount state so async fetches don't setState after unmount.
  const isMountedRef = useRef(true);
  // Track the current AbortController so we can cancel in-flight fetches
  // on unmount or when a new fetch supersedes it.
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!marketOpen) {
      // Off-hours: nothing to do. Preserve any existing data from a
      // previous on-hours session.
      return;
    }

    isMountedRef.current = true;

    const buildUrl = (): string => {
      const params = new URLSearchParams({
        limit: String(limit),
        window_minutes: String(windowMinutes),
      });
      return `/api/options-flow/top-strikes?${params.toString()}`;
    };

    const fetchNow = async (): Promise<void> => {
      // Abort any in-flight request; start a fresh controller for this one.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      try {
        const res = await fetch(buildUrl(), { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`options-flow HTTP ${res.status}`);
        }
        const raw = (await res.json()) as TopStrikesApiResponse;

        if (!isMountedRef.current || controller.signal.aborted) return;

        setData({
          strikes: raw.strikes,
          rollup: raw.rollup,
          spot: raw.spot,
          windowMinutes: raw.window_minutes,
          lastUpdated: raw.last_updated,
          alertCount: raw.alert_count,
        });
        setError(null);
        setLastFetchedAt(new Date());
      } catch (err) {
        // AbortError from unmount or supersession — not a real error, skip.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isMountedRef.current) return;
        setError(
          err instanceof Error ? err : new Error('options-flow fetch failed'),
        );
        // Leave `data` in place — stale is better than empty.
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    // Immediate fetch on mount / when marketOpen flips to true.
    void fetchNow();

    const intervalId = setInterval(() => {
      void fetchNow();
    }, pollIntervalMs);

    return () => {
      clearInterval(intervalId);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [marketOpen, limit, windowMinutes, pollIntervalMs]);

  // Unmount cleanup — flip the mounted flag so any late-resolving promises
  // from the last fetch short-circuit before calling setState.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return { data, isLoading, error, lastFetchedAt };
}
