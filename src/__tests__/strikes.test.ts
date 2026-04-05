import { describe, expect, it } from 'vitest';

import {
  snapToIncrement,
  calcScaledSkew,
  calcScaledCallSkew,
  calcStrikes,
  isStrikeError,
  calcAllDeltas,
  spxToSpy,
} from '../utils/strikes';
import {
  DEFAULTS,
  DELTA_Z_SCORES,
  DELTA_OPTIONS,
  DEFAULT_SPX_SPY_RATIO,
} from '../constants';
import type { StrikeResult } from '../types';

// ── snapToIncrement ────────────────────────────────────────────

describe('snapToIncrement', () => {
  it('snaps to nearest 5-point increment by default', () => {
    expect(snapToIncrement(5802)).toBe(5800);
    expect(snapToIncrement(5803)).toBe(5805);
    expect(snapToIncrement(5797)).toBe(5795);
  });

  it('returns exact value when already on increment', () => {
    expect(snapToIncrement(5800)).toBe(5800);
    expect(snapToIncrement(5805)).toBe(5805);
  });

  it('rounds 0.5 up (banker rounding: Math.round)', () => {
    // 5802.5 / 5 = 1160.5, Math.round(1160.5) = 1161, 1161 * 5 = 5805
    // Note: JS Math.round rounds .5 up
    expect(snapToIncrement(5802.5)).toBe(5805);
  });

  it('works with custom increment of 1', () => {
    expect(snapToIncrement(5802.3, 1)).toBe(5802);
    expect(snapToIncrement(5802.7, 1)).toBe(5803);
  });

  it('works with custom increment of 10', () => {
    expect(snapToIncrement(5804, 10)).toBe(5800);
    expect(snapToIncrement(5806, 10)).toBe(5810);
  });

  it('handles negative values', () => {
    expect(snapToIncrement(-5802)).toBe(-5800);
    expect(snapToIncrement(-5803)).toBe(-5805);
  });

  it('snaps 0 to 0', () => {
    expect(snapToIncrement(0)).toBe(0);
  });
});

// ── calcScaledSkew (put skew) ──────────────────────────────────

describe('calcScaledSkew', () => {
  it('returns 0 when skew is 0', () => {
    expect(calcScaledSkew(0, 1.28)).toBe(0);
  });

  it('returns 0 when z is 0 or negative', () => {
    expect(calcScaledSkew(0.03, 0)).toBe(0);
    expect(calcScaledSkew(0.03, -1)).toBe(0);
  });

  it('returns 0 when z is NaN or Infinity', () => {
    expect(calcScaledSkew(0.03, NaN)).toBe(0);
    expect(calcScaledSkew(0.03, Infinity)).toBe(0);
  });

  it('returns the base skew at the reference z-score (10 delta)', () => {
    const skew = 0.03;
    const z = DEFAULTS.SKEW_REFERENCE_Z; // 1.28
    // ratio = 1.28 / 1.28 = 1.0, so result = 0.03 × 1.0^1.35 = 0.03
    expect(calcScaledSkew(skew, z)).toBeCloseTo(skew, 8);
  });

  it('returns higher skew for higher z (further OTM = convex increase)', () => {
    const skew = 0.03;
    const z10 = DELTA_Z_SCORES[10]; // 1.28
    const z5 = DELTA_Z_SCORES[5]; // 1.645
    expect(calcScaledSkew(skew, z5)).toBeGreaterThan(calcScaledSkew(skew, z10));
  });

  it('returns lower skew for lower z (closer to ATM)', () => {
    const skew = 0.03;
    const z20 = DELTA_Z_SCORES[20]; // 0.842
    const z10 = DELTA_Z_SCORES[10]; // 1.28
    expect(calcScaledSkew(skew, z20)).toBeLessThan(calcScaledSkew(skew, z10));
  });

  it('convexity means 5-delta skew > linear extrapolation', () => {
    const skew = 0.03;
    const z5 = DELTA_Z_SCORES[5];
    const linearScaled = skew * (z5 / DEFAULTS.SKEW_REFERENCE_Z);
    const convexScaled = calcScaledSkew(skew, z5);
    // Convexity > 1 means convex result > linear result
    expect(convexScaled).toBeGreaterThan(linearScaled);
  });
});

