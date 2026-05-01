/**
 * useGexPerStrike — fetches /api/gex-per-strike for the GexPerStrike widget.
 *
 * Returns per-strike 0DTE GEX data plus scrub controls so the user can step
 * backwards/forwards through previous snapshots without leaving the page.
 * Owner-only — skips polling for public visitors.
 *
 * Effect dispatch (in priority order):
 *   1. Not owner          → no fetch.
 *   2. Scrubbed           → fetch the exact snapshot once, no polling.
 *   3. Past date          → fetch latest for that date once, no polling.
 *   4. Today, market open → fetch + poll every POLL_INTERVALS.GEX_STRIKE.
 *   5. Today, market closed → fetch once, no polling.
 *
 * This hook deliberately does NOT take `selectedTime` from the calculator.
 * The time picker in `useAppState` is an "as-of" control for the Black-Scholes
 * math, not a scrub control for the GEX panel — the scrub buttons are. Coupling
 * this hook to `selectedTime` would make polling refetch the same stale
 * snapshot every cycle (since `selectedTime` defaults to the minute the page
 * loaded at and doesn't auto-advance), causing the panel to appear frozen.
 *
 * The hook also owns its own `selectedDate` state, decoupled from the
 * calculator's `vix.selectedDate`. The GEX panel is a live/backtest browsing
 * tool — picking a past date in GEX should not re-anchor the Black-Scholes
 * math in the calculator, and vice versa. The `initialDate` parameter only
 * seeds the initial value; after that, `setSelectedDate` from the return is
 * the only way to change it.
 *
 * Live-ness has TWO independent signals:
 *   - The dispatch ladder above decides whether the panel is *trying* to be
 *     live (i.e., whether `setInterval` is running).
 *   - A wall-clock freshness check (STALE_THRESHOLD_MS) decides whether the
 *     displayed snapshot is *actually* live. This is defense-in-depth — it
 *     catches the case where polling silently fails (network error,
 *     backgrounded tab throttling) and prevents the badge from lying.
 *
 * The server returns `timestamps[]` (every snapshot for the day, ascending),
 * which the hook caches so prev/next can step through them without an extra
 * round trip.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { getETToday } from '../utils/timezone';
import { useScrubController } from './useScrubController';
import { useWallClockFreshness } from './useWallClockFreshness';
import { usePolling } from './usePolling';

/**
 * A snapshot is considered "live" only if its timestamp is within this many
 * milliseconds of the wall clock. Generous enough to absorb a missed poll
 * (POLL_INTERVALS.GEX_STRIKE is 60s) without flickering.
 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Cadence for the wall-clock re-render ticker. Half the freshness threshold
 * so the badge flips within ~30s of going stale, but light enough that the
 * resulting re-renders are negligible.
 */
const WALL_CLOCK_TICK_MS = 30 * 1000;

export interface GexStrikeLevel {
  strike: number;
  price: number;
  // Gamma — OI (standing position)
  callGammaOi: number;
  putGammaOi: number;
  netGamma: number;
  // Gamma — volume (today's flow)
  callGammaVol: number;
  putGammaVol: number;
  netGammaVol: number;
  // Vol vs OI reinforcement signal
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
  // Gamma — directionalized (bid/ask)
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
  // Charm — OI
  callCharmOi: number;
  putCharmOi: number;
  netCharm: number;
  // Charm — volume
  callCharmVol: number;
  putCharmVol: number;
  netCharmVol: number;
  // Delta (DEX) — OI only, no vol variant from UW
  callDeltaOi: number;
  putDeltaOi: number;
  netDelta: number;
  // Vanna — OI
  callVannaOi: number;
  putVannaOi: number;
  netVanna: number;
  // Vanna — volume
  callVannaVol: number;
  putVannaVol: number;
  netVannaVol: number;
}

/**
 * One prior per-strike snapshot within the requested ?window=<N>m on the
 * active date. Populated when `useGexPerStrike` is called with
 * `includeWindow: true` — otherwise always empty. Consumers use these to
 * seed their own rolling Δ% / flow-signal buffers on scrub, instead of
 * waiting for a live stream to accumulate.
 */
export interface GexWindowSnapshot {
  timestamp: string;
  strikes: GexStrikeLevel[];
}

/** Options bag for `useGexPerStrike`. */
export interface UseGexPerStrikeOptions {
  /**
   * Seed date — same contract as the historical positional argument. If
   * provided, seeds `selectedDate` once at mount; after that, the returned
   * `setSelectedDate` is the only way to change it.
   */
  initialDate?: string;
  /**
   * When `true`, request `?window=5m` alongside each fetch and expose the
   * prior snapshots on the return as `windowSnapshots`. Default `false` so
   * the analyze path and other consumers don't pay the extra query / bytes.
   */
  includeWindow?: boolean;
}

