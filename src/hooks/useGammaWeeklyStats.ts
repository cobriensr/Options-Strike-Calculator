/**
 * useGammaWeeklyStats — polls /api/gamma-setups/weekly-stats for the
 * Gamma-Node Composite Detector tile's rolling-stats bar.
 *
 * Phase 3b of docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md.
 *
 * Lazy / low-priority compared to the active-fires poll:
 *   - Refreshes every 5 minutes (live fires update every 60s in the
 *     primary hook). Win-rate over 30 days barely moves at minute cadence.
 *   - Skips the public-session path entirely so signed-out tabs don't
 *     hammer the endpoint.
 *
 * Shape mirrors `AggregateStats` from `api/_lib/gamma-stats.ts` —
 * duplicated here (rather than imported across the api/src boundary)
 * because Vite's bundler doesn't always resolve the api/ ESM `.js`
 * specifier cleanly. Same convention as useGammaSetups.
 */

import { useCallback, useEffect, useState } from 'react';

import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';
import type { SignalType } from './useGammaSetups';

export interface PerSignalStats {
  signal_type: SignalType;
  n_total: number;
  n_with_outcome: number;
  n_winners: number;
  win_rate: number | null;
  mean_edge_pts: number | null;
  expected_edge_pts: number;
  edge_ratio: number | null;
}

export interface AggregateStats {
  from: string;
  to: string;
  n_total: number;
  n_with_outcome: number;
  n_winners: number;
  win_rate: number | null;
  mean_edge_pts: number | null;
  by_signal: PerSignalStats[];
}

export interface UseGammaWeeklyStatsState {
  data: AggregateStats | null;
  loading: boolean;
  error: string | null;
  /** Imperative refresh — used after the user changes the window length. */
  refresh: () => Promise<void>;
}

const STATS_POLL_MS = 5 * 60 * 1000;

export type WindowDays = 7 | 14 | 30 | 60 | 90;

export function useGammaWeeklyStats(
  days: WindowDays = 30,
  marketOpen: boolean = true,
): UseGammaWeeklyStatsState {
  const hasSession = getAccessMode() !== 'public';
  const [data, setData] = useState<AggregateStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (): Promise<void> => {
    if (!hasSession) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/gamma-setups/weekly-stats?days=${days}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        setError(`fetch failed: ${res.status}`);
        return;
      }
      const json = (await res.json()) as AggregateStats;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [hasSession, days]);

  // Eager mount-fetch + re-fetch on window-length change.
  useEffect(() => {
    if (!hasSession) return;
    fetchStats();
  }, [hasSession, fetchStats]);

  // Recurring poll — 5-minute cadence is plenty for a rolling window.
  usePolling(fetchStats, STATS_POLL_MS, [hasSession, marketOpen]);

  return { data, loading, error, refresh: fetchStats };
}
