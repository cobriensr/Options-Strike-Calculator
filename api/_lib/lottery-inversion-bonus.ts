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

/**
 * SQL `CASE` expression that mirrors {@link INVERSION_BONUS_BY_QUINTILE}
 * exactly, mapping `s.inversion_quintile` (1..5, NULL) to the additive
 * inversion-quality bonus. NULL quintile → 0 bonus (cold-start protection).
 *
 * SINGLE SOURCE OF TRUTH for the in-SQL bonus so the qas filter in the
 * lottery feed + ticker-count queries can gate on the SAME displayed score
 * the row badge derives via {@link qualityAdjustedScore}. The bonus table is
 * inlined here as raw SQL text (constant integers from
 * INVERSION_BONUS_BY_QUINTILE) — no bound params, no `db.unsafe` — so the
 * literal mapping stays grep-visible alongside the JS map. If the JS map
 * changes, this string MUST change with it (the `bonus-sql-parity` test in
 * lottery-inversion-bonus.test.ts pins them together).
 *
 * The `s` alias is hardcoded because `inversion_quintile` invariably comes
 * from the `lottery_ticker_stats` LEFT JOIN aliased `s` at every call site —
 * identical to the convention in keptSuppressionSql.
 */
export const INVERSION_BONUS_CASE_SQL =
  'CASE s.inversion_quintile ' +
  'WHEN 1 THEN -5 ' +
  'WHEN 2 THEN -2 ' +
  'WHEN 3 THEN 0 ' +
  'WHEN 4 THEN 3 ' +
  'WHEN 5 THEN 5 ' +
  'ELSE 0 END';
