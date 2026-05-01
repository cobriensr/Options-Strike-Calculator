/**
 * Claude-facing string formatters extracted from their reinvented homes
 * across `api/_lib/`. Every function in here is pure, side-effect free,
 * and stable across calls — they exist so prompt-context formatters get
 * consistent output without each module rolling its own.
 *
 * Origin notes (capture point of each function's existing semantics so
 * Phase 5d adoption can swap call sites without changing prompt text):
 *
 *   - fmtPct           — futures-context.ts: percent already in 0–100 units.
 *                         uw-deltas.ts has a SECOND formatPct that takes a
 *                         decimal (0.1 → "+10.0%"). We preserve both
 *                         shapes via `opts.fromDecimal`.
 *   - fmtPrice         — futures-context.ts: locale-formatted with fixed
 *                         decimal count.
 *   - formatSigned     — uw-deltas.ts + microstructure-signals.ts (verbatim
 *                         copies). Adds a leading '+' when v >= 0.
 *   - fmtOI            — futures-context.ts: open-interest scaling
 *                         (1.2K / 5.0M).
 *   - fmtDp            — darkpool.ts: dark-pool premium scaling
 *                         (5.0K / 12.5M / 1.2B). Always non-negative — caller
 *                         passes Math.abs() or already-positive sums.
 *   - formatDollarAbbrev — uw-deltas.ts: signed dollar abbrev
 *                         ("-$1.5M" / "+$2.0B" — note the higher-precision
 *                         B-suffix).
 *
 * Adoption is staged — see Phase 5d in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1c of the refactor.
 */

const NA = 'N/A';

// ── Percent ────────────────────────────────────────────────

/**
 * Format a percent value with a leading sign.
 *
 *   fmtPct(2.5)                              → '+2.50%'
 *   fmtPct(-1)                               → '-1.00%'
 *   fmtPct(null)                             → 'N/A'
 *   fmtPct(0.025, { fromDecimal: true })     → '+2.5%'  (matches uw-deltas)
 *   fmtPct(2.5, { digits: 1 })               → '+2.5%'
 *
 * `fromDecimal: true` multiplies by 100 first — for the
 * `formatPct(0.025) → "+2.5%"` shape that uw-deltas / db-flow use.
 */
export function fmtPct(
  value: number | null | undefined,
  opts: { digits?: number; fromDecimal?: boolean } = {},
): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const { digits = 2, fromDecimal = false } = opts;
  const v = fromDecimal ? value * 100 : value;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

// ── Price ──────────────────────────────────────────────────

/**
 * Format a price with US-locale grouping and fixed decimal places.
 *
 *   fmtPrice(5825.5)              → '5,825.50'
 *   fmtPrice(5825.5, { digits: 0 }) → '5,826'
 *   fmtPrice(null)                → 'N/A'
 */
export function fmtPrice(
  value: number | null | undefined,
  opts: { digits?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const digits = opts.digits ?? 2;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// ── Signed numbers ─────────────────────────────────────────

/**
 * Format a signed number with leading '+' for non-negative values.
 *
 *   formatSigned(2)                  → '+2.00'
 *   formatSigned(-1.234, { digits: 3 }) → '-1.234'
 *   formatSigned(null)               → 'N/A'
 */
export function formatSigned(
  value: number | null | undefined,
  opts: { digits?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const digits = opts.digits ?? 2;
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

// ── Open interest scaling ──────────────────────────────────

/**
 * Open-interest scaling matching `futures-context.ts`:
 *
 *   fmtOI(950)        → '950'
 *   fmtOI(1_500)      → '1.5K'
 *   fmtOI(5_400_000)  → '5.4M'
 *
 * Negative values aren't expected for OI but we tolerate them by
 * formatting the magnitude — caller intent is preserved.
 */
export function fmtOI(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

// ── Dark-pool premium scaling ──────────────────────────────

/**
 * Dollar-abbreviation matching `darkpool.ts`'s `fmtDp`. Operates on
 * absolute magnitude (the function in darkpool already calls
 * `Math.abs()` on its input, then formats positive). We accept any
 * sign and return the magnitude only — this matches the exact behavior
 * adoption sites expect.
 *
 *   fmtDp(750)            → '750'
 *   fmtDp(5_500)          → '6K'    (toFixed(0))
 *   fmtDp(12_500_000)     → '12.5M'
 *   fmtDp(1_200_000_000)  → '1.2B'
 */
export function fmtDp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}K`;
  return abs.toFixed(0);
}

// ── Signed dollar abbreviation ─────────────────────────────

/**
 * Signed dollar abbreviation matching `uw-deltas.ts`'s
 * `formatDollarAbbrev`. Note the asymmetric precision: B is 2 decimals
 * (so `$1.50B` doesn't lose resolution), M and K are 1 / 0 decimals.
 *
 *   formatDollarAbbrev(null)              → 'N/A'
 *   formatDollarAbbrev(950)               → '$950'
 *   formatDollarAbbrev(-5_500)            → '-$6K'
 *   formatDollarAbbrev(12_500_000)        → '$12.5M'
 *   formatDollarAbbrev(1_500_000_000)     → '$1.50B'
 */
export function formatDollarAbbrev(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
