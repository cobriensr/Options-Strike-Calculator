/** Shared numeric rounding helpers */

export function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

export function round0(n: number): number {
  return Math.round(n);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Round to the nearest half — e.g. 5.24 → 5.0, 5.26 → 5.5. */
export function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Snap an SPX strike to the nearest SPY half-point.
 * E.g. SPX 5700 / 10.1 → SPY 564.5
 */
export function snapToSpyHalf(strike: number, spxToSpyRatio: number): number {
  return roundToHalf(strike / spxToSpyRatio);
}
