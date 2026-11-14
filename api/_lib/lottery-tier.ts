/**
 * V2 tier classification — operates on `qualityAdjustedScore`
 * (combined_score + inversion bonus) instead of bare combined_score.
 *
 * The cutoffs belong to a weights version (`feed_cutoffs` in
 * `lottery-weights-schema.ts`), so the callers pass the active version's:
 * `tierFromQas` tiers a score, `resolveMinQas` turns a feed filter into the
 * score floor it gates on.
 *
 * The first version's cutoffs were recalibrated 2026-06-03 (spec:
 * docs/superpowers/specs/lottery-feed-tier-recalibration-2026-06-03.md).
 * The original 24/22 cutoffs were locked 2026-05-20 against the old
 * combined_score scale; Phase 3 (2026-05-22) switched the `score` column to
 * bare scoreLotteryV2 (max ~17), making qas (max observed 22, p95 13,
 * p85 10) unable to reach 24/22 — the feed produced 0 tier1/tier2 for weeks.
 * New cutoffs are the 95th/85th percentile of the live qas distribution
 * (matching the Python training's tier-derivation philosophy), validated to
 * separate realized outcomes monotonically (tier1 win 59.8%, peak-hit≥50 54.8%).
 *
 * Legacy lotteryScoreTier() in lottery-score-weights.ts is preserved as
 * a deprecated re-export for any external caller — see the comment
 * Phase 3 adds to that function.
 */

import type { LotteryScoreTier } from './lottery-score-weights.js';
import type { FeedTierCutoffs } from './lottery-weights-schema.js';
import { SEED_LOTTERY_WEIGHTS } from './lottery-weights-seed.js';

/** The tier a quality-adjusted score falls in under `cutoffs`; null is tier3. */
export function tierFromQas(
  qas: number | null,
  cutoffs: FeedTierCutoffs,
): LotteryScoreTier {
  if (qas == null) return 'tier3';
  if (qas >= cutoffs.tier1_min_score) return 'tier1';
  if (qas >= cutoffs.tier2_min_score) return 'tier2';
  return 'tier3';
}

/**
 * The quality-adjusted score a feed filter gates on: `minTier` names a tier
 * and wins, giving that tier's cutoff in `cutoffs`; else `minScore` is taken
 * as given; with neither there is no floor (undefined).
 */
export function resolveMinQas(
  minTier: 'tier1' | 'tier2' | undefined,
  minScore: number | undefined,
  cutoffs: FeedTierCutoffs,
): number | undefined {
  if (minTier === 'tier1') return cutoffs.tier1_min_score;
  if (minTier === 'tier2') return cutoffs.tier2_min_score;
  return minScore;
}

/**
 * @deprecated The seed's cutoffs, not the active version's. The feed endpoint
 * still reads them until it moves to `tierFromQas` with the loaded weights;
 * that task deletes this.
 */
export const TIER_CUTOFFS_V2 = {
  tier1MinScore: SEED_LOTTERY_WEIGHTS.feed_cutoffs.tier1_min_score,
  tier2MinScore: SEED_LOTTERY_WEIGHTS.feed_cutoffs.tier2_min_score,
} as const;

/**
 * @deprecated Tiers on the seed's cutoffs, not the active version's. Deleted
 * with `TIER_CUTOFFS_V2`.
 */
export function tierFromQualityScore(score: number | null): LotteryScoreTier {
  return tierFromQas(score, SEED_LOTTERY_WEIGHTS.feed_cutoffs);
}
