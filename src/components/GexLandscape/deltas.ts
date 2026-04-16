/**
 * Snapshot-buffer helpers: 1m/5m Δ%, closest-snapshot lookup, and
 * per-strike smoothing used by the bias verdict.
 *
 * Pure functions, no React — all state ownership lives in the component.
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { DRIFT_CONSISTENCY_THRESHOLD, DRIFT_PTS_THRESHOLD } from './constants';
import type { PriceTrend, Snapshot } from './types';

/** Compute % change in netGamma from prev → current for each strike. */
export function computeDeltaMap(
  current: GexStrikeLevel[],
  prev: GexStrikeLevel[],
): Map<number, number | null> {
  const prevByStrike = new Map(prev.map((s) => [s.strike, s.netGamma]));
  const result = new Map<number, number | null>();
  for (const s of current) {
    const prevGamma = prevByStrike.get(s.strike);
    result.set(
      s.strike,
      prevGamma === undefined || prevGamma === 0
        ? null
        : ((s.netGamma - prevGamma) / Math.abs(prevGamma)) * 100,
    );
  }
  return result;
}

/**
 * Find the snapshot in `buf` whose timestamp is closest to `targetTs`.
 * Returns null if no snapshot falls within `toleranceMs` of the target,
 * so callers get an empty column rather than a misleading comparison.
 */
export function findClosestSnapshot(
  buf: Snapshot[],
  targetTs: number,
  toleranceMs = 120_000,
): Snapshot | null {
  if (!buf.length) return null;
  let closest: Snapshot | null = null;
  let minDiff = Infinity;
  for (const snap of buf) {
    const diff = Math.abs(snap.ts - targetTs);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snap;
    }
  }
  return minDiff <= toleranceMs ? closest : null;
}

/**
 * Average netGamma and netCharm for each strike across the current snapshot
 * and all buffer entries within `windowMs` (default 5 minutes).
 *
 * Smoothing makes the structural bias verdict stable: small minute-to-minute
 * GEX fluctuations won't flip the signal. The Δ% columns in the table still
 * show raw real-time changes — only the verdict inputs are smoothed.
 */
export function computeSmoothedStrikes(
  current: GexStrikeLevel[],
  buf: Snapshot[],
  nowTs: number,
  windowMs = 5 * 60 * 1000,
): GexStrikeLevel[] {
  const recent = buf.filter((snap) => snap.ts >= nowTs - windowMs);
  if (recent.length === 0) return current;
  return current.map((s) => {
    const history = recent
      .map((snap) => snap.strikes.find((r) => r.strike === s.strike))
      .filter((r): r is GexStrikeLevel => r !== undefined);
    if (history.length === 0) return s;
    const all = [s, ...history];
    const avgGamma = all.reduce((sum, r) => sum + r.netGamma, 0) / all.length;
    const avgCharm = all.reduce((sum, r) => sum + r.netCharm, 0) / all.length;
    return { ...s, netGamma: avgGamma, netCharm: avgCharm };
  });
}

/**
 * Compute a price trend from the snapshot buffer.
 *
 * Extracts `strikes[0].price` from each buffered snapshot within `windowMs`,
 * measures the net point/% change, and checks directional consistency to
 * distinguish sustained drifts from choppy noise.
 */
export function computePriceTrend(
  currentPrice: number,
  buf: Snapshot[],
  nowTs: number,
  windowMs = 5 * 60 * 1000,
): PriceTrend {
  const recent = buf
    .filter((snap) => snap.ts >= nowTs - windowMs && snap.strikes.length > 0)
    .sort((a, b) => a.ts - b.ts);

  const MIN_SNAPSHOTS = 3;
  if (recent.length < MIN_SNAPSHOTS) {
    return { direction: 'flat', changePct: 0, changePts: 0, consistency: 0 };
  }

  // Build price series: buffered snapshots + current price
  const prices = recent.map((s) => s.strikes[0]!.price);
  prices.push(currentPrice);

  const first = prices[0]!;
  const changePts = currentPrice - first;
  const changePct = first > 0 ? (changePts / first) * 100 : 0;

  // Count directional intervals (skip flat intervals)
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! > prices[i - 1]!) ups++;
    else if (prices[i]! < prices[i - 1]!) downs++;
  }
  const total = ups + downs;
  const dominant = Math.max(ups, downs);
  const consistency = total > 0 ? dominant / total : 0;

  let direction: PriceTrend['direction'] = 'flat';
  if (
    Math.abs(changePts) >= DRIFT_PTS_THRESHOLD &&
    consistency >= DRIFT_CONSISTENCY_THRESHOLD
  ) {
    direction = changePts > 0 ? 'up' : 'down';
  }

  return { direction, changePct, changePts, consistency };
}
