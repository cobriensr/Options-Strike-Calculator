/**
 * Price-trend helper for the GexLandscape drift override.
 *
 * Phase 4 of the 1-min GexBot rebuild dropped the 5-min snapshot
 * smoothing buffer (`computeSmoothedStrikes`) — GexBot's native 1-min
 * cadence is fast enough that single-snapshot bias is stable without
 * smoothing. `computePriceTrend` is what's left: a thin adapter over
 * the primitive in `src/utils/price-trend.ts` that takes a flat
 * `{ts, price}[]` buffer instead of full `Snapshot[]`.
 *
 * Pure functions, no React — all state ownership lives in the component.
 */

import {
  computePriceTrend as computePriceTrendPrimitive,
  type PricePoint,
} from '../../utils/price-trend';
import type { PriceTrend } from './types';

export type { PricePoint };

/**
 * Minimum buffered points required before emitting a directional trend.
 * Sits one step above the primitive's own MIN_SNAPSHOTS = 3 because we
 * append a synthesized "now" point — with 3 buffered + 1 current we
 * get a real 3-interval consistency reading.
 */
const MIN_BUFFERED_POINTS = 3;

/**
 * Compute a price trend from a minimal `{ts, price}` buffer.
 *
 * Filters to entries within `[nowTs - windowMs, nowTs]`, requires at
 * least `MIN_BUFFERED_POINTS` in-window samples, then appends the
 * caller's `currentPrice` as the "now" point and hands off to the
 * primitive.
 *
 * The upper bound (`pt.ts <= nowTs`) is load-bearing for scrub
 * correctness: live-accumulated buffer entries from after the scrubbed
 * `nowTs` would otherwise leak into the trend reading. See the
 * regression test in `GexLandscape-deltas.test.ts`.
 */
export function computePriceTrend(
  currentPrice: number,
  buf: PricePoint[],
  nowTs: number,
  windowMs = 30 * 60 * 1000,
): PriceTrend {
  const inWindow = buf.filter(
    (pt) => pt.ts >= nowTs - windowMs && pt.ts <= nowTs,
  );
  if (inWindow.length < MIN_BUFFERED_POINTS) {
    return { direction: 'flat', changePct: 0, changePts: 0, consistency: 0 };
  }
  const points: PricePoint[] = inWindow.map((pt) => ({
    price: pt.price,
    ts: pt.ts,
  }));
  points.push({ price: currentPrice, ts: nowTs });
  return computePriceTrendPrimitive(points, nowTs, windowMs);
}
