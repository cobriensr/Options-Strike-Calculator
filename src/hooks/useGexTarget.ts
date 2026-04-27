/**
 * useGexTarget — fetches /api/gex-target-history for the GexTarget widget.
 *
 * Returns the three parallel per-mode `TargetScore` payloads (OI / VOL / DIR),
 * plus the SPX 1-minute candles and scrub controls the panel needs to render
 * its five sub-panels. Owner-only — skips polling for public visitors.
 *
 * **Three-mode contract.** The Phase 5 endpoint computes and returns all
 * three modes for every snapshot. This hook passes them through as three
 * separate fields (`oi`, `vol`, `dir`) rather than picking one based on a
 * "current mode" parameter. The component is responsible for deciding which
 * mode to render. Switching modes is therefore a pure UI toggle with no
 * refetch, which matters both for ML fidelity (we always have all three)
 * and for test reuse (mode toggle is not a hook concern).
 *
 * Effect dispatch:
 *   1. Not owner          → no fetch.
 *   2. Date change        → bulk-load all snapshots (`?all=true`), populate cache.
 *   3. Live polling       → setInterval fires `fetchData` when market is open,
 *                           today, and not scrubbed; updates cache on each poll.
 *   4. Scrub              → instant from cache; fallback single fetch on miss.
 *
 * Like `useGexPerStrike`, this hook owns its own `selectedDate` state —
 * the GexTarget panel is a live/backtest browsing tool, and picking a past
 * date here should NOT re-anchor the calculator's Black-Scholes math. The
 * `initialDate` parameter only seeds the state once at mount; after that,
 * the returned `setSelectedDate` is the only way to change it. Production
 * passes no `initialDate`; tests pass a fixed date for deterministic
 * branch coverage.
 *
 * Live-ness has TWO independent signals:
 *   - The dispatch ladder decides whether the panel is *trying* to be
 *     live (i.e., whether `setInterval` is running).
 *   - A wall-clock freshness check (STALE_THRESHOLD_MS) decides whether
 *     the displayed snapshot is *actually* live. This is defense-in-depth
 *     — it catches the case where polling silently fails (network error,
 *     backgrounded tab throttling) and prevents the badge from lying.
 *
 * The server returns `timestamps[]` (every snapshot for the day, ascending)
 * and `availableDates[]` (every date with rows in `gex_target_features`).
 * Both are cached so the scrubber and the date picker can operate without
 * extra round-trips.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { getETToday } from '../utils/timezone';
import type { TargetScore } from '../utils/gex-target';

/**
 * A snapshot is considered "live" only if its timestamp is within this many
 * milliseconds of the wall clock. Generous enough to absorb a missed poll
 * (POLL_INTERVALS.GEX_TARGET is 60s) without flickering.
 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Cadence for the wall-clock re-render ticker. Half the freshness threshold
 * so the badge flips within ~30s of going stale, but light enough that the
 * resulting re-renders are negligible.
 */
const WALL_CLOCK_TICK_MS = 30 * 1000;

/**
 * SPX 1-minute candle as returned by the /api/gex-target-history endpoint.
 * Mirrors the shape defined server-side in `api/_lib/spx-candles.ts` — kept
 * as a local frontend copy so the hook doesn't cross the `src/` -> `api/`
 * import boundary.
 */
export interface SPXCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Epoch ms (start_time of the 1-minute bar). */
  datetime: number;
}

/**
 * Single snapshot as returned inside the bulk `?all=true` response.
 * Local frontend copy -- mirrors the server-side shape without crossing the
 * `src/` -> `api/` import boundary.
 */
interface BulkSnapshot {
  timestamp: string;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
}

/**
 * Response payload shape from `GET /api/gex-target-history?all=true`. Local
 * copy kept in sync with the server-side canonical definition.
 */
interface GexTargetBulkResponse {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  candles: SPXCandle[];
  previousClose: number | null;
  snapshots: BulkSnapshot[];
}

/**
 * Response payload shape from `GET /api/gex-target-history`. Local copy of
 * the server-side `GexTargetHistoryResponse` interface -- keeping the two in
 * sync is part of Phase 6 maintenance. See `api/gex-target-history.ts` for
 * the canonical definition and per-field semantics.
 */
interface GexTargetHistoryResponse {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  timestamp: string | null;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
  candles: SPXCandle[];
  previousClose: number | null;
}

