import { describe, expect, it } from 'vitest';
import { resolveMinQas, tierFromQas } from '../_lib/lottery-tier.js';
import type { FeedTierCutoffs } from '../_lib/lottery-weights-schema.js';
import { SEED_LOTTERY_WEIGHTS } from '../_lib/lottery-weights-seed.js';

const SEED_CUTOFFS = SEED_LOTTERY_WEIGHTS.feed_cutoffs;
// A version whose cutoffs sit apart from the seed's, so a function that
// ignores its `cutoffs` argument cannot pass.
const WIDE: FeedTierCutoffs = { tier1_min_score: 20, tier2_min_score: 15 };

describe('tierFromQas', () => {
  it('reads the 13/10 cutoffs of the seed (the recalibrated 2026-06-03 pair)', () => {
    expect(SEED_CUTOFFS).toEqual({ tier1_min_score: 13, tier2_min_score: 10 });
  });

  it.each([
    { qas: 99, cutoffs: SEED_CUTOFFS, tier: 'tier1' },
    { qas: 14, cutoffs: SEED_CUTOFFS, tier: 'tier1' },
    { qas: 13, cutoffs: SEED_CUTOFFS, tier: 'tier1' },
    { qas: 12, cutoffs: SEED_CUTOFFS, tier: 'tier2' },
    { qas: 10, cutoffs: SEED_CUTOFFS, tier: 'tier2' },
    { qas: 9, cutoffs: SEED_CUTOFFS, tier: 'tier3' },
    { qas: 0, cutoffs: SEED_CUTOFFS, tier: 'tier3' },
    { qas: -5, cutoffs: SEED_CUTOFFS, tier: 'tier3' },
    { qas: 20, cutoffs: WIDE, tier: 'tier1' },
    { qas: 19, cutoffs: WIDE, tier: 'tier2' },
    { qas: 15, cutoffs: WIDE, tier: 'tier2' },
    { qas: 14, cutoffs: WIDE, tier: 'tier3' },
    // 13 is tier1 under the seed and tier3 under WIDE: the cutoffs decide.
    { qas: 13, cutoffs: WIDE, tier: 'tier3' },
  ])(
    'puts qas $qas in $tier under cutoffs $cutoffs',
    ({ qas, cutoffs, tier }) => {
      expect(tierFromQas(qas, cutoffs)).toBe(tier);
    },
  );

  it.each([{ cutoffs: SEED_CUTOFFS }, { cutoffs: WIDE }])(
    'puts a null qas in tier3 under $cutoffs',
    ({ cutoffs }) => {
      expect(tierFromQas(null, cutoffs)).toBe('tier3');
    },
  );
});

describe('resolveMinQas', () => {
  it.each([
    { minTier: 'tier1', minScore: undefined, cutoffs: SEED_CUTOFFS, qas: 13 },
    { minTier: 'tier2', minScore: undefined, cutoffs: SEED_CUTOFFS, qas: 10 },
    { minTier: 'tier1', minScore: undefined, cutoffs: WIDE, qas: 20 },
    { minTier: 'tier2', minScore: undefined, cutoffs: WIDE, qas: 15 },
  ] as const)(
    'resolves minTier $minTier to the cutoff of $cutoffs',
    ({ minTier, minScore, cutoffs, qas }) => {
      expect(resolveMinQas(minTier, minScore, cutoffs)).toBe(qas);
    },
  );

  it('lets minTier win over a minScore', () => {
    expect(resolveMinQas('tier1', 99, WIDE)).toBe(20);
    expect(resolveMinQas('tier2', 1, WIDE)).toBe(15);
  });

  it.each([{ minScore: 11 }, { minScore: 0 }, { minScore: -3 }])(
    'passes minScore $minScore through when there is no minTier',
    ({ minScore }) => {
      expect(resolveMinQas(undefined, minScore, WIDE)).toBe(minScore);
    },
  );

  it('returns undefined when neither is given', () => {
    expect(resolveMinQas(undefined, undefined, WIDE)).toBeUndefined();
    expect(resolveMinQas(undefined, undefined, SEED_CUTOFFS)).toBeUndefined();
  });
});
