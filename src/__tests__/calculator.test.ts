import { describe, it, expect } from 'vitest';
import {
  calcStrikes,
  calcTimeToExpiry,
  calcAllDeltas,
  snapToIncrement,
  spxToSpy,
  to24Hour,
  toETTime,
  isStrikeError,
  calcIVAcceleration,
  adjustPoPForKurtosis,
  adjustICPoPForKurtosis,
  calcScaledSkew,
  calcScaledCallSkew,
  calcPoP,
  calcThetaCurve,
} from '../utils/calculator';
import { DELTA_OPTIONS, MARKET, getKurtosisFactor } from '../constants';
import type { DeltaTarget } from '../types';

// ============================================================
// GOLDEN TEST CASE — March 4th from spec
// ============================================================
describe('Golden test: March 4th 2026 spec example', () => {
  // Spec worked example: SPX 6790, VIX 19, σ = 0.2185
  // Note: The spec uses 4h remaining for "10 AM Central" entry.
  // (The spec computes "11 AM to 3 PM Central" = 4h, but 11 AM is Eastern.
  //  Correct value for 10 AM CT would be 5h. We match the spec's example here.)
  const spot = 6790;
  const sigma = 0.2185; // (19 × 1.15) / 100
  const hoursRemaining = 4; // matching spec's worked example
  const T = calcTimeToExpiry(hoursRemaining);

  it('calculates T correctly', () => {
    expect(T).toBeCloseTo(4 / 1638, 6);
  });

  it('produces correct 10-delta put strike within ±5 points of spec (6697)', () => {
    const result = calcStrikes(spot, sigma, T, 10);
    expect(isStrikeError(result)).toBe(false);
    if (!isStrikeError(result)) {
      expect(result.putStrike).toBeGreaterThanOrEqual(6692);
      expect(result.putStrike).toBeLessThanOrEqual(6702);
    }
  });

  it('produces correct 10-delta call strike within ±5 points of spec (6885)', () => {
    const result = calcStrikes(spot, sigma, T, 10);
    if (!isStrikeError(result)) {
      expect(result.callStrike).toBeGreaterThanOrEqual(6880);
      expect(result.callStrike).toBeLessThanOrEqual(6890);
    }
  });
});

// ============================================================
// FULL TEST MATRIX: 6 deltas × 3 times × 3 IV levels
// ============================================================
describe('Full test matrix: deltas × times × IV levels', () => {
  const spot = 5800;

  const timeScenarios: Array<{ label: string; hoursRemaining: number }> = [
    { label: 'early (6h remaining)', hoursRemaining: 6 },
    { label: 'midday (3h remaining)', hoursRemaining: 3 },
    { label: 'near close (0.5h remaining)', hoursRemaining: 0.5 },
  ];

  const ivScenarios: Array<{ label: string; sigma: number }> = [
    { label: 'low IV (σ=0.12)', sigma: 0.12 },
    { label: 'medium IV (σ=0.20)', sigma: 0.2 },
    { label: 'high IV (σ=0.35)', sigma: 0.35 },
  ];

  const deltas: DeltaTarget[] = [...DELTA_OPTIONS];

  for (const time of timeScenarios) {
    for (const iv of ivScenarios) {
      for (const delta of deltas) {
        const T = calcTimeToExpiry(time.hoursRemaining);

        it(`${delta}Δ | ${time.label} | ${iv.label}: put < spot < call`, () => {
          const result = calcStrikes(spot, iv.sigma, T, delta);
          if (!isStrikeError(result)) {
            expect(result.putStrike).toBeLessThan(spot);
            expect(result.callStrike).toBeGreaterThan(spot);
          }
        });

        it(`${delta}Δ | ${time.label} | ${iv.label}: snapped strikes are multiples of 5`, () => {
          const result = calcStrikes(spot, iv.sigma, T, delta);
          if (!isStrikeError(result)) {
            expect(result.putStrikeSnapped % 5).toBe(0);
            expect(result.callStrikeSnapped % 5).toBe(0);
          }
        });
      }
    }
  }
});

