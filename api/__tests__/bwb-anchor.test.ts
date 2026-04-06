// @vitest-environment node

import { describe, it, expect } from 'vitest';
import type { StrikeExposureRow } from '../_lib/db-strike-helpers.js';
import { computeProxCentroid, computeCharmCentroid } from '../bwb-anchor.js';

/** Build a minimal StrikeExposureRow for testing. */
function strike(
  s: number,
  price: number,
  netGamma: number,
  netCharm: number = 0,
): StrikeExposureRow {
  return {
    strike: s,
    price,
    timestamp: '2026-04-06T18:00:00Z',
    netGamma,
    netCharm,
    netDelta: 0,
    callGammaOi: netGamma > 0 ? netGamma : 0,
    putGammaOi: netGamma < 0 ? netGamma : 0,
    callCharmOi: netCharm > 0 ? netCharm : 0,
    putCharmOi: netCharm < 0 ? netCharm : 0,
    dirGamma: 0,
    dirCharm: 0,
  };
}

describe('computeProxCentroid', () => {
  it('weights closer strikes more heavily', () => {
    const price = 5700;
    const strikes = [
      strike(5690, price, 1000), // 10 pts away
      strike(5750, price, 1000), // 50 pts away
    ];
    const { centroid } = computeProxCentroid(strikes);
    // Closer strike should pull centroid toward it
    expect(centroid).toBeLessThan(price);
  });

  it('returns price when all gamma is zero', () => {
    const price = 5700;
    const strikes = [strike(5690, price, 0), strike(5710, price, 0)];
    const { centroid } = computeProxCentroid(strikes);
    expect(centroid).toBe(price);
  });

  it('computes top-3 concentration correctly', () => {
    const price = 5700;
    const strikes = [
      strike(5690, price, 100),
      strike(5695, price, 200),
      strike(5700, price, 300),
      strike(5705, price, 50),
      strike(5710, price, -350), // negative gamma, abs = 350
    ];
    // Total |gamma| = 100 + 200 + 300 + 50 + 350 = 1000
    // Top 3: 350 + 300 + 200 = 850
    const { concentration } = computeProxCentroid(strikes);
    expect(concentration).toBeCloseTo(0.85, 2);
  });
});

describe('computeCharmCentroid — gamma/charm interaction matrix', () => {
  it('+γ +charm gets 1.5× boost (wall strengthening)', () => {
    const price = 5700;
    // Two strikes with equal gamma and distance, different charm
    const withCharm = [
      strike(5690, price, 1000, 500), // +γ +charm
      strike(5710, price, 1000, 0), // +γ, no charm
    ];
    const withoutCharm = [
      strike(5690, price, 1000, 0),
      strike(5710, price, 1000, 0),
    ];
    const boosted = computeCharmCentroid(withCharm);
    const neutral = computeCharmCentroid(withoutCharm);
    // With charm boost on 5690, centroid should pull toward 5690
    expect(boosted).toBeLessThan(neutral);
  });

  it('+γ -charm gets 0.75× dampen (wall decaying)', () => {
    const price = 5700;
    const decaying = [
      strike(5690, price, 1000, -500), // +γ -charm → 0.75×
      strike(5710, price, 1000, 0), // +γ, no charm → 1×
    ];
    const neutral = [
      strike(5690, price, 1000, 0),
      strike(5710, price, 1000, 0),
    ];
    const dampened = computeCharmCentroid(decaying);
    const base = computeCharmCentroid(neutral);
    // Dampened 5690 pulls less → centroid moves toward 5710
    expect(dampened).toBeGreaterThan(base);
  });

  it('-γ +charm gets 0.5× discount (acceleration intensifying)', () => {
    const price = 5700;
    const accelerating = [
      strike(5690, price, -1000, 500), // -γ +charm → 0.5×
      strike(5710, price, 1000, 0), // +γ, no charm → 1×
    ];
    const neutral = [
      strike(5690, price, -1000, 0), // -γ, no charm → 1×
      strike(5710, price, 1000, 0),
    ];
    const discounted = computeCharmCentroid(accelerating);
    const base = computeCharmCentroid(neutral);
    // Discounted -γ strike pulls less → centroid moves toward 5710
    expect(discounted).toBeGreaterThan(base);
  });

  it('-γ -charm stays at 1× (acceleration weakening)', () => {
    const price = 5700;
    // Both strikes equidistant, equal |gamma|
    const weakening = [
      strike(5690, price, -1000, -500), // -γ -charm → 1×
      strike(5710, price, -1000, -500), // -γ -charm → 1×
    ];
    const neutral = [
      strike(5690, price, -1000, 0),
      strike(5710, price, -1000, 0),
    ];
    const result = computeCharmCentroid(weakening);
    const base = computeCharmCentroid(neutral);
    // Both have equal distance and same multiplier → same centroid
    expect(result).toBeCloseTo(base, 4);
  });

  it('centroid pulls away from -γ +charm zones toward +γ +charm zones', () => {
    const price = 5700;
    const strikes = [
      strike(5680, price, -2000, 800), // acceleration intensifying → 0.5×
      strike(5700, price, 1000, 600), // wall strengthening → 1.5×
      strike(5720, price, -500, 0), // neutral acceleration → 1×
    ];
    const centroid = computeCharmCentroid(strikes);
    // Should pull toward 5700 (boosted wall), away from 5680 (discounted)
    expect(centroid).toBeGreaterThan(5690);
    expect(centroid).toBeLessThan(5710);
  });
});
