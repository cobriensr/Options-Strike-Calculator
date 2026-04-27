/**
 * useDarkPoolLevels — polls /api/darkpool-levels every 60 seconds.
 *
 * Returns dark pool strike levels for the DarkPoolLevels widget.
 * Owner-only — skips polling for public visitors.
 *
 * Effect dispatch (in priority order):
 *   1. Not owner          → no fetch.
 *   2. Past date          → one-shot fetch for that date, no polling.
 *   3. Today, market open → fetch + poll every POLL_INTERVALS.DARK_POOL.
 *   4. Today, market closed → one-shot fetch (BACKTEST view of today).
 *
 * IMPORTANT: The `scrubTime` state is the hook's own internal time-scrubber
 * for historical browsing. It is NOT coupled to the app's time picker —
 * doing so caused the "panel appears frozen" bug because polling refetched
 * the same stale snapshot every cycle while the displayed `updatedAt` never
 * advanced. Only the user's explicit scrubPrev/scrubNext actions set scrubTime.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { checkIsOwner } from '../utils/auth';
import { useTimeGridScrubber } from './useTimeGridScrubber';

export interface DarkPoolLevel {
  spxLevel: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  latestTime: string | null;
  updatedAt: string;
}

export interface UseDarkPoolLevelsReturn {
  levels: DarkPoolLevel[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
  refresh: () => void;
  // Date & time scrubbing
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  scrubTime: string | null;
  isLive: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  scrubPrev: () => void;
  scrubNext: () => void;
  /** Jump directly to a specific HH:MM time slot. */
  scrubTo: (time: string) => void;
  /** All available HH:MM time slots for the trading session. */
  timeGrid: readonly string[];
  scrubLive: () => void;
}

/** Today in ET as YYYY-MM-DD (same convention as the existing `isToday` logic). */
function etToday(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

// ── Hook ────────────────────────────────────────────────────────────

export function useDarkPoolLevels(
  marketOpen: boolean,
): UseDarkPoolLevelsReturn {
  const isOwner = checkIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Own date state — decoupled from the app's vix.selectedDate so that
  // browsing dark pool history doesn't re-anchor the Black-Scholes math.
  const [selectedDate, setSelectedDate] = useState(etToday);

  // Time scrubber: null = live (no ?time= param), HH:MM = scrubbed.
  // The shared `useTimeGridScrubber` owns navigation; per-feature `isLive`
  // policy stays here because it depends on `isToday`.
  const scrubber = useTimeGridScrubber();
  const { scrubTime, isScrubbed, scrubLive } = scrubber;

  // Recompute each render so the today-vs-past branch flips at midnight ET.
  const isToday = selectedDate === etToday();

  const isLive = isToday && scrubTime === null;

  const fetchLevels = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      qs.set('date', selectedDate);
      if (scrubTime) qs.set('time', scrubTime);
      const res = await fetch(`/api/darkpool-levels?${qs}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load dark pool data');
        return;
      }

      const data = (await res.json()) as {
        levels: DarkPoolLevel[];
        date: string;
        meta?: { lastUpdated: string | null };
      };

      if (!mountedRef.current) return;

      setLevels(data.levels);
      setError(null);

      if (data.meta?.lastUpdated != null) {
        setUpdatedAt(data.meta.lastUpdated);
      } else if (data.levels.length > 0) {
        setUpdatedAt(data.levels[0]!.updatedAt);
      }
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [selectedDate, scrubTime]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset scrub time when the date changes so the new date always starts live.
  useEffect(() => {
    scrubLive();
  }, [selectedDate, scrubLive]);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    // Past date or scrubbed: fetch once — the snapshot is static.
    if (!isToday || isScrubbed) {
      setLoading(true);
      void fetchLevels();
      return;
    }

    // Today, market closed: one-shot fetch — no fresh data being produced.
    if (!marketOpen) {
      setLoading(true);
      void fetchLevels();
      return;
    }

    // Today, live, market open → live polling.
    void fetchLevels();
    const id = setInterval(() => void fetchLevels(), POLL_INTERVALS.DARK_POOL);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, isToday, isScrubbed, fetchLevels]);

  // ── Explicit refresh ─────────────────────────────────────────────

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchLevels();
  }, [fetchLevels]);

  return {
    levels,
    loading,
    error,
    updatedAt,
    refresh,
    selectedDate,
    setSelectedDate,
    scrubTime,
    isLive,
    isScrubbed,
    canScrubPrev: scrubber.canScrubPrev,
    canScrubNext: scrubber.canScrubNext,
    scrubPrev: scrubber.scrubPrev,
    scrubNext: scrubber.scrubNext,
    scrubTo: scrubber.scrubTo,
    timeGrid: scrubber.timeGrid,
    scrubLive,
  };
}