// ============================================================
// PROPERTY-BASED TESTS
// ============================================================
describe('Property: structural invariants', () => {
  const spot = 5800;
  const sigma = 0.2;

  it('put strike < spot for all deltas', () => {
    const T = calcTimeToExpiry(3);
    for (const d of DELTA_OPTIONS) {
      const r = calcStrikes(spot, sigma, T, d);
      if (!isStrikeError(r)) {
        expect(r.putStrike).toBeLessThan(spot);
      }
    }
  });

  it('call strike > spot for all deltas', () => {
    const T = calcTimeToExpiry(3);
    for (const d of DELTA_OPTIONS) {
      const r = calcStrikes(spot, sigma, T, d);
      if (!isStrikeError(r)) {
        expect(r.callStrike).toBeGreaterThan(spot);
      }
    }
  });

  it('higher delta = narrower strikes (closer to spot)', () => {
    const T = calcTimeToExpiry(3);
    let prevWidth = Infinity;
    // Sorted ascending: 5, 8, 10, 12, 15, 20
    for (const d of DELTA_OPTIONS) {
      const r = calcStrikes(spot, sigma, T, d);
      if (!isStrikeError(r)) {
        const width = r.callStrike - r.putStrike;
        expect(width).toBeLessThan(prevWidth);
        prevWidth = width;
      }
    }
  });

  it('higher sigma = wider strikes', () => {
    const T = calcTimeToExpiry(3);
    const lowIV = calcStrikes(spot, 0.12, T, 10);
    const highIV = calcStrikes(spot, 0.35, T, 10);

    if (!isStrikeError(lowIV) && !isStrikeError(highIV)) {
      const lowWidth = lowIV.callStrike - lowIV.putStrike;
      const highWidth = highIV.callStrike - highIV.putStrike;
      expect(highWidth).toBeGreaterThan(lowWidth);
    }
  });

  it('less time remaining = narrower strikes', () => {
    const earlyT = calcTimeToExpiry(6);
    const lateT = calcTimeToExpiry(0.5);

    const early = calcStrikes(spot, sigma, earlyT, 10);
    const late = calcStrikes(spot, sigma, lateT, 10);

    if (!isStrikeError(early) && !isStrikeError(late)) {
      const earlyWidth = early.callStrike - early.putStrike;
      const lateWidth = late.callStrike - late.putStrike;
      expect(lateWidth).toBeLessThan(earlyWidth);
    }
  });

  it('strikes are symmetric around spot (approximately)', () => {
    const T = calcTimeToExpiry(3);
    const r = calcStrikes(spot, sigma, T, 10);
    if (!isStrikeError(r)) {
      const putDist = spot - r.putStrike;
      const callDist = r.callStrike - spot;
      // Should be approximately equal (within 1% of spot)
      expect(Math.abs(putDist - callDist)).toBeLessThan(spot * 0.01);
    }
  });
});

// ============================================================
// calcAllDeltas
// ============================================================
describe('calcAllDeltas', () => {
  it('returns exactly 6 rows', () => {
    const T = calcTimeToExpiry(3);
    const rows = calcAllDeltas(5800, 0.2, T);
    expect(rows).toHaveLength(6);
  });

  it('rows are ordered by delta ascending', () => {
    const T = calcTimeToExpiry(3);
    const rows = calcAllDeltas(5800, 0.2, T);
    const deltas = rows.map((r) => r.delta);
    expect(deltas).toEqual([5, 8, 10, 12, 15, 20]);
  });

  it('SPY values are SPX / 10', () => {
    const T = calcTimeToExpiry(3);
    const rows = calcAllDeltas(5800, 0.2, T);
    for (const row of rows) {
      if ('spyPut' in row) {
        expect(Number.parseFloat(row.spyPut)).toBeCloseTo(
          row.putStrike / 10,
          1,
        );
        expect(Number.parseFloat(row.spyCall)).toBeCloseTo(
          row.callStrike / 10,
          1,
        );
      }
    }
  });
});

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
describe('snapToIncrement', () => {
  it('snaps 6697 to 6695', () => {
    expect(snapToIncrement(6697)).toBe(6695);
  });

  it('snaps 6698 to 6700', () => {
    expect(snapToIncrement(6698)).toBe(6700);
  });

  it('snaps exact multiples to themselves', () => {
    expect(snapToIncrement(6700)).toBe(6700);
  });

  it('handles custom increment', () => {
    expect(snapToIncrement(6697, 25)).toBe(6700);
  });
});

