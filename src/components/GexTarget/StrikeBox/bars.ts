/**
 * Greek-bar sizing helpers for StrikeBox.
 *
 * Bars are sized via `tanh(|value| / scale)` where `scale` is the median of
 * absolute values across the displayed leaderboard — recomputed every
 * render so the visual range adapts to whatever's currently on the board.
 *
 * `nearZeroThreshold` is the 5th percentile of |value|. Bars below it are
 * rendered in muted gray to keep noise from claiming visual weight.
 */

/** Pixel width of a fully-saturated greek bar. */
export const BAR_MAX_W = 40;
/** Pixel height of all greek bars. */
export const BAR_H = 6;

export interface BarStats {
  scale: number;
  nearZeroThreshold: number;
}

/**
 * Compute per-greek bar sizing parameters from one greek's values.
 *
 * Returns `{ scale: 1, nearZeroThreshold: 1e-6 }` for an empty input so
 * downstream sizing math never divides by zero.
 */
export function computeBarStats(values: number[]): BarStats {
  if (values.length === 0) return { scale: 1, nearZeroThreshold: 1e-6 };

  const absVals = values.map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(absVals.length / 2);
  const scale =
    absVals.length % 2 === 1
      ? (absVals[mid] ?? 0)
      : ((absVals[mid - 1] ?? 0) + (absVals[mid] ?? 0)) / 2;

  const p5Idx = Math.floor(absVals.length * 0.05);
  const nearZeroThreshold = absVals[p5Idx] ?? 1e-6;

  return {
    scale: scale || 1,
    nearZeroThreshold: nearZeroThreshold || 1e-6,
  };
}
