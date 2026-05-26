/**
 * Unit tests for GexLandscape `computePriceTrend`. Pure function — no React.
 *
 * Phase 4 of the 1-min GexBot rebuild dropped the 5-min snapshot
 * smoothing buffer (`computeSmoothedStrikes`) and the `Snapshot` type.
 * `computePriceTrend` now operates on a minimal `{ts, price}[]` buffer
 * — see `src/components/GexLandscape/deltas.ts`.
 */

import { describe, expect, it } from 'vitest';
import { computePriceTrend } from '../../components/GexLandscape/deltas';
import type { PricePoint } from '../../utils/price-trend';

describe('computePriceTrend', () => {
  const NOW = 600_000; // 10 min in ms
  const WINDOW = 5 * 60 * 1000;

  /** Create a price point at the given ms. */
  function pt(ts: number, price: number): PricePoint {
    return { ts, price };
  }

  it('returns flat when fewer than 3 in-window points', () => {
    const buf = [pt(300_000, 7000), pt(350_000, 6998)];
    const trend = computePriceTrend(6995, buf, NOW, WINDOW);
    expect(trend.direction).toBe('flat');
    expect(trend.changePts).toBe(0);
  });

  it('returns flat when price change is below threshold despite consistency', () => {
    // 3+ points, all going down, but only ~1 pt total change
    const buf = [
      pt(300_000, 7000),
      pt(360_000, 6999.8),
      pt(420_000, 6999.5),
      pt(480_000, 6999.2),
    ];
    const trend = computePriceTrend(6999, buf, NOW, WINDOW);
    expect(trend.direction).toBe('flat');
  });

  it('returns flat when consistency is below threshold despite large change', () => {
    const buf = [
      pt(300_000, 7000),
      pt(330_000, 6995),
      pt(360_000, 7002),
      pt(390_000, 6993),
      pt(420_000, 7001),
      pt(450_000, 6990),
      pt(480_000, 6998),
    ];
    // Net change is small + choppy → flat regardless.
    const trend = computePriceTrend(6998, buf, NOW, WINDOW);
    expect(trend.direction).toBe('flat');
  });

  it('returns down for a sustained downward grind meeting both thresholds', () => {
    const buf = [
      pt(300_000, 7020),
      pt(330_000, 7018),
      pt(360_000, 7016),
      pt(390_000, 7013),
      pt(420_000, 7011),
    ];
    const trend = computePriceTrend(7010, buf, NOW, WINDOW);
    expect(trend.direction).toBe('down');
    expect(trend.changePts).toBeCloseTo(-10, 5);
    expect(trend.changePct).toBeLessThan(0);
    expect(trend.consistency).toBeGreaterThan(0.55);
  });

  it('returns up for a sustained upward grind meeting both thresholds', () => {
    const buf = [
      pt(300_000, 7000),
      pt(330_000, 7002),
      pt(360_000, 7004),
      pt(390_000, 7005),
      pt(420_000, 7008),
    ];
    const trend = computePriceTrend(7010, buf, NOW, WINDOW);
    expect(trend.direction).toBe('up');
    expect(trend.changePts).toBeCloseTo(10, 5);
    expect(trend.changePct).toBeGreaterThan(0);
  });

  it('filters out points outside the window', () => {
    const buf = [
      pt(10_000, 6900), // way outside 5min window from NOW=600_000
      pt(300_000, 7000),
      pt(360_000, 7003),
      pt(420_000, 7005),
    ];
    const trend = computePriceTrend(7008, buf, NOW, WINDOW);
    // oldest in-window is 7000, not 6900
    expect(trend.changePts).toBeCloseTo(8, 5);
    expect(trend.direction).toBe('up');
  });

  it('handles currentPrice of 0 without NaN in changePct', () => {
    const buf = [pt(300_000, 0), pt(360_000, 0), pt(420_000, 0)];
    const trend = computePriceTrend(0, buf, NOW, WINDOW);
    expect(trend.changePct).toBe(0);
    expect(Number.isNaN(trend.changePct)).toBe(false);
  });

  it('drops future-relative points when scrubbing backward', () => {
    // Regression for the scrub coordination bug (2026-05-12). nowTs is
    // the scrubbed timestamp; the buffer holds live entries from AFTER
    // that scrubbed moment. Without the upper bound `pt.ts <= nowTs`,
    // those future entries would slip past the MIN_BUFFERED_POINTS
    // gate and produce a directional trend reading that reflects the
    // post-scrub future, not what the trader is actually looking at.
    const scrubbedNow = 600_000;
    const buf = [
      pt(300_000, 7000),
      pt(450_000, 7000),
      pt(600_000, 7000),
      // Future-relative-to-scrub entries with strong directional move.
      pt(900_000, 7015),
      pt(1_200_000, 7025),
    ];
    const trend = computePriceTrend(7000, buf, scrubbedNow, WINDOW);
    expect(trend.direction).toBe('flat');
    expect(trend.changePts).toBe(0);
  });
});
