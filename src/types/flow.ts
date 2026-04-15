/**
 * Shared types for the Options Flow Ranking feature.
 *
 * Previously duplicated between `api/_lib/flow-scoring.ts` (backend) and
 * `src/hooks/useOptionsFlow.ts` (frontend) with a "keep in sync" comment.
 * Consolidated here so the API response shape and the hook's exposed data
 * can't drift.
 *
 * Scope — only the shapes that cross the network boundary live here.
 * Backend-internal types like `Aggregated` stay in `api/_lib/flow-scoring.ts`.
 */

export interface RankedStrike {
  strike: number;
  type: 'call' | 'put';
  distance_from_spot: number;
  distance_pct: number;
  total_premium: number;
  ask_side_ratio: number;
  volume_oi_ratio: number;
  hit_count: number;
  has_ascending_fill: boolean;
  has_descending_fill: boolean;
  has_multileg: boolean;
  is_itm: boolean;
  score: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DirectionalRollup {
  bullish_count: number;
  bearish_count: number;
  bullish_premium: number;
  bearish_premium: number;
  lean: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  top_bullish_strike: number | null;
  top_bearish_strike: number | null;
}

// ============================================================
// Whale Positioning (0-7 DTE, >=$1M premium institutional flow)
// ============================================================

/**
 * Single whale-sized options-flow alert row. Mirrors the API contract from
 * `GET /api/options-flow/whale-positioning`, which aggregates per
 * option_chain (strike+expiry+side) over the session window.
 *
 * The `alert_rule` is the UW rule identifier (e.g. `RepeatedHits`,
 * `FloorTradeLargeCap`) that surfaced the underlying prints. The frontend
 * maps these to short badge labels for compact display.
 */
export interface WhaleAlert {
  option_chain: string;
  strike: number;
  type: 'call' | 'put';
  expiry: string; // ISO date, e.g. "2026-04-20"
  dte_at_alert: number;
  created_at: string; // ISO UTC timestamp
  age_minutes: number;
  total_premium: number;
  total_ask_side_prem: number;
  total_bid_side_prem: number;
  ask_side_ratio: number;
  total_size: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: number;
  has_sweep: boolean;
  has_floor: boolean;
  has_multileg: boolean;
  alert_rule: string;
  underlying_price: number;
  distance_from_spot: number;
  distance_pct: number;
  is_itm: boolean;
}

/**
 * Frontend-facing shape for whale positioning data. The hook converts the
 * raw snake_case API payload into this camelCase shape at the boundary so
 * consuming components don't have to reason about two naming conventions.
 */
export interface WhalePositioningData {
  strikes: WhaleAlert[];
  totalPremium: number;
  alertCount: number;
  lastUpdated: string | null;
  spot: number | null;
  windowMinutes: number;
  minPremium: number;
  maxDte: number;
}
