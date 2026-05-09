/**
 * LotteryFinder average-hold-minutes lookup.
 *
 * Returns the historical P75 of `minutes_to_peak` among winners
 * (peak_ceiling_pct >= 50) for the fire's (tier, ticker) cohort.
 * Surfaced to the UI as a "~Nmin" hint chip on each row so the user
 * has a baseline expectation for when to exit.
 *
 * Recompute monthly via scripts/recompute_lottery_hold_minutes.py
 * and paste the printed TS block here.
 *
 * Spec: docs/superpowers/specs/lottery-finder-avg-hold-2026-05-08.md
 * Last calibrated: 2026-05-08 (n=27,615 enriched winners,
 *   2026-04-13 → 2026-05-08).
 *
 * Note on tier ordering: tier2 (160min) is shorter than tier1 (219min).
 * Lottery's tier1 cohort is dominated by tail-blasters (SNDK, RKLB)
 * that hold for hours, while tier2 catches more AM-open scalps. The
 * row tooltip should explain this so the number doesn't read as a typo.
 */

import type { LotteryScoreTier } from './lottery-score-weights.js';

/** Tier-default P75 minutes-to-peak among winners. */
const TIER_DEFAULTS: Readonly<Record<LotteryScoreTier, number>> = {
  tier1: 219,
  tier2: 160,
  tier3: 230,
} as const;

/**
 * Per-(ticker, tier) overrides. Only included when both:
 *   - n >= 50 historical winners, AND
 *   - |ticker_p75 - tier_p75| / tier_p75 >= 0.40
 *
 * Stricter bar than silent-boom (n>=30, |delta|>=0.25) because lottery
 * has 10x the data density and the same thresholds would yield 41
 * entries — too many to maintain by hand. Recompute monthly via the
 * Phase C script. 21 entries today (3 tier1 / 11 tier2 / 7 tier3).
 */
const TICKER_OVERRIDES: ReadonlyMap<string, number> = new Map([
  // tier1 — three meaningful overrides
  ['RKLB:tier1', 343], // n=387, +57% vs tier default (219)
  ['SNDK:tier1', 340], // n=711, +56%
  ['SLV:tier1', 102], //  n=789, -54%

  // tier2 — ten meaningful overrides
  ['WMT:tier2', 296], //  n=57,  +86% vs tier default (160)
  ['GOOG:tier2', 287], // n=158, +80%
  ['QQQ:tier2', 42], //   n=124, -74%
  ['RIVN:tier2', 277], // n=54,  +73%
  ['SNOW:tier2', 265], // n=65,  +66%
  ['NVDA:tier2', 258], // n=662, +62%
  ['SOFI:tier2', 243], // n=52,  +53%
  ['SPY:tier2', 78], //   n=54,  -51%
  ['APLD:tier2', 241], // n=68,  +51%
  ['SOXS:tier2', 90], //  n=60,  -43%
  ['SNDK:tier2', 96], //  n=728, -40%

  // tier3 — seven meaningful overrides
  ['SPXW:tier3', 50], //  n=139, -78% vs tier default (230)
  ['WDC:tier3', 54], //   n=88,  -76%
  ['SMH:tier3', 77], //   n=77,  -66%
  ['RUTW:tier3', 88], //  n=174, -62%
  ['QQQ:tier3', 104], //  n=790, -55%
  ['SPY:tier3', 114], //  n=505, -50%
  ['CRWV:tier3', 129], // n=200, -44%
]);

/**
 * Look up the cohort avg-hold-minutes for a fire. Falls back to the
 * tier3 default when tier is null (legacy rows pre-#126 backfill) —
 * matches the lotteryScoreTier null-handling.
 */
export function avgHoldMinutesFor(args: {
  tier: LotteryScoreTier | null;
  ticker: string;
}): number {
  const tier: LotteryScoreTier = args.tier ?? 'tier3';
  const override = TICKER_OVERRIDES.get(`${args.ticker.toUpperCase()}:${tier}`);
  if (override != null) return override;
  return TIER_DEFAULTS[tier];
}