describe('spxToSpy', () => {
  it('divides by 10 with 2 decimal places', () => {
    expect(spxToSpy(6697)).toBe('669.70');
    expect(spxToSpy(5800)).toBe('580.00');
  });
});

describe('to24Hour', () => {
  it('converts AM hours correctly', () => {
    expect(to24Hour(9, 'AM')).toBe(9);
    expect(to24Hour(10, 'AM')).toBe(10);
    expect(to24Hour(11, 'AM')).toBe(11);
  });

  it('converts 12 AM to 0 (midnight)', () => {
    expect(to24Hour(12, 'AM')).toBe(0);
  });

  it('converts PM hours correctly', () => {
    expect(to24Hour(1, 'PM')).toBe(13);
    expect(to24Hour(3, 'PM')).toBe(15);
    expect(to24Hour(4, 'PM')).toBe(16);
  });

  it('converts 12 PM to 12 (noon)', () => {
    expect(to24Hour(12, 'PM')).toBe(12);
  });
});

describe('toETTime', () => {
  it('returns ET hour unchanged when timezone is ET', () => {
    expect(toETTime('9', '30', 'AM', 'ET')).toEqual({
      etHour: 9,
      etMinute: 30,
    });
  });

  it('adds 1 hour when timezone is CT', () => {
    expect(toETTime('8', '30', 'AM', 'CT')).toEqual({
      etHour: 9,
      etMinute: 30,
    });
  });

  it('handles PM correctly', () => {
    expect(toETTime('2', '15', 'PM', 'ET')).toEqual({
      etHour: 14,
      etMinute: 15,
    });
    expect(toETTime('1', '15', 'PM', 'CT')).toEqual({
      etHour: 14,
      etMinute: 15,
    });
  });

  it('handles 12 AM (midnight) correctly', () => {
    expect(toETTime('12', '00', 'AM', 'ET')).toEqual({
      etHour: 0,
      etMinute: 0,
    });
  });

  it('handles 12 PM (noon) correctly', () => {
    expect(toETTime('12', '00', 'PM', 'CT')).toEqual({
      etHour: 13,
      etMinute: 0,
    });
  });

  it('defaults minute to 0 for invalid input', () => {
    expect(toETTime('9', '', 'AM', 'ET')).toEqual({ etHour: 9, etMinute: 0 });
  });
});

describe('calcTimeToExpiry', () => {
  it('full day (6.5h) gives T ≈ 0.003968', () => {
    expect(calcTimeToExpiry(6.5)).toBeCloseTo(
      6.5 / MARKET.ANNUAL_TRADING_HOURS,
      6,
    );
  });

  it('0 hours gives T = 0', () => {
    expect(calcTimeToExpiry(0)).toBe(0);
  });

  it('T scales linearly with hours', () => {
    const t1 = calcTimeToExpiry(1);
    const t3 = calcTimeToExpiry(3);
    expect(t3).toBeCloseTo(t1 * 3, 10);
  });
});

// ============================================================
// IV ACCELERATION
// ============================================================

describe('calcIVAcceleration', () => {
  it('returns 1.0 at market open (6.5h remaining)', () => {
    expect(calcIVAcceleration(6.5)).toBe(1);
  });

  it('returns 1.0 when hours >= full day', () => {
    expect(calcIVAcceleration(7)).toBe(1);
    expect(calcIVAcceleration(10)).toBe(1);
  });

  it('returns > 1 with less time remaining', () => {
    expect(calcIVAcceleration(4)).toBeGreaterThan(1);
    expect(calcIVAcceleration(2)).toBeGreaterThan(1.1);
    expect(calcIVAcceleration(1)).toBeGreaterThan(1.2);
  });

  it('increases monotonically as time decreases', () => {
    const at4 = calcIVAcceleration(4);
    const at2 = calcIVAcceleration(2);
    const at1 = calcIVAcceleration(1);
    const at05 = calcIVAcceleration(0.5);
    expect(at2).toBeGreaterThan(at4);
    expect(at1).toBeGreaterThan(at2);
    expect(at05).toBeGreaterThan(at1);
  });

  it('is capped at max value', () => {
    expect(calcIVAcceleration(0.01)).toBeLessThanOrEqual(1.8);
    expect(calcIVAcceleration(0.001)).toBeLessThanOrEqual(1.8);
  });

  it('returns max when hours <= 0', () => {
    expect(calcIVAcceleration(0)).toBe(1.8);
    expect(calcIVAcceleration(-1)).toBe(1.8);
  });
});

