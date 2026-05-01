/**
 * flow-formatters — pure number/currency/pct formatters shared by the
 * options-flow tables (`OptionsFlowTable`, `WhalePositioningTable`, and
 * future flow surfaces).
 *
 * Every function here is pure and side-effect free. No React, no Intl
 * locale dependence beyond `Number.prototype.toFixed`, no DOM. Safe to
 * tree-shake into any flow-style consumer that needs the same compact
 * "$N.NM / $NK / N.N% / +Npts" reading the desk uses verbatim.
 *
 * The two tables previously kept private duplicates of these helpers
 * with subtle drift (Whale used 0 decimals for `$NK`, Flow used 1; Whale
 * forced signed pct, Flow made it optional). Where drift was meaningful
 * we parameterize via an options object; where it was cosmetic we
 * collapsed onto a single canonical form.
 *
 * Conventions:
 *   - Null / non-finite inputs → `'—'` (em dash) for displayed values that
 *     could legitimately be missing data, and `'$0'` only for `formatPremium`
 *     where zero is the natural neutral (matches the desk's reading of
 *     "no premium" as a hard zero rather than missing).
 *   - Sign affordance is text-leading (`+`, `-`) so colorblind / assistive
 *     readers see the sign without depending on color.
 */

// ============================================================
// SCALE THRESHOLDS — explicit names so consumers and tests can refer to
// the same boundaries the formatters use internally.
// ============================================================

/** Lowest "billion" boundary — used by `formatGex`. */
export const BILLION = 1_000_000_000;
/** Lowest "million" boundary — used by `formatPremium`, `formatGex`. */
export const MILLION = 1_000_000;
/** Lowest "thousand" boundary — used by `formatPremium`, `formatGex`. */
export const THOUSAND = 1_000;

// ============================================================
// CURRENCY: PREMIUM (positive-only, no billions branch)
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
// PERCENT
// ============================================================

export interface FormatPctOptions {
  /** Prepend `+` for positive values. Defaults to `false`. */
  signed?: boolean;
  /**
   * Digits after the decimal point. Whale-flow tables use `1`; intraday
   * flow uses `2` for tighter reads. Defaults to `2`.
   */
  digits?: number;
}

/**
 * Convert a fraction (e.g. `0.0125`) to a percent string (e.g. `"1.25%"`,
 * or `"+1.25%"` when `signed` is true). Null or non-finite input renders
 * as `'—'` so the column collapses cleanly.
 */
export function formatPct(
  value: number | null,
  opts: FormatPctOptions = {},
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const { signed = false, digits = 2 } = opts;
  const pct = value * 100;
  const sign = signed && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

/**
 * Ask-side share (a fraction in [0, 1]) rendered as a one-decimal percent.
 * Both flow tables format ask-side ratios identically; null and non-finite
 * inputs render as `'—'`.
 */
export function formatAskPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

// ============================================================
// GEX (signed dealer gamma exposure dollars)
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

// ============================================================
// SIGNED INTEGER
// ============================================================

/**
 * Render a signed integer with a leading `+` for positives, `-` for
 * negatives, and a bare `0` for zero. Used for "distance from spot in
 * points" style columns. Null / non-finite renders as `'—'`.
 */
export function formatSignedInt(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}
