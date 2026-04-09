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
import { isTradingDay, isHalfDay } from '../data/marketHours';
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

/**
 * FE-STATE-002 — tri-state (well, quad-state) US equity session label.
 *
 * Exposed as a primitive string union so consumers can write
 * `session === 'regular'` without forcing a re-render when an unrelated
 * state field changes (React best-practices: rerender-derived-state).
 *
 * Phases (ET wall clock, NYSE calendar):
 *   - `pre-market`  04:00 ≤ t < 09:30   on a trading day
 *   - `regular`     09:30 ≤ t < 16:00   on a full trading day
 *                   09:30 ≤ t < 13:00   on a half-day
 *   - `after-hours` 16:00 ≤ t < 20:00   on a full trading day
 *                   13:00 ≤ t < 20:00   on a half-day
 *   - `closed`      everything else (overnight, weekends, full holidays)
 *
 * The 04:00 / 20:00 ET brackets match CBOE extended hours; the site
 * owner starts his prep workflow at 08:30 CT (09:30 ET) so pre-market
 * polling is what unlocks the prep workflow.
 */
export type MarketSession =
  | 'pre-market'
  | 'regular'
  | 'after-hours'
  | 'closed';

// ============================================================
// SESSION DERIVATION (client-side, UTC → ET)
// ============================================================

/**
 * Extract the ET calendar date (YYYY-MM-DD) and time-of-day minutes
 * from a Date using Intl.DateTimeFormat. Mirrors
 * `getCTCalendarAndMinutes` in `src/data/marketHours.ts` but uses the
 * ET zone directly — MarketSession is defined in ET brackets, and
 * doing the conversion twice (ET → CT → ET) just to share the helper
 * would introduce a DST corner case for no benefit.
 */
function getETCalendarAndMinutes(instant: Date): {
  dateStr: string;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const rawHour = pick('hour');
  const hour = rawHour === '24' ? 0 : Number(rawHour);
  const minute = Number(pick('minute'));

  return {
    dateStr: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
  };
}

// ET minute boundaries for the session classifier.
const ET_PRE_MARKET_START = 4 * 60; //  04:00 ET
const ET_REGULAR_START = 9 * 60 + 30; //  09:30 ET
const ET_REGULAR_END_FULL = 16 * 60; //  16:00 ET
const ET_REGULAR_END_HALF = 13 * 60; //  13:00 ET (half-days)
const ET_AFTER_HOURS_END = 20 * 60; //  20:00 ET

/**
 * Classify an instant into a `MarketSession`. Pure function, safe to
 * call from React render because it takes `now` as a parameter — the
 * hook gates `Date.now()` behind a timer per React purity rules.
 *
 * Half-days are handled explicitly (13:00 ET close instead of 16:00 ET)
 * via `isHalfDay`. `currentSessionStage` from `marketHours.ts` doesn't
 * help here: it returns a blanket `'half-day'` with no sub-phase and
 * has no `after-hours` concept, so we compute ET minutes directly.
 */
export function computeMarketSession(now: Date): MarketSession {
  const { dateStr, minutes } = getETCalendarAndMinutes(now);

  if (!isTradingDay(dateStr)) return 'closed';

  const regularEnd = isHalfDay(dateStr)
    ? ET_REGULAR_END_HALF
    : ET_REGULAR_END_FULL;

  if (minutes < ET_PRE_MARKET_START) return 'closed';
  if (minutes < ET_REGULAR_START) return 'pre-market';
  if (minutes < regularEnd) return 'regular';
  if (minutes < ET_AFTER_HOURS_END) return 'after-hours';
  return 'closed';
}

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
  /**
   * Current US equity session, derived client-side from ET wall-clock
   * time. Updates on a timer as phase boundaries pass (08:30 CT prep
   * transition, RTH open/close, 20:00 ET extended-hours close).
   *
   * Exposed as a primitive string union so consumers can write
   * `session === 'regular'` without triggering false re-renders
   * (rerender-derived-state). FE-STATE-002.
   */
  session: MarketSession;
  /**
   * Convenience alias — true iff `session === 'regular'`. Preserved for
   * backward compatibility with consumers that historically checked
   * `marketOpen` before the tri-state session type existed. New code
   * should prefer `session` directly since it carries strictly more
   * information (pre-market vs after-hours vs closed). FE-STATE-002.
   */
  marketOpen: boolean;
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

/**
 * How often to re-evaluate `session` against the wall clock. 15 seconds
 * gives at most a 15s lag around phase boundaries (8:30 CT prep flip,
 * 9:30 ET regular-hours flip, 16:00 ET close, 20:00 ET extended-hours
 * end) — imperceptible to the trader and cheap even at the top of the
 * component tree. Runs unconditionally (unlike the staleness tick) so
 * `closed` → `pre-market` transitions actually fire without needing a
 * manual refresh.
 */