export interface UseGexPerStrikeReturn {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  /** Timestamp currently being displayed (latest if live, scrub ts if scrubbing) */
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending */
  timestamps: string[];
  /**
   * Prior per-strike snapshots within the requested `?window=Nm` window
   * preceding the currently displayed `timestamp`. Empty unless the caller
   * opted in via `includeWindow: true`.
   */
  windowSnapshots: GexWindowSnapshot[];
  /** The date currently being viewed (YYYY-MM-DD in ET), panel-local state */
  selectedDate: string;
  /** Change the viewed date. Clears scrub state as a side effect. */
  setSelectedDate: (date: string) => void;
  /**
   * True when the displayed snapshot is genuinely live: not scrubbed, market
   * is open, and we're viewing today's data. False during after-hours or when
   * looking at a historical date — those are backtest views.
   */
  isLive: boolean;
  /** True when `selectedDate` equals today's ET date. */
  isToday: boolean;
  /** True when the user has explicitly stepped backwards from the latest snapshot */
  isScrubbed: boolean;
  /** True when there is at least one earlier snapshot the user can scrub to */
  canScrubPrev: boolean;
  /** True when the user is currently scrubbed and can step forward */
  canScrubNext: boolean;
  /** Step one snapshot earlier */
  scrubPrev: () => void;
  /** Step one snapshot later (clears scrub when at the latest) */
  scrubNext: () => void;
  /** Jump directly to a specific snapshot timestamp. */
  scrubTo: (ts: string) => void;
  /**
   * Resume live mode. Clears scrub state AND resets `selectedDate` to today
   * if viewing a past date — the "Live" control is the single way back to
   * the present across both scrub and backtest dimensions.
   */
  scrubLive: () => void;
  refresh: () => void;
}

/**
 * The second argument may be either the legacy `initialDate` string or
 * a `UseGexPerStrikeOptions` bag. Both forms stay supported so existing
 * call sites don't churn; new consumers pass the options object to opt
 * into `includeWindow`.
 */
