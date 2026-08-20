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
 * its declared type. The payload is still shape-validated at the parse
 * (see `validateGammaSetupsResponse`) so a malformed body degrades to a
 * stable error state instead of crashing the tile.
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

// ── Validation ─────────────────────────────────────────────
// Mirrors the `validateSpike` pattern in useVegaSpikes: each fire row is
// validated individually (a malformed row is dropped, never fatal), while a
// payload whose envelope doesn't match — `{}`, an HTML error body parsed
// loosely, a 5xx JSON blob — is rejected wholesale and surfaces as a stable
// error state instead of crashing the tile into its section ErrorBoundary
// (`data.fires.map` / `data.anti_filters.is_fomc_day` on undefined).

const SIGNAL_TYPES: readonly string[] = [
  'e1_long_call',
  'e5_long_put',
  'pcs_monday',
];
const CONFIDENCE_TIERS: readonly string[] = ['MAXIMUM', 'HIGH', 'MEDIUM'];
const DOW_LABELS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
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

function isConfidenceTier(v: unknown): v is ConfidenceTier {
  return typeof v === 'string' && CONFIDENCE_TIERS.includes(v);
}

function isDowLabel(v: unknown): v is DowLabel {
  return typeof v === 'string' && DOW_LABELS.includes(v);
}

/**
 * Validate one fire row from `fires`. Returns the typed fire on success
 * (nullish nullable fields normalized to `null`) or `null` on any
 * field-shape mismatch — the caller drops it so one bad row can't poison
 * the whole tile.
 */
function validateFire(raw: unknown): GammaSetupFire | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(r.id) ||
    typeof r.fired_at !== 'string' ||
    !isSignalType(r.signal_type) ||
    !isDowLabel(r.dow_label) ||
    !isConfidenceTier(r.confidence_tier) ||
    !isFiniteNumber(r.spot_at_fire) ||
    !isFiniteNumber(r.node_strike) ||
    !isFiniteNumber(r.node_gex) ||
    !isFiniteNumber(r.bar_open) ||
    !isFiniteNumber(r.bar_high) ||
    !isFiniteNumber(r.bar_low) ||
    !isFiniteNumber(r.bar_close) ||
    !isFiniteNumber(r.bar_range) ||
    !isNullishOrFiniteNumber(r.es_basis_change_5m) ||
    !isNullishOrFiniteNumber(r.ret_15m) ||
    !isNullishOrFiniteNumber(r.ret_30m) ||
    !isNullishOrFiniteNumber(r.ret_60m) ||
    !isNullishOrFiniteNumber(r.ret_eod) ||
    typeof r.trade_taken !== 'boolean' ||
    !isNullishOrFiniteNumber(r.trade_pnl_dollars)
  ) {
    return null;
  }
  return {
    id: r.id,
    fired_at: r.fired_at,
    signal_type: r.signal_type,
    dow_label: r.dow_label,
    confidence_tier: r.confidence_tier,
    spot_at_fire: r.spot_at_fire,
    node_strike: r.node_strike,
    node_gex: r.node_gex,
    bar_open: r.bar_open,
    bar_high: r.bar_high,
    bar_low: r.bar_low,
    bar_close: r.bar_close,
    bar_range: r.bar_range,
    es_basis_change_5m: r.es_basis_change_5m ?? null,
    ret_15m: r.ret_15m ?? null,
    ret_30m: r.ret_30m ?? null,
    ret_60m: r.ret_60m ?? null,
    ret_eod: r.ret_eod ?? null,
    trade_taken: r.trade_taken,
    trade_pnl_dollars: r.trade_pnl_dollars ?? null,
  };
}

/**
 * `nearest_floor` / `nearest_ceiling` are optional decorations — a nullish
 * or malformed node degrades to `null` (the banner simply hides it) rather
 * than rejecting the whole envelope.
 */
function validateNode(v: unknown): { strike: number; gex: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const n = v as Record<string, unknown>;
  if (!isFiniteNumber(n.strike) || !isFiniteNumber(n.gex)) return null;
  return { strike: n.strike, gex: n.gex };
}

/**
 * Validate the top-level /api/gamma-setups/active envelope. Returns the
 * typed response on success or `null` on any mismatch (the caller treats
 * that as an error state and keeps the last-known-good data).
 */
function validateGammaSetupsResponse(raw: unknown): GammaSetupsResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.today !== 'string' ||
    !(r.dow_label == null || isDowLabel(r.dow_label)) ||
    !(r.confidence_tier == null || isConfidenceTier(r.confidence_tier)) ||
    typeof r.pre_day_filter_fires !== 'boolean' ||
    !isNullishOrFiniteNumber(r.prior_5d_ret) ||
    !isNullishOrFiniteNumber(r.prior_iv_rank) ||
    !isFiniteNumber(r.open_gap_pct) ||
    !Array.isArray(r.fires)
  ) {
    return null;
  }
  if (typeof r.anti_filters !== 'object' || r.anti_filters === null) {
    return null;
  }
  const a = r.anti_filters as Record<string, unknown>;
  if (
    typeof a.is_fomc_day !== 'boolean' ||
    typeof a.is_dom_1_5 !== 'boolean' ||
    typeof a.is_dom_16_20 !== 'boolean'
  ) {
    return null;
  }
  const fires: GammaSetupFire[] = [];
  for (const rawFire of r.fires) {
    const fire = validateFire(rawFire);
    if (fire) fires.push(fire);
  }
  return {
    today: r.today,
    dow_label: r.dow_label ?? null,
    confidence_tier: r.confidence_tier ?? null,
    pre_day_filter_fires: r.pre_day_filter_fires,
    prior_5d_ret: r.prior_5d_ret ?? null,
    prior_iv_rank: r.prior_iv_rank ?? null,
    open_gap_pct: r.open_gap_pct,
    anti_filters: {
      is_fomc_day: a.is_fomc_day,
      is_dom_1_5: a.is_dom_1_5,
      is_dom_16_20: a.is_dom_16_20,
    },
    nearest_floor: validateNode(r.nearest_floor),
    nearest_ceiling: validateNode(r.nearest_ceiling),
    fires,
  };
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
      const raw: unknown = await res.json();
      const validated = validateGammaSetupsResponse(raw);
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
