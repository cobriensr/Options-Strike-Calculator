/**
 * Shared types for the GexLandscape module. Zero dependencies on other
 * GexLandscape files — safe to import from anywhere in the folder.
 */

import type { PriceTrend as PriceTrendInternal } from '../../utils/price-trend';
import type {
  GexClassification as GexClassificationInternal,
  Direction as DirectionInternal,
} from '../../utils/gex-classification';

/**
 * One per-strike row inside a GEX snapshot. Built by `projectStrike` in
 * `useGexLandscapeData` from the `/api/gex-landscape` per-strike payload
 * (1-min GexBot capture). MM-attributed gamma/charm/vanna populate
 * `netGamma`/`netCharm`/`netVanna`; the call/put split fields stay at 0
 * because the 1-min GexBot feed doesn't expose attribution.
 */
export interface GexStrikeLevel {
  strike: number;
  price: number;
  // Gamma — OI (standing position)
  callGammaOi: number;
  putGammaOi: number;
  netGamma: number;
  // Gamma — volume (today's flow)
  callGammaVol: number;
  putGammaVol: number;
  netGammaVol: number;
  // Vol vs OI reinforcement signal
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
  // Gamma — directionalized (bid/ask)
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
  // Charm — OI
  callCharmOi: number;
  putCharmOi: number;
  netCharm: number;
  // Charm — volume
  callCharmVol: number;
  putCharmVol: number;
  netCharmVol: number;
  // Delta (DEX) — OI only, no vol variant from UW
  callDeltaOi: number;
  putDeltaOi: number;
  netDelta: number;
  // Vanna — OI
  callVannaOi: number;
  putVannaOi: number;
  netVanna: number;
  // Vanna — volume
  callVannaVol: number;
  putVannaVol: number;
  netVannaVol: number;
}

// `GexClassification` and `Direction` moved to src/utils/gex-classification.ts
// so the daemon can share the same source of truth without pulling in
// React-flavored modules. Re-exported here for backward compatibility.
export type GexClassification = GexClassificationInternal;
export type Direction = DirectionInternal;

export interface DriftTarget {
  strike: number;
  cls: GexClassification;
  netGamma: number;
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
}

// `PriceTrend` moved to `src/utils/price-trend.ts` so the server-side
// regime cron can consume it without pulling the GexLandscape module
// (and its React dependency graph) into the Vercel Function bundle.
// Re-exported here for back-compat with all existing consumers.
export type PriceTrend = PriceTrendInternal;

export interface BiasMetrics {
  verdict:
    | 'gex-pull-up'
    | 'gex-pull-down'
    | 'breakout-risk-up'
    | 'breakdown-risk-down'
    | 'rangebound'
    | 'volatile'
    | 'gex-floor-below'
    | 'drifting-down'
    | 'drifting-up';
  /** Sign of total net GEX across all strikes. */
  regime: 'positive' | 'negative';
  totalNetGex: number;
  /** Strike with the largest absolute GEX. */
  gravityStrike: number;
  /** Signed distance from spot (+ = above, − = below). */
  gravityOffset: number;
  /** netGamma at the gravity strike. */
  gravityGex: number;
  /** Top 2 above spot by |netGamma|. */
  upsideTargets: DriftTarget[];
  /** Top 2 below spot by |netGamma|. */
  downsideTargets: DriftTarget[];
  /** Avg 1m Δ% for below-spot strikes (GexBot cadence is 1 min). */
  floorTrend1m: number | null;
  /** Avg 1m Δ% for above-spot strikes. */
  ceilingTrend1m: number | null;
  /** Avg 5m Δ% for below-spot strikes. */
  floorTrend5m: number | null;
  /** Avg 5m Δ% for above-spot strikes. */
  ceilingTrend5m: number | null;
  /** Avg 10m Δ% for below-spot strikes. */
  floorTrend10m: number | null;
  /** Avg 10m Δ% for above-spot strikes. */
  ceilingTrend10m: number | null;
  /** Price trend over the lookback window (null until enough data accumulates). */
  priceTrend: PriceTrendInternal | null;
}
