/**
 * Tests for `calibration-stats` — pure helpers extracted from
 * `TRACELiveCalibrationPanel.tsx` so they're testable in isolation.
 *
 * Coverage:
 *   - niceTicks: produces 1/2/5 × 10^k step ladders for several typical
 *     SPX-close ranges, plus the lo === hi and lo > hi guards.
 *   - median: empty / single / odd / even, plus an unsorted input to
 *     verify the function does not mutate its argument.
 *   - classifyRegime: each of the four status zones (thin / good /
 *     biased / broken) including the n boundary at 5 and the |median|
 *     boundaries at 3 and 10.
 */

import { describe, it, expect } from 'vitest';
import {
  niceTicks,
  median,
  classifyRegime,
} from '../../utils/calibration-stats';

describe('niceTicks', () => {
  it('returns step-50 ladder for a 250-pt SPX range targeting 6 ticks', () => {
    // (7100, 7350) ÷ 5 → rawStep 50 → frac 5 → step 50.
    const ticks = niceTicks(7100, 7350, 6);
    expect(ticks).toEqual([7100, 7150, 7200, 7250, 7300, 7350]);
  });

  it('rounds rawStep up to the next 1/2/5 magnitude', () => {
    // (0, 12) ÷ 5 = 2.4 → frac 2.4 (< 3) → step 2.
    expect(niceTicks(0, 12, 6)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    // (0, 7) ÷ 5 = 1.4 → frac 1.4 (< 1.5) → step 1.
    expect(niceTicks(0, 7, 6)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // (0, 35) ÷ 5 = 7 → frac 7 (≥ 7) → step 10.
    expect(niceTicks(0, 35, 6)).toEqual([0, 10, 20, 30]);
    // (0, 22) ÷ 5 = 4.4 → frac 4.4 (< 7) → step 5.
    expect(niceTicks(0, 22, 6)).toEqual([0, 5, 10, 15, 20]);
  });

  it('handles non-integer ranges with a sub-unit step', () => {
    // (0, 1) ÷ 5 = 0.2 → frac 2 → step 0.2.
    const ticks = niceTicks(0, 1, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(ticks[0]).toBeCloseTo(0, 9);
    expect(ticks.at(-1)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('handles negative ranges (residual axis)', () => {
    const ticks = niceTicks(-15, 15, 6);
    expect(ticks).toContain(0);
    // Sorted ascending, symmetric about zero.
    expect(ticks[0]).toBeLessThan(0);
    expect(ticks.at(-1)).toBeGreaterThan(0);
  });

  it('returns [lo] when lo === hi (degenerate range)', () => {
    expect(niceTicks(7200, 7200, 6)).toEqual([7200]);
  });

  it('returns [lo] when range is negative', () => {
    expect(niceTicks(10, 5, 6)).toEqual([10]);
  });
});

describe('median', () => {
  it('returns 0 for empty input (panel sentinel)', () => {
    expect(median([])).toBe(0);
  });

  it('returns the single value for a 1-element array', () => {
    expect(median([7])).toBe(7);
  });

  it('returns the middle value for odd-length input', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  it('averages the two middle values for even-length input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles negative values', () => {
    expect(median([-5, -1, 0, 2, 8])).toBe(0);
    expect(median([-3, -1])).toBe(-2);
  });

  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('classifyRegime', () => {
  it('returns "thin" when n < 5 regardless of bias', () => {
    expect(classifyRegime(0, 0)).toBe('thin');
    expect(classifyRegime(4, 0)).toBe('thin');
    expect(classifyRegime(4, 100)).toBe('thin');
    expect(classifyRegime(4, -100)).toBe('thin');
  });

  it('returns "good" when n ≥ 5 and |median| ≤ 3', () => {
    expect(classifyRegime(5, 0)).toBe('good');
    expect(classifyRegime(5, 3)).toBe('good');
    expect(classifyRegime(5, -3)).toBe('good');
    expect(classifyRegime(100, 2.9)).toBe('good');
  });

  it('returns "biased" when n ≥ 5 and 3 < |median| ≤ 10', () => {
    expect(classifyRegime(5, 3.01)).toBe('biased');
    expect(classifyRegime(5, 5)).toBe('biased');
    expect(classifyRegime(5, 10)).toBe('biased');
    expect(classifyRegime(5, -10)).toBe('biased');
  });

  it('returns "broken" when n ≥ 5 and |median| > 10', () => {
    expect(classifyRegime(5, 10.01)).toBe('broken');
    expect(classifyRegime(5, 25)).toBe('broken');
    expect(classifyRegime(5, -25)).toBe('broken');
  });

  it('boundary at n=5: thin below, classified at exactly 5', () => {
    expect(classifyRegime(4, 1)).toBe('thin');
    expect(classifyRegime(5, 1)).toBe('good');
  });
});
