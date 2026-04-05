/**
 * useMarketData — React hook for live Schwab market data.
 *
 * Fetches from five independent endpoints in parallel on mount:
 *   /api/quotes    → SPY, SPX, VIX, VIX1D, VIX9D
 *   /api/intraday  → today's SPX OHLC + 30-min opening range
 *   /api/yesterday → prior day SPX OHLC for clustering
 *   /api/events    → economic calendar events
 *   /api/movers    → market movers
 *
 * Each endpoint is independent — if one fails, the others still load.
 *
 * OWNER GATING: The API endpoints require an owner session cookie.
 * Public visitors get 401s, which this hook silently ignores — the
 * calculator works normally with manual input. Only the site owner
 * (after visiting /api/auth/init) gets live data auto-fill.
 *
 * Auto-refreshes quotes every 60s during market hours, stops after close.
 *
 * Fetch logic and result processing are extracted to
 * `useMarketData.fetchers.ts` for independent testability.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { useIsOwner } from './useIsOwner';
import type { QuotesResponse, IntradayResponse } from '../types/api';
import {
  fetchJson,
  fetchAllEndpoints,
  processEndpointResults,
} from './useMarketData.fetchers';
import type { MarketData } from './useMarketData.fetchers';

// ============================================================
// TYPES (re-export MarketData so consumers don't need to change imports)
// ============================================================

export type { MarketData } from './useMarketData.fetchers';

export interface MarketDataState {
  data: MarketData;
  loading: boolean;
  /** True if any data loaded successfully (owner is authenticated) */
  hasData: boolean;
  /** True if Schwab auth is expired (needs /api/auth/init) */
  needsAuth: boolean;
  /** Manually trigger a refresh */
  refresh: () => Promise<void>;
  /** Timestamp of last successful fetch */
  lastUpdated: string | null;
}

// ============================================================
// HOOK
// ============================================================

/** How often to refresh quotes during market hours (ms) */
const REFRESH_INTERVAL_MS = POLL_INTERVALS.MARKET_DATA;

export function useMarketData(): MarketDataState {
  const [data, setData] = useState<MarketData>({
    quotes: null,
    intraday: null,
    yesterday: null,
    events: null,
    movers: null,
  });
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  // Track if the owner cookie is present (any endpoint returned 200,
  // or the sc-hint cookie exists from a prior auth session).
  const isOwnerRef = useRef(useIsOwner());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveFailsRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const results = await fetchAllEndpoints();

    setData((prev) => {
      const { nextData, anySuccess, anyAuthError } = processEndpointResults(
        prev,
        results,
      );

      // Only show needsAuth if the user previously had data (was authenticated)
      // but now gets 401s. Don't show it for public visitors who never auth'd.
      // Check the ref BEFORE updating it so we can detect the transition.
      if (anyAuthError && !anySuccess && isOwnerRef.current) {
        setNeedsAuth(true);
      } else {
        setNeedsAuth(false);
      }

      if (anySuccess) isOwnerRef.current = true;

      if (anySuccess) {
        consecutiveFailsRef.current = 0;
      } else if (!anyAuthError) {
        // Only count as a failure if it wasn't just a 401 (public visitor)
        consecutiveFailsRef.current += 1;
      }

      if (anySuccess) {
        setLastUpdated(new Date().toISOString());
      }

      return nextData;
    });

    setLoading(false);
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh during market hours (only if owner is authenticated)
  // Quotes refresh every cycle; intraday also refreshes until opening range is complete.
  const openingRangeComplete = data.intraday?.openingRange?.complete ?? false;

  useEffect(() => {
    if (isOwnerRef.current && data.quotes?.marketOpen) {
      const backoff = consecutiveFailsRef.current >= 3 ? 2 : 1;
      const interval = REFRESH_INTERVAL_MS * backoff;
      intervalRef.current = setInterval(() => {
        const fetches: Promise<void>[] = [
          fetchJson<QuotesResponse>('/api/quotes').then((result) => {
            if ('data' in result) {
              setData((prev) => ({ ...prev, quotes: result.data }));
            }
          }),
        ];

        // Keep refreshing intraday until the 30-min opening range is complete
        if (!openingRangeComplete) {
          fetches.push(
            fetchJson<IntradayResponse>('/api/intraday').then((result) => {
              if ('data' in result) {
                setData((prev) => ({
                  ...prev,
                  intraday: result.data,
                }));
              }
            }),
          );
        }

        Promise.all(fetches).then(() => {
          setLastUpdated(new Date().toISOString());
        });
      }, interval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [data.quotes?.marketOpen, openingRangeComplete]);

  const hasData =
    data.quotes != null || data.intraday != null || data.yesterday != null;

  return {
    data,
    loading,
    hasData,
    needsAuth,
    refresh: fetchAll,
    lastUpdated,
  };
}
