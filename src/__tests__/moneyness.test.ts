import { describe, expect, it } from 'vitest';
import {
  isOtm,
  signedOtmPct,
  usableSpot,
  type MoneynessOptionType,
} from '../utils/moneyness';

describe('usableSpot', () => {
  it('returns the same value for a positive finite spot', () => {
    expect(usableSpot(100)).toBe(100);
    expect(usableSpot(0.5)).toBe(0.5);
    expect(usableSpot(6000.25)).toBe(6000.25);
  });

  it('returns null for null', () => {
    expect(usableSpot(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(usableSpot(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(usableSpot(Number.NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(usableSpot(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableSpot(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(usableSpot(0)).toBeNull();
  });

  it('returns null for a negative spot', () => {
    expect(usableSpot(-100)).toBeNull();
  });
});

describe('isOtm', () => {
  it('call strike > spot is OTM', () => {
    expect(isOtm('C', 110, 100)).toBe(true);
  });

  it('call strike < spot is not OTM', () => {
    expect(isOtm('C', 90, 100)).toBe(false);
  });

  it('call ATM (strike === spot) counts as OTM', () => {
    expect(isOtm('C', 100, 100)).toBe(true);
  });

  it('put strike < spot is OTM', () => {
    expect(isOtm('P', 90, 100)).toBe(true);
  });

  it('put strike > spot is not OTM', () => {
    expect(isOtm('P', 110, 100)).toBe(false);
  });

  it('put ATM (strike === spot) counts as OTM', () => {
    expect(isOtm('P', 100, 100)).toBe(true);
  });
});

describe('signedOtmPct', () => {
  it('call OTM is positive', () => {
    expect(signedOtmPct('C', 110, 100)).toBeCloseTo(0.1, 10);
  });

  it('call ITM is negative', () => {
    expect(signedOtmPct('C', 90, 100)).toBeCloseTo(-0.1, 10);
  });

  it('call ATM is exactly 0', () => {
    // Numerically zero (could be +0); add 0 to normalize -0 → +0 before toBe.
    expect((signedOtmPct('C', 100, 100) as number) + 0).toBe(0);
  });

  it('put OTM is positive', () => {
    expect(signedOtmPct('P', 90, 100)).toBeCloseTo(0.1, 10);
  });

  it('put ITM is negative', () => {
    expect(signedOtmPct('P', 110, 100)).toBeCloseTo(-0.1, 10);
  });

  it('put ATM is exactly 0', () => {
    // Put ATM produces -0 (negated 0); add 0 to normalize -0 → +0 before toBe.
    expect((signedOtmPct('P', 100, 100) as number) + 0).toBe(0);
  });

  it('returns null for an unusable null spot', () => {
    expect(signedOtmPct('C', 100, null)).toBeNull();
  });

  it('returns null for an unusable zero spot', () => {
    expect(signedOtmPct('C', 100, 0)).toBeNull();
  });

  it('returns null for an unusable NaN spot', () => {
    expect(signedOtmPct('C', 100, Number.NaN)).toBeNull();
  });

  it('returns null for an unusable undefined spot', () => {
    expect(signedOtmPct('P', 100, undefined)).toBeNull();
  });
});

describe('INVARIANT: (signedOtmPct >= 0) === isOtm for any usable spot', () => {
  const optionTypes: MoneynessOptionType[] = ['C', 'P'];
  // Usable spots that straddle and equal the strikes below.
  const spots = [50, 99, 100, 101, 150, 6000.25];
  // Strikes that straddle/equal the spots, including exact-ATM matches.
  const strikes = [50, 90, 99, 100, 101, 110, 150, 6000.25];

  for (const optionType of optionTypes) {
    for (const spot of spots) {
      for (const strike of strikes) {
        it(`${optionType} strike=${strike} spot=${spot}`, () => {
          const pct = signedOtmPct(optionType, strike, spot) as number;
          expect(pct >= 0).toBe(isOtm(optionType, strike, spot));
        });
      }
    }
  }
});
