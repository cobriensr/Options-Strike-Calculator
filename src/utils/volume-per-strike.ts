/**
 * Volume-per-strike math: pure helpers for turning per-minute 0DTE volume
 * snapshots into the top-ranked strikes, intraday "magnets" (highest call
 * and highest put volume), percent-delta series, and spot-relative distance.
 *
 * The design mirrors `gex-migration.ts`: the endpoint returns raw snapshot
 * rows and the frontend component picks a slice / metric at render time,
 * so mode switching is instant (no re-fetch). These functions are pure,
 * synchronous, tree-shakeable, and stateless — the Phase 4 React component
 * will call them inside a `useMemo`.
 *
 * The "magnet" concept is from Wonce's original Discord description:
 * "just plotting the most volume call and put strike" — the two strikes
 * where 0DTE flow is concentrating and pulling price.
 */

import type { VolumePerStrikeRow, VolumePerStrikeSnapshot } from '../types/api';

/**
 * Find the single strike with the highest call volume and the single
 * strike with the highest put volume in a snapshot. These are the two
 * intraday "magnets" — Wonce's method from the original Discord
 * conversation: "just plotting the most volume call and put strike".
 *
 * On tie, the LOWER strike wins (stable, deterministic). Because the
 * snapshot's strikes are already sorted ascending (as guaranteed by the
 * read endpoint) and the loop uses strict `>` comparison, the first strike
 * to hit a given max value is retained.
 *
 * Returns nulls when the snapshot is empty or missing.
 *
 * Note: an all-zero snapshot (every row has `callVolume === 0` and
 * `putVolume === 0`) is NOT treated as "no data" — it returns the lowest
 * strike in the snapshot, because `0 > -Infinity` on the first row seeds
 * the maxes and subsequent equal-zero rows never beat it (strict `>`).
 * Callers that need a "no data" signal at the start of the trading day
 * should check `snapshot.strikes.length` or the total traded volume
 * themselves rather than relying on null magnets.
 */
export function findMagnets(
  snapshot: VolumePerStrikeSnapshot | null | undefined,
): { maxCallStrike: number | null; maxPutStrike: number | null } {
  if (!snapshot || snapshot.strikes.length === 0) {
    return { maxCallStrike: null, maxPutStrike: null };
  }

  let maxCallStrike: number | null = null;
  let maxCallVolume = -Infinity;
  let maxPutStrike: number | null = null;
  let maxPutVolume = -Infinity;

  for (const row of snapshot.strikes) {
    if (row.callVolume > maxCallVolume) {
      maxCallVolume = row.callVolume;
      maxCallStrike = row.strike;
    }
    if (row.putVolume > maxPutVolume) {
      maxPutVolume = row.putVolume;
      maxPutStrike = row.strike;
    }
  }

  return { maxCallStrike, maxPutStrike };
}

/**
 * Rank strikes in a snapshot by `max(callVolume, putVolume)` descending
 * and return the top N. Ranking by the per-side max (rather than the
 * call+put total) guarantees the single-highest-per-side strikes from
 * `findMagnets()` are always visible in the ranked list, even on extreme
 * days where one side dominates and a top-by-total ranking would miss it.
 *
 * Stable sort — ties break by preserving the snapshot's original order
 * (which is ascending by strike, as guaranteed by the read endpoint).
 * Does not mutate the input snapshot.
 */
export function rankByVolume(
  snapshot: VolumePerStrikeSnapshot | null | undefined,
  topN: number,
): VolumePerStrikeRow[] {
  if (!snapshot || snapshot.strikes.length === 0 || topN <= 0) return [];

  // Copy to a mutable array so we can sort without mutating the snapshot.
  // Array.prototype.sort is stable in modern JS engines, so equal keys
  // preserve the original (ascending-strike) order.
  const copy: VolumePerStrikeRow[] = snapshot.strikes.slice();
  copy.sort((a, b) => {
    const aKey = Math.max(a.callVolume, a.putVolume);
    const bKey = Math.max(b.callVolume, b.putVolume);
    return bKey - aKey;
  });

  return copy.slice(0, topN);
}

/**
 * Compute the 5-min-style percent delta of volume at a strike across
 * snapshots. Used for the ΔVOL column that mirrors the existing ΔGEX
 * column in the SOFBOT GEX panel.
 *
 * - `metric` = 'call' | 'put' | 'total' — which volume field to diff.
 *   'total' sums call and put volume at the strike.
 * - `offsetSlots` = how many snapshots back to compare (5 for 5-min at
 *    1-min cadence, 20 for 20-min at 1-min cadence).
 *
 * Returns null when:
 *   - snapshots has fewer than `offsetSlots + 1` entries
 *   - the strike isn't present in the latest or reference snapshot
 *   - the reference (past) value is 0 (can't divide by zero)
 *
 * Formula (matches gex-migration.ts:pctChange exactly):
 *   ((now - past) / Math.abs(past)) * 100
 *
 * `Math.abs(past)` is used even though volume is always non-negative,
 * keeping the formula identical to `pctChange` in gex-migration.ts so
 * the codebase has one mental model for percent deltas.
 */
export function computeVolumeDelta(
  snapshots: readonly VolumePerStrikeSnapshot[],
  strike: number,
  metric: 'call' | 'put' | 'total',
  offsetSlots: number,
): number | null {
  if (snapshots.length < offsetSlots + 1) return null;

  const latest = snapshots.at(-1);
  const past = snapshots[snapshots.length - 1 - offsetSlots];
  if (!latest || !past) return null;

  const latestRow = latest.strikes.find((r) => r.strike === strike);
  const pastRow = past.strikes.find((r) => r.strike === strike);
  if (!latestRow || !pastRow) return null;

  const pick = (row: VolumePerStrikeRow): number => {
    if (metric === 'call') return row.callVolume;
    if (metric === 'put') return row.putVolume;
    return row.callVolume + row.putVolume;
  };

  const nowValue = pick(latestRow);
  const pastValue = pick(pastRow);
  if (pastValue === 0) return null;

  return ((nowValue - pastValue) / Math.abs(pastValue)) * 100;
}

/**
 * Signed distance from spot in points. Positive = strike above spot
 * (call-side), negative = below spot (put-side). Matches the sign
 * convention used in ChainStrike / GexMigration elsewhere in the codebase.
 */
export function distFromSpot(strike: number, spot: number): number {
  return strike - spot;
}
