import { describe, it, expect } from 'vitest';
import {
  adjustPoPForKurtosis,
  adjustICPoPForKurtosis,
  buildIronCondor,
  calcPoP,
  calcAllDeltas,
  calcStrikes,
  calcTimeToExpiry,
  isStrikeError,
  calcBSDelta,
} from '../../utils/calculator';
import { getKurtosisFactor, DEFAULTS } from '../../constants';
import type { KurtosisPair } from '../../constants';
import type { DeltaRow, DeltaTarget } from '../../types';

/** Helper: build a symmetric KurtosisPair for tests that don't care about asymmetry */
const kp = (v: number): KurtosisPair => ({ crash: v, rally: v });

// ============================================================
// adjustPoPForKurtosis (single spread)
// ============================================================

describe('adjustPoPForKurtosis', () => {
  it('returns original PoP when kurtosis <= 1', () => {
    expect(adjustPoPForKurtosis(0.85, kp(1.0))).toBe(0.85);
    expect(adjustPoPForKurtosis(0.85, kp(0.5))).toBe(0.85);
    expect(adjustPoPForKurtosis(0.85, kp(0))).toBe(0.85);
  });

  it('kurtosis > 1 reduces PoP (inflates breach probability)', () => {
    const original = 0.9;
    const adjusted = adjustPoPForKurtosis(original, kp(2.0));
    expect(adjusted).toBeLessThan(original);
  });

  it('higher kurtosis → lower PoP (monotonic decrease)', () => {
    const pop = 0.85;
    const k1 = adjustPoPForKurtosis(pop, kp(1.5));
    const k2 = adjustPoPForKurtosis(pop, kp(2.0));
    const k3 = adjustPoPForKurtosis(pop, kp(3.0));
    const k4 = adjustPoPForKurtosis(pop, kp(3.5));
    expect(k1).toBeGreaterThan(k2);
    expect(k2).toBeGreaterThan(k3);
    expect(k3).toBeGreaterThan(k4);
  });

  it('result is always in [0, 1]', () => {
    for (const pop of [0, 0.1, 0.5, 0.9, 1.0]) {
      for (const k of [1.5, 2.0, 3.0, 5.0, 10.0]) {
        const result = adjustPoPForKurtosis(pop, kp(k));
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });

  it('PoP = 1.0 with kurtosis > 1 → adjusted still 1.0', () => {
    expect(adjustPoPForKurtosis(1.0, kp(2.0))).toBe(1.0);
  });

  it('PoP = 0.0 stays at 0.0 regardless of kurtosis', () => {
    expect(adjustPoPForKurtosis(0, kp(2.0))).toBe(0);
    expect(adjustPoPForKurtosis(0, kp(5.0))).toBe(0);
  });

  it('breach probability is inflated by exactly kurtosis factor', () => {
    const pop = 0.9; // breach = 0.1
    const adjusted = adjustPoPForKurtosis(pop, kp(2.0));
    // adjusted_breach = min(1, 0.1 * 2.0) = 0.2
    // adjusted_pop = max(0, 1 - 0.2) = 0.8
    expect(adjusted).toBeCloseTo(0.8, 10);
  });

  it('breach probability caps at 1.0 (PoP floors at 0)', () => {
    const pop = 0.3; // breach = 0.7
    const adjusted = adjustPoPForKurtosis(pop, kp(2.0)); // inflated = 1.4 → capped
    expect(adjusted).toBe(0);
  });

  it('uses default kurtosis when not provided', () => {
    const pop = 0.9;
    const withDefault = adjustPoPForKurtosis(pop);
    const withExplicit = adjustPoPForKurtosis(pop, DEFAULTS.KURTOSIS_FACTOR);
    expect(withDefault).toBe(withExplicit);
  });

  it('put side uses crash factor, call side uses rally factor', () => {
    const pop = 0.9;
    const pair: KurtosisPair = { crash: 3.0, rally: 1.5 };
    const putAdjusted = adjustPoPForKurtosis(pop, pair, 'put');
    const callAdjusted = adjustPoPForKurtosis(pop, pair, 'call');
    // crash > rally → put adjusted should be lower (more conservative)
    expect(putAdjusted).toBeLessThan(callAdjusted);
  });

  it('asymmetric factors produce different results per side', () => {
    const pop = 0.85;
    const pair: KurtosisPair = { crash: 3.0, rally: 2.0 };
    const putResult = adjustPoPForKurtosis(pop, pair, 'put');
    const callResult = adjustPoPForKurtosis(pop, pair, 'call');
    // breach = 0.15
    // put: min(1, 0.15 * 3.0) = 0.45 → PoP = 0.55
    // call: min(1, 0.15 * 2.0) = 0.30 → PoP = 0.70
    expect(putResult).toBeCloseTo(0.55, 10);
    expect(callResult).toBeCloseTo(0.7, 10);
  });
});

// ============================================================
// adjustICPoPForKurtosis (iron condor — two tails)
// ============================================================

describe('adjustICPoPForKurtosis', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = calcTimeToExpiry(3);
  const beLow = 5700;
  const beHigh = 5900;

  it('kurtosis <= 1 returns unadjusted calcPoP', () => {
    const unadjusted = calcPoP(spot, beLow, beHigh, sigma, sigma, T);
    const adjusted = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(1.0),
    );
    expect(adjusted).toBeCloseTo(unadjusted, 10);
  });

  it('kurtosis > 1 reduces IC PoP', () => {
    const unadjusted = calcPoP(spot, beLow, beHigh, sigma, sigma, T);
    const adjusted = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(2.5),
    );
    expect(adjusted).toBeLessThan(unadjusted);
  });

  it('higher kurtosis → lower IC PoP (monotonic)', () => {
    const k15 = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(1.5),
    );
    const k25 = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(2.5),
    );
    const k35 = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(3.5),
    );
    expect(k15).toBeGreaterThan(k25);
    expect(k25).toBeGreaterThan(k35);
  });

  it('result is always in [0, 1]', () => {
    for (const k of [1.5, 2.0, 3.0, 5.0, 10.0]) {
      const result = adjustICPoPForKurtosis(
        spot,
        beLow,
        beHigh,
        sigma,
        sigma,
        T,
        kp(k),
      );
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });

  it('T <= 0 returns calcPoP result (which is 0)', () => {
    const result = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      0,
      kp(2.0),
    );
    expect(result).toBe(0);
  });

  it('wider breakevens → higher adjusted PoP', () => {
    const narrow = adjustICPoPForKurtosis(
      spot,
      5750,
      5850,
      sigma,
      sigma,
      T,
      kp(2.0),
    );
    const wide = adjustICPoPForKurtosis(
      spot,
      5500,
      6100,
      sigma,
      sigma,
      T,
      kp(2.0),
    );
    expect(wide).toBeGreaterThan(narrow);
  });

  it('skew-adjusted sigmas produce different per-tail inflation', () => {
    const putSigma = sigma * 1.05;
    const callSigma = sigma * 0.95;
    const symmetric = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(2.0),
    );
    const skewed = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      kp(2.0),
    );
    expect(skewed).not.toBeCloseTo(symmetric, 6);
  });

  it('asymmetric kurtosis: crash > rally inflates put side more', () => {
    const asymmetric = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      { crash: 3.0, rally: 1.5 },
    );
    const symmetricHigh = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      kp(3.0),
    );
    // Asymmetric (lower rally factor) should give higher PoP than
    // symmetric with the higher crash factor on both sides
    expect(asymmetric).toBeGreaterThan(symmetricHigh);
  });
});

