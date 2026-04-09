import { describe, it, expect } from 'vitest';
import {
  computeZeroGammaStrike,
  analyzeZeroGamma,
  type StrikeGamma,
} from '../../utils/zero-gamma';

// Helper: build a gamma profile whose cumulative walk crosses exactly at
// `flipStrike`. The two strikes bracketing the flip carry the majority of
// the gamma (−50 and +100) so that after the cumulative reaches −50 at
// flipStrike − 5, the next step adds +100 to land at +50 at flipStrike + 5.
// Linear interpolation between those points (t = 50/100 = 0.5) lands the
// crossing at exactly flipStrike.
//
// The outer padding strikes (−30, −20, +20, +30) carry small non-zero
// gamma on both sides so that cumulative-at-spot regime detection reads
// a meaningful value regardless of where spot sits in the range.
function symmetricProfile(flipStrike: number): StrikeGamma[] {
  return [
    { strike: flipStrike - 30, netGamma: -20 },
    { strike: flipStrike - 20, netGamma: -20 },
    { strike: flipStrike - 5, netGamma: -10 }, // cumulative -50 here
    { strike: flipStrike + 5, netGamma: 100 }, // cumulative +50 here
    { strike: flipStrike + 20, netGamma: 20 },
    { strike: flipStrike + 30, netGamma: 20 },
  ];
}

describe('computeZeroGammaStrike', () => {
  // ── Happy path: single clean crossing ───────────────────────

  it('finds a clean single crossing in a symmetric profile', () => {
    const strikes = symmetricProfile(6600);
    const result = computeZeroGammaStrike(strikes, 6600);
    expect(result).not.toBeNull();
    // The interpolated crossing lands exactly at 6600 (the midpoint
    // between the last negative and first positive strike).
    expect(result!).toBeCloseTo(6600, 0);
  });

  it('interpolates between strikes with sub-strike precision', () => {
    // Two strikes bracketing zero: cumulative = [-10, +30]
    //   crossing fraction t = 10 / 40 = 0.25
    //   interpolated = 6500 + 0.25 * (6505 - 6500) = 6501.25
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -10 },
      { strike: 6505, netGamma: 40 },
    ];
    const result = computeZeroGammaStrike(strikes, 6502);
    expect(result).toBeCloseTo(6501.25, 2);
  });

  it('handles an inverted-direction crossing (positive → negative)', () => {
    // Cumulative walks positive down to negative: [+20, +10, -10, -30]
    // Zero crossing between strike 6510 (cum +10) and 6515 (cum -10).
    // t = 10/20 = 0.5 → crossing at 6512.5
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: 20 },
      { strike: 6505, netGamma: -10 }, // cum = 10
      { strike: 6510, netGamma: 0 }, // cum = 10
      { strike: 6515, netGamma: -20 }, // cum = -10
      { strike: 6520, netGamma: -20 }, // cum = -30
    ];
    const result = computeZeroGammaStrike(strikes, 6512);
    expect(result).toBeCloseTo(6512.5, 2);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('returns null when the cumulative never crosses (all positive)', () => {
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: 100 },
      { strike: 6510, netGamma: 200 },
      { strike: 6520, netGamma: 150 },
    ];
    expect(computeZeroGammaStrike(strikes, 6510)).toBeNull();
  });

  it('returns null when the cumulative never crosses (all negative)', () => {
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -100 },
      { strike: 6510, netGamma: -200 },
      { strike: 6520, netGamma: -150 },
    ];
    expect(computeZeroGammaStrike(strikes, 6510)).toBeNull();
  });

  it('returns null for an empty strike array', () => {
    expect(computeZeroGammaStrike([], 6600)).toBeNull();
  });

  it('returns null for a single-strike array (cannot interpolate)', () => {
    expect(
      computeZeroGammaStrike([{ strike: 6600, netGamma: -50 }], 6600),
    ).toBeNull();
  });

  it('treats an exact zero at a strike as a crossing point', () => {
    // Cumulative hits exactly 0 at strike 6505, then goes positive.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -100 },
      { strike: 6505, netGamma: 100 }, // cum = 0
      { strike: 6510, netGamma: 100 }, // cum = 100
    ];
    const result = computeZeroGammaStrike(strikes, 6505);
    expect(result).toBe(6505);
  });

  it('does not double-count a crossing when cumulative hits zero exactly', () => {
    // Profile: cumulative = [−100, 0, 100]. Only one zero crossing
    // (at strike 6505), not two.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -100 },
      { strike: 6505, netGamma: 100 }, // cum = 0
      { strike: 6510, netGamma: 100 }, // cum = 100
    ];
    const analysis = analyzeZeroGamma(strikes, 6505, null);
    expect(analysis.crossingCount).toBe(1);
  });

  // ── Multiple crossings ──────────────────────────────────────

  it('returns the crossing closest to spot when multiple exist', () => {
    // Two crossings in the cumulative walk. Spot at 6600 should prefer
    // the nearby crossing, not the far one.
    const strikes: StrikeGamma[] = [
      // First crossing region (near 6502.5)
      { strike: 6500, netGamma: -50 }, // cum = -50
      { strike: 6505, netGamma: 100 }, // cum = +50   ← crossing between 6500 and 6505
      // Neutral middle
      { strike: 6550, netGamma: 0 }, // cum = +50
      // Second crossing region (near 6597.5)
      { strike: 6595, netGamma: -100 }, // cum = -50  ← crossing between 6550 and 6595
      { strike: 6600, netGamma: 50 }, // cum = 0      (this is also a crossing at 6600)
      { strike: 6605, netGamma: 50 }, // cum = +50
    ];
    const result = computeZeroGammaStrike(strikes, 6600);
    expect(result).not.toBeNull();
    // The closest crossing to spot=6600 should be the second region,
    // which lands around 6600 (exact zero at strike 6600 itself or very close).
    expect(Math.abs(result! - 6600)).toBeLessThan(5);
  });

  // ── Duplicate strikes (multi-expiry data) ───────────────────

  it('aggregates duplicate strikes before computing (defensive against multi-expiry rows)', () => {
    // Two rows per strike, simulating rows from 0DTE and 1DTE expiries.
    // After aggregation: { 6500: -60, 6505: +120 }.
    //   cumulative = [-60, +60]
    //   t = 60/120 = 0.5
    //   crossing = 6500 + 0.5 * 5 = 6502.5
    // If aggregation were skipped, the walk would see four separate rows
    // and the crossing would land elsewhere.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -40 },
      { strike: 6500, netGamma: -20 }, // → aggregated −60
      { strike: 6505, netGamma: 50 },
      { strike: 6505, netGamma: 70 }, // → aggregated +120
    ];
    const result = computeZeroGammaStrike(strikes, 6502);
    expect(result).toBeCloseTo(6502.5, 2);
  });

  it('works when rows arrive in an arbitrary (unsorted) order', () => {
    // Shuffled version of the symmetric-profile test. Must sort internally.
    const strikes: StrikeGamma[] = [
      { strike: 6605, netGamma: 100 },
      { strike: 6595, netGamma: -100 },
      { strike: 6600, netGamma: 100 }, // at flip
      { strike: 6590, netGamma: -100 },
      { strike: 6610, netGamma: 100 },
    ];
    const result = computeZeroGammaStrike(strikes, 6600);
    expect(result).not.toBeNull();
    expect(Math.abs(result! - 6600)).toBeLessThan(10);
  });
});

