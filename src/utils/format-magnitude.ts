/**
 * Compact magnitude formatters — the canonical home for K/M/B helpers
 * across the app.
 *
 * Several closely-related conventions live here. Pairs that look similar
 * (e.g. `formatPremium` vs `formatPremiumShort`) are intentionally
 * distinct: input scale, billions branch, and null/zero handling differ
 * subtly enough that consumers can't be swapped without re-checking the
 * exact column the formatter feeds.
 *
 * - `formatSignedShort` — Greek-style values. Always sign-prefixed
 *   (+/-), K/M/B suffixes, no currency. Zero renders as plain "0".
 *   Used by GreekHeatmapTable cells (gamma/charm/vanna) and the
 *   TopStrikesCallout chip labels.
 *
 * - `formatPremiumShort` — Premium-style $ values with billions branch
 *   and two-decimal M/B. Leading "$" and negative gets a "-" prefix;
 *   positives have no "+". Used by NetFlowRow.
 *
 * - `formatPremium` — Options-flow premium formatter. Positive-only
 *   (negative / non-finite coalesce to "$0"), no billions branch,
 *   single-decimal M / parameterized K decimals. Consumed by the
 *   options-flow tables via `flow-formatters` re-export.
 *
 * - `formatGex` — Signed dollar GEX with K/M/B. Null/non-finite render
 *   as em dash. Consumed via `flow-formatters` re-export.
 *
 * - `formatNetGexShort` — Aggregate-GEX values where the input is
 *   already in thousands of dollars (the `netGexK` snapshot field).
 *   Always sign-prefixed, "$" suffix, K/M/B scaling against the
 *   K-scaled input. Used by RegimeChip.
 *
 * - `formatOI` — Open-interest compact formatter. Unsigned, K suffix
 *   at >= 1000. Used by the Pin Risk surface.
 *
 * Centralized here because every previous copy of these helpers was
 * subtly different (one omitted "+" sign, another emitted "+0" for
 * zero, a third divided differently because of the netGexK scale)
 * and the divergence was a real audit finding.
 */

// ============================================================
// SCALE THRESHOLDS — explicit names so consumers and tests can refer
// to the same boundaries the formatters use internally.
// ============================================================

/** Lowest "billion" boundary — used by `formatGex`. */
export const BILLION = 1_000_000_000;
/** Lowest "million" boundary — used by `formatPremium`, `formatGex`. */
export const MILLION = 1_000_000;
/** Lowest "thousand" boundary — used by `formatPremium`, `formatGex`. */
export const THOUSAND = 1_000;

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

/**
 * Plain dollar amount with thousands separators, no `$` prefix.
 * Values >= $100 render as a comma-grouped integer (`"1,234"`); values
 * below $100 keep two decimals (`"42.50"`, `"99.99"`, `"0.00"`). The
 * IronCondor / BWB / Hedge P&L tables prepend `$` or `+$` manually so
 * the caller controls sign presentation.
 *
 * Distinct from `src/components/FuturesCalculator/formatters.ts`'s local
 * `fmtDollar`, which has different semantics (always `$` prefix, optional
 * always-sign) and intentionally stays scoped to that feature folder.
 */
export function formatDollars(value: number): string {
  if (Math.abs(value) >= 100) {
    return Math.round(value).toLocaleString('en-US');
  }
  return value.toFixed(2);
}

// ============================================================
// OPTIONS-FLOW CURRENCY (PREMIUM)
// ============================================================

export interface FormatPremiumOptions {
  /**
   * Decimals to keep in the `$NK` branch. Whale-flow tables prefer `0`
   * (`"$850K"`) for column density; intraday flow prefers `1` (`"$850.0K"`)
   * for finer-grained reads on smaller premium prints. Defaults to `1` —
   * the more common case across the codebase.
   */
  kDigits?: 0 | 1;
}

/**
 * Compact dollar premium: `"$206.5M"`, `"$1.4M"`, `"$850K"`, `"$0"`.
 * Negative or non-finite inputs render as `"$0"` — premium magnitudes are
 * always non-negative in the underlying flow data, so a negative value
 * indicates upstream corruption that's safer to coalesce than to render.
 */
export function formatPremium(
  value: number,
  opts: FormatPremiumOptions = {},
): string {
  const { kDigits = 1 } = opts;
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value >= MILLION) return `$${(value / MILLION).toFixed(1)}M`;
  if (value >= THOUSAND) return `$${(value / THOUSAND).toFixed(kDigits)}K`;
  return `$${Math.round(value)}`;
}

// ============================================================
// SIGNED DEALER GAMMA EXPOSURE (GEX)
// ============================================================

/**
 * Compact signed-dollar formatter for dealer GEX exposure. Matches the
 * sign-leading convention used in `GexTarget`: `"+$120M"`, `"-$80M"`.
 * The leading `+` / `-` is the text affordance so color is never the
 * sole signal. Null / non-finite renders as `'—'`.
 */
export function formatGex(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= BILLION) return `${sign}$${(abs / BILLION).toFixed(1)}B`;
  if (abs >= MILLION) return `${sign}$${(abs / MILLION).toFixed(0)}M`;
  if (abs >= THOUSAND) return `${sign}$${(abs / THOUSAND).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
