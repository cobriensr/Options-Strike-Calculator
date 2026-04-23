// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeZeroGammaLevel, type GexStrike } from '../_lib/zero-gamma.js';

// Helpers to build synthetic chains. Each "strike" carries a signed dealer
// gamma $ notional — positive = dealers long gamma, negative = dealers short.

function evenChain(
  strikes: number[],
  gammaAt: (strike: number) => number,
): GexStrike[] {
  return strikes.map((strike) => ({ strike, gamma: gammaAt(strike) }));
}

describe('computeZeroGammaLevel', () => {
  it('returns empty result for empty input', () => {
    const result = computeZeroGammaLevel([], 7100);
    expect(result).toEqual({ level: null, confidence: 0, curve: [] });
  });

  it('locates zero-gamma near the mid on a balanced put-vs-call chain', () => {
    // Classic regime-flip layout: puts below 7105 are long-gamma (dealers
    // long puts), calls above are short-gamma (dealers short calls). At
    // low candidate spot the put contribution dominates → net positive;
    // at high candidate spot the call contribution dominates → net
    // negative. The crossing sits near 7105 by symmetry.
    const input: GexStrike[] = [
      { strike: 7095, gamma: 1_000_000_000 },
      { strike: 7100, gamma: 1_500_000_000 },
      { strike: 7105, gamma: 0 },
      { strike: 7110, gamma: -1_500_000_000 },
      { strike: 7115, gamma: -1_000_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7105);

    expect(result.level).not.toBeNull();
    // Crossing should land within ±1 pt of the symmetric midpoint.
    expect(Math.abs(result.level! - 7105)).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.curve.length).toBe(30);
  });

  it('returns null when dealers are long gamma everywhere', () => {
    const input: GexStrike[] = [
      { strike: 7090, gamma: 500_000_000 },
      { strike: 7100, gamma: 800_000_000 },
      { strike: 7110, gamma: 600_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7100);

    expect(result.level).toBeNull();
    expect(result.confidence).toBe(0);
    // Every sample in the curve should still be non-negative.
    for (const pt of result.curve) {
      expect(pt.netGamma).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns null when dealers are short gamma everywhere', () => {
    const input: GexStrike[] = [
      { strike: 7090, gamma: -400_000_000 },
      { strike: 7100, gamma: -900_000_000 },
      { strike: 7110, gamma: -500_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7100);

    expect(result.level).toBeNull();
    expect(result.confidence).toBe(0);
    for (const pt of result.curve) {
      expect(pt.netGamma).toBeLessThanOrEqual(0);
    }
  });

  it('locates a known asymmetric crossing within tolerance', () => {
    // Construct a chain with a clear monotonic transition: strong negative
    // gamma on the low side, strong positive on the high side, with a
    // balanced pivot around 7105. The triangular kernel with spacing 5 has
    // half-width 10 — so only the two nearest strikes contribute at any
    // candidate. Net gamma at candidate c between strikes k and k+5 is
    // g(k)*(1 - (c-k)/10) + g(k+5)*(1 - (k+5-c)/10), zero when the two
    // weighted gammas cancel.
    const input: GexStrike[] = [
      { strike: 7090, gamma: -1_000_000_000 },
      { strike: 7095, gamma: -500_000_000 },
      { strike: 7100, gamma: -100_000_000 },
      { strike: 7105, gamma: 100_000_000 },
      { strike: 7110, gamma: 500_000_000 },
      { strike: 7115, gamma: 1_000_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7102.5);

    expect(result.level).not.toBeNull();
    // Symmetry: the crossing should land near the pivot 7102.5 where the
    // two innermost strikes (7100: -100M, 7105: +100M) cancel each other.
    expect(Math.abs(result.level! - 7102.5)).toBeLessThan(7102.5 * 0.001);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles a sign change at the edge of the range', () => {
    // Arrange gamma so the curve crosses zero near the low edge of the
    // ±3% window. Grid runs 7100-7300 when spot = 7200; we place the
    // flip near 7110 so it still falls inside the grid's lowest samples.
    const input: GexStrike[] = evenChain(
      [7100, 7105, 7110, 7115, 7120, 7200, 7280, 7290, 7295, 7300],
      (strike) => (strike < 7108 ? -500_000_000 : 200_000_000),
    );

    const result = computeZeroGammaLevel(input, 7200);

    expect(result.level).not.toBeNull();
    expect(result.level!).toBeGreaterThanOrEqual(result.curve[0]!.spot);
    expect(result.level!).toBeLessThanOrEqual(result.curve.at(-1)!.spot);
  });

  it('degrades gracefully with a single strike input', () => {
    const input: GexStrike[] = [{ strike: 7100, gamma: 1_000_000_000 }];

    const result = computeZeroGammaLevel(input, 7100);

    // Single strike with a single sign cannot produce a sign change
    // anywhere in the kernel window — level should be null.
    expect(result.level).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.curve.length).toBe(30);
  });

  it('respects custom gridPoints and gridRangePct options', () => {
    const input: GexStrike[] = [
      { strike: 7095, gamma: 1_000_000_000 },
      { strike: 7100, gamma: 500_000_000 },
      { strike: 7110, gamma: -500_000_000 },
      { strike: 7115, gamma: -1_000_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7105, {
      gridPoints: 10,
      gridRangePct: 0.01,
    });

    expect(result.curve.length).toBe(10);
    const firstSpot = result.curve[0]!.spot;
    const lastSpot = result.curve.at(-1)!.spot;
    // ±1% range around 7105
    expect(firstSpot).toBeCloseTo(7105 * 0.99, 4);
    expect(lastSpot).toBeCloseTo(7105 * 1.01, 4);
  });

  it('curve spans exactly ±gridRangePct of spot', () => {
    const input: GexStrike[] = [
      { strike: 7100, gamma: 500_000_000 },
      { strike: 7110, gamma: -500_000_000 },
    ];

    const result = computeZeroGammaLevel(input, 7100, { gridRangePct: 0.03 });

    expect(result.curve[0]!.spot).toBeCloseTo(7100 * 0.97, 4);
    expect(result.curve.at(-1)!.spot).toBeCloseTo(7100 * 1.03, 4);
  });
});