const SESSION_TICK_MS = 15_000;

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
  // FE-STATE-002: tri-state session. Initialized lazily from the current
  // wall clock so the first render has a meaningful value (otherwise the
  // first render would hard-code `'closed'` and the mount effect would
  // flip it, causing a gratuitous second render). The lazy initializer
  // only runs on mount per React docs — safe to call `new Date()` here.
  const [session, setSession] = useState<MarketSession>(() =>
    computeMarketSession(new Date()),
  );
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

  // Auto-refresh polling (only if owner is authenticated).
  //
  // FE-STATE-002 gate split:
  //   - QUOTES poll runs in pre-market / regular / after-hours. The SPX/VIX
  //     underlier has real extended-hours prints and the trader's 08:30 CT
  //     prep workflow depends on seeing them before RTH opens — this is the
  //     whole point of FE-STATE-002.
  //   - INTRADAY (opening-range) poll only makes sense during RTH because
  //     the opening range is a strictly 09:30-10:00 ET concept. Also gated
  //     on `!openingRangeComplete` so we stop fetching it once the 30-min
  //     window has closed.
  //
  // Effect dependency is the primitive `session` string so cheap equality
  // keeps re-runs minimal (rerender-dependencies).
  const openingRangeComplete = data.intraday?.openingRange?.complete ?? false;

  useEffect(() => {
    // Gate: session !== 'closed' — poll underlier whenever it can have
    // meaningful prints (pre-market / regular / after-hours).
    if (isOwnerRef.current && session !== 'closed') {
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

        // Opening-range refresh: RTH-only. The 30-min opening range is a
        // strictly 09:30-10:00 ET concept — fetching it in pre-market or
        // after-hours would return stale or empty data and waste quota.
        if (session === 'regular' && !openingRangeComplete) {
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
  }, [session, openingRangeComplete]);

  // FE-STATE-002: wall-clock tick that advances `session` across phase
  // boundaries. Runs unconditionally — we need `closed` → `pre-market`
  // to fire at 08:30 CT even though at 08:29 CT the session IS closed.
  // The setter only triggers a re-render when the value actually changes
  // (React bails out on Object.is equality for primitive state), so this
  // is cheap in steady state.
  useEffect(() => {
    const id = setInterval(() => {
      setSession((prev) => {
        const next = computeMarketSession(new Date());
        return next === prev ? prev : next;
      });
    }, SESSION_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // FE-STATE-001 + FE-STATE-002: wall-clock tick that drives staleness
  // re-evaluation. Runs while the session is NOT closed — that covers
  // pre-market / regular / after-hours so stale-badge semantics match
  // the extended polling gate above. Outside those windows polling has
  // intentionally stopped, `quotesLastUpdated` is no longer updating,
  // and a stale badge would be pure noise overnight.
  //
  // Fires once immediately so the first render after a session flip has
  // a meaningful clock value, then every STALENESS_TICK_MS thereafter.
  // Setter lives inside the effect so `Date.now()` is only called from
  // outside the render path — this keeps the hook pure per React's
  // idempotence rule.
  useEffect(() => {
    // Gate: session !== 'closed' — matches the polling gate so the
    // staleness badge is only meaningful while we're actually trying
    // to fetch quotes.
    if (session === 'closed') {
      setNowForStaleness(null);
      return;
    }
    setNowForStaleness(Date.now());
    const id = setInterval(() => {
      setNowForStaleness(Date.now());
    }, STALENESS_TICK_MS);
    return () => clearInterval(id);
  }, [session]);

  const hasData =
    data.quotes != null || data.intraday != null || data.yesterday != null;

  // FE-STATE-001 + FE-STATE-002: derived staleness flags. Only meaningful
  // when:
  //   (a) session is not closed (polling is expected to run), AND
  //   (b) quotes have been fetched at least once, AND
  //   (c) the tick has populated `nowForStaleness`.
  // All three conditions null-out the flags so consumers get `false`
  // rather than a positive stale signal during startup or overnight.
  //
  // Gate: session !== 'closed' — staleness has to apply in pre-market /
  // after-hours too, otherwise the 08:30 CT prep workflow would never
  // see a degraded-polling warning.
  let isStale = false;
  let isVeryStale = false;
  let staleAgeSec: number | null = null;
  if (
    session !== 'closed' &&
    quotesLastUpdated != null &&
    nowForStaleness != null
  ) {
    const ageMs = nowForStaleness - new Date(quotesLastUpdated).getTime();
    isStale = ageMs >= STALE_THRESHOLD_MS;
    isVeryStale = ageMs >= VERY_STALE_THRESHOLD_MS;
    staleAgeSec = Math.max(0, Math.round(ageMs / 1000));
  }

  // FE-STATE-002: backward-compat `marketOpen` alias. Historically
  // consumers checked `data.quotes?.marketOpen` or the hook-level
  // `marketOpen` to gate RTH-only UI. Preserving this means existing
  // call sites that haven't been migrated to `session` keep working.
  const marketOpen = session === 'regular';

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
    session,
    marketOpen,
  };
}