export function useGexPerStrike(
  marketOpen: boolean,
  initialDateOrOptions?: string | UseGexPerStrikeOptions,
): UseGexPerStrikeReturn {
  const options: UseGexPerStrikeOptions =
    typeof initialDateOrOptions === 'string'
      ? { initialDate: initialDateOrOptions }
      : (initialDateOrOptions ?? {});
  const { initialDate, includeWindow = false } = options;
  const isOwner = checkIsOwner();
  const [strikes, setStrikes] = useState<GexStrikeLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const [windowSnapshots, setWindowSnapshots] = useState<GexWindowSnapshot[]>(
    [],
  );
  // Panel-local date state. `initialDate` only seeds this once at mount;
  // after that, `setSelectedDate` (exposed in the return) is the only way
  // to change it. Production does not pass `initialDate` and lets the hook
  // default to today. Tests pass a fixed date to exercise the branches
  // deterministically.
  const [selectedDate, setSelectedDate] = useState<string>(
    () => initialDate ?? getETToday(),
  );
  const mountedRef = useRef(true);

  // Scrub state machine — extracted to `useScrubController`. Owns the
  // pinned `scrubTimestamp` plus prev/next/to/live transitions.
  const scrub = useScrubController(timestamps);
  const { scrubTimestamp, isScrubbed } = scrub;

  // `todayET` recomputes each render so the panel flips from LIVE → BACKTEST
  // at the midnight-ET session boundary without needing an explicit state
  // update. The `isToday` comparison then drives the dispatch ladder.
  const todayET = getETToday();
  const isToday = selectedDate === todayET;

  const fetchData = useCallback(
    async (tsOverride?: string | null, externalSignal?: AbortSignal) => {
      try {
        const qs = new URLSearchParams();
        // Always send the date so the server doesn't have to guess ET.
        // The hook always has a concrete date in state (never undefined).
        qs.set('date', selectedDate);
        if (tsOverride) qs.set('ts', tsOverride);
        if (includeWindow) qs.set('window', '5m');
        const params = qs.size > 0 ? `?${qs}` : '';
        // Combine the effect-cleanup signal with the original 5s timeout so
        // we still abort stale requests on date change AND cap request duration.
        const signal = externalSignal
          ? AbortSignal.any([externalSignal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000);
        const res = await fetch(`/api/gex-per-strike${params}`, {
          credentials: 'same-origin',
          signal,
        });

        if (!mountedRef.current) return;

        if (!res.ok) {
          if (res.status !== 401) setError('Failed to load GEX data');
          return;
        }

        const data = (await res.json()) as {
          strikes: GexStrikeLevel[];
          timestamp: string | null;
          timestamps?: string[];
          windowSnapshots?: GexWindowSnapshot[];
        };

        if (!mountedRef.current) return;

        setStrikes(data.strikes);
        setTimestamp(data.timestamp);
        setTimestamps(data.timestamps ?? []);
        setWindowSnapshots(data.windowSnapshots ?? []);
        setError(null);
      } catch (err) {
        // Intentional abort from effect cleanup — not an error worth surfacing.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mountedRef.current) setError(getErrorMessage(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [selectedDate, includeWindow],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset scrub state whenever the active date changes — the previous date's
  // scrub timestamp is meaningless against a different day's snapshot list.
  // (`useScrubController` also defensively clears the pin if it disappears
  // from the timestamps array, but we want the clear to fire eagerly on date
  // change even when fixtures or caches happen to share the same ts string.)
  const clearScrub = scrub.scrubLive;
  useEffect(() => {
    clearScrub();
  }, [selectedDate, clearScrub]);

  // Eager dispatch effect — owns one-shot fetches and the AbortController
  // that aborts in-flight requests on dep change. The recurring interval has
  // been extracted to `usePolling` below; this effect stops at the eager
  // fetch for the live-polling branch and lets `usePolling` carry the
  // recurring tick. Both share the same controller via `pollAbortRef` so
  // that gate flips abort interval-fired fetches just like the legacy code
  // (race-prevention for stale responses overwriting fresh state).
  const pollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    // Live-polling branch shares this controller with `usePolling` so an
    // interval-fired fetch in flight is aborted on the same dep flip that
    // tears down the eager-fetch path. Other branches don't poll, so the
    // ref is cleared after the eager fetch.
    pollAbortRef.current = controller;

    // Scrubbing: fetch the exact pinned snapshot, no polling. The user is
    // explicitly inspecting one moment in time.
    if (scrubTimestamp != null) {
      setLoading(true);
      fetchData(scrubTimestamp, signal);
      return () => controller.abort();
    }

    // Past date: one-shot fetch with the requested time, no polling — there's
    // nothing new to poll for, the day's data is fully written.
    if (!isToday) {
      setLoading(true);
      fetchData(undefined, signal);
      return () => controller.abort();
    }

    // Today, market closed: one-shot fetch. Same reasoning — no fresh
    // snapshots are being produced, polling would just hit the cache.
    if (!marketOpen) {
      setLoading(true);
      fetchData(undefined, signal);
      return () => controller.abort();
    }

    // Today, market open, not scrubbed → eager fetch now; `usePolling` below
    // handles the recurring tick. Each poll fetches the latest snapshot for
    // the day (no `?time=` param), so the displayed timestamp advances as
    // the cron writes new snapshots.
    fetchData(undefined, signal);
    return () => controller.abort();
  }, [isOwner, marketOpen, isToday, scrubTimestamp, fetchData]);

  // Live-polling tick. Gate matches the original guard
  // `!isOwner || !isToday || !marketOpen || isScrubbed → return` collapsed
  // into the conjunction `[isOwner, isToday, marketOpen, !isScrubbed]`.
  // Reuses the eager-fetch effect's AbortController via `pollAbortRef` so
  // that an interval-fired fetch in flight is aborted on the same dep flip
  // that tears down the eager fetch path — preserving the race protection
  // the legacy `setInterval`-inside-the-effect form provided for free.
  usePolling(
    () => fetchData(undefined, pollAbortRef.current?.signal),
    POLL_INTERVALS.GEX_STRIKE,
    [isOwner, isToday, marketOpen, !isScrubbed],
  );

  // Wall-clock freshness — extracted to `useWallClockFreshness`. The ticker
  // only runs while every gate is truthy: BACKTEST or scrubbed states have a
  // permanently-labeled badge, so re-rendering would be wasted work.
  //
  // Timing caveat (preserved from the original): between mount and the first
  // tick, `nowMs` is whatever `Date.now()` returned at mount. So a snapshot
  // exactly at the freshness boundary at mount can briefly read as fresh for
  // up to WALL_CLOCK_TICK_MS past its actual staleness — total worst-case
  // "fresh badge on stale data" is STALE_THRESHOLD_MS + WALL_CLOCK_TICK_MS
  // (currently 2m30s). Acceptable because the threshold is already 2x the
  // poll interval.
  const { isFresh } = useWallClockFreshness(
    timestamp != null ? new Date(timestamp).getTime() : null,
    STALE_THRESHOLD_MS,
    { gates: [isToday, marketOpen, !isScrubbed], tickMs: WALL_CLOCK_TICK_MS },
  );

  // The displayed snapshot is "live" only when (1) we're in a state where
  // polling is active AND (2) the snapshot itself is recent. The second
  // clause catches the dial-back case: polling keeps firing, but each poll
  // returns the same stale snapshot, so the wall-clock comparison flips the
  // badge to BACKTEST while leaving the polling machinery alone.
  const isLive = !isScrubbed && marketOpen && isToday && isFresh;

  const { canScrubPrev, canScrubNext, scrubPrev, scrubNext, scrubTo } = scrub;

  const scrubLive = useCallback(() => {
    // Reset to live mode on both axes: clear scrub AND snap date back to
    // today. If the user was on a past date, this also kicks the dispatch
    // ladder into live polling via the `isToday` check. If they were
    // already on today with just scrub active, the date setter is a no-op
    // (state equality).
    scrub.scrubLive();
    setSelectedDate((cur) => {
      const today = getETToday();
      return cur === today ? cur : today;
    });
  }, [scrub]);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchData(scrubTimestamp ?? undefined);
  }, [fetchData, scrubTimestamp]);

  return {
    strikes,
    loading,
    error,
    timestamp,
    timestamps,
    windowSnapshots,
    selectedDate,
    setSelectedDate,
    isLive,
    isToday,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    refresh,
  };
}
