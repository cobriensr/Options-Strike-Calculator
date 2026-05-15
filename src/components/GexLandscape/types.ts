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
 * One per-strike row inside a GEX snapshot. Field shape matches the
 * `/api/gex-strike-expiry` projection in `useGexLandscapeData` and the
 * legacy `/api/gex-per-strike` payload — both write into the same canonical
 * row format the GexLandscape table consumes.
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

export interface Snapshot {
  strikes: GexStrikeLevel[];
  /** Unix ms from snapshot timestamp. */
  ts: number;
}

export interface DriftTarget {
  strike: number;
  cls: GexClassification;
  netGamma: number;
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
}

/**
 * Naive drift-target shape used by the BiasPanel's naive sub-readout.
 * Leaner than `DriftTarget` because the naive view has no charm
 * equivalent (so no classification badge) and no per-strike vol
 * reinforcement (that's an MM-side OI-vs-vol read).
 */
export interface NaiveDriftTarget {
  strike: number;
  /** `callGammaOi + putGammaOi` from the WS feed. */
  netGamma: number;
}

/**
 * Parallel naive read of the structural bias, sourced from the WS
 * feed's raw `call_gamma_oi + put_gamma_oi` per strike. Rendered as
 * a sub-line under the MM readout in the BiasPanel. `null` when no
 * WS data is available for the rows being analyzed (panel skips the
 * sub-line entirely in that case).
 *
 * Verdict and regime are NOT duplicated here — those are MM-only
 * structural reads (see [bias.ts](./bias.ts) for rationale).
 */
export interface NaiveBiasMetrics {
  gravityStrike: number;
  gravityOffset: number;
  gravityGex: number;
  upsideTargets: NaiveDriftTarget[];
  downsideTargets: NaiveDriftTarget[];
  floorTrend10m: number | null;
  ceilingTrend10m: number | null;
  floorTrend30m: number | null;
  ceilingTrend30m: number | null;
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
  /** Avg 10m Δ% for below-spot strikes (MM cadence is 10 min). */
  floorTrend10m: number | null;
  /** Avg 10m Δ% for above-spot strikes. */
  ceilingTrend10m: number | null;
  /** Avg 30m Δ% for below-spot strikes. */
  floorTrend30m: number | null;
  /** Avg 30m Δ% for above-spot strikes. */
  ceilingTrend30m: number | null;
  /** Price trend over the lookback window (null until enough data accumulates). */
  priceTrend: PriceTrendInternal | null;
  /**
   * Parallel naive read — gravity, drift targets, and Δ% trend numbers
   * computed over `call_gamma_oi + put_gamma_oi` instead of MM
   * `netGamma`. `null` when no WS data is available; BiasPanel
   * defensively skips the sub-line.
   */
  naive: NaiveBiasMetrics | null;
}
