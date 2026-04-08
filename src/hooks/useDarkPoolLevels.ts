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
 * This hook deliberately does NOT take `selectedTime` from the calculator.
 * The time picker in `useAppState` is an "as-of" control for Black-Scholes
 * math, not a scrub control for the dark pool panel. Coupling here would
 * make polling refetch the same stale snapshot every cycle (since
 * `selectedTime` defaults to the minute the page loaded at and doesn't
 * auto-advance), causing the panel to appear frozen.
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
}

export function useDarkPoolLevels(
  marketOpen: boolean,
  selectedDate?: string,
): UseDarkPoolLevelsReturn {
  const isOwner = useIsOwner();
  const [levels, setLevels] = useState<DarkPoolLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Computed each render — recomputes naturally across midnight Eastern so
  // the "today vs. past" branch flips at the session boundary without
  // needing a state update.
  const todayET = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = !selectedDate || selectedDate === todayET;

  const fetchLevels = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('date', selectedDate);
      const params = qs.size > 0 ? `?${qs}` : '';
      const res = await fetch(`/api/darkpool-levels${params}`, {
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
      };

      if (!mountedRef.current) return;

      setLevels(data.levels);
      setError(null);

      if (data.levels.length > 0) {
        setUpdatedAt(data.levels[0]!.updatedAt);
      }
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

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    // Past date: fetch once, no polling — the day's data is fully written.
    if (!isToday) {
      setLoading(true);
      fetchLevels();
      return;
    }

    // Today, market closed: one-shot fetch, no polling — no fresh data is
    // being produced, polling would just hit the cache.
    if (!marketOpen) {
      setLoading(true);
      fetchLevels();
      return;
    }

    // Today, market open → live polling. Each poll fetches latest for today
    // (no `?time=` param) so the "Updated HH:MM" display actually advances
    // as the dark pool cron writes new blocks.
    fetchLevels();
    const id = setInterval(fetchLevels, POLL_INTERVALS.DARK_POOL);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, isToday, fetchLevels]);

  return { levels, loading, error, updatedAt, refresh: fetchLevels };
}