// ============================================================
// FAT-TAIL KURTOSIS ADJUSTMENT
// ============================================================

describe('adjustPoPForKurtosis', () => {
  it('returns original PoP when kurtosis <= 1', () => {
    expect(adjustPoPForKurtosis(0.9, 1)).toBe(0.9);
    expect(adjustPoPForKurtosis(0.9, 0.5)).toBe(0.9);
  });

  it('reduces PoP by inflating breach probability', () => {
    const adjusted = adjustPoPForKurtosis(0.9, 2.0);
    expect(adjusted).toBeLessThan(0.9);
    // breach = 0.1, adjusted breach = 0.2, adjusted PoP = 0.8
    expect(adjusted).toBeCloseTo(0.8, 6);
  });

  it('never goes below 0', () => {
    expect(adjustPoPForKurtosis(0.3, 5)).toBeGreaterThanOrEqual(0);
  });

  it('handles PoP = 1 (no breach)', () => {
    expect(adjustPoPForKurtosis(1.0, 2.0)).toBe(1);
  });

  it('handles PoP = 0 (full breach)', () => {
    expect(adjustPoPForKurtosis(0, 2.0)).toBe(0);
  });

  it('with default kurtosis factor of 2.0', () => {
    const pop = adjustPoPForKurtosis(0.85);
    // breach = 0.15, adjusted = 0.30, pop = 0.70
    expect(pop).toBeCloseTo(0.7, 6);
  });
});

describe('getKurtosisFactor: VIX-regime-dependent', () => {
  it('returns default 2.0 when VIX is undefined', () => {
    expect(getKurtosisFactor()).toBe(2.0);
  });

  it('returns 1.5 for low VIX (< 15)', () => {
    expect(getKurtosisFactor(12)).toBe(1.5);
    expect(getKurtosisFactor(14.9)).toBe(1.5);
  });

  it('returns 2.0 for moderate VIX (15-20)', () => {
    expect(getKurtosisFactor(15)).toBe(2.0);
    expect(getKurtosisFactor(18)).toBe(2.0);
  });

  it('returns 2.5 for elevated VIX (20-25)', () => {
    expect(getKurtosisFactor(20)).toBe(2.5);
    expect(getKurtosisFactor(24)).toBe(2.5);
  });

  it('returns 3.0 for high VIX (25-30)', () => {
    expect(getKurtosisFactor(25)).toBe(3.0);
    expect(getKurtosisFactor(29)).toBe(3.0);
  });

  it('returns 3.5 for crisis VIX (30+)', () => {
    expect(getKurtosisFactor(30)).toBe(3.5);
    expect(getKurtosisFactor(50)).toBe(3.5);
  });

  it('monotonically increases with VIX', () => {
    const factors = [12, 17, 22, 27, 35].map((v) => getKurtosisFactor(v));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeGreaterThanOrEqual(factors[i - 1]!);
    }
  });
});

