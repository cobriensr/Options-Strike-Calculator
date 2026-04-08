/**
 * useGexPerStrike — fetches /api/gex-per-strike for the GexPerStrike widget.
 *
 * Returns per-strike 0DTE GEX data plus scrub controls so the user can step
 * backwards/forwards through previous snapshots without leaving the page.
 * Owner-only — skips polling for public visitors.
 *
 * Behavior:
 *   - Live mode (no selectedDate, market open, no scrub): polls every 60s.
 *   - Explicit date (today or past): fetches once (data is in DB).
 *   - Scrub mode (any date, scrubTimestamp set): fetches that exact snapshot
 *     once and pauses polling. `scrubLive()` clears scrub and resumes polling.
 *
 * The server returns `timestamps[]` (every snapshot for the day, ascending),
 * which the hook caches so prev/next can step through them without an extra
 * round trip.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { useIsOwner } from './useIsOwner';

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
  const mountedRef = useRef(true);

  const hasExplicitDate = selectedDate != null;

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

    // Scrubbing: fetch exact snapshot, pause polling.
    if (scrubTimestamp != null) {
      setLoading(true);
      fetchData(scrubTimestamp);
      return;
    }

    // Explicit date (today or past): fetch latest for that date once.
    if (hasExplicitDate) {
      setLoading(true);
      fetchData();
      return;
    }

    // Live mode — only poll while the market is open.
    if (!marketOpen) {
      setLoading(false);
      return;
    }

    fetchData();
    const id = setInterval(() => fetchData(), POLL_INTERVALS.GEX_STRIKE);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, hasExplicitDate, scrubTimestamp, fetchData]);

  const isScrubbed = scrubTimestamp != null;

  // "Live" means the displayed snapshot is the current one and the market is
  // actively producing new snapshots. After the close (or on a past date) the
  // panel is showing the most recent snapshot for that day, but the data is
  // not flowing — that's a backtest view, not a live view.
  //
  // `today` is computed inline (not memoized) so the panel correctly flips
  // from live → backtest at midnight Eastern without needing a state update.
  const todayET = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = !selectedDate || selectedDate === todayET;
  const isLive = !isScrubbed && marketOpen && isToday;

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