// ============================================================
// getKurtosisFactor (VIX regime mapping)
// ============================================================

describe('getKurtosisFactor', () => {
  it('returns default when VIX is undefined', () => {
    expect(getKurtosisFactor()).toEqual(DEFAULTS.KURTOSIS_FACTOR);
    expect(getKurtosisFactor(undefined)).toEqual(DEFAULTS.KURTOSIS_FACTOR);
  });

  it('returns default when VIX <= 0', () => {
    expect(getKurtosisFactor(0)).toEqual(DEFAULTS.KURTOSIS_FACTOR);
    expect(getKurtosisFactor(-5)).toEqual(DEFAULTS.KURTOSIS_FACTOR);
  });

  it('VIX < 15 → crash 1.8, rally 1.2', () => {
    expect(getKurtosisFactor(10)).toEqual({ crash: 1.8, rally: 1.2 });
    expect(getKurtosisFactor(14.99)).toEqual({ crash: 1.8, rally: 1.2 });
  });

  it('VIX 15-20 → crash 2.5, rally 1.5', () => {
    expect(getKurtosisFactor(15)).toEqual({ crash: 2.5, rally: 1.5 });
    expect(getKurtosisFactor(19.99)).toEqual({ crash: 2.5, rally: 1.5 });
  });

  it('VIX 20-25 → crash 3.0, rally 2.0', () => {
    expect(getKurtosisFactor(20)).toEqual({ crash: 3.0, rally: 2.0 });
    expect(getKurtosisFactor(24.99)).toEqual({ crash: 3.0, rally: 2.0 });
  });

  it('VIX 25-30 → crash 3.5, rally 2.5', () => {
    expect(getKurtosisFactor(25)).toEqual({ crash: 3.5, rally: 2.5 });
    expect(getKurtosisFactor(29.99)).toEqual({ crash: 3.5, rally: 2.5 });
  });

  it('VIX 30+ → crash 4.0, rally 3.0', () => {
    expect(getKurtosisFactor(30)).toEqual({ crash: 4.0, rally: 3.0 });
    expect(getKurtosisFactor(80)).toEqual({ crash: 4.0, rally: 3.0 });
  });

  it('higher VIX → higher kurtosis on both sides (monotonic)', () => {
    const vixLevels = [12, 17, 22, 27, 35];
    for (let i = 0; i < vixLevels.length - 1; i++) {
      const lower = getKurtosisFactor(vixLevels[i]);
      const higher = getKurtosisFactor(vixLevels[i + 1]!);
      expect(lower.crash).toBeLessThanOrEqual(higher.crash);
      expect(lower.rally).toBeLessThanOrEqual(higher.rally);
    }
  });

  it('crash factor always >= rally factor in every regime', () => {
    for (const vix of [10, 17, 22, 27, 35]) {
      const k = getKurtosisFactor(vix);
      expect(k.crash).toBeGreaterThanOrEqual(k.rally);
    }
  });
});

