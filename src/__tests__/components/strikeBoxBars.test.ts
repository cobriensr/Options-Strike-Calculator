/**
 * Unit tests for StrikeBox bars math. Pure functions — no React, no DOM.
 *
 * `computeBarStats` derives the per-greek scale (median |value|) and
 * near-zero threshold (5th percentile |value|) used by GreekBar to size
 * and color bars. Median + percentile have edge cases worth pinning down
 * so a future refactor doesn't silently change visual scaling.
 */

import { describe, expect, it } from 'vitest';
import { computeBarStats } from '../../components/GexTarget/StrikeBox/bars';

describe('computeBarStats', () => {
  it('returns safe defaults for an empty input', () => {
    const stats = computeBarStats([]);
    expect(stats.scale).toBe(1);
    expect(stats.nearZeroThreshold).toBe(1e-6);
  });

  it('uses the middle absolute value as scale for an odd-length input', () => {
    const stats = computeBarStats([10, -20, 30, -40, 50]);
    // sorted abs: [10,20,30,40,50] — median = 30
    expect(stats.scale).toBe(30);
  });

  it('averages the two middle absolute values for an even-length input', () => {
    const stats = computeBarStats([10, -20, 30, -40]);
    // sorted abs: [10,20,30,40] — mean of middle two (20 + 30) / 2 = 25
    expect(stats.scale).toBe(25);
  });

  it('treats sign as irrelevant — only absolute magnitude matters', () => {
    const positive = computeBarStats([10, 20, 30, 40, 50]);
    const mixed = computeBarStats([-10, 20, -30, 40, -50]);
    expect(mixed.scale).toBe(positive.scale);
  });

  it('clamps a zero-median scale to 1 to avoid divide-by-zero downstream', () => {
    const stats = computeBarStats([0, 0, 0]);
    expect(stats.scale).toBe(1);
  });

  it('clamps a zero near-zero threshold to 1e-6', () => {
    const stats = computeBarStats([0, 0, 0]);
    expect(stats.nearZeroThreshold).toBe(1e-6);
  });

  it('derives the near-zero threshold from the 5th percentile', () => {
    // 20 values; floor(20 * 0.05) = 1 → 2nd-smallest |value|
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const stats = computeBarStats(values);
    expect(stats.nearZeroThreshold).toBe(2);
  });

  it('handles a single-value input by setting scale = |value|', () => {
    const stats = computeBarStats([42]);
    expect(stats.scale).toBe(42);
    // floor(1 * 0.05) = 0 → first (only) abs value
    expect(stats.nearZeroThreshold).toBe(42);
  });
});
