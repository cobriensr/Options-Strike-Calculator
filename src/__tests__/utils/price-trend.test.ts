import { describe, it, expect } from 'vitest';
import {
  computePriceTrend,
  DRIFT_CONSISTENCY_THRESHOLD,
  DRIFT_PTS_THRESHOLD,
  type PricePoint,
} from '../../utils/price-trend';

// Anchor wall-clock at a known instant so the window math is reproducible.
const NOW_MS = new Date('2026-04-21T19:30:00Z').getTime();
const MIN = 60 * 1000;

/** Build a series spanning the last `n` minutes with a linear slope. */
function linearSeries(
  startPrice: number,
  slopePerMin: number,
  n: number,
): PricePoint[] {
  const out: PricePoint[] = [];
  for (let i = n; i > 0; i--) {
    out.push({
      price: startPrice + slopePerMin * (n - i),
      ts: NOW_MS - i * MIN,
    });
  }
  return out;
}

describe('computePriceTrend', () => {
  it('returns flat when fewer than MIN_SNAPSHOTS in-window samples', () => {
    const result = computePriceTrend(
      [
        { price: 5800, ts: NOW_MS - 4 * MIN },
        { price: 5802, ts: NOW_MS - 3 * MIN },
      ],
      NOW_MS,
    );
    expect(result).toEqual({
      direction: 'flat',
      changePct: 0,
      changePts: 0,
      consistency: 0,
    });
  });

  it('classifies an up-drift with strong consistency and sufficient magnitude', () => {
    // +1/min for 5 minutes → +5 pts, monotonic → consistency 1.0
    const result = computePriceTrend(linearSeries(5800, 1, 5), NOW_MS);
    expect(result.direction).toBe('up');
    expect(result.changePts).toBe(4);
    expect(result.consistency).toBe(1);
  });

  it('classifies a down-drift symmetrically', () => {
    const result = computePriceTrend(linearSeries(5800, -1, 5), NOW_MS);
    expect(result.direction).toBe('down');
    expect(result.changePts).toBe(-4);
    expect(result.consistency).toBe(1);
  });

  it('returns flat when magnitude below DRIFT_PTS_THRESHOLD despite perfect consistency', () => {
    // +0.5/min for 5 min → +2 pts (below 3-pt threshold).
    const result = computePriceTrend(linearSeries(5800, 0.5, 5), NOW_MS);
    expect(result.direction).toBe('flat');
    expect(Math.abs(result.changePts)).toBeLessThan(DRIFT_PTS_THRESHOLD);
    expect(result.consistency).toBe(1);
  });

  it('returns flat when consistency below threshold despite large magnitude', () => {
    // Zig-zag producing ~50% consistency with final +4 pts net move.
    const series: PricePoint[] = [
      { price: 5800, ts: NOW_MS - 5 * MIN },
      { price: 5810, ts: NOW_MS - 4 * MIN },
      { price: 5800, ts: NOW_MS - 3 * MIN },
      { price: 5810, ts: NOW_MS - 2 * MIN },
      { price: 5804, ts: NOW_MS - 1 * MIN },
    ];
    const result = computePriceTrend(series, NOW_MS);
    expect(result.direction).toBe('flat');
    expect(result.consistency).toBeLessThan(DRIFT_CONSISTENCY_THRESHOLD);
  });

  it('filters out points outside the lookback window', () => {
    // One old point far outside the 5-min window should be ignored.
    const series: PricePoint[] = [
      { price: 5800, ts: NOW_MS - 60 * MIN }, // old, dropped
      ...linearSeries(5800, 1, 5),
    ];
    const result = computePriceTrend(series, NOW_MS);
    expect(result.direction).toBe('up');
    expect(result.changePts).toBe(4); // measured from the IN-window first, not the ancient point
  });

  it('drops non-finite prices silently without poisoning the result', () => {
    const series: PricePoint[] = [
      { price: 5800, ts: NOW_MS - 5 * MIN },
      { price: Number.NaN, ts: NOW_MS - 4 * MIN },
      { price: 5802, ts: NOW_MS - 3 * MIN },
      { price: 5804, ts: NOW_MS - 2 * MIN },
      { price: 5806, ts: NOW_MS - 1 * MIN },
    ];
    const result = computePriceTrend(series, NOW_MS);
    expect(result.direction).toBe('up');
  });

  it('handles an unsorted input (sorts by ts internally)', () => {
    const sorted = linearSeries(5800, 1, 5);
    const shuffled = [
      sorted[2]!,
      sorted[0]!,
      sorted[4]!,
      sorted[1]!,
      sorted[3]!,
    ];
    const result = computePriceTrend(shuffled, NOW_MS);
    expect(result.direction).toBe('up');
    expect(result.changePts).toBe(4);
  });

  it('returns flat for a perfectly flat series (zero change, zero consistency)', () => {
    const series: PricePoint[] = [
      { price: 5800, ts: NOW_MS - 4 * MIN },
      { price: 5800, ts: NOW_MS - 3 * MIN },
      { price: 5800, ts: NOW_MS - 2 * MIN },
      { price: 5800, ts: NOW_MS - 1 * MIN },
    ];
    const result = computePriceTrend(series, NOW_MS);
    expect(result.direction).toBe('flat');
    expect(result.changePts).toBe(0);
    expect(result.consistency).toBe(0);
  });

  it('respects a custom windowMs', () => {
    // +1/min for 10 minutes, but we pass windowMs = 2min.
    const result = computePriceTrend(
      linearSeries(5800, 1, 10),
      NOW_MS,
      2 * MIN,
    );
    // Only the last ~2 minutes of points are in-window → likely still
    // below MIN_SNAPSHOTS of 3 → flat.
    expect(result.direction).toBe('flat');
  });
});