// ============================================================
// buildIronCondor: adjusted PoP integration
// ============================================================

describe('buildIronCondor adjusted PoP fields', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);
  const rows = calcAllDeltas(spot, sigma, T, 0.03, 10);
  const d10 = rows.find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  );

  it('adjustedPoP < probabilityOfProfit when VIX provided', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10, 18);
    expect(ic.adjustedPoP).toBeLessThan(ic.probabilityOfProfit);
  });

  it('adjustedPutSpreadPoP < putSpreadPoP', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10, 18);
    expect(ic.adjustedPutSpreadPoP).toBeLessThan(ic.putSpreadPoP);
  });

  it('adjustedCallSpreadPoP < callSpreadPoP', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10, 18);
    expect(ic.adjustedCallSpreadPoP).toBeLessThan(ic.callSpreadPoP);
  });

  it('higher VIX → lower adjusted PoP', () => {
    if (!d10) return;
    const lowVix = buildIronCondor(d10, 25, spot, T, 10, 12);
    const highVix = buildIronCondor(d10, 25, spot, T, 10, 28);
    expect(highVix.adjustedPoP).toBeLessThan(lowVix.adjustedPoP);
  });

  it('put spread adjustment is more conservative than call spread', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10, 18);
    // Asymmetric kurtosis: crash > rally
    // Put spread PoP should be reduced more than call spread PoP
    const putReduction = ic.putSpreadPoP - ic.adjustedPutSpreadPoP;
    const callReduction = ic.callSpreadPoP - ic.adjustedCallSpreadPoP;
    expect(putReduction).toBeGreaterThan(callReduction);
  });
});

