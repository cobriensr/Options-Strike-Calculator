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
