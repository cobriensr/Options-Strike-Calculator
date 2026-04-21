import { describe, it, expect } from 'vitest';
import {
  computeMaxPain,
  type MaxPainStrikeInput,
} from '../../utils/max-pain';

describe('computeMaxPain', () => {
  it('returns null for empty input', () => {
    expect(computeMaxPain([])).toBeNull();
  });

  it('returns the strike when given a single strike with non-zero OI', () => {
    // Single strike — only one candidate, payout is zero by construction,
    // but the data is informative (non-zero OI present). Return the strike.
    const strikes: MaxPainStrikeInput[] = [
      { strike: 5800, callOi: 1000, putOi: 500 },
    ];
    expect(computeMaxPain(strikes)).toBe(5800);
  });

  it('returns the center strike for a symmetric distribution', () => {
    // Symmetric equal call/put OI on either side of 5800 → max-pain at center.
    const strikes: MaxPainStrikeInput[] = [
      { strike: 5790, callOi: 100, putOi: 100 },
      { strike: 5800, callOi: 100, putOi: 100 },
      { strike: 5810, callOi: 100, putOi: 100 },
    ];
    expect(computeMaxPain(strikes)).toBe(5800);
  });

  it('computes a known 3-strike case by hand', () => {
    // Strikes 100/110/120 with call OI heavy at 100 and put OI heavy at 120.
    // Hand calc at each candidate S:
    //   S=100: callOi*max(0,100-k) + putOi*max(0,k-100)
    //     k=100: 10*0  + 50*0  = 0
    //     k=110: 20*0  + 60*10 = 600
    //     k=120: 30*0  + 70*20 = 1400
    //     total = 2000
    //   S=110:
    //     k=100: 10*10 + 50*0  = 100
    //     k=110: 20*0  + 60*0  = 0
    //     k=120: 30*0  + 70*10 = 700
    //     total = 800
    //   S=120:
    //     k=100: 10*20 + 50*0  = 200
    //     k=110: 20*10 + 60*0  = 200
    //     k=120: 30*0  + 70*0  = 0
    //     total = 400
    // Min payout = 400 at S=120.
    const strikes: MaxPainStrikeInput[] = [
      { strike: 100, callOi: 10, putOi: 50 },
      { strike: 110, callOi: 20, putOi: 60 },
      { strike: 120, callOi: 30, putOi: 70 },
    ];
    expect(computeMaxPain(strikes)).toBe(120);
  });

  it('returns null when all OI is zero (uninformative)', () => {
    const strikes: MaxPainStrikeInput[] = [
      { strike: 5790, callOi: 0, putOi: 0 },
      { strike: 5800, callOi: 0, putOi: 0 },
      { strike: 5810, callOi: 0, putOi: 0 },
    ];
    expect(computeMaxPain(strikes)).toBeNull();
  });

  it('picks the lowest-payout strike with skewed OI', () => {
    // Heavy put OI above → dealers lose most if settlement is high.
    // Expect max-pain at the lowest strike in this skewed fixture.
    const strikes: MaxPainStrikeInput[] = [
      { strike: 5790, callOi: 10, putOi: 10 },
      { strike: 5800, callOi: 10, putOi: 10 },
      { strike: 5810, callOi: 10, putOi: 10_000 },
    ];
    expect(computeMaxPain(strikes)).toBe(5810);
  });
});
