/**
 * useWhalePositioning — React hook for institutional whale-sized flow.
 *
 * Polls `GET /api/options-flow/whale-positioning` and exposes aggregated
 * WhaleAlert rows plus session-level totals. Complements the 0-1 DTE
 * intraday `useOptionsFlow` hook by surfacing the 2-7 DTE, >=$1M premium
 * positioning that institutional dealers actually leave prints on.
 *
 * Effect dispatch ladder (highest priority first):
 *   1. **Scrub mode** — `asOf` is a non-null string: one-shot fetch with
 *      `?date=selectedDate&as_of=asOf`. No polling.
 *   2. **Past date** — `selectedDate` is provided and is NOT today in ET:
 *      one-shot fetch with `?date=selectedDate`. No polling.
 *   3. **Live mode** — `selectedDate` is today or undefined, `asOf` is
 *      null/undefined, `marketOpen` is true: fetch + poll every
 *      `pollIntervalMs` (default 2 min).
 *   4. **Market closed** — `marketOpen` false, no date/asOf: fetch once on
 *      mount, no polling.
 *
 * Errors surface via `error` but do not clear `data`. Stale whale data is
 * strictly more useful than an empty panel. AbortError from unmount /
 * supersession is swallowed.
 *
 * Unmount: clears the interval and aborts any in-flight request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WhaleAlert, WhalePositioningData } from '../types/flow';

// ============================================================
// HOOK PUBLIC TYPES
// ============================================================

export interface UseWhalePositioningOptions {
  marketOpen: boolean;
  minPremium?: number;
  maxDte?: number;
  limit?: number;
  pollIntervalMs?: number;
  /** YYYY-MM-DD date. When provided, passed as `?date=` to the API. */
  selectedDate?: string;
  /**
   * ISO timestamp for scrub mode. When non-null, passed as `?as_of=` to
   * the API. Triggers a one-shot fetch with no polling.
   */
  asOf?: string | null;
}

export interface UseWhalePositioningResult {
  data: WhalePositioningData | null;
  isLoading: boolean;
  error: Error | null;
  lastFetchedAt: Date | null;
  /** Abort any in-flight request and trigger a fresh fetch. */
  refresh: () => void;
}

// ============================================================
// RAW API RESPONSE SHAPE (snake_case)
// ============================================================

interface WhalePositioningApiResponse {
  strikes: WhaleAlert[];
  total_premium: number;
  alert_count: number;
  last_updated: string | null;
  spot: number | null;
  window_minutes: number;
  min_premium: number;
  max_dte: number;
  timestamps: string[];
}

// ============================================================
// CONSTANTS
// ============================================================

// Lowered from $1M → $500K so the whale-table min-premium slider has a
// lower floor to slide from. The UI filters client-side above this floor;
// the $1M baseline is enforced by the slider's default value.
const DEFAULT_MIN_PREMIUM = 500_000;
const DEFAULT_MAX_DTE = 7;
const DEFAULT_LIMIT = 20;
const DEFAULT_POLL_INTERVAL_MS = 120_000;

// ============================================================
// HELPERS
// ============================================================

/** Today's date in ET as YYYY-MM-DD. */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

// ============================================================
// HOOK
// ============================================================

export function useWhalePositioning(
  options: UseWhalePositioningOptions,
): UseWhalePositioningResult {
  const {
    marketOpen,
    minPremium = DEFAULT_MIN_PREMIUM,
    maxDte = DEFAULT_MAX_DTE,
    limit = DEFAULT_LIMIT,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    selectedDate,
    asOf,
  } = options;

  const [data, setData] = useState<WhalePositioningData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Track mount state so late-resolving promises don't setState post-unmount.
  const isMountedRef = useRef(true);
  // Tracks the current in-flight AbortController so we can cancel it on
  // unmount or when a new fetch supersedes it.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Monotonically increasing counter — bumped by `refresh()` to force the
  // effect to re-fire without changing any "real" dependency.
  const [refreshToken, setRefreshToken] = useState(0);

  // Derive the dispatch mode once so both the effect and its deps list
  // stay in sync.
  const isScrubMode = typeof asOf === 'string';
  const isPastDate =
    !isScrubMode &&
    typeof selectedDate === 'string' &&
    selectedDate !== todayET();
  const isOneShot = isScrubMode || isPastDate;

  const buildUrl = useCallback((): string => {
    const params = new URLSearchParams({
      min_premium: String(minPremium),
      max_dte: String(maxDte),
      limit: String(limit),
    });
    if (selectedDate) {
      params.set('date', selectedDate);
    }
    if (typeof asOf === 'string') {
      params.set('as_of', asOf);
    }
    return `/api/options-flow/whale-positioning?${params.toString()}`;
  }, [minPremium, maxDte, limit, selectedDate, asOf]);

  useEffect(() => {
    isMountedRef.current = true;

    const fetchNow = async (): Promise<void> => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      try {
        const res = await fetch(buildUrl(), {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`whale-positioning HTTP ${String(res.status)}`);
        }
        const raw = (await res.json()) as WhalePositioningApiResponse;

        if (!isMountedRef.current || controller.signal.aborted) return;

        setData({
          strikes: raw.strikes,
          totalPremium: raw.total_premium,
          alertCount: raw.alert_count,
          lastUpdated: raw.last_updated,
          spot: raw.spot,
          windowMinutes: raw.window_minutes,
          minPremium: raw.min_premium,
          maxDte: raw.max_dte,
          timestamps: raw.timestamps,
        });
        setError(null);
        setLastFetchedAt(new Date());
      } catch (err) {
        // AbortError = unmount/supersession. Not a user-facing error.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isMountedRef.current) return;
        setError(
          err instanceof Error
            ? err
            : new Error('whale-positioning fetch failed'),
        );
        // Preserve any prior `data` — stale is more useful than empty.
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    // Always fetch once on mount / on options change — even when the
    // market is closed. Post-session review is a primary use case.
    void fetchNow();

    // ---- dispatch ladder ----
    // 1. Scrub mode or past date → one-shot, no interval.
    // 2. Live + market open → poll.
    // 3. Market closed → single shot (already fired above).
    if (isOneShot || !marketOpen) {
      return () => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
      };
    }

    const intervalId = setInterval(() => {
      void fetchNow();
    }, pollIntervalMs);

    return () => {
      clearInterval(intervalId);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [marketOpen, buildUrl, isOneShot, pollIntervalMs, refreshToken]);

  // Unmount cleanup — flip the mounted flag so any late-resolving promises
  // from the final fetch short-circuit before calling setState.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Manual refresh — abort in-flight, bump the token to re-trigger the
  // main effect.
  const refresh = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setRefreshToken((t) => t + 1);
  }, []);

  return { data, isLoading, error, lastFetchedAt, refresh };
}
