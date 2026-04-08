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
 *   3. Past date          → fetch once with the requested time, no polling.
 *   4. Today, market open → fetch + poll every POLL_INTERVALS.GEX_STRIKE.
 *   5. Today, market closed → fetch once, no polling.
 *
 * Live-ness has TWO independent signals:
 *   - The dispatch ladder above decides whether the panel is *trying* to be
 *     live (i.e., whether `setInterval` is running).
 *   - A wall-clock freshness check (STALE_THRESHOLD_MS) decides whether the
 *     displayed snapshot is *actually* live. This catches the case where the
 *     user has dialed `selectedTime` to a past minute — polling keeps firing
 *     but each fetch returns the same stale snapshot, so the badge correctly
 *     flips from LIVE to BACKTEST without disabling the polling machinery.
 *
 * The server returns `timestamps[]` (every snapshot for the day, ascending),
 * which the hook caches so prev/next can step through them without an extra
 * round trip.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { useIsOwner } from './useIsOwner';

/**
 * A snapshot is considered "live" only if its timestamp is within this many
 * milliseconds of the wall clock. Generous enough to absorb a missed poll
 * (POLL_INTERVALS.GEX_STRIKE is 60s) without flickering, tight enough to
 * catch the "user dialed selectedTime to a past minute" case.
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

export interface UseGexPerStrikeReturn {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  /** Timestamp currently being displayed (latest if live, scrub ts if scrubbing) */
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending */
  timestamps: string[];
  /**
   * True when the displayed snapshot is genuinely live: not scrubbed, market
   * is open, and we're viewing today's data. False during after-hours or when
   * looking at a historical date — those are backtest views.
   */
  isLive: boolean;
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
  /** Clear scrub and resume live polling */
  scrubLive: () => void;
  refresh: () => void;
}

export function useGexPerStrike(
  marketOpen: boolean,
  selectedDate?: string,
  selectedTime?: string,
): UseGexPerStrikeReturn {
  const isOwner = useIsOwner();
  const [strikes, setStrikes] = useState<GexStrikeLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const [scrubTimestamp, setScrubTimestamp] = useState<string | null>(null);
  // Wall-clock state — refreshed every WALL_CLOCK_TICK_MS by a separate
  // effect. The freshness check below reads `nowMs` rather than calling
  // `Date.now()` inline so the re-render dependency is explicit and testable
  // under fake timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(true);

  // Computed each render. `todayET` recomputes naturally as the wall clock
  // crosses midnight Eastern, so the panel flips from LIVE → BACKTEST at the
  // session boundary without needing an explicit state update.
  const todayET = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = !selectedDate || selectedDate === todayET;
  const isScrubbed = scrubTimestamp != null;

  const fetchData = useCallback(
    async (tsOverride?: string | null) => {
      try {
        const qs = new URLSearchParams();
        if (selectedDate) qs.set('date', selectedDate);
        if (tsOverride) qs.set('ts', tsOverride);
        else if (selectedTime) qs.set('time', selectedTime);
        const params = qs.size > 0 ? `?${qs}` : '';
        const res = await fetch(`/api/gex-per-strike${params}`, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(5_000),
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
        };

        if (!mountedRef.current) return;

        setStrikes(data.strikes);
        setTimestamp(data.timestamp);
        setTimestamps(data.timestamps ?? []);
        setError(null);
      } catch (err) {
        if (mountedRef.current) setError(getErrorMessage(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [selectedDate, selectedTime],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset scrub state whenever the active date changes — the previous date's
  // scrub timestamp is meaningless against a different day's snapshot list.
  useEffect(() => {
    setScrubTimestamp(null);
  }, [selectedDate]);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    // Scrubbing: fetch the exact pinned snapshot, no polling. The user is
    // explicitly inspecting one moment in time.
    if (scrubTimestamp != null) {
      setLoading(true);
      fetchData(scrubTimestamp);
      return;
    }

    // Past date: one-shot fetch with the requested time, no polling — there's
    // nothing new to poll for, the day's data is fully written.
    if (!isToday) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market closed: one-shot fetch. Same reasoning — no fresh
    // snapshots are being produced, polling would just hit the cache.
    if (!marketOpen) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market open, not scrubbed → live polling. Each poll re-uses
    // `selectedTime` if set, so a user who has dialed back to a past minute
    // gets that same snapshot returned every cycle (slightly wasteful, but
    // preserves their selection — the wall-clock check below labels it
    // BACKTEST). When `selectedTime` matches the current minute, polling
    // delivers fresh snapshots and the LIVE badge stays green.
    fetchData();
    const id = setInterval(() => fetchData(), POLL_INTERVALS.GEX_STRIKE);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, isToday, scrubTimestamp, fetchData]);

  // Wall-clock ticker — only runs when freshness could plausibly flip. In
  // BACKTEST or scrubbed states the badge is permanently labeled, so we'd
  // just be re-rendering for nothing. The ticker re-snaps `nowMs` so the
  // freshness comparison below picks up the new wall-clock value without
  // calling `Date.now()` inline (which sonarjs flags and which makes the
  // re-render dependency invisible).
  //
  // Timing caveat: between mount and the first tick, `nowMs` is whatever
  // `Date.now()` returned at mount. So a snapshot that's exactly at the
  // freshness boundary at mount can briefly read as fresh for up to
  // WALL_CLOCK_TICK_MS past its actual staleness — total worst-case
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
      // Unknown ts, or the next step would land on (or past) the latest →
      // resume live so polling restarts. We never let scrubTimestamp pin to
      // the newest value; that's what `null` (live) means.
      if (idx < 0 || idx >= timestamps.length - 2) return null;
      return timestamps[idx + 1] ?? null;
    });
  }, [timestamps]);

  const scrubLive = useCallback(() => setScrubTimestamp(null), []);

  const refresh = useCallback(() => {
    fetchData(scrubTimestamp ?? undefined);
  }, [fetchData, scrubTimestamp]);

  return {
    strikes,
    loading,
    error,
    timestamp,
    timestamps,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubLive,
    refresh,
  };
}
