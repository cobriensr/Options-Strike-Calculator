import { describe, it, expect } from 'vitest';
import { normalCDF, normalPDF, blackScholesPrice, calcBSDelta, calcBSGamma, calcTimeToExpiry } from '../calculator';

describe('normalCDF', () => {
  it('N(0) = 0.5', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 7);
  });

  it('N(-inf) approaches 0', () => {
    expect(normalCDF(-10)).toBeCloseTo(0, 7);
  });

  it('N(+inf) approaches 1', () => {
    expect(normalCDF(10)).toBeCloseTo(1, 7);
  });

  it('N(1) ≈ 0.8413', () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 4);
  });

  it('N(-1) ≈ 0.1587', () => {
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 4);
  });

  it('N(1.96) ≈ 0.975', () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3);
  });

  it('N(x) + N(-x) = 1 (symmetry)', () => {
    for (const x of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(normalCDF(x) + normalCDF(-x)).toBeCloseTo(1, 6);
    }
  });

  it('is monotonically increasing', () => {
    let prev = 0;
    for (let x = -5; x <= 5; x += 0.1) {
      const val = normalCDF(x);
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });
});

describe('blackScholesPrice', () => {
  // ATM call with known values for sanity check
  // S=100, K=100, σ=0.20, T=1 year, r=0
  // Expected call ≈ 7.97 (standard BS result with r=0)
  it('ATM call S=100 K=100 σ=0.20 T=1y ≈ 7.97', () => {
    const price = blackScholesPrice(100, 100, 0.20, 1, 'call');
    expect(price).toBeCloseTo(7.97, 1);
  });

  it('ATM put equals ATM call when r=0 (put-call parity)', () => {
    const call = blackScholesPrice(100, 100, 0.20, 1, 'call');
    const put = blackScholesPrice(100, 100, 0.20, 1, 'put');
    // With r=0: C - P = S - K = 0 for ATM
    expect(call).toBeCloseTo(put, 4);
  });

  it('deep OTM put is near zero', () => {
    const price = blackScholesPrice(5800, 5500, 0.20, 0.003, 'put');
    expect(price).toBeLessThan(1);
  });

  it('deep ITM call ≈ S - K when deep enough', () => {
    const price = blackScholesPrice(5800, 5000, 0.20, 1, 'call');
    expect(price).toBeGreaterThan(780); // at least intrinsic
  });

  it('call price increases with spot', () => {
    const low = blackScholesPrice(5700, 5800, 0.20, 0.003, 'call');
    const high = blackScholesPrice(5900, 5800, 0.20, 0.003, 'call');
    expect(high).toBeGreaterThan(low);
  });

  it('put price decreases with spot', () => {
    const low = blackScholesPrice(5700, 5800, 0.20, 0.003, 'put');
    const high = blackScholesPrice(5900, 5800, 0.20, 0.003, 'put');
    expect(low).toBeGreaterThan(high);
  });

  it('higher IV = higher premium for both puts and calls', () => {
    const lowCall = blackScholesPrice(5800, 5800, 0.15, 0.003, 'call');
    const highCall = blackScholesPrice(5800, 5800, 0.30, 0.003, 'call');
    expect(highCall).toBeGreaterThan(lowCall);

    const lowPut = blackScholesPrice(5800, 5800, 0.15, 0.003, 'put');
    const highPut = blackScholesPrice(5800, 5800, 0.30, 0.003, 'put');
    expect(highPut).toBeGreaterThan(lowPut);
  });

  it('more time = higher premium', () => {
    const short = blackScholesPrice(5800, 5800, 0.20, 0.001, 'call');
    const long = blackScholesPrice(5800, 5800, 0.20, 0.004, 'call');
    expect(long).toBeGreaterThan(short);
  });

  it('returns 0 for T=0', () => {
    expect(blackScholesPrice(5800, 5800, 0.20, 0, 'call')).toBe(0);
  });

  it('returns 0 for σ=0', () => {
    expect(blackScholesPrice(5800, 5800, 0, 0.003, 'call')).toBe(0);
  });

  it('0DTE SPX-scale premiums are reasonable', () => {
    // SPX 5800, 10Δ puts (~100 pts OTM), 3h remaining
    const T = calcTimeToExpiry(3);
    const put = blackScholesPrice(5800, 5700, 0.20, T, 'put');
    // Should be a few dollars, not hundreds
    expect(put).toBeGreaterThan(0.01);
    expect(put).toBeLessThan(20);
  });
});