export interface UseGexTargetReturn {
  // -- Three-mode parallel results
  /** OI-mode TargetScore for the displayed snapshot, or null when empty. */
  oi: TargetScore | null;
  /** VOL-mode TargetScore for the displayed snapshot, or null when empty. */
  vol: TargetScore | null;
  /** DIR-mode TargetScore for the displayed snapshot, or null when empty. */
  dir: TargetScore | null;

  // -- Snapshot context
  /** Spot price at the displayed snapshot, or null when no data. */
  spot: number | null;
  /** Timestamp currently being displayed (latest if live, scrub ts if scrubbing). */
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending. */
  timestamps: string[];
  /** Regular-session SPX 1-minute candles for the active date, ascending. */
  candles: SPXCandle[];
  /**
   * Candles visible at the current scrub position -- filtered to <= scrubTimestamp.
   * Equals `candles` when live (not scrubbed).
   */
  visibleCandles: SPXCandle[];
  /** Previous session close (SPX), or null if not available. */
  previousClose: number | null;
  /**
   * Strike with the highest call-volume dominance in the OI leaderboard of
   * the first (opening) snapshot for the active date. Derived from the strike
   * with the most positive `callRatio` = (callVol - putVol) / (callVol + putVol).
   * Null until the bulk load resolves.
   */
  openingCallStrike: number | null;
  /**
   * Strike with the highest put-volume dominance (most negative `callRatio`)
   * in the OI leaderboard of the first snapshot. Null until bulk load resolves.
   */
  openingPutStrike: number | null;

  // -- Date browsing (panel-local)
  /** The date currently being viewed (YYYY-MM-DD in ET), panel-local state. */
  selectedDate: string;
  /** Change the viewed date. Clears scrub state as a side effect. */
  setSelectedDate: (date: string) => void;
  /** Every distinct trading date present in `gex_target_features`, ascending. */
  availableDates: string[];

  // -- Live / scrubbed state
  /**
   * True when the displayed snapshot is genuinely live: not scrubbed, market
   * is open, we're viewing today's data, AND the snapshot is within the
   * freshness threshold. False during after-hours or when looking at a
   * historical date -- those are backtest views.
   */
  isLive: boolean;
  /** True when `selectedDate` equals today's ET date. */
  isToday: boolean;
  /** True when the user has explicitly stepped backwards from the latest snapshot. */
  isScrubbed: boolean;
  /** True when there is at least one earlier snapshot the user can scrub to. */
  canScrubPrev: boolean;
  /** True when the user is currently scrubbed and can step forward. */
  canScrubNext: boolean;
  /** Step one snapshot earlier. */
  scrubPrev: () => void;
  /** Step one snapshot later (clears scrub when at the latest). */
  scrubNext: () => void;
  /** Jump directly to a specific snapshot timestamp. */
  scrubTo: (ts: string) => void;
  /**
   * Resume live mode. Clears scrub state AND resets `selectedDate` to today
   * if viewing a past date -- the "Live" control is the single way back to
   * the present across both scrub and backtest dimensions.
   */
  scrubLive: () => void;

  // -- Status
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Filter candles to the regular SPX session: 8:30 AM – 3:00 PM CT.
 *
 * The DB cron occasionally stores early bars (9:00 AM ET = 8:00 AM CT)
 * tagged as regular-session by the UW source. This client-side guard
 * ensures the price chart never shows pre-market or post-market bars,
 * consistent with the user's 8:30–15:00 CT requirement. DST is handled
 * automatically by the `America/Chicago` timezone identifier.
 */
function filterRegularSessionCT(candles: SPXCandle[]): SPXCandle[] {
  return candles.filter((c) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(new Date(c.datetime));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const mins = hour * 60 + minute;
    // 8:30 AM CT = 510 min, 3:00 PM CT = 900 min (exclusive)
    return mins >= 510 && mins < 900;
  });
}

