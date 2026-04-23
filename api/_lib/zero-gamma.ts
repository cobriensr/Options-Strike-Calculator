/**
 * Zero-Gamma Level Calculator
 *
 * Pure, side-effect-free module. Given a snapshot of dealer gamma per strike
 * and the current spot price, computes the spot level where net dealer gamma
 * would flip sign ("zero-gamma"). This is the regime-flip reference:
 *   - spot > zero_gamma → dealers net long gamma (mean-reverting / dampened)
 *   - spot < zero_gamma → dealers net short gamma (trend-accelerating)
 *
 * ## Algorithm
 *
 * 1. Build a candidate spot grid of `gridPoints` samples over
 *    [spot*(1-gridRangePct), spot*(1+gridRangePct)].
 * 2. For each candidate c, compute netGamma(c) = Σ gamma_i × kernel(strike_i − c)
 *    where kernel is a linear triangular kernel with half-width = 2 ×
 *    (median consecutive strike spacing). This models "what would dealer
 *    gamma be if spot sat at c?" without requiring a full re-pricing.
 * 3. Walk the curve in order; at the first sign change, linearly interpolate
 *    between the two adjacent candidates to locate the zero crossing.
 * 4. Confidence = |slope at crossing| ÷ max(|netGamma|) over the curve,
 *    clipped to [0, 1]. Steeper crossings → higher confidence.
 *
 * No DB, no logger, no I/O. Deterministic given the same inputs.
 */

export interface GexStrike {
  strike: number;
  /** Signed dealer gamma $ notional (positive = dealers long gamma). */
  gamma: number;
}

export interface ZeroGammaResult {
  /** Spot price where net gamma = 0; null if no sign change in the grid. */
  level: number | null;
  /** [0, 1] — higher = steeper, more reliable crossing. */
  confidence: number;
  /** Sampled curve for downstream visualization / debugging. */
  curve: Array<{ spot: number; netGamma: number }>;
}

export interface ZeroGammaOptions {
  /** Number of candidate spots sampled across the range. Default 30. */
  gridPoints?: number;
  /** Half-width of the spot grid as a fraction of spot. Default 0.03 (±3%). */
  gridRangePct?: number;
}

const DEFAULT_GRID_POINTS = 30;
const DEFAULT_GRID_RANGE_PCT = 0.03;
/**
 * Fallback strike spacing when the input has <2 strikes. Chosen to match
 * the characteristic 5-point SPX strike grid so the kernel's support is
 * non-degenerate even on pathological inputs.
 */
const SPX_FALLBACK_SPACING = 5;
/**
 * Triangular-kernel half-width expressed in strike-spacing units. At 2×, a
 * strike contributes to candidate spots within ±2 strikes of itself —
 * wide enough to smooth isolated OI but narrow enough to preserve local
 * structure. Smaller values sharpen the curve; larger values smooth it.
 */
const KERNEL_HALF_WIDTH_MULT = 2;

/**
 * Median of the absolute differences between consecutive sorted strikes.
 * Used as the characteristic strike spacing for the triangular kernel.
 * Falls back to a reasonable SPX-scale default when the input is too sparse
 * (caller is still expected to handle single-strike edge cases upstream).
 */
function medianStrikeSpacing(sortedStrikes: number[]): number {
  if (sortedStrikes.length < 2) {
    // No spacing observable from one strike — return a value large enough
    // that the lone strike contributes across the grid without blowing up.
    return SPX_FALLBACK_SPACING;
  }
  const diffs: number[] = [];
  for (let i = 1; i < sortedStrikes.length; i += 1) {
    const prev = sortedStrikes[i - 1] ?? 0;
    const curr = sortedStrikes[i] ?? 0;
    diffs.push(Math.abs(curr - prev));
  }
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  if (diffs.length % 2 === 1) {
    return diffs[mid] ?? 0;
  }
  const lo = diffs[mid - 1] ?? 0;
  const hi = diffs[mid] ?? 0;
  return (lo + hi) / 2;
}

/**
 * Linear triangular kernel centered at 0 with the given half-width.
 * kernel(0) = 1, kernel(±halfWidth) = 0, zero outside. Returns 0 when
 * halfWidth ≤ 0 (defensive guard against pathological inputs).
 */
function triangularKernel(delta: number, halfWidth: number): number {
  if (halfWidth <= 0) return 0;
  const abs = Math.abs(delta);
  if (abs >= halfWidth) return 0;
  return 1 - abs / halfWidth;
}