// ── calcScaledCallSkew ─────────────────────────────────────────

describe('calcScaledCallSkew', () => {
  it('returns 0 when skew is 0', () => {
    expect(calcScaledCallSkew(0, 1.28)).toBe(0);
  });

  it('returns 0 when z is 0 or negative', () => {
    expect(calcScaledCallSkew(0.03, 0)).toBe(0);
    expect(calcScaledCallSkew(0.03, -1)).toBe(0);
  });

  it('returns the base skew at the reference z-score', () => {
    const skew = 0.03;
    const z = DEFAULTS.SKEW_REFERENCE_Z;
    // At z_ref: ratio = 1, dampening = 1/(1+0.5*0) = 1, result = skew * 1 * 1
    expect(calcScaledCallSkew(skew, z)).toBeCloseTo(skew, 8);
  });

  it('call skew is dampened at high z-scores (further OTM)', () => {
    const skew = 0.03;
    const z5 = DELTA_Z_SCORES[5]; // 1.645
    const callSkew5 = calcScaledCallSkew(skew, z5);
    // Linear would be 0.03 * (1.645 / 1.28) = 0.0386
    // Dampened should be less than linear extrapolation
    const linearExtrapolation = skew * (z5 / DEFAULTS.SKEW_REFERENCE_Z);
    expect(callSkew5).toBeLessThan(linearExtrapolation);
  });

  it('call skew < put skew at the same z > z_ref (asymmetry)', () => {
    const skew = 0.03;
    const z5 = DELTA_Z_SCORES[5];
    const putSkew = calcScaledSkew(skew, z5);
    const callSkew = calcScaledCallSkew(skew, z5);
    expect(callSkew).toBeLessThan(putSkew);
  });
});

// ── calcStrikes ────────────────────────────────────────────────

describe('calcStrikes', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns an error for an invalid delta', () => {
    // @ts-expect-error — Testing invalid delta
    const result = calcStrikes(spot, sigma, T, 99);
    expect(isStrikeError(result)).toBe(true);
    if (isStrikeError(result)) {
      expect(result.error).toContain('No z-score');
    }
  });

  it('returns valid strikes for all standard deltas', () => {
    for (const d of DELTA_OPTIONS) {
      const result = calcStrikes(spot, sigma, T, d);
      expect(isStrikeError(result)).toBe(false);
      if (!isStrikeError(result)) {
        expect(result.putStrike).toBeLessThan(spot);
        expect(result.callStrike).toBeGreaterThan(spot);
      }
    }
  });

  it('put strike < spot < call strike', () => {
    const result = calcStrikes(spot, sigma, T, 10) as StrikeResult;
    expect(result.putStrike).toBeLessThan(spot);
    expect(result.callStrike).toBeGreaterThan(spot);
  });

  it('snapped strikes are multiples of STRIKE_INCREMENT', () => {
    const result = calcStrikes(spot, sigma, T, 10) as StrikeResult;
    expect(result.putStrikeSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
    expect(result.callStrikeSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
  });

  it('higher delta = strikes closer to spot', () => {
    const r10 = calcStrikes(spot, sigma, T, 10) as StrikeResult;
    const r20 = calcStrikes(spot, sigma, T, 20) as StrikeResult;
    // 20 delta = higher probability = closer to ATM
    expect(r20.putStrike).toBeGreaterThan(r10.putStrike);
    expect(r20.callStrike).toBeLessThan(r10.callStrike);
  });

  it('lower delta = strikes further from spot', () => {
    const r5 = calcStrikes(spot, sigma, T, 5) as StrikeResult;
    const r10 = calcStrikes(spot, sigma, T, 10) as StrikeResult;
    expect(r5.putStrike).toBeLessThan(r10.putStrike);
    expect(r5.callStrike).toBeGreaterThan(r10.callStrike);
  });

  it('higher sigma = wider strikes', () => {
    const rLow = calcStrikes(spot, 0.1, T, 10) as StrikeResult;
    const rHigh = calcStrikes(spot, 0.2, T, 10) as StrikeResult;
    expect(rHigh.putStrike).toBeLessThan(rLow.putStrike);
    expect(rHigh.callStrike).toBeGreaterThan(rLow.callStrike);
  });

  it('skew makes puts further OTM and calls closer (put sigma increases)', () => {
    const noSkew = calcStrikes(spot, sigma, T, 10, 0) as StrikeResult;
    const withSkew = calcStrikes(spot, sigma, T, 10, 0.05) as StrikeResult;
    // Put skew increases put sigma, so put strike moves further OTM
    expect(withSkew.putStrike).toBeLessThan(noSkew.putStrike);
    // Call skew reduces call sigma, so call strike moves closer to spot
    expect(withSkew.callStrike).toBeLessThan(noSkew.callStrike);
  });
});

