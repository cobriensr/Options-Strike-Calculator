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
 * `formatPremium`, `formatGex`, and the `BILLION` / `MILLION` / `THOUSAND`
 * scale constants now live in `format-magnitude.ts` (the canonical home
 * for K/M/B helpers). They're re-exported below so existing flow-formatter
 * imports continue to work without change.
 *
 * Conventions:
 *   - Null / non-finite inputs → `'—'` (em dash) for displayed values that
 *     could legitimately be missing data, and `'$0'` only for `formatPremium`
 *     where zero is the natural neutral (matches the desk's reading of
 *     "no premium" as a hard zero rather than missing).
 *   - Sign affordance is text-leading (`+`, `-`) so colorblind / assistive
 *     readers see the sign without depending on color.
 */

export {
  BILLION,
  MILLION,
  THOUSAND,
  formatGex,
  formatPremium,
  type FormatPremiumOptions,
} from './format-magnitude.js';

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
