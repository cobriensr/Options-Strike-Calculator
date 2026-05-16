// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  divergence,
  lateDayCliff,
  recentFlip,
  slopeLastNMinutes,
  type FlowPoint,
} from '../_lib/greek-flow-metrics.js';

function makeSeries(
  values: number[],
  startUtcIso = '2026-04-28T13:30:00Z',
): FlowPoint[] {
  const start = new Date(startUtcIso).getTime();
  return values.map((v, i) => ({
    timestamp: new Date(start + i * 60_000).toISOString(),
    cumulative: v,
  }));
}

describe('slopeLastNMinutes', () => {
  it('returns null for empty input', () => {
    expect(slopeLastNMinutes([])).toEqual({ slope: null, points: 0 });
  });

  it('returns null for a single point', () => {
    const series = makeSeries([42]);
    expect(slopeLastNMinutes(series)).toEqual({ slope: null, points: 1 });
  });

  it('returns positive slope on a monotonically rising series', () => {
    const series = makeSeries([1, 2, 3, 4, 5]);
    const result = slopeLastNMinutes(series);
    expect(result.slope).toBeCloseTo(1, 6);
    expect(result.points).toBe(5);
  });

  it('returns 0 for a flat series', () => {
    const series = makeSeries([7, 7, 7, 7, 7]);
    expect(slopeLastNMinutes(series).slope).toBeCloseTo(0, 6);
  });

  it('only uses the trailing window when series exceeds it', () => {
    // First 100 points dropping, last 5 rising — slope should reflect
    // only the last 5 once we cap to 5.
    const series = makeSeries([
      ...Array.from({ length: 100 }, (_, i) => -i),
      0,
      10,
      20,
      30,
      40,
    ]);
    const result = slopeLastNMinutes(series, 5);
    expect(result.slope).toBeCloseTo(10, 6);
    expect(result.points).toBe(5);
  });
});

describe('recentFlip', () => {
  it('reports no flip on empty input', () => {
    expect(recentFlip([])).toEqual({
      occurred: false,
      atTimestamp: null,
      magnitude: 0,
      currentSign: 0,
    });
  });

  it('detects a sign change inside the lookback window', () => {
    // Goes negative for 3 minutes, then positive — that's a flip.
    const series = makeSeries([-2, -1, -0.5, 0.5, 1.5, 2.5]);
    const result = recentFlip(series, 30);
    expect(result.occurred).toBe(true);
    expect(result.currentSign).toBe(1);
    // Magnitude is the max abs(value) inside the window.
    expect(result.magnitude).toBeCloseTo(2.5, 6);
    expect(result.atTimestamp).not.toBeNull();
  });

  it('reports no flip when sign is consistent across the window', () => {
    const series = makeSeries([1, 2, 3, 4, 5]);
    const result = recentFlip(series, 30);
    expect(result.occurred).toBe(false);
    expect(result.currentSign).toBe(1);
  });

  it('treats a zero crossing followed by negative as a flip', () => {
    const series = makeSeries([3, 2, 1, -1, -2]);
    const result = recentFlip(series, 30);
    expect(result.occurred).toBe(true);
    expect(result.currentSign).toBe(-1);
  });

  it('reports currentSign=0 when the latest cumulative is exactly zero', () => {
    const series = makeSeries([3, 2, 1, 0]);
    const result = recentFlip(series, 30);
    expect(result.currentSign).toBe(0);
    // Flip detection requires non-zero signs on both sides — 1→0 is not a flip.
    expect(result.occurred).toBe(false);
  });
});

