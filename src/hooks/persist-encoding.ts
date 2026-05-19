/**
 * Shared `UsePersistedStateOptions` shims for the common bespoke
 * encodings used across SilentBoom / LotteryFinder / GexLandscape /
 * Tracker filter chips. Each preserves the on-disk localStorage
 * payload byte-for-byte from before the Phase 2B/2C usePersistedState
 * sweep, so users' saved filter state stays valid across the refactor.
 *
 * Returning `undefined` from `parse` tells `usePersistedState` to fall
 * back to its `defaultValue`.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md
 */

import type { UsePersistedStateOptions } from './usePersistedState.js';

/** Boolean stored as `'1'` / `'0'` (legacy filter-chip convention). */
export const boolPersistOpts: UsePersistedStateOptions<boolean> = {
  parse: (raw) => raw === '1',
  serialize: (v) => (v ? '1' : '0'),
};

/**
 * Non-negative integer stored via `String(n)` (no JSON quoting).
 * Negative values and non-finite parses fall back to `defaultValue`.
 */
export const intPersistOpts: UsePersistedStateOptions<number> = {
  parse: (raw) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  },
  serialize: String,
};

/**
 * Float stored via `String(n)`. No negative-value rejection — used
 * for ratios like minVolOi where negatives are nonsensical but the
 * pre-refactor code didn't reject them, so we don't either.
 */
export const floatPersistOpts: UsePersistedStateOptions<number> = {
  parse: (raw) => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  },
  serialize: String,
};

/** Moneyness tri-state — 'all' | 'otm' | 'itm' — stored verbatim. */
export type MoneynessMode = 'all' | 'otm' | 'itm';

export function isMoneynessMode(v: unknown): v is MoneynessMode {
  return v === 'all' || v === 'otm' || v === 'itm';
}

export const moneynessPersistOpts: UsePersistedStateOptions<MoneynessMode> = {
  parse: (raw) => (isMoneynessMode(raw) ? raw : undefined),
  serialize: (v) => v,
};

/** Conviction-floor tier — 'all' | 'tier2' | 'tier1' — stored verbatim. */
export type ConvictionFloor = 'all' | 'tier2' | 'tier1';

export function isConvictionFloor(v: unknown): v is ConvictionFloor {
  return v === 'tier1' || v === 'tier2' || v === 'all';
}

export const convictionFloorPersistOpts: UsePersistedStateOptions<ConvictionFloor> =
  {
    parse: (raw) => (isConvictionFloor(raw) ? raw : undefined),
    serialize: (v) => v,
  };
