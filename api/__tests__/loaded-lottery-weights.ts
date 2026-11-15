// What the handler tests that mock `../_lib/lottery-weights-loader.js` hand back
// from `loadLotteryWeights`. One fixture for the detect cron and the three feed
// endpoints (finder, ticker counts, export), so a change to the loader's result
// shape is one edit here, and not four copies that drift apart.

import type { LoadedLotteryWeights } from '../_lib/lottery-weights-loader.js';
import type { FeedTierCutoffs } from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';

/** Both pointers sit on this in production until the first promotion. */
const SEED_VERSIONED = {
  version: SEED_LOTTERY_WEIGHTS_VERSION,
  weights: SEED_LOTTERY_WEIGHTS,
};

/**
 * The loader's answer: both pointers on the seed, no fallback, unless a test
 * overrides a part.
 */
export function loadedWeights(
  parts: Partial<LoadedLotteryWeights> = {},
): LoadedLotteryWeights {
  return {
    active: SEED_VERSIONED,
    takeit: SEED_VERSIONED,
    fallback: null,
    ...parts,
  };
}

/**
 * The seed's weights with `feed_cutoffs` replaced, under `version`, in the
 * ACTIVE slot only. The `takeit` slot keeps the seed, so a handler that read the
 * wrong slot would bind the seed's 13 / 10 and fail the cutoff tests, rather
 * than pass because both slots agreed. `fallback` marks a seed fallback.
 */
export function loadedWithFeedCutoffs(
  version: string,
  cutoffs: FeedTierCutoffs,
  fallback: LoadedLotteryWeights['fallback'] = null,
): LoadedLotteryWeights {
  return loadedWeights({
    active: {
      version,
      weights: { ...SEED_LOTTERY_WEIGHTS, feed_cutoffs: cutoffs },
    },
    fallback,
  });
}