export function computeZeroGammaLevel(
  gexByStrike: GexStrike[],
  spot: number,
  options: ZeroGammaOptions = {},
): ZeroGammaResult {
  if (gexByStrike.length === 0) {
    return { level: null, confidence: 0, curve: [] };
  }

  const gridPoints = options.gridPoints ?? DEFAULT_GRID_POINTS;
  const gridRangePct = options.gridRangePct ?? DEFAULT_GRID_RANGE_PCT;

  // Sort strikes ascending for median spacing computation. Keep the gamma
  // alongside each strike — we iterate the full list in the kernel sum.
  const sorted = [...gexByStrike].sort((a, b) => a.strike - b.strike);
  const sortedStrikes = sorted.map((s) => s.strike);
  const spacing = medianStrikeSpacing(sortedStrikes);
  const halfWidth = spacing * KERNEL_HALF_WIDTH_MULT;

  // Build candidate grid. For gridPoints < 2 we degenerate to a single
  // sample at spot, which trivially cannot exhibit a sign change.
  const lo = spot * (1 - gridRangePct);
  const hi = spot * (1 + gridRangePct);
  const curve: Array<{ spot: number; netGamma: number }> = [];

  if (gridPoints < 2) {
    curve.push({ spot, netGamma: sumKernel(sorted, spot, halfWidth) });
    return { level: null, confidence: 0, curve };
  }

  const step = (hi - lo) / (gridPoints - 1);
  for (let i = 0; i < gridPoints; i += 1) {
    const c = lo + step * i;
    curve.push({ spot: c, netGamma: sumKernel(sorted, c, halfWidth) });
  }

  // Scan for the first true sign change (positive to negative or vice
  // versa). We explicitly ignore transitions from/to exactly zero — those
  // are almost always caused by candidate spots sitting outside the
  // kernel's support on the edges of the grid, not by real dealer gamma
  // flipping sign. A meaningful zero-gamma level requires gamma of
  // opposite signs on either side of the crossing.
  let crossingIndex = -1;
  for (let i = 0; i < curve.length - 1; i += 1) {
    const a = curve[i];
    const b = curve[i + 1];
    if (!a || !b) continue;
    if (
      (a.netGamma > 0 && b.netGamma < 0) ||
      (a.netGamma < 0 && b.netGamma > 0)
    ) {
      crossingIndex = i;
      break;
    }
  }

  if (crossingIndex === -1) {
    return { level: null, confidence: 0, curve };
  }

  const a = curve[crossingIndex];
  const b = curve[crossingIndex + 1];
  if (!a || !b) {
    return { level: null, confidence: 0, curve };
  }

  // Linear interpolation: find t where a.netGamma + t*(b.netGamma - a.netGamma) = 0
  const denom = b.netGamma - a.netGamma;
  const t = denom === 0 ? 0 : -a.netGamma / denom;
  const level = a.spot + t * (b.spot - a.spot);

  return {
    level,
    confidence: computeConfidence(curve, crossingIndex),
    curve,
  };
}

function sumKernel(
  sorted: GexStrike[],
  candidate: number,
  halfWidth: number,
): number {
  let total = 0;
  for (const s of sorted) {
    total += s.gamma * triangularKernel(s.strike - candidate, halfWidth);
  }
  return total;
}

/**
 * Confidence = |local slope at crossing| ÷ max(|netGamma|) across the curve,
 * clipped to [0, 1]. The slope is measured between the two samples
 * straddling the crossing so a very shallow crossing (curve barely grazes
 * zero) gets a low score while a decisive sign flip gets a high score.
 */
function computeConfidence(
  curve: Array<{ spot: number; netGamma: number }>,
  crossingIndex: number,
): number {
  const a = curve[crossingIndex];
  const b = curve[crossingIndex + 1];
  if (!a || !b) return 0;

  const dx = b.spot - a.spot;
  if (dx === 0) return 0;
  const slope = Math.abs((b.netGamma - a.netGamma) / dx);

  let peak = 0;
  for (const pt of curve) {
    const mag = Math.abs(pt.netGamma);
    if (mag > peak) peak = mag;
  }
  if (peak === 0) return 0;

  // Normalize slope by peak/dx so the result is scale-free. dx is the grid
  // step; peak/dx is the worst-case "as steep as possible if the curve
  // fell from peak to zero in one step" slope. Clamp to [0, 1].
  const reference = peak / dx;
  if (reference === 0) return 0;
  const raw = slope / reference;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}
