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
  /** Timestamp of last successful fetch (any endpoint) */
  lastUpdated: string | null;
  /**
   * Timestamp of last successful fetch of the /api/quotes endpoint
   * specifically. Distinct from `lastUpdated` because events/movers/
   * yesterday have their own cadences and shouldn't affect quote freshness.
   * FE-STATE-001.
   */
  quotesLastUpdated: string | null;
  /**
   * True when quotes data is older than STALE_THRESHOLD_MS (90s) during
   * market hours. Gated on `marketOpen` so the badge doesn't show after
   * market close when polling has intentionally stopped. FE-STATE-001.
   */
  isStale: boolean;
  /**
   * True when quotes data is older than VERY_STALE_THRESHOLD_MS (180s)
   * during market hours. Implies `isStale`. Used for the red severity
   * tier in the header badge. FE-STATE-001.
   */
  isVeryStale: boolean;
  /**
   * Age of the most recent quotes fetch in whole seconds, or `null` when
   * market is closed or no fetch has happened yet. Derived from the
   * internal staleness tick so consumers can display "Quotes Ns old"
   * without calling `Date.now()` during render (React purity rule).
   * FE-STATE-001.
   */
  staleAgeSec: number | null;
}

// ============================================================
// HOOK
// ============================================================

/** How often to refresh quotes during market hours (ms) */
const REFRESH_INTERVAL_MS = POLL_INTERVALS.MARKET_DATA;

/**
 * FE-STATE-001 staleness thresholds (in ms, gated on market hours):
 * - STALE (yellow pill): quotes older than 90s — one missed poll beyond
 *   the normal 60s cadence. Signal that polling is lagging or degraded.
 * - VERY_STALE (red pill): quotes older than 180s — three missed polls.
 *   Indicates sustained polling failure; price-dependent decisions should
 *   be treated with strong skepticism.
 *
 * Fixed thresholds (not dynamic per backoff) per the decision that
 * backoff itself is a valid signal worth surfacing — if polling has
 * doubled to 120s, that's still abnormal from the trader's perspective
 * and the pill should reflect it.
 */
const STALE_THRESHOLD_MS = 90_000;
const VERY_STALE_THRESHOLD_MS = 180_000;

/**
 * How often to force a re-render to re-evaluate staleness. 5 seconds
 * is imperceptibly late (stale becomes visible at 95s instead of 90s)
 * and avoids the cost of a 1-second interval on a hook at the top of
 * the component tree.
 */
const STALENESS_TICK_MS = 5_000;

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
  // FE-STATE-001: track quotes-endpoint freshness independently. `lastUpdated`
  // reflects ANY successful endpoint; the staleness badge needs to reflect
  // the /api/quotes endpoint specifically since that's what drives hedge
  // pricing and calculator inputs.
  const [quotesLastUpdated, setQuotesLastUpdated] = useState<string | null>(
    null,
  );
  // Wall-clock snapshot used by the staleness derivations below. Updated
  // periodically by the force-tick effect so `isStale` / `isVeryStale` can
  // flip as real time passes without a new fetch. Storing the clock value
  // in state (rather than calling `Date.now()` during render) keeps the
  // hook idempotent per React's purity rule — render functions must not
  // call impure APIs. `null` means either the market is closed (tick
  // suspended) or the first tick hasn't fired yet.
  const [nowForStaleness, setNowForStaleness] = useState<number | null>(null);
  // Track if the owner cookie is present (any endpoint returned 200,
  // or the sc-hint cookie exists from a prior auth session).
  const isOwnerRef = useRef(useIsOwner());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveFailsRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const results = await fetchAllEndpoints();

    setData((prev) => {
      const { nextData, anySuccess, anyAuthError, quotesSuccess } =
        processEndpointResults(prev, results);

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
      // FE-STATE-001: track quote-specific freshness independently.
      if (quotesSuccess) {
        setQuotesLastUpdated(new Date().toISOString());
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
        // Track whether the quotes fetch specifically succeeded so we can
        // update `quotesLastUpdated` independently of `lastUpdated`.
        let quotesSucceeded = false;
        const fetches: Promise<void>[] = [
          fetchJson<QuotesResponse>('/api/quotes').then((result) => {
            if ('data' in result) {
              quotesSucceeded = true;
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
          const now = new Date().toISOString();
          setLastUpdated(now);
          if (quotesSucceeded) {
            setQuotesLastUpdated(now);
          }
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

  // FE-STATE-001: wall-clock tick that drives staleness re-evaluation.
  // Only runs while the market is open (outside market hours polling has
  // stopped, `quotesLastUpdated` is no longer updating, and a stale badge
  // would be pure noise). Fires once immediately on open so the first
  // render after market-open has a meaningful clock value, then every
  // STALENESS_TICK_MS thereafter. Setter lives inside the effect so
  // `Date.now()` is only called from outside the render path — this
  // keeps the hook pure per React's idempotence rule.
  useEffect(() => {
    if (data.quotes?.marketOpen !== true) {
      setNowForStaleness(null);
      return;
    }
    setNowForStaleness(Date.now());
    const id = setInterval(() => {
      setNowForStaleness(Date.now());
    }, STALENESS_TICK_MS);
    return () => clearInterval(id);
  }, [data.quotes?.marketOpen]);

  const hasData =
    data.quotes != null || data.intraday != null || data.yesterday != null;

  // FE-STATE-001: derived staleness flags. Only meaningful when:
  //   (a) market is open (polling is expected to run), AND
  //   (b) quotes have been fetched at least once, AND
  //   (c) the tick has populated `nowForStaleness`.
  // All three conditions null-out the flags so consumers get `false`
  // rather than a positive stale signal during startup or after-hours.
  let isStale = false;
  let isVeryStale = false;
  let staleAgeSec: number | null = null;
  if (
    data.quotes?.marketOpen === true &&
    quotesLastUpdated != null &&
    nowForStaleness != null
  ) {
    const ageMs = nowForStaleness - new Date(quotesLastUpdated).getTime();
    isStale = ageMs >= STALE_THRESHOLD_MS;
    isVeryStale = ageMs >= VERY_STALE_THRESHOLD_MS;
    staleAgeSec = Math.max(0, Math.round(ageMs / 1000));
  }

  return {
    data,
    loading,
    hasData,
    needsAuth,
    refresh: fetchAll,
    lastUpdated,
    quotesLastUpdated,
    isStale,
    isVeryStale,
    staleAgeSec,
  };
}
