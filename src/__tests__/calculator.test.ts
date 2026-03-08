import { describe, it, expect } from 'vitest';
import {
  calcStrikes,
  calcTimeToExpiry,
  calcAllDeltas,
  snapToIncrement,
  spxToSpy,
  to24Hour,
  isStrikeError,
} from '../calculator';
import { DELTA_OPTIONS, MARKET } from '../constants';
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
    { label: 'medium IV (σ=0.20)', sigma: 0.20 },
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
  const sigma = 0.20;

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
    const rows = calcAllDeltas(5800, 0.20, T);
    expect(rows).toHaveLength(6);
  });

  it('rows are ordered by delta ascending', () => {
    const T = calcTimeToExpiry(3);
    const rows = calcAllDeltas(5800, 0.20, T);
    const deltas = rows.map((r) => r.delta);
    expect(deltas).toEqual([5, 8, 10, 12, 15, 20]);
  });

  it('SPY values are SPX / 10', () => {
    const T = calcTimeToExpiry(3);
    const rows = calcAllDeltas(5800, 0.20, T);
    for (const row of rows) {
      if ('spyPut' in row) {
        expect(parseFloat(row.spyPut)).toBeCloseTo(row.putStrike / 10, 1);
        expect(parseFloat(row.spyCall)).toBeCloseTo(row.callStrike / 10, 1);
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

describe('calcTimeToExpiry', () => {
  it('full day (6.5h) gives T ≈ 0.003968', () => {
    expect(calcTimeToExpiry(6.5)).toBeCloseTo(6.5 / MARKET.ANNUAL_TRADING_HOURS, 6);
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
