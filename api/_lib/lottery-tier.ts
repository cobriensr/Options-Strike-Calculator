/**
 * V2 tier classification — operates on `qualityAdjustedScore`
 * (combined_score + inversion bonus) instead of bare combined_score.
 *
 * Cutoffs recalibrated 2026-06-03 (spec:
 * docs/superpowers/specs/lottery-feed-tier-recalibration-2026-06-03.md).
 * The original 24/22 cutoffs were locked 2026-05-20 against the old
 * combined_score scale; Phase 3 (2026-05-22) switched the `score` column to
 * bare computeLotteryScoreV2 (max ~17), making qas (max observed 22, p95 13,
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

export const TIER_CUTOFFS_V2 = {
  tier1MinScore: 13,
  tier2MinScore: 10,
} as const;

export function tierFromQualityScore(score: number | null): LotteryScoreTier {
  if (score == null) return 'tier3';
  if (score >= TIER_CUTOFFS_V2.tier1MinScore) return 'tier1';
  if (score >= TIER_CUTOFFS_V2.tier2MinScore) return 'tier2';
  return 'tier3';
}
