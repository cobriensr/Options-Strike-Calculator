// ── Lottery Q1/Q2 inversion-quality suppression predicate ──
//
// SINGLE SOURCE OF TRUTH for the Lottery never-vanish "keep" rule.
//
// A lottery chain stays visible in the feed and is counted in the chip
// totals when ANY of these hold:
//   1. showAll is true               → suppression is disabled entirely.
//   2. inversion_quintile IS NULL    → cold-start ticker, never suppressed.
//   3. inversion_quintile > 2        → ticker is in Q3/Q4/Q5 (good inversion).
//   4. the ticker is in the durable, page-independent "ever-shown" kept-set
//      (lottery_kept_tickers) — so a ticker that ever cleared the bar this
//      day never vanishes, even if its quintile later flips to Q1/Q2.
//
// This predicate was previously copy-pasted across SIX SQL sites:
//   - api/lottery-finder.ts — 3 row-query WHERE branches + 2 COUNT(*) FILTER
//     clauses (the `total` and `suppressed` columns).
//   - api/lottery-finder-ticker-counts.ts — 1 outer WHERE clause.
// A drift between any of them silently desynchronizes the rendered rows from
// the chip totals. ALL SIX SITES MUST call this helper so the rule lives in
// exactly one place.
//
// Composition mechanism (verified against @neondatabase/serverless@1.1.0):
// the driver's tagged-template processor (`SqlTemplate.toParameterizedQuery`)
// recursively splices a nested `db`...`` fragment into its parent — the
// nested fragment's own params are pushed onto the SHARED params array with
// correctly-renumbered `$N` placeholders. So this helper returns a composable
// fragment that the existing tagged-template queries embed directly:
//
//   db`... WHERE rn = 1 AND ${keptSuppressionSql(db, 'f', showAll, kept)} ...`
//
// `showAll` and `keptTickers` are ALWAYS bound params ($1, $2 — never inlined,
// so injection-safe). The empty-array case binds `ANY($N::text[])` against
// `[]`, which matches nothing (term 4 contributes no extra keeps) — identical
// to the pre-helper behavior.
//
// The `inversion_quintile` column is read from `lottery_ticker_stats`, which
// is invariably aliased `s` at every call site, so the quintile alias is
// HARDCODED here. The only thing that varies across the six sites is the
// alias of the driving table that owns `underlying_symbol` (the LEFT JOIN's
// probe side): `f` (row queries), `ranked` (COUNT FILTER), `cd`
// (ticker-counts). That symbol alias is whitelisted and spliced as a raw
// identifier — never a free-form interpolation.

import type { NeonQueryFunction } from '@neondatabase/serverless';

type Db = NeonQueryFunction<false, false>;

/**
 * Aliases of the driving table that exposes `underlying_symbol` at each of
 * the six suppression sites. NOT a bind param — validated against this
 * whitelist and spliced as a raw SQL identifier.
 *
 * `s` is intentionally excluded: it is the fixed `lottery_ticker_stats`
 * alias whose symbol column is `ticker`, not `underlying_symbol`, so it can
 * never be the symbol-side alias. The quintile term hardcodes `s.`.
 */
export const SYMBOL_ALIAS_WHITELIST = ['f', 'ranked', 'cd'] as const;

export type SymbolAlias = (typeof SYMBOL_ALIAS_WHITELIST)[number];

function isSymbolAlias(alias: string): alias is SymbolAlias {
  return (SYMBOL_ALIAS_WHITELIST as readonly string[]).includes(alias);
}

/**
 * Build the composable Q1/Q2-suppression SQL fragment.
 *
 * Embed the return value directly inside a tagged-template query:
 *
 *   db`SELECT ... WHERE rn = 1
 *      AND ${keptSuppressionSql(db, 'f', showAll, keptTickers)}`
 *
 * @param db          the Neon query function (same handle used by the caller)
 * @param symbolAlias alias of the table owning `underlying_symbol` at this
 *                    site — must be one of {@link SYMBOL_ALIAS_WHITELIST}.
 * @param showAll     when true, suppression is disabled (bound param).
 * @param keptTickers durable ever-shown kept-set (bound `text[]` param).
 * @throws if `symbolAlias` is not whitelisted (guards against any future
 *         caller passing an un-vetted, injectable identifier).
 */
export function keptSuppressionSql(
  db: Db,
  symbolAlias: string,
  showAll: boolean | undefined,
  keptTickers: string[],
) {
  if (!isSymbolAlias(symbolAlias)) {
    throw new Error(
      `keptSuppressionSql: invalid symbol alias "${symbolAlias}" — ` +
        `must be one of ${SYMBOL_ALIAS_WHITELIST.join(', ')}`,
    );
  }

  return db`(${showAll ?? false}::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2 OR ${db.unsafe(symbolAlias)}.underlying_symbol = ANY(${keptTickers}::text[]))`;
}
