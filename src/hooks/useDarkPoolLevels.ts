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
import { useIsOwner } from './useIsOwner';

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
  scrubLive: () => void;
}

// ── Time grid ──────────────────────────────────────────────────────
// 5-minute slots from 08:30 to 15:00 CT (79 values).
// Used for prev/next scrubbing within a trading session.
const TIME_GRID: readonly string[] = (() => {
  const grid: string[] = [];
  for (let min = 8 * 60 + 30; min <= 15 * 60; min += 5) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    grid.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return grid;
})();

/** Today in ET as YYYY-MM-DD (same convention as the existing `isToday` logic). */
function etToday(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

/**
 * Last TIME_GRID slot at or before the current CT time.
 * Used when the user first clicks "prev" in live mode to anchor the scrubber.
 */
function lastGridTimeBeforeNow(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMin = (h >= 24 ? 0 : h) * 60 + m;
  // Walk backwards through the grid to find the last slot <= nowMin
  for (let i = TIME_GRID.length - 1; i >= 0; i--) {
    const slot = TIME_GRID[i]!;
    const [sh, sm] = slot.split(':').map(Number);
    if (sh! * 60 + sm! <= nowMin) return slot;
  }
  return TIME_GRID[0]!;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useDarkPoolLevels(
  marketOpen: boolean,
): UseDarkPoolLevelsReturn {
  const isOwner = useIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Own date state — decoupled from the app's vix.selectedDate so that
  // browsing dark pool history doesn't re-anchor the Black-Scholes math.
  const [selectedDate, setSelectedDate] = useState(etToday);

  // Time scrubber state: null = live (no ?time= param), HH:MM = scrubbed.
  const [scrubTime, setScrubTime] = useState<string | null>(null);

  // Recompute each render so the today-vs-past branch flips at midnight ET.
  const isToday = selectedDate === etToday();

  const isLive = isToday && scrubTime === null;
  const isScrubbed = scrubTime !== null;

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
    setScrubTime(null);
  }, [selectedDate]);

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

  // ── Scrubber navigation ──────────────────────────────────────────

  const scrubTimeIdx = scrubTime !== null ? TIME_GRID.indexOf(scrubTime) : null;

  const canScrubPrev =
    scrubTimeIdx === null
      ? true // can always enter scrub mode from live
      : scrubTimeIdx > 0;

  const canScrubNext =
    scrubTimeIdx !== null && scrubTimeIdx < TIME_GRID.length - 1;

  const scrubPrev = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) {
        // Entering scrub from live: jump to the last slot at or before now
        // (or last grid slot for past dates).
        return lastGridTimeBeforeNow();
      }
      const idx = TIME_GRID.indexOf(cur);
      return idx > 0 ? (TIME_GRID[idx - 1] ?? cur) : cur;
    });
  }, []);

  const scrubNext = useCallback(() => {
    setScrubTime((cur) => {
      if (cur === null) return cur;
      const idx = TIME_GRID.indexOf(cur);
      return idx < TIME_GRID.length - 1 ? (TIME_GRID[idx + 1] ?? cur) : cur;
    });
  }, []);

  const scrubLive = useCallback(() => {
    setScrubTime(null);
  }, []);

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
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubLive,
  };
}
