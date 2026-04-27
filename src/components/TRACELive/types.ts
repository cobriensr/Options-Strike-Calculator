/**
 * Frontend types for the TRACE Live dashboard.
 *
 * These mirror the API response shapes from /api/trace-live-list and
 * /api/trace-live-get exactly. The full TraceAnalysis Zod schema lives
 * server-side in api/_lib/trace-live-types.ts; the structural type below
 * is duplicated (not re-imported) so the frontend bundle stays free of
 * api/ dependencies and Vite doesn't pull in zod at the chart-tab level.
 */

export type TraceChart = 'gamma' | 'charm' | 'delta';

export type TraceConfidence = 'high' | 'medium' | 'low' | 'no_trade';

export type TraceRegime =
  | 'range_bound_positive_gamma'
  | 'trending_positive_gamma'
  | 'range_bound_negative_gamma'
  | 'trending_negative_gamma'
  | 'mixed';

export type TraceCrossChartAgreement =
  | 'all_agree'
  | 'mostly_agree'
  | 'split'
  | 'no_call';

export type TraceTradeType =
  | 'iron_fly'
  | 'iron_condor'
  | 'tight_credit_spread'
  | 'directional_long'
  | 'directional_short'
  | 'flat';

export type TraceSize = 'full' | 'three_quarter' | 'half' | 'quarter' | 'none';

export interface TraceCharmRead {
  predominantColor: 'red' | 'blue' | 'mixed' | 'multi_band';
  direction: 'long' | 'short' | 'flip' | 'unstable' | 'no_call';
  junctionStrike: number | null;
  flipFlopDetected: boolean;
  rejectionWicksAtRed: boolean;
  notes: string;
}

export interface TraceGammaRead {
  signAtSpot:
    | 'positive_strong'
    | 'positive_pale'
    | 'neutral'
    | 'negative_pale'
    | 'negative_strong';
  dominantNodeStrike: number | null;
  dominantNodeMagnitudeB: number | null;
  dominantNodeRatio: number | null;
  floorStrike: number | null;
  ceilingStrike: number | null;
  overrideFires: boolean;
  notes: string;
}

export interface TraceDeltaRead {
  blueBelowStrike: number | null;
  redAboveStrike: number | null;
  corridorWidth: number | null;
  zoneBehavior: 'support_resistance' | 'acceleration' | 'unclear';
  notes: string;
}

export interface TraceTradeRecommendation {
  type: TraceTradeType;
  centerStrike: number | null;
  wingWidth: number | null;
  size: TraceSize;
}

export interface TraceSynthesis {
  predictedClose: number;
  confidence: TraceConfidence;
  crossChartAgreement: TraceCrossChartAgreement;
  overrideApplied: boolean;
  trade: TraceTradeRecommendation;
  headline: string;
  warnings: string[];
}

export interface TraceAnalysis {
  timestamp: string;
  spot: number;
  stabilityPct: number | null;
  regime: TraceRegime;
  charm: TraceCharmRead;
  gamma: TraceGammaRead;
  delta: TraceDeltaRead;
  synthesis: TraceSynthesis;
  reasoningSummary?: string;
}

/** Sparse map keyed by chart name. Empty when all uploads failed. */
export type TraceLiveImageUrls = Partial<Record<TraceChart, string>>;

/** Compact summary returned by /api/trace-live-list (one row per capture). */
export interface TraceLiveSummary {
  id: number;
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  regime: string | null;
  predictedClose: number | null;
  confidence: string | null;
  overrideApplied: boolean | null;
  headline: string | null;
  hasImages: boolean;
}

/**
 * Single analog returned by /api/trace-live-analogs?id=N&k=K. Each entry is
 * a historical capture whose embedding is closest to the seed row's, paired
 * with its post-close outcome where known.
 */
export interface TraceLiveAnalog {
  id: number;
  capturedAt: string;
  spot: number;
  regime: string | null;
  predictedClose: number | null;
  actualClose: number | null;
  confidence: string | null;
  headline: string | null;
  distance: number;
  /** actualClose - predictedClose, or null if either side is missing. */
  error: number | null;
}

/** Response shape from /api/trace-live-analogs. */
export interface TraceLiveAnalogsResponse {
  id: number;
  k: number;
  analogs: TraceLiveAnalog[];
}

/** Detail row returned by /api/trace-live-get?id=N. */
export interface TraceLiveDetail {
  id: number;
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  regime: string | null;
  predictedClose: number | null;
  confidence: string | null;
  overrideApplied: boolean | null;
  headline: string | null;
  imageUrls: TraceLiveImageUrls;
  analysis: TraceAnalysis | null;
  /** Cosine distance to k-th nearest historical embedding (k=20). Null
   *  when fewer than k historical rows exist or when computation failed.
   *  Higher = more novel setup. */
  noveltyScore: number | null;
  /** SPX cash close on the trading day of capture, populated post-close
   *  by fetch-outcomes. Null for today's pre-close rows. */
  actualClose: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}
