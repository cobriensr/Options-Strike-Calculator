/**
 * Compact magnitude formatters for the Greek Heatmap section.
 *
 * Three closely-related conventions:
 *
 * - `formatSignedShort` — Greek-style values. Always sign-prefixed
 *   (+/-), K/M/B suffixes, no currency. Zero renders as plain "0".
 *   Used by GreekHeatmapTable cells (gamma/charm/vanna) and the
 *   TopStrikesCallout chip labels.
 *
 * - `formatPremiumShort` — Premium-style $ values. Leading "$" and
 *   negative gets a "-" prefix; positives have no "+" since "$1.7M"
 *   already reads positive. Used by NetFlowRow.
 *
 * - `formatNetGexShort` — Aggregate-GEX values where the input is
 *   already in thousands of dollars (the `netGexK` snapshot field).
 *   Always sign-prefixed, "$" suffix, K/M/B scaling against the
 *   K-scaled input. Used by RegimeChip.
 *
 * Centralized here because every previous copy of these helpers was
 * subtly different (one omitted "+" sign, another emitted "+0" for
 * zero, a third divided differently because of the netGexK scale)
 * and the divergence was a real audit finding.
 */

function divideByScale(abs: number, scale: number, decimals: number): string {
  return (abs / scale).toFixed(decimals);
}

export function formatSignedShort(value: number): string {
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000)
    return `${sign}${divideByScale(abs, 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}${divideByScale(abs, 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${divideByScale(abs, 1_000, 0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function formatPremiumShort(value: number): string {
  if (value === 0) return '$0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000)
    return `${sign}$${divideByScale(abs, 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}$${divideByScale(abs, 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}$${divideByScale(abs, 1_000, 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatNetGexShort(netGexK: number): string {
  if (netGexK === 0) return '$0';
  const sign = netGexK > 0 ? '+' : '-';
  const absK = Math.abs(netGexK);
  // Input is already in thousands of dollars. 1k netGexK = $1K,
  // 1000k = $1M, 1_000_000k = $1B.
  if (absK >= 1_000_000) return `${sign}$${divideByScale(absK, 1_000_000, 2)}B`;
  if (absK >= 1_000) return `${sign}$${divideByScale(absK, 1_000, 1)}M`;
  if (absK >= 1) return `${sign}$${absK.toFixed(0)}K`;
  return `${sign}$${(absK * 1000).toFixed(0)}`;
}

/**
 * Open-interest compact formatter: `"500"`, `"1.0K"`, `"25.3K"`.
 * Used by the Pin Risk chip + table. Unsigned; OI is always non-negative.
 * Values below 1000 render as the raw integer; values >= 1000 use a
 * single-decimal K suffix.
 */
export function formatOI(oi: number): string {
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return String(oi);
}
