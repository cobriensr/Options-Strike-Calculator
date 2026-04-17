/**
 * Pyramid trade tracker — shared TypeScript types.
 *
 * Mirror of the Zod schemas in `api/_lib/validation.ts` and row shapes
 * returned by `api/_lib/db-pyramid.ts`. Used by the data hook
 * (`src/hooks/usePyramidData.ts`) and the PyramidTracker component tree.
 *
 * Per spec (docs/superpowers/specs/pyramid-tracker-2026-04-16.md) every
 * feature field is optional — only identity fields (`id`, `chain_id`,
 * `leg_number`) are strictly required so partial rows save during live
 * trading.
 *
 * If the experiment is abandoned this entire file is deleted; see the
 * cleanup runbook in the spec.
 */

// ============================================================
// Enum literal unions (consumed by form dropdowns in Task 2B)
// ============================================================

export type PyramidDirection = 'long' | 'short';

export type PyramidDayType = 'trend' | 'chop' | 'news' | 'mixed';

export type PyramidExitReasonChain =
  | 'reverse_choch'
  | 'stopped_out'
  | 'manual'
  | 'eod';

export type PyramidSignalType = 'CHoCH' | 'BOS';

export type PyramidVwapBandPosition =
  | 'outside_upper'
  | 'at_upper'
  | 'inside'
  | 'at_lower'
  | 'outside_lower';

export type PyramidSessionPhase =
  | 'pre_open'
  | 'open_drive'
  | 'morning_drive'
  | 'lunch'
  | 'afternoon'
  | 'power_hour'
  | 'close';

export type PyramidExitReasonLeg = 'reverse_choch' | 'trailed_stop' | 'manual';

export type PyramidChainStatus = 'open' | 'closed';

// ============================================================
// Row shapes (what the API returns on GET)
// ============================================================

/**
 * One row from `pyramid_chains`. Every feature column is nullable in the
 * database; only `id`, `status`, `created_at`, `updated_at` are always
 * populated. Enum fields are typed as their literal unions when present.
 */
export interface PyramidChain {
  id: string;
  trade_date: string | null;
  instrument: string | null;
  direction: PyramidDirection | null;
  entry_time_ct: string | null;
  exit_time_ct: string | null;
  initial_entry_price: number | null;
  final_exit_price: number | null;
  exit_reason: PyramidExitReasonChain | null;
  total_legs: number | null;
  winning_legs: number | null;
  net_points: number | null;
  session_atr_pct: number | null;
  day_type: PyramidDayType | null;
  higher_tf_bias: string | null;
  notes: string | null;
  status: PyramidChainStatus;
  created_at: string;
  updated_at: string;
}

/**
 * One row from `pyramid_legs`. `id`, `chain_id`, `leg_number`,
 * `created_at`, `updated_at` are always populated; every other column is
 * nullable.
 */