// ============================================================
// Strike-delta accuracy: verify strikes match target deltas
// ============================================================

describe('strike-delta accuracy', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(4);

  it('unsnapped strikes produce delta within 15% of target', () => {
    const deltas: DeltaTarget[] = [5, 8, 10, 12, 15, 20];
    for (const d of deltas) {
      const result = calcStrikes(spot, sigma, T, d, 0);
      if (isStrikeError(result)) continue;

      const putDelta = calcBSDelta(spot, result.putStrike, sigma, T, 'put');
      const callDelta = calcBSDelta(spot, result.callStrike, sigma, T, 'call');

      const targetFrac = d / 100;
      expect(putDelta).toBeCloseTo(targetFrac, 1);
      expect(callDelta).toBeCloseTo(targetFrac, 1);
    }
  });

  it('snapped strikes produce delta within 2 delta points of target', () => {
    const deltas: DeltaTarget[] = [5, 10, 15, 20];
    for (const d of deltas) {
      const result = calcStrikes(spot, sigma, T, d, 0);
      if (isStrikeError(result)) continue;

      const putDelta =
        calcBSDelta(spot, result.putStrikeSnapped, sigma, T, 'put') * 100;
      const callDelta =
        calcBSDelta(spot, result.callStrikeSnapped, sigma, T, 'call') * 100;

      expect(Math.abs(putDelta - d)).toBeLessThan(2);
      expect(Math.abs(callDelta - d)).toBeLessThan(2);
    }
  });

  it('with skew, put strikes are further OTM but delta is still close', () => {
    const result = calcStrikes(spot, sigma, T, 10, 0.05);
    if (isStrikeError(result)) return;

    const putSigma = sigma * (1 + 0.05);
    const putDelta =
      calcBSDelta(spot, result.putStrike, putSigma, T, 'put') * 100;
    expect(Math.abs(putDelta - 10)).toBeLessThan(2);
  });

  it('strikes at different spot levels maintain delta accuracy', () => {
    for (const s of [4500, 5800, 6500, 7000]) {
      const result = calcStrikes(s, sigma, T, 10, 0);
      if (isStrikeError(result)) continue;

      const putDelta = calcBSDelta(s, result.putStrike, sigma, T, 'put') * 100;
      const callDelta =
        calcBSDelta(s, result.callStrike, sigma, T, 'call') * 100;

      expect(Math.abs(putDelta - 10)).toBeLessThan(1.5);
      expect(Math.abs(callDelta - 10)).toBeLessThan(1.5);
    }
  });

  it('very short T still produces reasonable deltas', () => {
    const shortT = calcTimeToExpiry(0.5);
    const result = calcStrikes(spot, sigma, shortT, 10, 0);
    if (isStrikeError(result)) return;

    const putDelta =
      calcBSDelta(spot, result.putStrike, sigma, shortT, 'put') * 100;
    const callDelta =
      calcBSDelta(spot, result.callStrike, sigma, shortT, 'call') * 100;

    expect(Math.abs(putDelta - 10)).toBeLessThan(3);
    expect(Math.abs(callDelta - 10)).toBeLessThan(3);
  });

  it('calcAllDeltas rows have actual deltas near targets (base sigma)', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0, 10);
    for (const row of rows) {
      if ('error' in row) continue;
      const baseSigma = sigma;
      const putDelta =
        calcBSDelta(spot, row.putStrike, baseSigma, T, 'put') * 100;
      expect(Math.abs(putDelta - row.delta)).toBeLessThan(1.5);
    }
  });
});
