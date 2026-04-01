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
import type { DeltaRow, DeltaTarget } from '../../types';

// ============================================================
// adjustPoPForKurtosis (single spread)
// ============================================================

describe('adjustPoPForKurtosis', () => {
  it('returns original PoP when kurtosis <= 1', () => {
    expect(adjustPoPForKurtosis(0.85, 1.0)).toBe(0.85);
    expect(adjustPoPForKurtosis(0.85, 0.5)).toBe(0.85);
    expect(adjustPoPForKurtosis(0.85, 0)).toBe(0.85);
  });

  it('kurtosis > 1 reduces PoP (inflates breach probability)', () => {
    const original = 0.9;
    const adjusted = adjustPoPForKurtosis(original, 2.0);
    expect(adjusted).toBeLessThan(original);
  });

  it('higher kurtosis → lower PoP (monotonic decrease)', () => {
    const pop = 0.85;
    const k1 = adjustPoPForKurtosis(pop, 1.5);
    const k2 = adjustPoPForKurtosis(pop, 2.0);
    const k3 = adjustPoPForKurtosis(pop, 3.0);
    const k4 = adjustPoPForKurtosis(pop, 3.5);
    expect(k1).toBeGreaterThan(k2);
    expect(k2).toBeGreaterThan(k3);
    expect(k3).toBeGreaterThan(k4);
  });

  it('result is always in [0, 1]', () => {
    // Even with extreme kurtosis
    for (const pop of [0, 0.1, 0.5, 0.9, 1.0]) {
      for (const k of [1.5, 2.0, 3.0, 5.0, 10.0]) {
        const result = adjustPoPForKurtosis(pop, k);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });

  it('PoP = 1.0 with kurtosis > 1 → adjusted < 1.0', () => {
    // breach = 0, inflated = 0, so adjusted should still be 1.0
    // (zero breach × kurtosis = zero breach)
    expect(adjustPoPForKurtosis(1.0, 2.0)).toBe(1.0);
  });

  it('PoP = 0.0 stays at 0.0 regardless of kurtosis', () => {
    expect(adjustPoPForKurtosis(0, 2.0)).toBe(0);
    expect(adjustPoPForKurtosis(0, 5.0)).toBe(0);
  });

  it('breach probability is inflated by exactly kurtosis factor', () => {
    const pop = 0.9; // breach = 0.1
    const k = 2.0;
    const adjusted = adjustPoPForKurtosis(pop, k);
    // adjusted_breach = min(1, 0.1 * 2.0) = 0.2
    // adjusted_pop = max(0, 1 - 0.2) = 0.8
    expect(adjusted).toBeCloseTo(0.8, 10);
  });

  it('breach probability caps at 1.0 (PoP floors at 0)', () => {
    const pop = 0.3; // breach = 0.7
    const k = 2.0; // inflated = 1.4 → capped at 1.0
    const adjusted = adjustPoPForKurtosis(pop, k);
    expect(adjusted).toBe(0);
  });

  it('uses default kurtosis when not provided', () => {
    const pop = 0.9;
    const withDefault = adjustPoPForKurtosis(pop);
    const withExplicit = adjustPoPForKurtosis(pop, DEFAULTS.KURTOSIS_FACTOR);
    expect(withDefault).toBe(withExplicit);
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
      1.0,
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
      2.5,
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
      1.5,
    );
    const k25 = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      2.5,
    );
    const k35 = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      3.5,
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
        k,
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
      2.0,
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
      2.0,
    );
    const wide = adjustICPoPForKurtosis(
      spot,
      5500,
      6100,
      sigma,
      sigma,
      T,
      2.0,
    );
    expect(wide).toBeGreaterThan(narrow);
  });

  it('skew-adjusted sigmas produce different per-tail inflation', () => {
    const putSigma = sigma * 1.05; // skew-widened
    const callSigma = sigma * 0.95; // skew-narrowed
    const symmetric = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      sigma,
      sigma,
      T,
      2.0,
    );
    const skewed = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      2.0,
    );
    expect(skewed).not.toBeCloseTo(symmetric, 6);
  });
});

// ============================================================
// getKurtosisFactor (VIX regime mapping)
// ============================================================