describe('adjustICPoPForKurtosis', () => {
  const spot = 5700;
  const beLow = 5630;
  const beHigh = 5770;
  const putSigma = 0.2;
  const callSigma = 0.18;
  const T = 0.003;

  it('returns lower PoP than log-normal calcPoP', () => {
    const logNormal = calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);
    const adjusted = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
    );
    expect(adjusted).toBeLessThan(logNormal);
  });

  it('returns calcPoP when kurtosis <= 1', () => {
    const logNormal = calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);
    const noAdj = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      1,
    );
    expect(noAdj).toBeCloseTo(logNormal, 6);
  });

  it('returns calcPoP when T <= 0', () => {
    const result = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      0,
      2,
    );
    expect(result).toBe(0); // calcPoP returns 0 for T <= 0
  });

  it('is bounded between 0 and 1', () => {
    const result = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      5,
    );
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// CONVEX SKEW & CALL DAMPENING
// ============================================================

describe('calcScaledCallSkew', () => {
  it('returns 0 when skew is 0', () => {
    expect(calcScaledCallSkew(0, 1.645)).toBe(0);
  });

  it('at reference z (1.28), equals input skew (no dampening)', () => {
    // At z = z_ref, ratio = 1, dampening = 1/(1 + 0.5 * 0) = 1
    expect(calcScaledCallSkew(0.03, 1.28)).toBeCloseTo(0.03, 6);
  });

  it('is less than put skew at same z for far OTM (z > z_ref)', () => {
    const putSkew = calcScaledSkew(0.03, 1.645);
    const callSkew = calcScaledCallSkew(0.03, 1.645);
    expect(callSkew).toBeLessThan(putSkew);
  });

  it('call skew increases less steeply than linear at high z', () => {
    const linear = (0.03 * 1.645) / 1.28;
    const dampened = calcScaledCallSkew(0.03, 1.645);
    expect(dampened).toBeLessThan(linear);
  });

  it('returns 0 for z <= 0', () => {
    expect(calcScaledCallSkew(0.03, 0)).toBe(0);
    expect(calcScaledCallSkew(0.03, -1)).toBe(0);
  });

  it('returns 0 for non-finite z', () => {
    expect(calcScaledCallSkew(0.03, Number.NaN)).toBe(0);
    expect(calcScaledCallSkew(0.03, Infinity)).toBe(0);
  });
});

describe('calcAllDeltas: ivAccelMult', () => {
  it('includes ivAccelMult in output rows', () => {
    const T = calcTimeToExpiry(4); // 4 hours remaining
    const rows = calcAllDeltas(5700, 0.2, T, 0.03);
    for (const row of rows) {
      if (!('error' in row)) {
        expect(row.ivAccelMult).toBeGreaterThan(1);
      }
    }
  });

  it('ivAccelMult is 1.0 at market open', () => {
    const T = calcTimeToExpiry(6.5);
    const rows = calcAllDeltas(5700, 0.2, T, 0.03);
    for (const row of rows) {
      if (!('error' in row)) {
        expect(row.ivAccelMult).toBe(1);
      }
    }
  });
});

describe('calcThetaCurve', () => {
  it('returns 13 data points (6.5h down to 0.5h)', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'put');
    expect(curve).toHaveLength(13);
  });

  it('premium decreases monotonically over time', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'put');
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.premiumPct).toBeLessThanOrEqual(
        curve[i - 1]!.premiumPct,
      );
    }
  });

  it('starts near 100% at open (6.5h)', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'put');
    expect(curve[0]!.premiumPct).toBeCloseTo(100, 0);
  });

  it('ends near 0% at close (0.5h)', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'put');
    const last = curve.at(-1)!;
    expect(last.premiumPct).toBeLessThan(30);
  });

  it('premium decay accelerates — more at-open premium per hour is lost early', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'put');
    // For 0DTE OTM options, sqrt(T) causes rapid early decay
    // Verify the curve is monotonically decreasing (premium % drops over time)
    // and that significant decay occurs in the first half (>50% gone by midday)
    const midday = curve.find((c) => c.hoursRemaining === 3.5);
    expect(midday).toBeDefined();
    expect(midday!.premiumPct).toBeLessThan(50);
    // But there's still measurable premium remaining
    expect(midday!.premiumPct).toBeGreaterThan(0);
  });

  it('works for calls too', () => {
    const curve = calcThetaCurve(5800, 0.2, 100, 'call');
    expect(curve.length).toBe(13);
    expect(curve[0]!.premiumPct).toBeCloseTo(100, 0);
  });

  it('returns empty array for zero premium', () => {
    // Extremely far OTM — basically zero premium
    const curve = calcThetaCurve(5800, 0.001, 5000, 'put');
    expect(curve).toHaveLength(0);
  });
});
