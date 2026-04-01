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

/**
 * Snap an SPX strike to the nearest SPY half-point.
 * E.g. SPX 5700 / 10.1 → SPY 564.5
 */
export function snapToSpyHalf(strike: number, spxToSpyRatio: number): number {
  return Math.round((strike / spxToSpyRatio) * 2) / 2;
}
