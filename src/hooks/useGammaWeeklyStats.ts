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

// ── Validation ─────────────────────────────────────────────
// Mirrors the `validateSpike` pattern in useVegaSpikes: each per-signal row
// is validated individually (a malformed row is dropped, never fatal),
// while a payload whose envelope doesn't match — `{}`, an HTML error body
// parsed loosely, a 5xx JSON blob — is rejected wholesale and surfaces as
// the RollingStatsBar's normal "stats error" state.

const SIGNAL_TYPES: readonly string[] = [
  'e1_long_call',
  'e5_long_put',
  'pcs_monday',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * `null` and `undefined` coalesce per the optional-props policy (both mean
 * "no value"); anything else must be a finite number.
 */
function isNullishOrFiniteNumber(v: unknown): v is number | null | undefined {
  return v == null || isFiniteNumber(v);
}

function isSignalType(v: unknown): v is SignalType {
  return typeof v === 'string' && SIGNAL_TYPES.includes(v);
}

/**
 * Validate one `by_signal` row. Returns the typed row on success (nullish
 * nullable fields normalized to `null`) or `null` on any field-shape
 * mismatch — the caller drops it so one bad row can't poison the bar.
 */
function validatePerSignalStats(raw: unknown): PerSignalStats | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isSignalType(r.signal_type) ||
    !isFiniteNumber(r.n_total) ||
    !isFiniteNumber(r.n_with_outcome) ||
    !isFiniteNumber(r.n_winners) ||
    !isNullishOrFiniteNumber(r.win_rate) ||
    !isNullishOrFiniteNumber(r.mean_edge_pts) ||
    !isFiniteNumber(r.expected_edge_pts) ||
    !isNullishOrFiniteNumber(r.edge_ratio)
  ) {
    return null;
  }
  return {
    signal_type: r.signal_type,
    n_total: r.n_total,
    n_with_outcome: r.n_with_outcome,
    n_winners: r.n_winners,
    win_rate: r.win_rate ?? null,
    mean_edge_pts: r.mean_edge_pts ?? null,
    expected_edge_pts: r.expected_edge_pts,
    edge_ratio: r.edge_ratio ?? null,
  };
}

/**
 * Validate the top-level /api/gamma-setups/weekly-stats envelope. Returns
 * the typed stats on success or `null` on any mismatch (the caller treats
 * that as an error state and keeps the last-known-good data).
 */
function validateAggregateStats(raw: unknown): AggregateStats | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.from !== 'string' ||
    typeof r.to !== 'string' ||
    !isFiniteNumber(r.n_total) ||
    !isFiniteNumber(r.n_with_outcome) ||
    !isFiniteNumber(r.n_winners) ||
    !isNullishOrFiniteNumber(r.win_rate) ||
    !isNullishOrFiniteNumber(r.mean_edge_pts) ||
    !Array.isArray(r.by_signal)
  ) {
    return null;
  }
  const bySignal: PerSignalStats[] = [];
  for (const rawRow of r.by_signal) {
    const row = validatePerSignalStats(rawRow);
    if (row) bySignal.push(row);
  }
  return {
    from: r.from,
    to: r.to,
    n_total: r.n_total,
    n_with_outcome: r.n_with_outcome,
    n_winners: r.n_winners,
    win_rate: r.win_rate ?? null,
    mean_edge_pts: r.mean_edge_pts ?? null,
    by_signal: bySignal,
  };
}

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
      const raw: unknown = await res.json();
      const validated = validateAggregateStats(raw);
      if (validated == null) {
        // Shapeless body ({} / loosely-parsed HTML / error JSON) — surface
        // as a normal error state and keep the last-known-good data.
        setError('unexpected response shape');
        return;
      }
      setData(validated);
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
