/**
 * Compact-number formatters used by StrikeBox cells.
 *
 * `formatGex` and `formatNet` differ subtly: GEX values are always whole
 * (no decimals under 1k), while net values keep two decimals when the
 * absolute value drops below 0.5 — useful for est. Δ where small
 * fractional positions still matter.
 */

export function formatGex(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function formatDeltaPct(v: number | null): string {
  if (v === null) return '\u2014';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

export function formatDist(dist: number): string {
  const sign = dist >= 0 ? '+' : '';
  return `${sign}${dist.toFixed(0)}p`;
}

/** Compact signed label for net values — two decimal places when fractional. */
export function formatNet(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '\u2212';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${Math.round(abs / 1e3)}K`;
  if (abs >= 0.5) return `${sign}${Math.round(abs)}`;
  return `${sign}${abs.toFixed(2)}`;
}