describe('normalPDF', () => {
  it('PDF at 0 = 1/√(2π) ≈ 0.3989', () => {
    expect(normalPDF(0)).toBeCloseTo(0.3989, 3);
  });

  it('symmetric: PDF(x) = PDF(-x)', () => {
    for (const x of [0.5, 1, 1.5, 2, 3]) {
      expect(normalPDF(x)).toBeCloseTo(normalPDF(-x), 10);
    }
  });

  it('decreases away from zero', () => {
    expect(normalPDF(0)).toBeGreaterThan(normalPDF(1));
    expect(normalPDF(1)).toBeGreaterThan(normalPDF(2));
    expect(normalPDF(2)).toBeGreaterThan(normalPDF(3));
  });

  it('approaches zero for large x', () => {
    expect(normalPDF(10)).toBeLessThan(0.0001);
  });
});

describe('calcBSDelta', () => {
  const T = calcTimeToExpiry(4);
  const sigma = 0.20;

  it('ATM call delta ≈ 0.50', () => {
    const delta = calcBSDelta(5800, 5800, sigma, T, 'call');
    expect(delta).toBeCloseTo(0.50, 1);
  });

  it('ATM put delta ≈ 0.50 (absolute)', () => {
    const delta = calcBSDelta(5800, 5800, sigma, T, 'put');
    expect(delta).toBeCloseTo(0.50, 1);
  });

  it('deep OTM put has small delta', () => {
    const delta = calcBSDelta(5800, 5500, sigma, T, 'put');
    expect(delta).toBeLessThan(0.05);
  });

  it('deep OTM call has small delta', () => {
    const delta = calcBSDelta(5800, 6100, sigma, T, 'call');
    expect(delta).toBeLessThan(0.05);
  });

  it('call delta increases as strike moves toward spot', () => {
    const far = calcBSDelta(5800, 6100, sigma, T, 'call');
    const near = calcBSDelta(5800, 5850, sigma, T, 'call');
    expect(near).toBeGreaterThan(far);
  });

  it('put delta increases as strike moves toward spot', () => {
    const far = calcBSDelta(5800, 5500, sigma, T, 'put');
    const near = calcBSDelta(5800, 5750, sigma, T, 'put');
    expect(near).toBeGreaterThan(far);
  });

  it('less time remaining → OTM delta decreases', () => {
    const moreTime = calcBSDelta(5800, 5700, sigma, calcTimeToExpiry(5), 'put');
    const lessTime = calcBSDelta(5800, 5700, sigma, calcTimeToExpiry(2), 'put');
    expect(lessTime).toBeLessThan(moreTime);
  });

  it('returns 0 for T=0', () => {
    expect(calcBSDelta(5800, 5800, sigma, 0, 'call')).toBe(0);
  });

  it('put-call delta parity: callΔ + putΔ ≈ 1 for same strike', () => {
    const callD = calcBSDelta(5800, 5800, sigma, T, 'call');
    const putD = calcBSDelta(5800, 5800, sigma, T, 'put');
    expect(callD + putD).toBeCloseTo(1.0, 2);
  });
});

describe('calcBSGamma', () => {
  const T = calcTimeToExpiry(4);
  const sigma = 0.20;

  it('gamma is highest ATM', () => {
    const atm = calcBSGamma(5800, 5800, sigma, T);
    const otm = calcBSGamma(5800, 5700, sigma, T);
    expect(atm).toBeGreaterThan(otm);
  });

  it('gamma is positive', () => {
    expect(calcBSGamma(5800, 5800, sigma, T)).toBeGreaterThan(0);
    expect(calcBSGamma(5800, 5700, sigma, T)).toBeGreaterThan(0);
    expect(calcBSGamma(5800, 5900, sigma, T)).toBeGreaterThan(0);
  });

  it('gamma increases as T decreases (more time = flatter gamma)', () => {
    const moreTime = calcBSGamma(5800, 5800, sigma, calcTimeToExpiry(5));
    const lessTime = calcBSGamma(5800, 5800, sigma, calcTimeToExpiry(2));
    expect(lessTime).toBeGreaterThan(moreTime);
  });

  it('gamma is approximately symmetric around ATM', () => {
    const putSide = calcBSGamma(5800, 5750, sigma, T);
    const callSide = calcBSGamma(5800, 5850, sigma, T);
    // Not exactly equal due to log-normal skew, but close
    expect(Math.abs(putSide - callSide) / putSide).toBeLessThan(0.15);
  });

  it('higher IV → lower peak gamma (flatter curve)', () => {
    const lowIV = calcBSGamma(5800, 5800, 0.15, T);
    const highIV = calcBSGamma(5800, 5800, 0.30, T);
    expect(lowIV).toBeGreaterThan(highIV);
  });

  it('returns 0 for T=0', () => {
    expect(calcBSGamma(5800, 5800, sigma, 0)).toBe(0);
  });

  it('0DTE gamma is much higher than 30DTE gamma', () => {
    const zeroDTE = calcBSGamma(5800, 5800, sigma, calcTimeToExpiry(4));
    const thirtyDTE = calcBSGamma(5800, 5800, sigma, 30 / 365);
    expect(zeroDTE).toBeGreaterThan(thirtyDTE * 5);
  });
});
