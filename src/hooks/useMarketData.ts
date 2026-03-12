/**
 * useMarketData — React hook for live Schwab market data.
 *
 * Fetches from three independent endpoints in parallel on mount:
 *   /api/quotes    → SPY, SPX, VIX, VIX1D, VIX9D
 *   /api/intraday  → today's SPX OHLC + 30-min opening range
 *   /api/yesterday → prior day SPX OHLC for clustering
 *
 * Each endpoint is independent — if one fails, the others still load.
 *
 * OWNER GATING: The API endpoints require an owner session cookie.
 * Public visitors get 401s, which this hook silently ignores — the
 * calculator works normally with manual input. Only the site owner
 * (after visiting /api/auth/init) gets live data auto-fill.
 *
 * Auto-refreshes quotes every 60s during market hours, stops after close.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  QuotesResponse,
  IntradayResponse,
  YesterdayResponse,
} from '../types/api';

// ============================================================
// TYPES
// ============================================================

export interface MarketData {
  quotes: QuotesResponse | null;
  intraday: IntradayResponse | null;
  yesterday: YesterdayResponse | null;
}

export interface MarketDataState {
  data: MarketData;
  loading: boolean;
  /** True if any data loaded successfully (owner is authenticated) */
  hasData: boolean;
  /** True if Schwab auth is expired (needs /api/auth/init) */
  needsAuth: boolean;
  /** Manually trigger a refresh */
  refresh: () => void;
  /** Timestamp of last successful fetch */
  lastUpdated: string | null;
}

// ============================================================
// FETCH HELPERS
// ============================================================

async function fetchJson<T>(
  url: string,
): Promise<{ data: T } | { error: string; status: number }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      return {
        error: body.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const data: T = await res.json();
    return { data };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Network error',
      status: 0,
    };
  }
}

// ============================================================
// HOOK
// ============================================================

/** How often to refresh quotes during market hours (ms) */
const REFRESH_INTERVAL_MS = 60_000;

export function useMarketData(): MarketDataState {
  const [data, setData] = useState<MarketData>({
    quotes: null,
    intraday: null,
    yesterday: null,
  });
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  // Track if the owner cookie is present (any endpoint returned 200)
  const isOwnerRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    const [quotesResult, intradayResult, yesterdayResult] = await Promise.all([
      fetchJson<QuotesResponse>('/api/quotes'),
      fetchJson<IntradayResponse>('/api/intraday'),
      fetchJson<YesterdayResponse>('/api/yesterday'),
    ]);

    let anySuccess = false;
    let anyAuthError = false;

    setData((prev) => {
      const next = { ...prev };

      if ('data' in quotesResult) {
        next.quotes = quotesResult.data;
        anySuccess = true;
      } else if (quotesResult.status === 401) {
        anyAuthError = true;
      }

      if ('data' in intradayResult) {
        next.intraday = intradayResult.data;
        anySuccess = true;
      } else if (intradayResult.status === 401) {
        anyAuthError = true;
      }

      if ('data' in yesterdayResult) {
        next.yesterday = yesterdayResult.data;
        anySuccess = true;
      } else if (yesterdayResult.status === 401) {
        anyAuthError = true;
      }

      return next;
    });

    isOwnerRef.current = anySuccess;

    // Only show needsAuth if the user previously had data (was authenticated)
    // but now gets 401s. Don't show it for public visitors who never auth'd.
    if (anyAuthError && !anySuccess && isOwnerRef.current) {
      setNeedsAuth(true);
    } else {
      setNeedsAuth(false);
    }

    setLoading(false);
    if (anySuccess) {
      setLastUpdated(new Date().toISOString());
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh quotes during market hours (only if owner is authenticated)
  useEffect(() => {
    if (isOwnerRef.current && data.quotes?.marketOpen) {
      intervalRef.current = setInterval(() => {
        fetchJson<QuotesResponse>('/api/quotes').then((result) => {
          if ('data' in result) {
            setData((prev) => ({ ...prev, quotes: result.data }));
            setLastUpdated(new Date().toISOString());
          }
        });
      }, REFRESH_INTERVAL_MS);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [data.quotes?.marketOpen]);

  const hasData =
    data.quotes != null || data.intraday != null || data.yesterday != null;

  return {
    data,
    loading,
    hasData,
    needsAuth,
    refresh: () => {
      void fetchAll();
    },
    lastUpdated,
  };
}
