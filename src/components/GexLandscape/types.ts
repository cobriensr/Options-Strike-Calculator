/**
 * Shared types for the GexLandscape module. Zero dependencies on other
 * GexLandscape files — safe to import from anywhere in the folder.
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';

export type GexClassification =
  | 'max-launchpad'
  | 'fading-launchpad'
  | 'sticky-pin'
  | 'weakening-pin';

export type Direction = 'ceiling' | 'floor' | 'atm';

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

/** Price trend computed from the snapshot buffer's price series. */
export interface PriceTrend {
  direction: 'up' | 'down' | 'flat';
  /** % change from oldest buffered price to current price. */
  changePct: number;
  /** Point change from oldest buffered price to current price. */
  changePts: number;
  /** Fraction of non-flat intervals in the dominant direction (0–1). */
  consistency: number;
}

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
  /** Avg 1m Δ% for below-spot strikes. */
  floorTrend: number | null;
  /** Avg 1m Δ% for above-spot strikes. */
  ceilingTrend: number | null;
  /** Avg 5m Δ% for below-spot strikes. */
  floorTrend5m: number | null;
  /** Avg 5m Δ% for above-spot strikes. */
  ceilingTrend5m: number | null;
  /** Price trend over the lookback window (null until enough data accumulates). */
  priceTrend: PriceTrend | null;
}
