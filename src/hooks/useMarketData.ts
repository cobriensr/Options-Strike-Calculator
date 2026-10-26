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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { checkIsOwner } from '../utils/auth';
import { usePolling } from './usePolling';
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
export type MarketSession = 'pre-market' | 'regular' | 'after-hours' | 'closed';

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
  /**
   * Epoch milliseconds of the last successful fetch on any endpoint.
   * Canonical freshness field per the project's `fetchedAt` convention -
   * the old `lastUpdated: string | null` (ISO) was renamed to align with
   * `useFuturesData` / `useDarkPoolLevels` / `useMLInsights`. Consumers
   * that previously called `new Date(lastUpdated)` can now drop the wrap.
   */
  fetchedAt: number | null;
  /**
   * Timestamp of last successful fetch of the /api/quotes endpoint
   * specifically. Distinct from `fetchedAt` because events/movers/
   * yesterday have their own cadences and shouldn't affect quote
   * freshness. Epoch ms (canonical), matching `fetchedAt`. FE-STATE-001.
   *
   * Staleness (`isStale` / `isVeryStale` / `staleAgeSec`) is derived from
   * this by `useQuoteStaleness`, called inside the header's quote badge.
   * It is not part of this hook's return: its 5 s wall-clock tick would
   * give the memoised return a new identity on every tick and re-render
   * the whole panel tree (F1).
   */
  quotesFetchedAt: number | null;
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
 * How often to re-evaluate `session` against the wall clock. 15 seconds
 * gives at most a 15s lag around phase boundaries (8:30 CT prep flip,
 * 9:30 ET regular-hours flip, 16:00 ET close, 20:00 ET extended-hours
 * end) — imperceptible to the trader and cheap even at the top of the
 * component tree, because the setter bails out unless the phase changes.
 * Runs unconditionally so `closed` → `pre-market` transitions actually
 * fire without needing a manual refresh.
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
  // AUD-M16: mirror the latest `data` on a ref so `fetchAll` can feed the
  // current snapshot to `processEndpointResults` (which carries-forward
  // non-updated endpoints) WITHOUT depending on `data` in its dep array.
  // Keeping `fetchAll` identity stable preserves the original behavior where
  // the mount effect fires exactly once and `refresh` is referentially
  // stable for consumers. Previously this carry-forward was done via the
  // functional `setData(prev => …)` updater; moving side effects out of the
  // updater (so it stays pure under StrictMode double-invoke) means we read
  // `prev` from this ref instead.
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // FE-STATE-001: track quotes-endpoint freshness independently. `fetchedAt`
  // reflects ANY successful endpoint; the staleness badge needs to reflect
  // the /api/quotes endpoint specifically since that's what drives hedge
  // pricing and calculator inputs.
  const [quotesFetchedAt, setQuotesFetchedAt] = useState<number | null>(null);
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
  //
  // AUD-M17: owner status is STATE (mirrored on a ref) rather than a bare
  // ref. The polling gate `[isOwner, session !== 'closed']` must re-evaluate
  // when a visitor who was public at mount authenticates in another tab and
  // a later fetch returns 200 — a bare ref mutated in `fetchAll` would flip
  // silently without re-rendering, so usePolling would never (re)start. The
  // ref mirror lets `fetchAll` read the latest value without being recreated.
  const [isOwner, setIsOwner] = useState<boolean>(() => checkIsOwner());
  const isOwnerRef = useRef(isOwner);
  isOwnerRef.current = isOwner;
  // AUD-M16 / AUD-M17: consecutive-failure streak is STATE (mirrored on a
  // ref). State so that crossing the backoff threshold re-renders and
  // usePolling re-schedules at the doubled cadence (a bare ref read at
  // render never re-renders, so the documented backoff was dead code). The
  // ref mirror lets the mount-fetch and the poll tick read/update the latest
  // streak without recreating `fetchAll`. Mirrors useChainData's pattern.
  const [consecutiveFails, setConsecutiveFails] = useState(0);
  const consecutiveFailsRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const results = await fetchAllEndpoints();

    // AUD-M16: process results and run ALL side effects OUTSIDE the setData
    // updater. The updater must be pure (return new state only) — under
    // React StrictMode the updater is invoked twice, so any side effect
    // inside it (ref mutation, nested setState, Date.now()) would run twice
    // per fetch, e.g. double-incrementing the fail streak and halving the
    // backoff threshold.
    const { nextData, anySuccess, anyAuthError, quotesSuccess } =
      processEndpointResults(dataRef.current, results);

    // Only show needsAuth if the user previously had data (was authenticated)
    // but now gets 401s. Don't show it for public visitors who never auth'd.
    // Read the ref BEFORE updating it so we can detect the transition.
    setNeedsAuth(anyAuthError && !anySuccess && isOwnerRef.current);

    if (anySuccess && !isOwnerRef.current) {
      isOwnerRef.current = true;
      setIsOwner(true);
    }

    if (anySuccess) {
      if (consecutiveFailsRef.current !== 0) {
        consecutiveFailsRef.current = 0;
        setConsecutiveFails(0);
      }
    } else if (!anyAuthError) {
      // Only count as a failure if it wasn't just a 401 (public visitor)
      const next = consecutiveFailsRef.current + 1;
      consecutiveFailsRef.current = next;
      setConsecutiveFails(next);
    }

    const now = Date.now();
    if (anySuccess) {
      setFetchedAt(now);
    }
    // FE-STATE-001: track quote-specific freshness independently.
    if (quotesSuccess) {
      setQuotesFetchedAt(now);
    }

    setData(nextData);
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
  // Extracted to `usePolling`. The gate `[isOwner, session !== 'closed']`
  // matches the original `if (isOwnerRef.current && session !== 'closed')`
  // guard, but reads `isOwner` STATE so the gate re-evaluates when a visitor
  // authenticates mid-session (AUD-M17 — a bare ref read here would never
  // restart polling).
  //
  // AUD-M17: backoff (interval doubling on 3+ consecutive failures) is driven
  // by `consecutiveFails` STATE, not the ref. The ref read at render never
  // re-rendered, so the doubled interval never reached usePolling — the
  // documented backoff was dead code. With state, crossing the threshold
  // re-renders, `backoff` recomputes, and usePolling re-schedules. The poll
  // tick below also feeds the fail counter (previously only the mount/refresh
  // path did), so a failing poll can actually engage the backoff.
  const openingRangeComplete = data.intraday?.openingRange?.complete ?? false;
  const backoff = consecutiveFails >= 3 ? 2 : 1;

  usePolling(
    () => {
      // Track per-endpoint outcomes so we can (a) update `quotesFetchedAt`
      // independently of `fetchedAt`, (b) only advance freshness on success
      // (AUD-M18), and (c) feed the consecutive-failure counter (AUD-M17).
      let quotesSucceeded = false;
      let quotesAuthError = false;
      const fetches: Promise<void>[] = [
        fetchJson<QuotesResponse>('/api/quotes').then((result) => {
          if ('data' in result) {
            quotesSucceeded = true;
            setData((prev) => ({ ...prev, quotes: result.data }));
          } else if (result.status === 401) {
            quotesAuthError = true;
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
        // AUD-M18: only advance freshness fields on a successful quotes
        // fetch. The contract says `fetchedAt` is the "last successful"
        // fetch; bumping it after an all-failed poll would mask a stale
        // feed and suppress the staleness badge.
        if (quotesSucceeded) {
          // Both freshness fields use epoch ms (canonical fetchedAt shape).
          const now = Date.now();
          setFetchedAt(now);
          setQuotesFetchedAt(now);
        }

        // AUD-M17: drive the consecutive-failure counter from the poll path
        // so backoff can actually engage. Reset on success; increment only
        // on a genuine failure (not a 401, which is just a public visitor or
        // an expired session — neither is a transient error worth backing
        // off for). The quotes endpoint is the gating signal here since it
        // runs in every poll.
        if (quotesSucceeded) {
          if (consecutiveFailsRef.current !== 0) {
            consecutiveFailsRef.current = 0;
            setConsecutiveFails(0);
          }
        } else if (!quotesAuthError) {
          const next = consecutiveFailsRef.current + 1;
          consecutiveFailsRef.current = next;
          setConsecutiveFails(next);
        }
      });
    },
    REFRESH_INTERVAL_MS * backoff,
    [isOwner, session !== 'closed'],
  );

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

  const hasData =
    data.quotes != null || data.intraday != null || data.yesterday != null;

  // FE-STATE-002: backward-compat `marketOpen` alias. Historically
  // consumers checked `data.quotes?.marketOpen` or the hook-level
  // `marketOpen` to gate RTH-only UI. Preserving this means existing
  // call sites that haven't been migrated to `session` keep working.
  const marketOpen = session === 'regular';

  // AUD-H6: stabilize the returned object's identity so a parent `useMemo`
  // keyed on it (App.tsx's panelMap memo barrier) holds when the underlying
  // data hasn't changed. Every field below is already individually
  // render-stable — `data` / `loading` / `needsAuth` / `fetchedAt` /
  // `quotesFetchedAt` / `session` are useState values, `fetchAll` is a
  // useCallback, and `hasData` / `marketOpen` are derived primitives. Only
  // the object literal wrapper was churning its reference every render;
  // useMemo holds it constant until one of the listed deps changes. Values
  // and semantics are unchanged.
  //
  // F1: keep wall-clock-derived values (like quote age) OUT of this return.
  // A periodic tick here changes the identity on every tick and re-renders
  // the whole panel tree; derive them in the leaf that displays them, as
  // useQuoteStaleness does for the header badge.
  return useMemo(
    () => ({
      data,
      loading,
      hasData,
      needsAuth,
      refresh: fetchAll,
      fetchedAt,
      quotesFetchedAt,
      session,
      marketOpen,
    }),
    [
      data,
      loading,
      hasData,
      needsAuth,
      fetchAll,
      fetchedAt,
      quotesFetchedAt,
      session,
      marketOpen,
    ],
  );
}
