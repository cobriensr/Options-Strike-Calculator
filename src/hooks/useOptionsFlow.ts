/**
 * useOptionsFlow — React hook for the options flow top-strikes endpoint.
 *
 * Polls `GET /api/options-flow/top-strikes` every 60s during market hours
 * and exposes the ranked strikes + directional rollup to consumers.
 *
 * Effect dispatch ladder (modeled on useGexPerStrike):
 *   1. Scrub mode (`asOf` is non-null string) — one-shot fetch with
 *      `?date=&as_of=`. No polling.
 *   2. Past date (`selectedDate` is NOT today in ET) — one-shot fetch
 *      with `?date=`. No polling.
 *   3. Live mode (today or no date, no asOf, marketOpen true) — fetch +
 *      poll every `pollIntervalMs`.
 *   4. Market closed (today or no date, no asOf, marketOpen false) — no
 *      fetch, preserve existing data.
 *
 * Errors surface via `error` but do not clear `data` — stale data is more
 * useful than an empty panel. The next polling tick re-attempts the fetch.
 *
 * Unmount: clears the interval and aborts any in-flight request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RankedStrike, DirectionalRollup } from '../types/flow';

// Re-export so existing consumers that imported these types from the hook
// module keep working (e.g. OptionsFlowTable, FlowDirectionalRollup, tests).
export type { RankedStrike, DirectionalRollup };

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
  timestamps: string[];
}

export interface UseOptionsFlowOptions {
  marketOpen: boolean;
  limit?: number;
  windowMinutes?: 5 | 15 | 30 | 60;
  pollIntervalMs?: number;
  /** YYYY-MM-DD date. When provided, passed as `?date=` to the API. */
  selectedDate?: string;
  /** ISO timestamp for scrub mode. When non-null, passed as `?as_of=`. */
  asOf?: string | null;
}

export interface UseOptionsFlowResult {
  data: OptionsFlowData | null;
  isLoading: boolean;
  error: Error | null;
  lastFetchedAt: Date | null;
  /** Abort any in-flight request and trigger a fresh fetch. */
  refresh: () => void;
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
  timestamps: string[];
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

/** Compute today's ET date as YYYY-MM-DD. */
function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

export function useOptionsFlow(
  options: UseOptionsFlowOptions,
): UseOptionsFlowResult {
  const {
    marketOpen,
    limit = DEFAULT_LIMIT,
    windowMinutes = DEFAULT_WINDOW_MINUTES,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    selectedDate,
    asOf,
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
  // Bump this counter to force a re-fetch from the refresh() callback.
  const [refreshToken, setRefreshToken] = useState(0);

  // Derive dispatch-ladder booleans.
  const todayET = getTodayET();
  const isScrubMode = typeof asOf === 'string';
  const isPastDate = selectedDate != null && selectedDate !== todayET;

  const buildUrl = useCallback((): string => {
    const params = new URLSearchParams({
      limit: String(limit),
      window_minutes: String(windowMinutes),
    });
    if (selectedDate) {
      params.set('date', selectedDate);
    }
    if (isScrubMode) {
      params.set('as_of', asOf);
    }
    return `/api/options-flow/top-strikes?${params.toString()}`;
  }, [limit, windowMinutes, selectedDate, asOf, isScrubMode]);

  const fetchNow = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setIsLoading(true);
      try {
        const res = await fetch(buildUrl(), { signal });
        if (!res.ok) {
          throw new Error(`options-flow HTTP ${res.status}`);
        }
        const raw = (await res.json()) as TopStrikesApiResponse;

        if (!isMountedRef.current || signal.aborted) return;

        setData({
          strikes: raw.strikes,
          rollup: raw.rollup,
          spot: raw.spot,
          windowMinutes: raw.window_minutes,
          lastUpdated: raw.last_updated,
          alertCount: raw.alert_count,
          timestamps: raw.timestamps ?? [],
        });
        setError(null);
        setLastFetchedAt(new Date());
      } catch (err) {
        // AbortError from unmount or supersession — not a real error.
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
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
    },
    [buildUrl],
  );

  useEffect(() => {
    // Each effect invocation owns its own AbortController. Cleanup
    // aborts in-flight fetches so stale responses never overwrite state.
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // ── 1. Scrub mode ────────────────────────────────────────────
    if (isScrubMode) {
      void fetchNow(controller.signal);
      return () => {
        controller.abort();
        abortControllerRef.current = null;
      };
    }

    // ── 2. Past date ─────────────────────────────────────────────
    if (isPastDate) {
      void fetchNow(controller.signal);
      return () => {
        controller.abort();
        abortControllerRef.current = null;
      };
    }

    // ── 3. Live mode ─────────────────────────────────────────────
    if (marketOpen) {
      void fetchNow(controller.signal);
      const intervalId = setInterval(() => {
        void fetchNow(controller.signal);
      }, pollIntervalMs);
      return () => {
        clearInterval(intervalId);
        controller.abort();
        abortControllerRef.current = null;
      };
    }

    // ── 4. Market closed ─────────────────────────────────────────
    // No fetch — preserve existing data from a previous session.
    return () => {
      controller.abort();
      abortControllerRef.current = null;
    };
  }, [
    marketOpen,
    isScrubMode,
    isPastDate,
    pollIntervalMs,
    fetchNow,
    refreshToken,
  ]);

  // Unmount cleanup — flip the mounted flag so any late-resolving
  // promises from the last fetch short-circuit before calling setState.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    abortControllerRef.current?.abort();
    setRefreshToken((t) => t + 1);
  }, []);

  return { data, isLoading, error, lastFetchedAt, refresh };
}
