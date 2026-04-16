import type { InternalSymbol } from '../types/market-internals';

export const INTERNAL_SYMBOLS: readonly InternalSymbol[] = [
  '$TICK',
  '$ADD',
  '$VOLD',
  '$TRIN',
] as const;

/**
 * $TICK threshold bands (NYSE, ~3,000 stocks).
 * $ADD / $VOLD / $TRIN use slope-based classification in Phase 2,
 * not fixed thresholds — displayed raw in Phase 1.
 */
export const MARKET_INTERNALS_THRESHOLDS = {
  tick: { elevated: 400, extreme: 600, blowoff: 1000 },
} as const;

export const PINNED_THRESHOLD_MINUTES = 3;