describe('lateDayCliff', () => {
  it('returns 0 when series is shorter than the window', () => {
    const series = makeSeries([1, 2, 3]);
    expect(lateDayCliff(series, 10)).toEqual({
      magnitude: 0,
      atTimestamp: null,
    });
  });

  it('ignores activity outside the 14:00–15:00 CT window', () => {
    // 13:30Z = 8:30 CT — well outside the 14:00–15:00 CT power hour.
    const values = Array.from({ length: 60 }, (_, i) => i * 10);
    const series = makeSeries(values, '2026-04-28T13:30:00Z');
    expect(lateDayCliff(series).magnitude).toBe(0);
  });

  it('captures a step change inside the power hour', () => {
    // 19:00Z = 14:00 CT during CDT (April → DST active).
    // Build a 25-minute series starting at 13:50 CT with a step at 14:10 CT.
    const start = '2026-04-28T18:50:00Z'; // 13:50 CT
    const values = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // 13:50–13:59 (10 mins, pre-window)
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // 14:00–14:09 (no movement yet)
      0,
      100,
      100,
      100,
      100, // 14:10 step → 100, holds
    ];
    const series = makeSeries(values, start);
    const result = lateDayCliff(series, 10);
    expect(result.magnitude).toBeCloseTo(100, 6);
    expect(result.atTimestamp).not.toBeNull();
  });

  // Regression: the prior index-based implementation walked back N entries
  // regardless of elapsed time. With a missing-minute gap, that became an
  // 11+-real-minute "10-min" window and overstated the cliff. Time-based
  // walk-back honors the wall-clock window, even with sparse series.
  it('walks back by elapsed time, not array index, when minutes are missing', () => {
    // 14:00 CT = 19:00Z (CDT). Build 11 minute marks but DROP minute 14:05
    // — the array now has 10 entries spanning 11 real minutes, with a step
    // landing at 14:10. An index-based 10-min window would compare 14:10
    // → 13:59 (11 real minutes) and pull in pre-window movement.
    const ts = (mins: number) =>
      new Date(
        new Date('2026-04-28T18:59:00Z').getTime() + mins * 60_000,
      ).toISOString();
    const series: FlowPoint[] = [
      { timestamp: ts(0), cumulative: 50 }, // 13:59 — pre-window, value 50
      { timestamp: ts(1), cumulative: 0 }, // 14:00 — value drops to 0
      { timestamp: ts(2), cumulative: 0 }, // 14:01
      { timestamp: ts(3), cumulative: 0 }, // 14:02
      { timestamp: ts(4), cumulative: 0 }, // 14:03
      { timestamp: ts(5), cumulative: 0 }, // 14:04
      // 14:05 INTENTIONALLY MISSING (UW dropped a bar)
      { timestamp: ts(7), cumulative: 0 }, // 14:06 (index 6, t+7)
      { timestamp: ts(8), cumulative: 0 }, // 14:07
      { timestamp: ts(9), cumulative: 0 }, // 14:08
      { timestamp: ts(10), cumulative: 0 }, // 14:09
      { timestamp: ts(11), cumulative: 100 }, // 14:10 — the actual cliff
    ];
    const result = lateDayCliff(series, 10);
    // Walk back from 14:10 by ≥10 real minutes lands at 14:00 (cum=0),
    // NOT at 13:59 (cum=50). Cliff magnitude is |100 - 0| = 100.
    expect(result.magnitude).toBeCloseTo(100, 6);
    expect(result.atTimestamp).toBe(ts(11));
  });
});

describe('divergence', () => {
  it('flags opposite signs as diverging', () => {
    expect(divergence(100, -50)).toEqual({
      spySign: 1,
      qqqSign: -1,
      diverging: true,
    });
  });

  it('reports same-sign as not diverging', () => {
    expect(divergence(100, 50)).toEqual({
      spySign: 1,
      qqqSign: 1,
      diverging: false,
    });
  });

  it('does not flag divergence when one side is zero', () => {
    expect(divergence(0, -50)).toEqual({
      spySign: 0,
      qqqSign: -1,
      diverging: false,
    });
  });

  it('handles null inputs without throwing', () => {
    expect(divergence(null, null)).toEqual({
      spySign: 0,
      qqqSign: 0,
      diverging: false,
    });
  });
});