export function useGexTarget(
  marketOpen: boolean,
  initialDate?: string,
): UseGexTargetReturn {
  const isOwner = checkIsOwner();

  // -- Per-snapshot data
  const [oi, setOi] = useState<TargetScore | null>(null);
  const [vol, setVol] = useState<TargetScore | null>(null);
  const [dir, setDir] = useState<TargetScore | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const [candles, setCandles] = useState<SPXCandle[]>([]);
  const [previousClose, setPreviousClose] = useState<number | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  // -- Status
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- Scrub / date state
  const [scrubTimestamp, setScrubTimestamp] = useState<string | null>(null);
  // Panel-local date state. `initialDate` only seeds this once at mount;
  // after that, `setSelectedDate` (exposed in the return) is the only way
  // to change it. Production does not pass `initialDate` and lets the hook
  // default to today. Tests pass a fixed date to exercise the branches
  // deterministically.
  const [selectedDate, setSelectedDate] = useState<string>(
    () => initialDate ?? getETToday(),
  );

  // Wall-clock state -- refreshed every WALL_CLOCK_TICK_MS by a separate
  // effect. The freshness check below reads `nowMs` rather than calling
  // `Date.now()` inline so the re-render dependency is explicit and testable
  // under fake timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(true);
  /** Cache of every snapshot loaded for the current date (keyed by timestamp). */
  const allSnapshotsRef = useRef<Map<string, BulkSnapshot>>(new Map());
  const [openingCallStrike, setOpeningCallStrike] = useState<number | null>(
    null,
  );
  const [openingPutStrike, setOpeningPutStrike] = useState<number | null>(null);

  // `todayET` recomputes each render so the panel flips from LIVE -> BACKTEST
  // at the midnight-ET session boundary without needing an explicit state
  // update. The `isToday` comparison then drives the dispatch ladder.
  const todayET = getETToday();
  const isToday = selectedDate === todayET;
  const isScrubbed = scrubTimestamp != null;

  const fetchData = useCallback(
    async (tsOverride?: string | null) => {
      try {
        const qs = new URLSearchParams();
        // Always send the date so the server doesn't have to infer ET.
        // The hook always has a concrete date in state (never undefined).
        qs.set('date', selectedDate);
        if (tsOverride) qs.set('ts', tsOverride);
        const res = await fetch(`/api/gex-target-history?${qs}`, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(5_000),
        });

        if (!mountedRef.current) return;

        if (!res.ok) {
          // 401 is the owner check -- silently swallow so guest visitors
          // don't see a scary error. Everything else is a real failure.
          if (res.status !== 401) setError('Failed to load GexTarget data');
          return;
        }

        const data = (await res.json()) as GexTargetHistoryResponse;

        if (!mountedRef.current) return;

        // Three parallel modes -- always written as a triple so a successful
        // fetch never leaves a stale mix of old/new across the three fields.
        setOi(data.oi);
        setVol(data.vol);
        setDir(data.dir);
        setSpot(data.spot);
        setTimestamp(data.timestamp);
        setTimestamps(data.timestamps ?? []);
        setCandles(filterRegularSessionCT(data.candles ?? []));
        setPreviousClose(data.previousClose);
        setAvailableDates(data.availableDates ?? []);
        setError(null);
      } catch (err) {
        if (mountedRef.current) setError(getErrorMessage(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [selectedDate],
  );

  /**
   * Bulk-loads every snapshot for `selectedDate` in a single request
   * (`?all=true`). Called once per date change. Populates `allSnapshotsRef`
   * so that scrubbing is served from the local cache without per-step fetches.
   */
  const fetchAllSnapshots = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('date', selectedDate);
      qs.set('all', 'true');
      const res = await fetch(`/api/gex-target-history?${qs}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(10_000),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load GexTarget data');
        return;
      }
      const data = (await res.json()) as GexTargetBulkResponse;
      if (!mountedRef.current) return;

      // Populate snapshot cache
      const cache = new Map<string, BulkSnapshot>();
      for (const snap of data.snapshots ?? []) {
        cache.set(snap.timestamp, snap);
      }
      allSnapshotsRef.current = cache;

      // Per-day fields — filter candles to 8:30 AM–3:00 PM CT only
      setCandles(filterRegularSessionCT(data.candles ?? []));
      setPreviousClose(data.previousClose);
      setTimestamps(data.timestamps ?? []);
      setAvailableDates(data.availableDates ?? []);

      // Opening walls: from the first snapshot's OI leaderboard, find the
      // strike with the largest dealer call-gamma-OI exposure (Call Wall)
      // and the largest dealer put-gamma-OI exposure (Put Wall). In
      // OI mode, callGexDollars and putGexDollars are UW's gamma × OI
      // dollar-weighted exposures — exactly where dealer hedging pressure
      // concentrates, so price tends to gravitate toward or pin at these
      // strikes. `Math.abs` normalizes sign conventions across the two
      // fields. The walls stay fixed for the day so the price chart can
      // draw static reference lines.
      const firstSnap = (data.snapshots ?? [])[0] ?? null;
      if (firstSnap?.oi?.leaderboard && firstSnap.oi.leaderboard.length > 0) {
        const board = firstSnap.oi.leaderboard;
        let maxCallGex = -Infinity;
        let maxPutGex = -Infinity;
        let callStrike: number | null = null;
        let putStrike: number | null = null;
        for (const row of board) {
          const callMag = Math.abs(row.features.callGexDollars);
          const putMag = Math.abs(row.features.putGexDollars);
          if (callMag > maxCallGex) {
            maxCallGex = callMag;
            callStrike = row.strike;
          }
          if (putMag > maxPutGex) {
            maxPutGex = putMag;
            putStrike = row.strike;
          }
        }
        setOpeningCallStrike(callStrike);
        setOpeningPutStrike(putStrike);
      } else {
        setOpeningCallStrike(null);
        setOpeningPutStrike(null);
      }

      // Set state from latest snapshot
      const latest = (data.snapshots ?? []).at(-1) ?? null;
      setOi(latest?.oi ?? null);
      setVol(latest?.vol ?? null);
      setDir(latest?.dir ?? null);
      setSpot(latest?.spot ?? null);
      setTimestamp(latest?.timestamp ?? null);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset scrub state whenever the active date changes -- the previous date's
  // scrub timestamp is meaningless against a different day's snapshot list.
  useEffect(() => {
    setScrubTimestamp(null);
  }, [selectedDate]);

  // Effect 1 -- Bulk load (fires on date change or market-open transition).
  // Clears the stale cache and fetches all snapshots for the new date in one
  // request. This sets the initial state from the latest snapshot and
  // pre-populates the cache for instant scrubbing.
  //
  // Skips the fetch when viewing today but the market is not open: weekends
  // and pre/post-session times have no live snapshots, so hitting the server
  // only produces noise. `marketOpen` is in the dep array so the effect
  // re-fires automatically when the session starts (e.g. user had the page
  // open before 9:30 AM ET). Historical-date browsing is always allowed
  // because `isToday` is false for any past date.
  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    if (isToday && !marketOpen) {
      setLoading(false);
      return;
    }
    allSnapshotsRef.current = new Map(); // clear stale cache
    setLoading(true);
    void fetchAllSnapshots();
  }, [isOwner, isToday, marketOpen, selectedDate, fetchAllSnapshots]);

  // Effect 2 -- Live polling (fires when live conditions change).
  // No immediate fetchData() call here -- the bulk load already set state
  // from the latest snapshot. The interval refreshes state after one poll
  // interval elapses.
  useEffect(() => {
    if (!isOwner || !isToday || !marketOpen || isScrubbed) return;
    const id = setInterval(() => void fetchData(), POLL_INTERVALS.GEX_TARGET);
    return () => clearInterval(id);
  }, [isOwner, isToday, marketOpen, isScrubbed, fetchData]);

  // Effect 3 -- Scrub (instant from cache, fallback to fetch on cache miss).
  // Also handles exiting scrub mode: restores the latest cached snapshot so
  // `timestamp` is current and `isLive` evaluates correctly without an extra
  // network round-trip.
  useEffect(() => {
    if (!isScrubbed) {
      // Exiting scrub: restore the latest cached snapshot. Without this,
      // `timestamp` would still hold the scrubbed value (or undefined from a
      // cache-miss fallback fetch), making `isFresh` evaluate false and
      // leaving `isLive` stuck at false even after scrubLive / scrubNext.
      const latestTs = timestamps.at(-1);
      if (latestTs) {
        const latest = allSnapshotsRef.current.get(latestTs);
        if (latest) {
          setOi(latest.oi);
          setVol(latest.vol);
          setDir(latest.dir);
          setSpot(latest.spot);
          setTimestamp(latest.timestamp);
        }
      }
      return;
    }
    if (scrubTimestamp == null) return;
    const cached = allSnapshotsRef.current.get(scrubTimestamp);
    if (cached) {
      setOi(cached.oi);
      setVol(cached.vol);
      setDir(cached.dir);
      setSpot(cached.spot);
      setTimestamp(scrubTimestamp);
      setLoading(false);
    } else {
      void fetchData(scrubTimestamp);
    }
  }, [isScrubbed, scrubTimestamp, fetchData, timestamps]);

  // Wall-clock ticker -- only runs when freshness could plausibly flip. In
  // BACKTEST or scrubbed states the badge is permanently labeled, so we'd
  // just be re-rendering for nothing. The ticker re-snaps `nowMs` so the
  // freshness comparison below picks up the new wall-clock value without
  // calling `Date.now()` inline (which sonarjs flags and which makes the
  // re-render dependency invisible).
  //
  // Timing caveat: between mount and the first tick, `nowMs` is whatever
  // `Date.now()` returned at mount. So a snapshot that's exactly at the
  // freshness boundary at mount can briefly read as fresh for up to
  // WALL_CLOCK_TICK_MS past its actual staleness -- total worst-case
  // "fresh badge on stale data" is STALE_THRESHOLD_MS + WALL_CLOCK_TICK_MS
  // (currently 2m30s). Acceptable because the threshold is already 2x the
  // poll interval.
  useEffect(() => {
    if (!isToday || !marketOpen || isScrubbed) return;
    const id = setInterval(() => setNowMs(Date.now()), WALL_CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [isToday, marketOpen, isScrubbed]);

  // The displayed snapshot is "live" only when (1) we're in a state where
  // polling is active AND (2) the snapshot itself is recent. The second
  // clause catches the dial-back case: polling keeps firing, but each poll
  // returns the same stale snapshot, so the wall-clock comparison flips the
  // badge to BACKTEST while leaving the polling machinery alone.
  const isFresh =
    timestamp != null &&
    nowMs - new Date(timestamp).getTime() < STALE_THRESHOLD_MS;
  const isLive = !isScrubbed && marketOpen && isToday && isFresh;

  // The "current" timestamp for nav math is whatever is on screen. When not
  // scrubbed that's the latest in the list (`timestamp` from the server).
  // When scrubbed it's the scrub ts.
  const activeTs = scrubTimestamp ?? timestamp;
  const activeIdx = activeTs ? timestamps.indexOf(activeTs) : -1;
  const canScrubPrev = activeIdx > 0;
  const canScrubNext = isScrubbed && timestamps.length > 0;

  const scrubPrev = useCallback(() => {
    setScrubTimestamp((current) => {
      // If currently live, "previous" means one step back from the latest.
      if (current == null) {
        if (timestamps.length < 2) return current;
        return timestamps.at(-2) ?? current;
      }
      const idx = timestamps.indexOf(current);
      if (idx <= 0) return current;
      return timestamps[idx - 1] ?? current;
    });
  }, [timestamps]);

  const scrubNext = useCallback(() => {
    setScrubTimestamp((current) => {
      if (current == null) return null;
      const idx = timestamps.indexOf(current);
      // Unknown ts, or the next step would land on (or past) the latest ->
      // resume live so polling restarts. We never let scrubTimestamp pin to
      // the newest value; that's what `null` (live) means.
      if (idx < 0 || idx >= timestamps.length - 2) return null;
      return timestamps[idx + 1] ?? null;
    });
  }, [timestamps]);

  const scrubTo = useCallback(
    (ts: string) => {
      // Jumping to the latest timestamp resumes live mode.
      if (ts === timestamps.at(-1)) {
        setScrubTimestamp(null);
      } else if (timestamps.includes(ts)) {
        setScrubTimestamp(ts);
      }
    },
    [timestamps],
  );

  const scrubLive = useCallback(() => {
    // Reset to live mode on both axes: clear scrub AND snap date back to
    // today. If the user was on a past date, this also kicks the dispatch
    // ladder into live polling via the `isToday` check. If they were
    // already on today with just scrub active, the date setter is a no-op
    // (state equality).
    setScrubTimestamp(null);
    setSelectedDate((cur) => {
      const today = getETToday();
      return cur === today ? cur : today;
    });
  }, []);

  const refresh = useCallback(() => {
    allSnapshotsRef.current = new Map();
    setLoading(true);
    void fetchAllSnapshots();
  }, [fetchAllSnapshots]);

  // Candles filtered to the scrub position for the price chart. When live
  // (not scrubbed) the full session candles are returned unchanged.
  const visibleCandles = useMemo(() => {
    if (scrubTimestamp == null) return candles;
    const limit = new Date(scrubTimestamp).getTime();
    return candles.filter((c) => c.datetime <= limit);
  }, [candles, scrubTimestamp]);

  return {
    oi,
    vol,
    dir,
    spot,
    timestamp,
    timestamps,
    candles,
    visibleCandles,
    previousClose,
    openingCallStrike,
    openingPutStrike,
    selectedDate,
    setSelectedDate,
    availableDates,
    isLive,
    isToday,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    loading,
    error,
    refresh,
  };
}
