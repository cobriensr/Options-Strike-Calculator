/**
 * Numeric coercion helpers — single source of truth for the
 * `num` / `toNum` / `toNumber` / `numOrNull` / `numOrZero` patterns
 * scattered across `api/_lib/`, `api/options-flow/`, and several
 * top-level endpoints.
 *
 * Why we need this: 8+ files reimplement the same 3-line "Postgres
 * NUMERIC may come back as string; coerce, drop NaN" pattern, and they
 * disagree on whether the null/invalid path returns 0 vs null. The
 * majority returns null; we standardize on null and provide an explicit
 * `parsedOrFallback` for the few sites that genuinely want a default.
 *
 * BigInt support: Postgres returns BigInt for COUNT(*) and other
 * potentially-large integers. JS Number conversion is lossy past
 * Number.MAX_SAFE_INTEGER (2^53 - 1) but every count we see in this
 * repo is wildly under that. We coerce via `Number()` and accept the
 * theoretical loss; if a counter ever blows past 2^53 we have bigger
 * problems.
 *
 * Adoption is staged — see Phase 5e in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1d of the refactor.
 */

/**
 * Coerce a value to a finite number, returning null for null/undefined,
 * empty strings, NaN, ±Infinity, or anything that can't parse.
 *
 * Accepts:
 *   - number  (passes through finite, drops non-finite)
 *   - bigint  (Postgres COUNT() etc. — coerced via Number())
 *   - string  (trimmed; empty → null; otherwise Number())
 *   - null / undefined → null
 *   - everything else  → null
 */
export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

/**
 * Coerce a value to a finite number, returning `fallback` for any input
 * that `numOrNull` would return null for.
 *
 *   parsedOrFallback('5.5', 0)    → 5.5
 *   parsedOrFallback(null, 0)     → 0
 *   parsedOrFallback('NaN', 0)    → 0
 *   parsedOrFallback(undefined, -1) → -1
 */
export function parsedOrFallback(value: unknown, fallback: number): number {
  const n = numOrNull(value);
  return n ?? fallback;
}

/**
 * Coerce a value to a finite number, throwing if invalid. For inputs
 * that callers consider load-bearing — when a missing or non-numeric
 * value should crash rather than silently default to null/0.
 *
 * The thrown message includes `label` so call sites can surface which
 * field failed without re-wrapping the error.
 */
export function requireNumber(value: unknown, label: string): number {
  const n = numOrNull(value);
  if (n === null) {
    throw new Error(
      `requireNumber: ${label} is not a finite number (got ${describe(value)})`,
    );
  }
  return n;
}

// Internal helper for error messages — keeps `JSON.stringify`'s "[object
// Object]" surprise out of the error text and trims long strings.
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    return value.length > 40 ? JSON.stringify(value.slice(0, 40) + '…') : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number') return String(value);
  return typeof value;
}
