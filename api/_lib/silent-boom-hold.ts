/**
 * Silent-Boom average-hold-minutes lookup.
 *
 * Returns the historical P75 of `minutes_to_peak` among winners
 * (peak_ceiling_pct >= 50) for the alert's (tier, ticker) cohort.
 * Surfaced to the UI as a "~Nmin" hint chip on each row so the user
 * has a baseline expectation for when to exit.
 *
 * Recompute monthly via scripts/recompute_silent_boom_hold_minutes.py
 * and paste the printed TS block here.
 *
 * Spec: docs/superpowers/specs/silent-boom-flame-exit-2026-05-08.md
 * Last calibrated: 2026-05-08 (n=14,140 enriched rows, 2026-04-13 →
 *   2026-05-08).
 */

import type { SilentBoomScoreTier } from './silent-boom-score.js';

/** Tier-default P75 minutes-to-peak among winners. */
const TIER_DEFAULTS: Readonly<Record<SilentBoomScoreTier, number>> = {
  tier1: 144,
  tier2: 197,
  tier3: 224,
} as const;

/**
 * Per-(ticker, tier) overrides. Only included when both:
 *   - n >= 30 historical winners, AND
 *   - |ticker_p75 - tier_p75| / tier_p75 >= 0.25
 *
 * Today only 2 pairs clear the bar. Recompute monthly; the list is
 * expected to grow as smaller-volume tickers (NVDA, TSLA, GOOGL)
 * accumulate enough enriched winners to be statistically distinct.
 */
const TICKER_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['QQQ:tier1', 89],
  ['SPXW:tier3', 296],
]);

/**
 * Look up the cohort avg-hold-minutes for an alert. Falls back to
 * the tier3 default when tier is null (legacy rows pre-#126
 * backfill) — matches the silentBoomScoreTier null-handling.
 */
export function avgHoldMinutesFor(args: {
  tier: SilentBoomScoreTier | null;
  ticker: string;
}): number {
  const tier: SilentBoomScoreTier = args.tier ?? 'tier3';
  const override = TICKER_OVERRIDES.get(`${args.ticker.toUpperCase()}:${tier}`);
  if (override != null) return override;
  return TIER_DEFAULTS[tier];
}