// ── isStrikeError ──────────────────────────────────────────────

describe('isStrikeError', () => {
  it('returns true for objects with an error property', () => {
    expect(isStrikeError({ error: 'test' })).toBe(true);
  });

  it('returns false for valid StrikeResult objects', () => {
    const result: StrikeResult = {
      putStrike: 5750,
      callStrike: 5850,
      putStrikeSnapped: 5750,
      callStrikeSnapped: 5850,
    };
    expect(isStrikeError(result)).toBe(false);
  });
});

// ── calcAllDeltas ──────────────────────────────────────────────

describe('calcAllDeltas', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns a row for every DELTA_OPTIONS entry', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    expect(rows).toHaveLength(DELTA_OPTIONS.length);
  });

  it('each row has the correct delta value', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.delta).toBe(DELTA_OPTIONS[i]);
    }
  });

  it('valid rows have non-error properties', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    for (const row of rows) {
      if ('error' in row) continue;
      expect(row.putStrike).toBeLessThan(spot);
      expect(row.callStrike).toBeGreaterThan(spot);
      expect(row.putPremium).toBeGreaterThanOrEqual(0);
      expect(row.callPremium).toBeGreaterThanOrEqual(0);
      expect(row.putActualDelta).toBeGreaterThanOrEqual(0);
      expect(row.putActualDelta).toBeLessThanOrEqual(1);
      expect(row.callActualDelta).toBeGreaterThanOrEqual(0);
      expect(row.callActualDelta).toBeLessThanOrEqual(1);
      expect(row.putGamma).toBeGreaterThan(0);
      expect(row.callGamma).toBeGreaterThan(0);
      expect(row.putTheta).toBeLessThan(0);
      expect(row.callTheta).toBeLessThan(0);
    }
  });

  it('snapped strikes are multiples of STRIKE_INCREMENT', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    for (const row of rows) {
      if ('error' in row) continue;
      expect(row.putSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
      expect(row.callSnapped % DEFAULTS.STRIKE_INCREMENT).toBe(0);
    }
  });

  it('distances and percentages are consistent', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    for (const row of rows) {
      if ('error' in row) continue;
      expect(row.putDistance).toBeCloseTo(spot - row.putStrike, 2);
      expect(row.callDistance).toBeCloseTo(row.callStrike - spot, 2);
      const expectedPutPct = ((spot - row.putStrike) / spot) * 100;
      expect(Number(row.putPct)).toBeCloseTo(expectedPutPct, 1);
    }
  });

  it('IV acceleration multiplier is consistent', () => {
    const rows = calcAllDeltas(spot, sigma, T);
    for (const row of rows) {
      if ('error' in row) continue;
      expect(row.ivAccelMult).toBeGreaterThanOrEqual(1);
      expect(row.ivAccelMult).toBeLessThanOrEqual(DEFAULTS.IV_ACCEL_MAX);
    }
  });
});

// ── spxToSpy ───────────────────────────────────────────────────

describe('spxToSpy', () => {
  it('divides by the SPX/SPY ratio', () => {
    expect(spxToSpy(5800)).toBe((5800 / DEFAULT_SPX_SPY_RATIO).toFixed(2));
  });

  it('returns a string with 2 decimal places', () => {
    const result = spxToSpy(5801);
    expect(result).toMatch(/^\d+\.\d{2}$/);
  });

  it('handles round numbers', () => {
    expect(spxToSpy(5800)).toBe('580.00');
  });
});
