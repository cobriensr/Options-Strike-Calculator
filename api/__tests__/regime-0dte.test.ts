import { describe, it, expect } from 'vitest';
import { gexNear, gradeGate, REGIME_0DTE } from '../_lib/regime-0dte';

const strikes = [
  { strike: 7400, netGex: -0.2 },
  { strike: 7450, netGex: -0.1 },
  { strike: 7500, netGex: 0.05 },
  { strike: 7600, netGex: 0.3 },
  { strike: 7700, netGex: 0.4 }, // far OTM, outside +/-1% band, satisfies MIN_STRIKES
];

describe('gexNear', () => {
  it('sums net GEX within +/-1% of spot', () => {
    // spot 7450, band +/-74.5 -> strikes 7400,7450,7500 in band
    expect(gexNear(strikes, 7450)).toBeCloseTo(-0.25, 5);
  });

  it('returns null when the chain is too sparse (< MIN_STRIKES)', () => {
    expect(gexNear(strikes.slice(0, 3), 7450)).toBeNull();
  });
});

describe('gradeGate', () => {
  it('positive -> calm', () => expect(gradeGate(0.1)).toBe('calm'));
  it('mild negative -> big_move', () =>
    expect(gradeGate(-0.05)).toBe('big_move'));
  it('deep negative -> lean_down', () =>
    expect(gradeGate(REGIME_0DTE.GATE_DEEP_NEG - 0.01)).toBe('lean_down'));
  it('null -> unknown', () => expect(gradeGate(null)).toBe('unknown'));
});
