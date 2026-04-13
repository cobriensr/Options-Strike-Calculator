/**
 * Zero-gamma level computation.
 *
 * The "zero-gamma strike" (also called the gamma flip level, GEX flip, or
 * volatility trigger) is the approximate spot price at which aggregate
 * dealer gamma exposure flips from positive (long gamma → dealers hedge
 * mean-reverting, suppression regime) to negative (short gamma → dealers
 * hedge momentum, acceleration regime).
 *
 * **Algorithm (industry-standard approximation):**
 *
 * 1. Aggregate `netGamma` per unique strike (defensive against upstream
 *    rows that may duplicate strikes across expiries).
 * 2. Sort strikes ascending and compute a cumulative running sum.
 * 3. Find every zero crossing in the running sum via linear interpolation
 *    between adjacent strike points.
 * 4. If there are multiple crossings (distorted profile), return the
 *    crossing closest to spot — that is the regime boundary actually
 *    governing current hedging mechanics.
 *
 * **Sign convention** (dealer perspective, matching the rest of the repo):
 * - `netGamma > 0` → dealers net long gamma (suppression / pinning)
 * - `netGamma < 0` → dealers net short gamma (acceleration)
 *
 * The current regime is determined by computing cumulative gamma through
 * all strikes *up to and including* spot, then reading the sign. This is
 * more robust than sign(spot − flipStrike) because a distorted profile
 * can have the flip go in either direction as strikes increase.
 *
 * Referenced by ENH-SIGNAL-001 in
 * `docs/superpowers/specs/analyze-prompt-enhancements-2026-04-08.md`.
 */

export interface StrikeGamma {
  strike: number;
  netGamma: number;
}

export interface ZeroGammaAnalysis {
  /**
   * The strike price at which cumulative dealer gamma flips sign.
   * `null` when no crossing exists (all strikes carry the same sign) or
   * when the input is too sparse to compute a crossing (< 2 strikes).
   */
  zeroGammaStrike: number | null;

  /**
   * Signed distance from spot to the flip strike, in SPX points.
   * Positive = spot is above the flip; negative = spot is below.
   * `null` when `zeroGammaStrike` is `null`.
   */
  distancePoints: number | null;

  /**
   * Unsigned distance in fractions of the straddle cone half-width.
   * A value of `1.0` means the flip is exactly one expected-move
   * half-width away; `0.5` means half a cone away; etc. `null` when
   * the cone half-width is unknown or non-positive, or when
   * `zeroGammaStrike` is `null`.
   */
  distanceConeFraction: number | null;

  /**
   * Current dealer gamma regime at spot, derived from cumulative gamma
   * across all strikes at or below spot.
   * - `'positive'` → dealers net long gamma → suppression / pinning regime
   * - `'negative'` → dealers net short gamma → acceleration / momentum regime
   * - `'unknown'` → input was empty or otherwise insufficient to decide
   */
  currentRegime: 'positive' | 'negative' | 'unknown';

  /**
   * Number of zero crossings detected in the cumulative gamma profile.
   * - `0` → no crossing (single-regime day, the flip is outside the
   *   observed strike range)
   * - `1` → clean single crossing (typical, textbook case)
   * - `>=2` → distorted profile with multiple crossings. The returned
   *   `zeroGammaStrike` is the crossing closest to spot, but the high
   *   count is itself a signal worth flagging in the prompt.
   */
  crossingCount: number;
}

/**
 * Aggregate `netGamma` per unique strike. Protects the algorithm against
 * upstream row shapes that may include one row per (strike, expiry) pair.
 */
