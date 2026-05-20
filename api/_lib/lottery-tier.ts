/**
 * V2 tier classification — operates on `qualityAdjustedScore`
 * (combined_score + inversion bonus) instead of bare combined_score.
 * Cutoffs locked from Phase 2 simulation
 * (docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md).
 *
 * Legacy lotteryScoreTier() in lottery-score-weights.ts is preserved as
 * a deprecated re-export for any external caller — see the comment
 * Phase 3 adds to that function.
 */

import type { LotteryScoreTier } from './lottery-score-weights.js';

export const TIER_CUTOFFS_V2 = {
  tier1MinScore: 24,
  tier2MinScore: 22,
} as const;

export function tierFromQualityScore(score: number | null): LotteryScoreTier {
  if (score == null) return 'tier3';
  if (score >= TIER_CUTOFFS_V2.tier1MinScore) return 'tier1';
  if (score >= TIER_CUTOFFS_V2.tier2MinScore) return 'tier2';
  return 'tier3';
}
