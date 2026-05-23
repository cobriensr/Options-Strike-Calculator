/**
 * useGammaSetups — polls /api/gamma-setups/active for the Gamma-Node
 * Composite Detector tile (Phase 2 of
 * docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md).
 *
 * Owner-or-guest endpoint (same access policy as other Market Context
 * tiles). Public visitors skip the poll loop to avoid hammering with
 * 401s. During market hours, refreshes every 30 seconds; outside RTH
 * the eager mount-fetch still runs so the EOD-backfilled fires render
 * for after-hours review.
 *
 * Mirrors the response shape from `api/gamma-setups/active.ts` exactly
 * — no client-side transformations. The endpoint already coerces Neon
 * NUMERIC strings to JS numbers, so consumers can treat every field as
 * its declared type.
 */

import { useCallback, useEffect, useState } from 'react';

import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { usePolling } from './usePolling';

export type SignalType = 'e1_long_call' | 'e5_long_put' | 'pcs_monday';

export type ConfidenceTier = 'MAXIMUM' | 'HIGH' | 'MEDIUM';

export type DowLabel =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday';

export interface GammaSetupFire {
  id: number;
  fired_at: string;
  signal_type: SignalType;
  dow_label: DowLabel;
  confidence_tier: ConfidenceTier;
  spot_at_fire: number;
  node_strike: number;
  node_gex: number;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_range: number;
  es_basis_change_5m: number | null;
  ret_15m: number | null;
  ret_30m: number | null;
  ret_60m: number | null;
  ret_eod: number | null;
  trade_taken: boolean;
  trade_pnl_dollars: number | null;
}

export interface GammaSetupsResponse {
  today: string;
  dow_label: DowLabel | null;
  confidence_tier: ConfidenceTier | null;
  pre_day_filter_fires: boolean;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  open_gap_pct: number;
  anti_filters: {
    is_fomc_day: boolean;
    is_dom_1_5: boolean;
    is_dom_16_20: boolean;
  };
  nearest_floor: { strike: number; gex: number } | null;
  nearest_ceiling: { strike: number; gex: number } | null;
  fires: GammaSetupFire[];
}

export interface UseGammaSetupsState {
  data: GammaSetupsResponse | null;
  loading: boolean;
  error: string | null;
  /** Imperative refresh — used by manual "refresh" affordances if added later. */
  refresh: () => Promise<void>;
}

const GAMMA_SETUPS_POLL_MS = POLL_INTERVALS.GREEK_FLOW; // 60_000ms — matches the
// other intraday tiles. Detector cron runs every minute anyway, so polling
// faster than 30s wouldn't surface fresher fires.

export function useGammaSetups(marketOpen: boolean): UseGammaSetupsState {
  const hasSession = getAccessMode() !== 'public';
  const [data, setData] = useState<GammaSetupsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSetups = useCallback(async (): Promise<void> => {
    if (!hasSession) return;
    setLoading(true);
    try {
      const res = await fetch('/api/gamma-setups/active', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        setError(`fetch failed: ${res.status}`);
        return;
      }
      const json = (await res.json()) as GammaSetupsResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [hasSession]);

  // Eager mount-fetch — runs once per session. Doesn't gate on marketOpen
  // so after-hours users see the day's persisted fires + outcomes.
  useEffect(() => {
    if (!hasSession) return;
    fetchSetups();
  }, [hasSession, fetchSetups]);

  // Recurring poll — only during market hours. Calendar gates (FOMC, etc.)
  // are surfaced inside the panel, not enforced here; polling continues so
  // the user sees fires as they happen even on caution days.
  usePolling(fetchSetups, GAMMA_SETUPS_POLL_MS, [hasSession, marketOpen]);

  return { data, loading, error, refresh: fetchSetups };
}
