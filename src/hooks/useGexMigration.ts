/**
 * useGexMigration — polls /api/gex-migration-0dte every 60 seconds.
 *
 * Returns the last 21 1-min snapshots of raw per-strike GEX for the
 * GexMigration component. The component computes the migration result
 * (target strike, leaderboard, sparklines) from these raw snapshots
 * using `computeMigration()` from `src/utils/gex-migration.ts`, which
 * means the OI/VOL/DIR mode toggle is instant with no re-fetch.
 *
 * Owner-only — skips polling for public visitors.
 *
 * Effect dispatch (in priority order):
 *   1. Not owner          → no fetch.
 *   2. Past date          → one-shot fetch for that date, no polling.
 *   3. Today, market open → fetch + poll every POLL_INTERVALS.GEX_STRIKE.
 *   4. Today, market closed → one-shot fetch (BACKTEST view of today).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { useIsOwner } from './useIsOwner';
import type { GexSnapshot } from '../utils/gex-migration';

export interface UseGexMigrationReturn {
  snapshots: GexSnapshot[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface ApiResponse {
  snapshots: GexSnapshot[];
  date: string;
}

export function useGexMigration(
  marketOpen: boolean,
  selectedDate?: string,
): UseGexMigrationReturn {
  const isOwner = useIsOwner();
  const [snapshots, setSnapshots] = useState<GexSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Computed each render — flips the "today vs. past" branch naturally at
  // midnight Eastern without needing a state update.
  const todayET = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = !selectedDate || selectedDate === todayET;

  const fetchData = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('date', selectedDate);
      const params = qs.size > 0 ? `?${qs}` : '';
      const res = await fetch(`/api/gex-migration-0dte${params}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        if (res.status !== 401) setError('Failed to load GEX migration data');
        return;
      }

      const data = (await res.json()) as ApiResponse;

      if (!mountedRef.current) return;

      setSnapshots(data.snapshots);
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

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }

    // Past date: fetch once, no polling — the day's snapshots are fully
    // written, there's nothing to poll for.
    if (!isToday) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market closed: one-shot fetch, no polling — no new snapshots
    // are being written.
    if (!marketOpen) {
      setLoading(true);
      fetchData();
      return;
    }

    // Today, market open → live polling. Each poll fetches the latest 21
    // snapshots for today, so the migration sparklines and urgency
    // leaderboard actually advance minute-by-minute.
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVALS.GEX_STRIKE);
    return () => clearInterval(id);
  }, [isOwner, marketOpen, isToday, fetchData]);

  return { snapshots, loading, error, refresh: fetchData };
}
