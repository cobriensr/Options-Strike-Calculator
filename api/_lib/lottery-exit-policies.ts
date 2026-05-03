/**
 * Lottery Finder — realized exit policies.
 *
 * Pure TS port of the three exit policies that ship in Phase 1 (default
 * + two toggles per the spec) plus peakCeiling as a reference metric:
 *
 *   1. realizedTrailAct30Trail10  — default, conservative trailing stop
 *   2. realizedHardStop30m         — EV-best, hard 30-min time stop
 *   3. realizedTier50HoldEod       — middle ground, two-tier exit
 *   4. peakCeiling                 — best-case (NOT a tradeable policy)
 *
 * The wider grid that p27 tested (act20/act50/grace/percentage trails)
 * is intentionally NOT ported — it would just expand the surface area
 * of the UI without changing user behavior.
 *
 * Each function takes the post-entry price stream of one chain and
 * returns the realized return percentage at the policy's exit point
 * (or at the last known price if no exit triggers). All returns are
 * % of entry price (e.g. +25.5 = sold for 1.255× entry).
 *
 * Inputs are simple parallel arrays so callers can pass straight from a
 * Postgres query without object mapping.
 */

/**
 * Trailing stop with absolute-pp drawdown — activates at +act% on a
 * running peak, exits when current return ≤ peak − dropPp.
 *
 * The default policy (act=30, dropPp=10) is the most conservative: it
 * leaves big right-tail upside on the table but keeps 50% of LOO days
 * profitable in the 15-day backtest.
 */
export function realizedTrailAct30Trail10(
  prices: number[],
  entry: number,
): number {
  return trailPp(prices, entry, 30, 10);
}

/**
 * Hard time-stop — exit at the last print whose offset from entry is
 * ≤ stopMin minutes. Highest EV in the 15-day backtest (+$127/day mean)
 * but only 25% of days are profitable: bigger wins, rarer.
 *
 * minutesSinceEntry must be the same length as prices and monotonically
 * non-decreasing (which a tape-time stream always is).
 */
export function realizedHardStop30m(
  prices: number[],
  entry: number,
  minutesSinceEntry: number[],
  stopMin = 30,
): number {
  if (entry <= 0 || prices.length === 0) return 0;

  // Find the last index whose ts ≤ stopMin. Linear scan with early
  // break — minutesSinceEntry is monotonic.
  let lastIn = -1;
  for (let i = 0; i < minutesSinceEntry.length; i++) {
    if (minutesSinceEntry[i]! <= stopMin) lastIn = i;
    else break;
  }
  if (lastIn === -1) return 0;
  return ((prices[lastIn]! - entry) / entry) * 100;
}

/**
 * Two-tier 50/50 exit: sell first half at +50% (first time threshold is
 * touched), hold second half to last print. Returns the equal-weighted
 * average realized return.
 *
 * Middle ground in EV vs the trail and the hard stop.
 */
export function realizedTier50HoldEod(prices: number[], entry: number): number {
  if (entry <= 0 || prices.length === 0) return 0;
  const last = prices.at(-1)!;
  let tier1Idx = -1;
  for (let i = 0; i < prices.length; i++) {
    const r = ((prices[i]! - entry) / entry) * 100;
    if (r >= 50) {
      tier1Idx = i;
      break;
    }
  }
  if (tier1Idx === -1) {
    // Tier 1 never filled — both halves ride to last print.
    return ((last - entry) / entry) * 100;
  }
  const tier1Ret = ((prices[tier1Idx]! - entry) / entry) * 100;
  const tier2Ret = ((last - entry) / entry) * 100;
  return (tier1Ret + tier2Ret) / 2;
}

/**
 * Best-case peak return — % gain at the highest post-entry print.
 * NOT a tradeable policy (look-ahead) but useful as a reference column
 * for the dashboard so users can see how much upside the realized
 * policies left on the table.
 */
export function peakCeiling(prices: number[], entry: number): number {
  if (entry <= 0 || prices.length === 0) return 0;
  let max = prices[0]!;
  for (let i = 1; i < prices.length; i++) {
    const px = prices[i]!;
    if (px > max) max = px;
  }
  return ((max - entry) / entry) * 100;
}

/**
 * Minutes-from-entry-to-peak — paired metric to peakCeiling. Used by
 * the dashboard to display "could have sold at +X% Y minutes after
 * entry". Returns the offset of the first occurrence of the maximum.
 */
export function minutesToPeak(
  prices: number[],
  minutesSinceEntry: number[],
): number {
  if (prices.length === 0) return 0;
  let maxIdx = 0;
  let maxPx = prices[0]!;
  for (let i = 1; i < prices.length; i++) {
    const px = prices[i]!;
    if (px > maxPx) {
      maxPx = px;
      maxIdx = i;
    }
  }
  return minutesSinceEntry[maxIdx] ?? 0;
}

// ============================================================
// Internals
// ============================================================

function trailPp(
  prices: number[],
  entry: number,
  act: number,
  dropPp: number,
): number {
  if (entry <= 0 || prices.length === 0) return 0;
  let activated = false;
  let peak = -Infinity;
  for (let i = 0; i < prices.length; i++) {
    const r = ((prices[i]! - entry) / entry) * 100;
    if (!activated) {
      if (r >= act) {
        activated = true;
        peak = r;
      }
    } else {
      if (r > peak) peak = r;
      else if (r <= peak - dropPp) return r;
    }
  }
  return ((prices.at(-1)! - entry) / entry) * 100;
}