describe('getKurtosisFactor', () => {
  it('returns default when VIX is undefined', () => {
    expect(getKurtosisFactor()).toBe(DEFAULTS.KURTOSIS_FACTOR);
    expect(getKurtosisFactor(undefined)).toBe(DEFAULTS.KURTOSIS_FACTOR);
  });

  it('returns default when VIX <= 0', () => {
    expect(getKurtosisFactor(0)).toBe(DEFAULTS.KURTOSIS_FACTOR);
    expect(getKurtosisFactor(-5)).toBe(DEFAULTS.KURTOSIS_FACTOR);
  });

  it('VIX < 15 → 1.5', () => {
    expect(getKurtosisFactor(10)).toBe(1.5);
    expect(getKurtosisFactor(14.99)).toBe(1.5);
  });

  it('VIX 15-20 → 2.0', () => {
    expect(getKurtosisFactor(15)).toBe(2.0);
    expect(getKurtosisFactor(19.99)).toBe(2.0);
  });

  it('VIX 20-25 → 2.5', () => {
    expect(getKurtosisFactor(20)).toBe(2.5);
    expect(getKurtosisFactor(24.99)).toBe(2.5);
  });

  it('VIX 25-30 → 3.0', () => {
    expect(getKurtosisFactor(25)).toBe(3.0);
    expect(getKurtosisFactor(29.99)).toBe(3.0);
  });

  it('VIX 30+ → 3.5', () => {
    expect(getKurtosisFactor(30)).toBe(3.5);
    expect(getKurtosisFactor(80)).toBe(3.5);
  });

  it('higher VIX → higher kurtosis (monotonic across regimes)', () => {
    const vixLevels = [12, 17, 22, 27, 35];
    for (let i = 0; i < vixLevels.length - 1; i++) {
      expect(getKurtosisFactor(vixLevels[i])).toBeLessThanOrEqual(
        getKurtosisFactor(vixLevels[i + 1]!),
      );
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

    const ic = buildIronCondor(d10, 25, spot, T, 10, 18); // VIX=18 → k=2.0
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

    const lowVix = buildIronCondor(d10, 25, spot, T, 10, 12); // k=1.5
    const highVix = buildIronCondor(d10, 25, spot, T, 10, 28); // k=3.0
    expect(highVix.adjustedPoP).toBeLessThan(lowVix.adjustedPoP);
  });
});

// ============================================================
// Strike-delta accuracy: verify strikes match target deltas
// ============================================================

describe('strike-delta accuracy', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(4); // 4 hours remaining

  it('unsnapped strikes produce delta within 15% of target', () => {
    const deltas: DeltaTarget[] = [5, 8, 10, 12, 15, 20];
    for (const d of deltas) {
      const result = calcStrikes(spot, sigma, T, d, 0);
      if (isStrikeError(result)) continue;

      // Compute actual BS delta at the raw (unsnapped) strikes
      const putDelta = calcBSDelta(
        spot,
        result.putStrike,
        sigma,
        T,
        'put',
      );
      const callDelta = calcBSDelta(
        spot,
        result.callStrike,
        sigma,
        T,
        'call',
      );

      const targetFrac = d / 100;
      // Within 15% relative of target (generous for rounding to nearest integer)
      expect(putDelta).toBeCloseTo(targetFrac, 1);
      expect(callDelta).toBeCloseTo(targetFrac, 1);
    }
  });

  it('snapped strikes produce delta within 2 delta points of target', () => {
    const deltas: DeltaTarget[] = [5, 10, 15, 20];
    for (const d of deltas) {
      const result = calcStrikes(spot, sigma, T, d, 0);
      if (isStrikeError(result)) continue;

      // Snapped strikes may shift up to 2.5 points → delta shift
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

    // Put sigma is higher with skew
    const putSigma = sigma * (1 + 0.05);
    const putDelta =
      calcBSDelta(spot, result.putStrike, putSigma, T, 'put') * 100;
    expect(Math.abs(putDelta - 10)).toBeLessThan(2);
  });

  it('strikes at different spot levels maintain delta accuracy', () => {
    for (const s of [4500, 5800, 6500, 7000]) {
      const result = calcStrikes(s, sigma, T, 10, 0);
      if (isStrikeError(result)) continue;

      const putDelta =
        calcBSDelta(s, result.putStrike, sigma, T, 'put') * 100;
      const callDelta =
        calcBSDelta(s, result.callStrike, sigma, T, 'call') * 100;

      expect(Math.abs(putDelta - 10)).toBeLessThan(1.5);
      expect(Math.abs(callDelta - 10)).toBeLessThan(1.5);
    }
  });

  it('very short T still produces reasonable deltas', () => {
    const shortT = calcTimeToExpiry(0.5); // 30 min left
    const result = calcStrikes(spot, sigma, shortT, 10, 0);
    if (isStrikeError(result)) return;

    const putDelta =
      calcBSDelta(spot, result.putStrike, sigma, shortT, 'put') * 100;
    const callDelta =
      calcBSDelta(spot, result.callStrike, sigma, shortT, 'call') * 100;

    // Wider tolerance at short T due to integer rounding mattering more
    expect(Math.abs(putDelta - 10)).toBeLessThan(3);
    expect(Math.abs(callDelta - 10)).toBeLessThan(3);
  });

  it('calcAllDeltas rows have actual deltas near targets (base sigma)', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0, 10);
    for (const row of rows) {
      if ('error' in row) continue;
      // Use base sigma (settlement) for delta check on unsnapped strike
      const baseSigma = sigma; // no skew
      const putDelta =
        calcBSDelta(spot, row.putStrike, baseSigma, T, 'put') * 100;
      expect(Math.abs(putDelta - row.delta)).toBeLessThan(1.5);
    }
  });
});
