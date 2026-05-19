/**
 * Hedge-module constants. Lifted from `hedge.ts` during the Phase 2Q
 * split so they can be referenced from `pricing.ts`, `scenarios.ts`,
 * and the `calcHedge` orchestrator without circular imports.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2Q)
 */

/**
 * Crash/rally scenario sizes as a fraction of spot. Each value generates
 * one row in each direction of the scenario table; e.g. 0.015 → 1.5%
 * crash AND 1.5% rally. Values were picked to span the trading-relevant
 * range (1.5% covers a normal trend day, 10% covers a 2020-COVID-style
 * tail). Changing this list changes the row count returned in
 * `HedgeResult.scenarios` — downstream UI assumes 9 per direction.
 */
export const CRASH_SCENARIO_PCTS = [
  0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1,
] as const;

/**
 * Bisection iteration cap when solving for the breakeven crash/rally.
 * 50 iterations bracket the answer to roughly `(searchMax / 2^50)` ≈
 * 10⁻¹⁵, which is well below the `Math.round` precision used on the
 * returned points value — anything beyond ~30 iterations is wasted work
 * but keeping 50 leaves margin if `searchMax` is later widened.
 */
export const BREAKEVEN_MAX_ITER = 50;

/**
 * Upper bound on the breakeven search (as a fraction of spot). 15% is
 * comfortably beyond every historical 1-day SPX move; pushing it higher
 * gains nothing for realistic inputs but expands the dead-band where
 * the bisection brackets a solution that doesn't exist.
 */
export const BREAKEVEN_SEARCH_PCT = 0.15;