export interface PyramidLeg {
  id: string;
  chain_id: string;
  leg_number: number;
  signal_type: PyramidSignalType | null;
  entry_time_ct: string | null;
  entry_price: number | null;
  stop_price: number | null;
  stop_distance_pts: number | null;
  stop_compression_ratio: number | null;
  vwap_at_entry: number | null;
  vwap_1sd_upper: number | null;
  vwap_1sd_lower: number | null;
  vwap_band_position: PyramidVwapBandPosition | null;
  vwap_band_distance_pts: number | null;
  minutes_since_chain_start: number | null;
  minutes_since_prior_bos: number | null;
  ob_quality: number | null;
  relative_volume: number | null;
  session_phase: PyramidSessionPhase | null;
  session_high_at_entry: number | null;
  session_low_at_entry: number | null;
  retracement_extreme_before_entry: number | null;
  exit_price: number | null;
  exit_reason: PyramidExitReasonLeg | null;
  points_captured: number | null;
  r_multiple: number | null;
  was_profitable: boolean | null;
  notes: string | null;
  ob_high: number | null;
  ob_low: number | null;
  ob_poc_price: number | null;
  ob_poc_pct: number | null;
  ob_secondary_node_pct: number | null;
  ob_tertiary_node_pct: number | null;
  ob_total_volume: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/pyramid/chains?id=<id>` returns the chain plus its legs in
 * leg_number order. Inline object shape so consumers don't have to import
 * both types separately.
 */
export interface PyramidChainWithLegs {
  chain: PyramidChain;
  legs: PyramidLeg[];
}

// ============================================================
// Input shapes (POST / PATCH bodies)
// ============================================================

/**
 * POST /api/pyramid/chains body — mirrors `pyramidChainSchema` in
 * `api/_lib/validation.ts`. `id` is required on create; every other
 * field is optional/nullable.
 *
 * For PATCH, clients send `Partial<PyramidChainInput>` (see
 * `updateChain` in the hook) — `id` comes from the query param, not the
 * body.
 */
export interface PyramidChainInput {
  id: string;
  trade_date?: string | null;
  instrument?: string | null;
  direction?: PyramidDirection | null;
  entry_time_ct?: string | null;
  exit_time_ct?: string | null;
  initial_entry_price?: number | null;
  final_exit_price?: number | null;
  exit_reason?: PyramidExitReasonChain | null;
  total_legs?: number | null;
  winning_legs?: number | null;
  net_points?: number | null;
  session_atr_pct?: number | null;
  day_type?: PyramidDayType | null;
  higher_tf_bias?: string | null;
  notes?: string | null;
  // Explicit-null is rejected by the Zod schema for status (see
  // validation.ts comment), so the input type mirrors that: optional
  // but not nullable.
  status?: PyramidChainStatus;
}

/**
 * POST /api/pyramid/legs body — mirrors `pyramidLegSchema`. `id`,
 * `chain_id`, `leg_number` required on create; every other field is
 * optional/nullable.
 *
 * PATCH takes `Partial<PyramidLegInput>` — `id` comes from the query
 * param. `stop_compression_ratio` is accepted in the input shape but is
 * computed server-side on create and whenever `stop_distance_pts`
 * changes; sending it is harmless but ineffective.
 */
export interface PyramidLegInput {
  id: string;
  chain_id: string;
  leg_number: number;
  signal_type?: PyramidSignalType | null;
  entry_time_ct?: string | null;
  entry_price?: number | null;
  stop_price?: number | null;
  stop_distance_pts?: number | null;
  stop_compression_ratio?: number | null;
  vwap_at_entry?: number | null;
  vwap_1sd_upper?: number | null;
  vwap_1sd_lower?: number | null;
  vwap_band_position?: PyramidVwapBandPosition | null;
  vwap_band_distance_pts?: number | null;
  minutes_since_chain_start?: number | null;
  minutes_since_prior_bos?: number | null;
  ob_quality?: number | null;
  relative_volume?: number | null;
  session_phase?: PyramidSessionPhase | null;
  session_high_at_entry?: number | null;
  session_low_at_entry?: number | null;
  retracement_extreme_before_entry?: number | null;
  exit_price?: number | null;
  exit_reason?: PyramidExitReasonLeg | null;
  points_captured?: number | null;
  r_multiple?: number | null;
  was_profitable?: boolean | null;
  notes?: string | null;
  ob_high?: number | null;
  ob_low?: number | null;
  ob_poc_price?: number | null;
  ob_poc_pct?: number | null;
  ob_secondary_node_pct?: number | null;
  ob_tertiary_node_pct?: number | null;
  ob_total_volume?: number | null;
}

// ============================================================
// Progress counters (GET /api/pyramid/progress)
// ============================================================

/**
 * Response shape from `GET /api/pyramid/progress`. Mirrors
 * `ProgressCounts` in `api/_lib/db-pyramid.ts`, but with `Record`-typed
 * fields since the keys are serialized as plain strings over JSON.
 *
 * - `chains_by_day_type` — counts include an "unspecified" bucket for
 *   chains with a null `day_type`. Use `PyramidDayType | 'unspecified'`
 *   if narrowing is needed.
 * - `fill_rates` — values in [0, 1]. Keys match column names on
 *   `pyramid_legs` (e.g. `signal_type`, `entry_price`, …). When there
 *   are zero legs logged, every rate is 0.
 * - `elapsed_calendar_days` — null before the first chain is logged.
 */
export interface PyramidProgress {
  total_chains: number;
  chains_by_day_type: Record<string, number>;
  elapsed_calendar_days: number | null;
  fill_rates: Record<string, number>;
}
