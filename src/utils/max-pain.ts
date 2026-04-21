/**
 * Pure client-side max-pain computation.
 *
 * Max pain is the settlement price that minimizes the aggregate intrinsic
 * payout across every listed call and put. Option writers (typically dealers)
 * collectively profit at that strike, and on low-gamma days price tends to
 * gravitate toward it through dealer hedging flows.
 *
 * For each candidate settlement S (iterated over the set of listed strikes),
 * we sum `callOi * max(0, S - strike)` + `putOi * max(0, strike - S)` across
 * every strike — the total intrinsic payout to option buyers. The max-pain
 * strike is the candidate S that minimizes that payout.
 *
 * Returns `null` when:
 *   - `strikes` is empty (no data), or
 *   - every strike has zero OI on both sides (uninformative data — the
 *     per-candidate payout is zero everywhere by definition, so the
 *     "minimum" is a meaningless tie).
 *
 * Mirrors the server-side selection logic in `api/_lib/max-pain.ts`, but
 * computes max-pain from per-strike OI rather than consuming it pre-computed
 * from the UW endpoint. Used by `useFuturesGammaPlaybook` for scrub mode,
 * where no live UW call is available.
 */

export interface MaxPainStrikeInput {
  /** Strike price (SPX index points). */
  strike: number;
  /** Call-side open interest in contracts. */
  callOi: number;
  /** Put-side open interest in contracts. */
  putOi: number;
}

export function computeMaxPain(strikes: MaxPainStrikeInput[]): number | null {
  if (strikes.length === 0) return null;

  // Informative data must include at least one strike with non-zero OI on
  // some side. All-zero OI yields payout = 0 at every candidate → the
  // "minimum" is an arbitrary tie that would leak false signal downstream.
  const hasAnyOi = strikes.some((s) => s.callOi !== 0 || s.putOi !== 0);
  if (!hasAnyOi) return null;

  let bestStrike: number | null = null;
  let bestPayout = Number.POSITIVE_INFINITY;

  for (const candidate of strikes) {
    let payout = 0;
    for (const s of strikes) {
      // Call-buyer intrinsic at settlement S = candidate.strike:
      //   max(0, S - strike) * callOi
      const callIntrinsic = Math.max(0, candidate.strike - s.strike);
      // Put-buyer intrinsic at settlement S:
      //   max(0, strike - S) * putOi
      const putIntrinsic = Math.max(0, s.strike - candidate.strike);
      payout += callIntrinsic * s.callOi + putIntrinsic * s.putOi;
    }

    if (payout < bestPayout) {
      bestPayout = payout;
      bestStrike = candidate.strike;
    }
  }

  return bestStrike;
}
