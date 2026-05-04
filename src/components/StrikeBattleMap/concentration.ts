/**
 * Pure logic for the Strike Battle Map "concentration" derivation.
 *
 * The aggregate Greek Flow tiles tell you the *total* directional bet
 * across all OTM strikes — but they can't distinguish a setup where
 * customer flow is piled at one strike (a magnet → likely pin) from one
 * where the same total flow is smeared across many strikes (no
 * gravity → trend probable). The concentration ratio is what surfaces
 * the difference: top-1 magnitude / sum of top-5 magnitudes.
 *
 * Thresholds (from docs/superpowers/specs/strike-battle-map-2026-05-03.md):
 *   ratio ≥ 0.50 → "magnet"   (single-strike gravity)
 *   ratio < 0.30 → "smeared"  (broad bet, trend-friendly)
 *   anything between → "partial"
 *
 * This module is data-source agnostic on purpose — it operates on a
 * generic StrikeMagnitude shape so the Battle Map component can
 * compose customer dir delta flow OR dealer net gamma OR any other
 * per-strike directional metric and reuse the same logic.
 */

export interface StrikeMagnitude {
  /** Strike price. */
  strike: number;
  /** Signed value (positive bullish, negative bearish). */
  signed: number;
}

export type ConcentrationLabel = 'magnet' | 'partial' | 'smeared' | 'empty';

export interface ConcentrationResult {
  /** Strike with the largest absolute magnitude, or null when input is empty. */
  topStrike: number | null;
  /** Absolute magnitude of the top strike. */
  topMagnitude: number;
  /** Sum of absolute magnitudes across the top N (capped at TOP_N_FOR_RATIO). */
  topNSum: number;
  /** topMagnitude / topNSum (0..1). 0 when input is empty. */
  ratio: number;
  /** Bucketed label using the spec thresholds. */
  label: ConcentrationLabel;
  /** Sign of the top strike's signed value. 0 when empty. */
  topSign: 1 | -1 | 0;
}

/** Number of top strikes used in the denominator of the ratio. */
export const TOP_N_FOR_RATIO = 5;

/** ratio >= MAGNET_THRESHOLD → 'magnet'. */
export const MAGNET_THRESHOLD = 0.5;
/** ratio < SMEARED_THRESHOLD → 'smeared'. Otherwise 'partial'. */
export const SMEARED_THRESHOLD = 0.3;

function classify(ratio: number, hasInput: boolean): ConcentrationLabel {
  if (!hasInput) return 'empty';
  if (ratio >= MAGNET_THRESHOLD) return 'magnet';
  if (ratio < SMEARED_THRESHOLD) return 'smeared';
  return 'partial';
}

function signOf(value: number): 1 | -1 | 0 {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * Compute the concentration ratio + label for a per-strike series.
 *
 * The input may carry zeros or be empty; the result is always
 * well-defined. Strikes are sorted by absolute magnitude descending
 * before the top-N is selected, so the caller doesn't need to pre-sort.
 */
export function computeConcentration(
  strikes: readonly StrikeMagnitude[],
): ConcentrationResult {
  const nonZero = strikes.filter(
    (s) => Number.isFinite(s.signed) && s.signed !== 0,
  );
  if (nonZero.length === 0) {
    return {
      topStrike: null,
      topMagnitude: 0,
      topNSum: 0,
      ratio: 0,
      label: 'empty',
      topSign: 0,
    };
  }

  const sorted = [...nonZero].sort(
    (a, b) => Math.abs(b.signed) - Math.abs(a.signed),
  );
  const topN = sorted.slice(0, TOP_N_FOR_RATIO);
  const top = topN[0];
  if (top == null) {
    // Unreachable given the empty check, but keeps the type checker happy.
    return {
      topStrike: null,
      topMagnitude: 0,
      topNSum: 0,
      ratio: 0,
      label: 'empty',
      topSign: 0,
    };
  }
  const topMagnitude = Math.abs(top.signed);
  const topNSum = topN.reduce((acc, s) => acc + Math.abs(s.signed), 0);
  const ratio = topNSum > 0 ? topMagnitude / topNSum : 0;

  return {
    topStrike: top.strike,
    topMagnitude,
    topNSum,
    ratio,
    label: classify(ratio, true),
    topSign: signOf(top.signed),
  };
}

/**
 * Pick the N nearest OTM strikes around a spot price, split evenly
 * between calls (strike > spot) and puts (strike < spot).
 *
 * Useful for narrowing a full per-strike chain to just the strikes
 * relevant for the Battle Map's directional read. When fewer strikes
 * exist on one side than requested, the function returns whatever's
 * available without padding.
 */
export interface StrikeKey {
  strike: number;
}

export function nearestOtmStrikes<T extends StrikeKey>(
  rows: readonly T[],
  spot: number,
  countPerSide: number,
): { calls: T[]; puts: T[] } {
  if (!Number.isFinite(spot) || countPerSide <= 0) {
    return { calls: [], puts: [] };
  }
  const calls = rows
    .filter((r) => r.strike > spot)
    .sort((a, b) => a.strike - b.strike)
    .slice(0, countPerSide);
  const puts = rows
    .filter((r) => r.strike < spot)
    .sort((a, b) => b.strike - a.strike)
    .slice(0, countPerSide);
  return { calls, puts };
}
