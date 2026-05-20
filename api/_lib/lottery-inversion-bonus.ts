/**
 * Inversion-quality bonus: maps a per-ticker inversion quintile
 * (1..5, NULL for cold-start tickers) to an additive score adjustment.
 *
 * Bonus shape locked in
 * docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md.
 * NULL quintile -> 0 bonus (cold-start protection — never penalize a
 * ticker that doesn't have inversion history yet).
 */

export const INVERSION_BONUS_BY_QUINTILE: Readonly<Record<number, number>> = {
  1: -5,
  2: -2,
  3: 0,
  4: 3,
  5: 5,
};

export function inversionQualityBonus(quintile: number | null): number {
  if (quintile == null) return 0;
  return INVERSION_BONUS_BY_QUINTILE[quintile] ?? 0;
}

export function qualityAdjustedScore(
  combinedScore: number,
  quintile: number | null,
): number {
  return combinedScore + inversionQualityBonus(quintile);
}
