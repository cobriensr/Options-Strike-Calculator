import { describe, expect, it } from 'vitest';
import {
  minutesToPeak,
  peakCeiling,
  realizedHardStop30m,
  realizedTier50HoldEod,
  realizedTrailAct30Trail10,
} from '../_lib/lottery-exit-policies.js';

// All policies share the same input contract:
//   prices              — post-entry tick prices (entry tick at index 0)
//   minutesSinceEntry   — same length, monotonically non-decreasing offset
//
// Returns are % of entry: e.g. +25.5 means realized 1.255× entry.

const ENTRY = 1.0;

// Helper — generate evenly-spaced minute offsets for `n` ticks.
const minutes = (n: number, stepMin = 1): number[] =>
  Array.from({ length: n }, (_, i) => i * stepMin);

// ============================================================
// realizedTrailAct30Trail10 — activates at +30%, exits on -10pp drop
// ============================================================

describe('realizedTrailAct30Trail10', () => {
  it('returns 0 on empty prices', () => {
    expect(realizedTrailAct30Trail10([], 1)).toBe(0);
  });

  it('returns 0 when entry ≤ 0', () => {
    expect(realizedTrailAct30Trail10([1, 2, 3], 0)).toBe(0);
    expect(realizedTrailAct30Trail10([1, 2, 3], -1)).toBe(0);
  });

  it('returns last-tick return when peak never reaches +30%', () => {
    // Peak +25%, never activates → realized = last (+10%)
    const r = realizedTrailAct30Trail10([1.0, 1.25, 1.1], ENTRY);
    expect(r).toBeCloseTo(10, 6);
  });

  it('exits when current return drops 10pp below the peak', () => {
    // Entry 1.0, prices: 1.0, 1.5 (peak +50%), 1.4 (+40%, no exit), 1.35 (+35%)
    // Peak=50, drop threshold = 40, so 1.40 is the boundary (≤ 40 = exit).
    const r = realizedTrailAct30Trail10([1.0, 1.5, 1.4, 1.2], ENTRY);
    expect(r).toBeCloseTo(40, 6);
  });

  it('updates the running peak on new highs before exiting', () => {
    // 1.0 → +30 (activate, peak=30) → +50 (peak=50) → +60 (peak=60)
    //     → +50 (peak-10 = 50, equal triggers exit) → return 50
    const r = realizedTrailAct30Trail10([1.0, 1.3, 1.5, 1.6, 1.5, 1.2], ENTRY);
    expect(r).toBeCloseTo(50, 6);
  });

  it('rides to the last tick when no exit triggers', () => {
    // Activate at +30, climb to +60, end at +55 (only -5pp drawdown).
    const r = realizedTrailAct30Trail10([1.0, 1.3, 1.6, 1.55], ENTRY);
    expect(r).toBeCloseTo(55, 6);
  });
});

// ============================================================
// realizedHardStop30m — exit at last tick within stopMin
// ============================================================

describe('realizedHardStop30m', () => {
  it('returns 0 on empty prices', () => {
    expect(realizedHardStop30m([], 1, [])).toBe(0);
  });

  it('returns 0 when no tick is within the stop window', () => {
    // stop = 30 min; first offset is 31
    expect(realizedHardStop30m([1.5, 1.6], 1, [31, 32])).toBe(0);
  });

  it('returns return at the last tick within the 30-min window', () => {
    // ticks at 0,15,30,45 — within window: 0,15,30 (last in = 30)
    const prices = [1.0, 1.4, 1.6, 2.0];
    const r = realizedHardStop30m(prices, ENTRY, [0, 15, 30, 45]);
    expect(r).toBeCloseTo(60, 6);
  });

  it('honors a custom stopMin override', () => {
    // 60-min override → last in = index 3 (price 2.0)
    const r = realizedHardStop30m(
      [1.0, 1.4, 1.6, 2.0],
      ENTRY,
      [0, 15, 30, 45],
      60,
    );
    expect(r).toBeCloseTo(100, 6);
  });

  it('returns 0 when entry ≤ 0', () => {
    expect(realizedHardStop30m([1, 2], 0, [0, 15])).toBe(0);
  });
});

// ============================================================
// realizedTier50HoldEod — sell half at +50%, hold rest to last
// ============================================================

describe('realizedTier50HoldEod', () => {
  it('returns 0 on empty prices', () => {
    expect(realizedTier50HoldEod([], 1)).toBe(0);
  });

  it('returns last-tick return when +50% threshold is never hit', () => {
    // Peak +30% — both halves held to last (+10%)
    const r = realizedTier50HoldEod([1.0, 1.3, 1.1], ENTRY);
    expect(r).toBeCloseTo(10, 6);
  });

  it('takes tier-1 at +50% then holds tier-2 to last tick', () => {
    // Tier1 at +50% (price 1.5), tier2 at last (price 2.0 = +100%)
    // Avg: (50 + 100) / 2 = 75
    const r = realizedTier50HoldEod([1.0, 1.5, 1.8, 2.0], ENTRY);
    expect(r).toBeCloseTo(75, 6);
  });

  it('takes tier-1 the first time threshold is touched', () => {
    // Brief +60% touch then long fade — tier1 = +60%, tier2 = -50%
    // Avg = (60 + (-50)) / 2 = 5
    const r = realizedTier50HoldEod([1.0, 1.6, 1.0, 0.5], ENTRY);
    expect(r).toBeCloseTo(5, 6);
  });

  it('returns 0 when entry ≤ 0', () => {
    expect(realizedTier50HoldEod([1, 2], 0)).toBe(0);
  });
});

// ============================================================
// peakCeiling + minutesToPeak (reference metrics)
// ============================================================

describe('peakCeiling', () => {
  it('returns 0 on empty', () => {
    expect(peakCeiling([], 1)).toBe(0);
  });

  it('returns max% above entry', () => {
    expect(peakCeiling([1, 1.5, 1.2, 2.0, 1.5], ENTRY)).toBeCloseTo(100, 6);
  });

  it('returns 0 when entry ≤ 0', () => {
    expect(peakCeiling([1, 2], 0)).toBe(0);
  });

  it('handles the SNDK 5/1 fire #4 archetype (+996% peak)', () => {
    // Entry $0.05, peak $0.55 → +1000%
    expect(peakCeiling([0.05, 0.1, 0.55, 0.4], 0.05)).toBeCloseTo(1000, 6);
  });
});

describe('minutesToPeak', () => {
  it('returns the offset of the first peak tick', () => {
    expect(minutesToPeak([1, 1.5, 1.2, 2.0, 1.5], minutes(5))).toBe(3);
  });

  it('returns 0 on empty', () => {
    expect(minutesToPeak([], [])).toBe(0);
  });
});
