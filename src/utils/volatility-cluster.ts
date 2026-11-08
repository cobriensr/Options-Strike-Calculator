import { getClusterMultiplier } from '../data/vixRangeStats.js';
import type { ClusterResult } from '../data/vixRangeStats.js';

/**
 * Volatility-clustering signal: yesterday's SPX high-low range, as a percent
 * of a reference price, bucketed against today's VIX regime. This is the one
 * formula. The app computes today's multiplier from it for the snapshot save,
 * the regime ceilings and the analyze context, and the Volatility Clustering
 * panel shows its result, so the two cannot drift (F24 in
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md).
 */

export interface ClusterSignalInputs {
  readonly vix: number | null | undefined;
  readonly spot: number | null | undefined;
  /** Yesterday's open: the reference price for the range when it is > 0. */
  readonly open: number | null | undefined;
  readonly high: number | null | undefined;
  readonly low: number | null | undefined;
}

export interface ClusterSignal {
  /** (high - low) / reference price x 100; null when high is not above low. */
  readonly rangePct: number | null;
  /** The bucket lookup; null without a range or without a VIX above 0. */
  readonly cluster: ClusterResult | null;
  /** cluster.mult, or 1 (no effect) when there is no cluster. */
  readonly mult: number;
}

const NO_SIGNAL: ClusterSignal = { rangePct: null, cluster: null, mult: 1 };

function isNumber(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * The reference price: yesterday's open if > 0, else spot if > 0, else the
 * high-low midpoint.
 */
function referencePrice(
  open: number | null | undefined,
  spot: number | null | undefined,
  high: number,
  low: number,
): number {
  if (isNumber(open) && open > 0) return open;
  if (isNumber(spot) && spot > 0) return spot;
  return (high + low) / 2;
}

export function computeClusterSignal({
  vix,
  spot,
  open,
  high,
  low,
}: ClusterSignalInputs): ClusterSignal {
  if (!isNumber(high) || !isNumber(low) || high <= low) return NO_SIGNAL;
  const refPrice = referencePrice(open, spot, high, low);
  // A midpoint at or below 0 would give an Infinity or negative range.
  if (refPrice <= 0) return NO_SIGNAL;

  const rangePct = ((high - low) / refPrice) * 100;
  const cluster =
    isNumber(vix) && vix > 0 ? getClusterMultiplier(vix, rangePct) : null;
  return { rangePct, cluster, mult: cluster?.mult ?? 1 };
}
