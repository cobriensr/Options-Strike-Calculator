import { describe, expect, it } from 'vitest';
import { tierFromQualityScore, TIER_CUTOFFS_V2 } from '../_lib/lottery-tier.js';

describe('tierFromQualityScore', () => {
  const { tier1MinScore, tier2MinScore } = TIER_CUTOFFS_V2;

  it('matches the recalibrated 2026-06-03 cutoffs', () => {
    expect(tier1MinScore).toBe(13);
    expect(tier2MinScore).toBe(10);
  });
  it('returns tier1 at and above tier1MinScore', () => {
    expect(tierFromQualityScore(tier1MinScore)).toBe('tier1');
    expect(tierFromQualityScore(tier1MinScore + 1)).toBe('tier1');
    expect(tierFromQualityScore(99)).toBe('tier1');
  });
  it('returns tier2 at tier2MinScore', () => {
    expect(tierFromQualityScore(tier2MinScore)).toBe('tier2');
  });
  it('returns tier2 between cutoffs', () => {
    expect(tierFromQualityScore(tier1MinScore - 1)).toBe('tier2');
  });
  it('returns tier3 below tier2MinScore', () => {
    expect(tierFromQualityScore(tier2MinScore - 1)).toBe('tier3');
    expect(tierFromQualityScore(0)).toBe('tier3');
    expect(tierFromQualityScore(-5)).toBe('tier3');
  });
  it('returns tier3 for null', () => {
    expect(tierFromQualityScore(null)).toBe('tier3');
  });
});
