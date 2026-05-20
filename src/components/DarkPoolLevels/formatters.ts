/**
 * DarkPoolLevels formatters — kept local to this widget because the
 * notional scale here regularly exceeds $1B and the integer-precision
 * M/K rounding matches the price-ladder column width budget. See the
 * note in `index.tsx` for why this is intentionally distinct from the
 * canonical `formatPremium` in `src/utils/format-magnitude.ts`.
 */

export function formatPremium(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

export function formatDist(level: number, price: number): string {
  const diff = Math.round(level - price);
  if (diff === 0) return 'ATM';
  return `${diff > 0 ? '+' : ''}${diff}pts`;
}