describe('analyzeZeroGamma', () => {
  // ── Integrated happy path ───────────────────────────────────

  it('returns flip strike, distance, cone fraction, and regime for a clean profile', () => {
    const strikes = symmetricProfile(6600);
    const result = analyzeZeroGamma(strikes, 6615, 30); // 30pt half-cone

    expect(result.zeroGammaStrike).toBeCloseTo(6600, 0);
    expect(result.distancePoints).toBeCloseTo(15, 0); // 6615 - 6600
    expect(result.distanceConeFraction).toBeCloseTo(0.5, 2); // 15 / 30
    expect(result.currentRegime).toBe('positive'); // spot above flip, positive-above profile
    expect(result.crossingCount).toBe(1);
  });

  it('reports negative regime when spot sits below the flip', () => {
    const strikes = symmetricProfile(6600);
    const result = analyzeZeroGamma(strikes, 6580, 30);

    expect(result.distancePoints).toBeCloseTo(-20, 0);
    expect(result.currentRegime).toBe('negative');
  });

  // ── Regime detection is independent of distance sign ──────

  it('reads regime from cumulative gamma at spot, not from sign of (spot - flipStrike)', () => {
    // Inverted profile: cumulative goes POSITIVE below flip and NEGATIVE above.
    // Spot above the flip should still read as NEGATIVE regime, because
    // cumulative-at-spot is negative.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: 100 }, // cum = 100  (positive regime below)
      { strike: 6505, netGamma: 100 }, // cum = 200
      { strike: 6600, netGamma: -300 }, // cum = -100 (crosses somewhere here)
      { strike: 6610, netGamma: -100 }, // cum = -200
    ];
    // Spot at 6605 is ABOVE the flip (which lands somewhere around 6533).
    // Naive sign(spot - flip) would say "positive regime" (spot above flip).
    // Correct: cumulative at 6605 = 100 + 100 + (-300) = -100 → NEGATIVE.
    const result = analyzeZeroGamma(strikes, 6605, null);
    expect(result.currentRegime).toBe('negative');
    expect(result.distancePoints).not.toBeNull();
    expect(result.distancePoints!).toBeGreaterThan(0); // spot IS above flip
  });

  // ── Cone fraction handling ──────────────────────────────────

  it('sets distanceConeFraction to null when straddleConeHalfWidth is null', () => {
    const strikes = symmetricProfile(6600);
    const result = analyzeZeroGamma(strikes, 6615, null);
    expect(result.distanceConeFraction).toBeNull();
    // Other fields still populated.
    expect(result.zeroGammaStrike).not.toBeNull();
    expect(result.distancePoints).not.toBeNull();
  });

  it('sets distanceConeFraction to null when cone half-width is 0', () => {
    const strikes = symmetricProfile(6600);
    const result = analyzeZeroGamma(strikes, 6615, 0);
    expect(result.distanceConeFraction).toBeNull();
  });

  it('sets distanceConeFraction to null when cone half-width is negative', () => {
    const strikes = symmetricProfile(6600);
    const result = analyzeZeroGamma(strikes, 6615, -10);
    expect(result.distanceConeFraction).toBeNull();
  });

  // ── No-crossing scenarios ──────────────────────────────────

  it('returns all-null position fields but a defined regime when no crossing exists', () => {
    // All-positive profile: cumulative is positive throughout.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: 100 },
      { strike: 6510, netGamma: 200 },
      { strike: 6520, netGamma: 150 },
    ];
    const result = analyzeZeroGamma(strikes, 6510, 30);
    expect(result.zeroGammaStrike).toBeNull();
    expect(result.distancePoints).toBeNull();
    expect(result.distanceConeFraction).toBeNull();
    expect(result.currentRegime).toBe('positive');
    expect(result.crossingCount).toBe(0);
  });

  it('returns negative regime when all cumulative is negative', () => {
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -100 },
      { strike: 6510, netGamma: -200 },
      { strike: 6520, netGamma: -150 },
    ];
    const result = analyzeZeroGamma(strikes, 6510, 30);
    expect(result.zeroGammaStrike).toBeNull();
    expect(result.currentRegime).toBe('negative');
    expect(result.crossingCount).toBe(0);
  });

  // ── Empty / sparse input ───────────────────────────────────

  it('returns unknown regime for empty input', () => {
    const result = analyzeZeroGamma([], 6600, 30);
    expect(result.zeroGammaStrike).toBeNull();
    expect(result.distancePoints).toBeNull();
    expect(result.distanceConeFraction).toBeNull();
    expect(result.currentRegime).toBe('unknown');
    expect(result.crossingCount).toBe(0);
  });

  it('returns unknown regime for single-strike input (insufficient to compute)', () => {
    const result = analyzeZeroGamma([{ strike: 6600, netGamma: 50 }], 6600, 30);
    expect(result.zeroGammaStrike).toBeNull();
    // With a single strike, regime detection still walks the input and
    // reads the cumulative sign — 50 > 0, so "positive".
    expect(result.currentRegime).toBe('positive');
  });

  // ── Multi-crossing flagging ────────────────────────────────

  it('reports the crossing count so the caller can flag distorted profiles', () => {
    // Three distinct crossings.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -50 }, // cum -50
      { strike: 6505, netGamma: 100 }, // cum +50  (crossing 1)
      { strike: 6510, netGamma: -100 }, // cum -50  (crossing 2)
      { strike: 6515, netGamma: 100 }, // cum +50  (crossing 3)
    ];
    const result = analyzeZeroGamma(strikes, 6512, 30);
    expect(result.crossingCount).toBe(3);
    expect(result.zeroGammaStrike).not.toBeNull();
  });

  // ── Regression: aggregates before walking ──────────────────

  it('aggregates duplicate strikes when computing cumulative and regime', () => {
    // Same strike twice — if we did not aggregate, the walk would see
    // two steps instead of one and the crossing would shift.
    const strikes: StrikeGamma[] = [
      { strike: 6500, netGamma: -50 },
      { strike: 6500, netGamma: -50 }, // aggregated: -100
      { strike: 6510, netGamma: 50 },
      { strike: 6510, netGamma: 50 }, // aggregated: +100
    ];
    const result = analyzeZeroGamma(strikes, 6505, 30);
    // Aggregated cumulative: 6500 → -100, 6510 → 0. Exact crossing at 6510.
    expect(result.zeroGammaStrike).toBe(6510);
    expect(result.crossingCount).toBe(1);
  });
});