function aggregateByStrike(strikes: readonly StrikeGamma[]): StrikeGamma[] {
  const byStrike = new Map<number, number>();
  for (const s of strikes) {
    byStrike.set(s.strike, (byStrike.get(s.strike) ?? 0) + s.netGamma);
  }
  return [...byStrike.entries()]
    .map(([strike, netGamma]) => ({ strike, netGamma }))
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Find all zero crossings in the cumulative gamma sequence.
 * Each crossing is returned as an interpolated strike price (fractional).
 */
function findZeroCrossings(
  sortedWithCumulative: ReadonlyArray<{ strike: number; cumulative: number }>,
): number[] {
  const crossings: number[] = [];
  for (let i = 1; i < sortedWithCumulative.length; i++) {
    const prev = sortedWithCumulative[i - 1]!;
    const curr = sortedWithCumulative[i]!;

    // Exact zero at current point (rare but possible).
    if (curr.cumulative === 0) {
      crossings.push(curr.strike);
      continue;
    }

    // Strict sign change between adjacent points. We use strict inequality
    // so an exact-zero at `prev` isn't double-counted here — it was already
    // pushed when that iteration ran.
    const crossed =
      (prev.cumulative < 0 && curr.cumulative > 0) ||
      (prev.cumulative > 0 && curr.cumulative < 0);

    if (crossed) {
      // Linear interpolation for sub-strike precision:
      //   flip = prev.strike + t * (curr.strike - prev.strike)
      //   where t is the fraction of the gap at which cumulative = 0.
      const t = -prev.cumulative / (curr.cumulative - prev.cumulative);
      crossings.push(prev.strike + t * (curr.strike - prev.strike));
    }
  }
  return crossings;
}

/**
 * Compute the zero-gamma (flip) strike from a set of per-strike gamma
 * exposures. Pure function, no side effects.
 *
 * @param strikes Array of `{ strike, netGamma }` pairs. May contain
 *   duplicate strikes (rows for different expiries) — these are
 *   aggregated automatically.
 * @param spot Current SPX spot price. Used only to pick the closest
 *   crossing when multiple zero crossings exist (distorted profile).
 * @returns The interpolated strike price where cumulative dealer gamma
 *   flips sign, or `null` when no crossing exists or the input is
 *   too sparse.
 */
export function computeZeroGammaStrike(
  strikes: readonly StrikeGamma[],
  spot: number,
): number | null {
  const aggregated = aggregateByStrike(strikes);
  if (aggregated.length < 2) return null;

  let cumulative = 0;
  const withCumulative = aggregated.map((s) => {
    cumulative += s.netGamma;
    return { strike: s.strike, cumulative };
  });

  const crossings = findZeroCrossings(withCumulative);
  if (crossings.length === 0) return null;
  if (crossings.length === 1) return crossings[0]!;

  // Multiple crossings (distorted profile): return the one closest to spot.
  // That's the flip actually governing current hedging mechanics.
  return crossings.reduce(
    (closest, current) =>
      Math.abs(current - spot) < Math.abs(closest - spot) ? current : closest,
    crossings[0]!,
  );
}

/**
 * Determine the current dealer gamma regime at spot by computing cumulative
 * gamma across all aggregated strikes at or below spot.
 *
 * This is more robust than `sign(spot - flipStrike)` because a distorted
 * profile can have the cumulative walk go in either direction as strikes
 * increase — meaning "above the flip" is not guaranteed to be the positive
 * regime. Reading the actual cumulative sign at spot eliminates that
 * ambiguity.
 */
function computeCurrentRegime(
  aggregated: readonly StrikeGamma[],
  spot: number,
): 'positive' | 'negative' | 'unknown' {
  if (aggregated.length === 0) return 'unknown';
  let cumulative = 0;
  for (const s of aggregated) {
    if (s.strike > spot) break;
    cumulative += s.netGamma;
  }
  if (cumulative > 0) return 'positive';
  if (cumulative < 0) return 'negative';
  return 'unknown';
}

/**
 * High-level analysis helper: compute the zero-gamma strike, the distance
 * from spot, the regime-normalized distance in cone half-widths, and the
 * current regime — all in one call.
 *
 * @param strikes Per-strike net gamma exposures.
 * @param spot Current SPX spot price.
 * @param straddleConeHalfWidth Half-width of today's straddle cone in SPX
 *   points. Used to normalize the distance-to-flip into "cone fractions",
 *   where 1.0 = one full expected-move half-width. Pass `null` when the
 *   cone is unavailable — the `distanceConeFraction` field will be `null`
 *   but every other field is still populated.
 */
export function analyzeZeroGamma(
  strikes: readonly StrikeGamma[],
  spot: number,
  straddleConeHalfWidth: number | null,
): ZeroGammaAnalysis {
  const aggregated = aggregateByStrike(strikes);

  // Insufficient data → return an unknown result, not an exception.
  if (aggregated.length < 2) {
    return {
      zeroGammaStrike: null,
      distancePoints: null,
      distanceConeFraction: null,
      currentRegime: computeCurrentRegime(aggregated, spot),
      crossingCount: 0,
    };
  }

  let cumulative = 0;
  const withCumulative = aggregated.map((s) => {
    cumulative += s.netGamma;
    return { strike: s.strike, cumulative };
  });

  const crossings = findZeroCrossings(withCumulative);
  const currentRegime = computeCurrentRegime(aggregated, spot);

  if (crossings.length === 0) {
    return {
      zeroGammaStrike: null,
      distancePoints: null,
      distanceConeFraction: null,
      currentRegime,
      crossingCount: 0,
    };
  }

  // Pick the crossing closest to spot when there are multiple.
  const zeroGammaStrike =
    crossings.length === 1
      ? crossings[0]!
      : crossings.reduce(
          (closest, current) =>
            Math.abs(current - spot) < Math.abs(closest - spot)
              ? current
              : closest,
          crossings[0]!,
        );

  const distancePoints = spot - zeroGammaStrike;
  const distanceConeFraction =
    straddleConeHalfWidth != null && straddleConeHalfWidth > 0
      ? Math.abs(distancePoints) / straddleConeHalfWidth
      : null;

  return {
    zeroGammaStrike,
    distancePoints,
    distanceConeFraction,
    currentRegime,
    crossingCount: crossings.length,
  };
}
