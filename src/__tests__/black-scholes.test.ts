import { describe, expect, it } from 'vitest';

import {
  normalCDF,
  normalPDF,
  calcBSDelta,
  calcBSGamma,
  calcBSTheta,
  calcBSVega,
  blackScholesPrice,
  calcIVAcceleration,
  impliedVolatility,
} from '../utils/black-scholes';
import { MARKET, DEFAULTS } from '../constants';

// ── normalCDF ──────────────────────────────────────────────────

describe('normalCDF', () => {
  it('returns 0.5 at x = 0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 8);
  });

  it('returns ~0.8413 at x = 1 (one std dev)', () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 4);
  });

  it('returns ~0.1587 at x = -1', () => {
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 4);
  });

  it('returns ~0.9772 at x = 2', () => {
    expect(normalCDF(2)).toBeCloseTo(0.9772, 4);
  });

  it('returns ~0.0228 at x = -2', () => {
    expect(normalCDF(-2)).toBeCloseTo(0.0228, 4);
  });

  it('returns ~0.9987 at x = 3', () => {
    expect(normalCDF(3)).toBeCloseTo(0.9987, 4);
  });

  it('approaches 1 for large positive x', () => {
    expect(normalCDF(6)).toBeCloseTo(1, 6);
  });

  it('approaches 0 for large negative x', () => {
    expect(normalCDF(-6)).toBeCloseTo(0, 6);
  });

  it('satisfies symmetry: N(x) + N(-x) = 1', () => {
    for (const x of [0.5, 1, 1.645, 2, 2.5, 3]) {
      expect(normalCDF(x) + normalCDF(-x)).toBeCloseTo(1, 8);
    }
  });
});

// ── normalPDF ──────────────────────────────────────────────────

describe('normalPDF', () => {
  it('returns the maximum value at x = 0', () => {
    const expected = 1 / Math.sqrt(2 * Math.PI);
    expect(normalPDF(0)).toBeCloseTo(expected, 10);
  });

  it('is symmetric: pdf(x) = pdf(-x)', () => {
    for (const x of [0.5, 1, 2, 3]) {
      expect(normalPDF(x)).toBeCloseTo(normalPDF(-x), 10);
    }
  });

  it('returns values that decrease away from 0', () => {
    expect(normalPDF(0)).toBeGreaterThan(normalPDF(1));
    expect(normalPDF(1)).toBeGreaterThan(normalPDF(2));
    expect(normalPDF(2)).toBeGreaterThan(normalPDF(3));
  });
});

// ── calcBSDelta ────────────────────────────────────────────────

describe('calcBSDelta', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252; // ~1 trading day

  it('returns 0 when T <= 0', () => {
    expect(calcBSDelta(spot, 5800, sigma, 0, 'call')).toBe(0);
    expect(calcBSDelta(spot, 5800, sigma, -1, 'put')).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcBSDelta(spot, 5800, 0, T, 'call')).toBe(0);
    expect(calcBSDelta(spot, 5800, -0.1, T, 'call')).toBe(0);
  });

  it('returns 0 when spot or strike <= 0', () => {
    expect(calcBSDelta(0, 5800, sigma, T, 'call')).toBe(0);
    expect(calcBSDelta(spot, 0, sigma, T, 'call')).toBe(0);
  });

  it('ATM call delta is approximately 0.5', () => {
    const d = calcBSDelta(spot, spot, sigma, T, 'call');
    expect(d).toBeGreaterThan(0.48);
    expect(d).toBeLessThan(0.55);
  });

  it('ATM put delta is approximately 0.5 (returned as absolute value)', () => {
    const d = calcBSDelta(spot, spot, sigma, T, 'put');
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(0.52);
  });

  it('call delta + put delta = 1 (put-call parity)', () => {
    const strikes = [5700, 5750, 5800, 5850, 5900];
    for (const K of strikes) {
      const callDelta = calcBSDelta(spot, K, sigma, T, 'call');
      const putDelta = calcBSDelta(spot, K, sigma, T, 'put');
      expect(callDelta + putDelta).toBeCloseTo(1, 6);
    }
  });

  it('call delta is bounded between 0 and 1', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      const d = calcBSDelta(spot, K, sigma, T, 'call');
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('put delta (absolute) is bounded between 0 and 1', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      const d = calcBSDelta(spot, K, sigma, T, 'put');
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('deep ITM call delta approaches 1', () => {
    const d = calcBSDelta(spot, 5400, sigma, T, 'call');
    expect(d).toBeGreaterThan(0.99);
  });

  it('deep OTM call delta approaches 0', () => {
    const d = calcBSDelta(spot, 6200, sigma, T, 'call');
    expect(d).toBeLessThan(0.01);
  });

  it('deep ITM put delta approaches 1', () => {
    const d = calcBSDelta(spot, 6200, sigma, T, 'put');
    expect(d).toBeGreaterThan(0.99);
  });

  it('deep OTM put delta approaches 0', () => {
    const d = calcBSDelta(spot, 5400, sigma, T, 'put');
    expect(d).toBeLessThan(0.01);
  });

  it('call delta increases as strike decreases (more ITM)', () => {
    const d1 = calcBSDelta(spot, 5900, sigma, T, 'call');
    const d2 = calcBSDelta(spot, 5800, sigma, T, 'call');
    const d3 = calcBSDelta(spot, 5700, sigma, T, 'call');
    expect(d3).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d1);
  });

  it('put delta increases as strike increases (more ITM)', () => {
    const d1 = calcBSDelta(spot, 5700, sigma, T, 'put');
    const d2 = calcBSDelta(spot, 5800, sigma, T, 'put');
    const d3 = calcBSDelta(spot, 5900, sigma, T, 'put');
    expect(d3).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d1);
  });
});

// ── calcBSGamma ────────────────────────────────────────────────

describe('calcBSGamma', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(calcBSGamma(spot, 5800, sigma, 0)).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcBSGamma(spot, 5800, 0, T)).toBe(0);
  });

  it('returns 0 when spot or strike <= 0', () => {
    expect(calcBSGamma(0, 5800, sigma, T)).toBe(0);
    expect(calcBSGamma(spot, 0, sigma, T)).toBe(0);
  });

  it('gamma is always positive', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      expect(calcBSGamma(spot, K, sigma, T)).toBeGreaterThan(0);
    }
  });

  it('gamma is highest ATM', () => {
    const gammaATM = calcBSGamma(spot, spot, sigma, T);
    const gammaOTMPut = calcBSGamma(spot, 5700, sigma, T);
    const gammaOTMCall = calcBSGamma(spot, 5900, sigma, T);
    expect(gammaATM).toBeGreaterThan(gammaOTMPut);
    expect(gammaATM).toBeGreaterThan(gammaOTMCall);
  });

  it('gamma increases as T decreases (approaching expiry)', () => {
    const T_long = 5 / 252;
    const T_short = 1 / 252;
    const gammaLong = calcBSGamma(spot, spot, sigma, T_long);
    const gammaShort = calcBSGamma(spot, spot, sigma, T_short);
    expect(gammaShort).toBeGreaterThan(gammaLong);
  });

  it('gamma is approximately symmetric around ATM for small deviations', () => {
    const dist = 20;
    const gUp = calcBSGamma(spot, spot + dist, sigma, T);
    const gDown = calcBSGamma(spot, spot - dist, sigma, T);
    // Not exactly equal due to log-normality, but close
    const ratio = gUp / gDown;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });
});

// ── calcBSTheta ────────────────────────────────────────────────

describe('calcBSTheta', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(calcBSTheta(spot, 5800, sigma, 0)).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcBSTheta(spot, 5800, 0, T)).toBe(0);
  });

  it('returns 0 when spot or strike <= 0', () => {
    expect(calcBSTheta(0, 5800, sigma, T)).toBe(0);
    expect(calcBSTheta(spot, 0, sigma, T)).toBe(0);
  });

  it('theta is always negative (time decay costs the holder)', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      expect(calcBSTheta(spot, K, sigma, T)).toBeLessThan(0);
    }
  });

  it('theta magnitude is highest ATM', () => {
    const thetaATM = Math.abs(calcBSTheta(spot, spot, sigma, T));
    const thetaOTM = Math.abs(calcBSTheta(spot, 5700, sigma, T));
    expect(thetaATM).toBeGreaterThan(thetaOTM);
  });

  it('theta magnitude increases as T decreases (theta accelerates near expiry)', () => {
    const T_long = 5 / 252;
    const T_short = 1 / 252;
    const thetaLong = Math.abs(calcBSTheta(spot, spot, sigma, T_long));
    const thetaShort = Math.abs(calcBSTheta(spot, spot, sigma, T_short));
    expect(thetaShort).toBeGreaterThan(thetaLong);
  });
});

// ── calcBSVega ─────────────────────────────────────────────────

describe('calcBSVega', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(calcBSVega(spot, 5800, sigma, 0)).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcBSVega(spot, 5800, 0, T)).toBe(0);
  });

  it('returns 0 when spot or strike <= 0', () => {
    expect(calcBSVega(0, 5800, sigma, T)).toBe(0);
    expect(calcBSVega(spot, 0, sigma, T)).toBe(0);
  });

  it('vega is always positive', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      expect(calcBSVega(spot, K, sigma, T)).toBeGreaterThan(0);
    }
  });

  it('vega is highest ATM', () => {
    const vegaATM = calcBSVega(spot, spot, sigma, T);
    const vegaOTM = calcBSVega(spot, 5700, sigma, T);
    expect(vegaATM).toBeGreaterThan(vegaOTM);
  });

  it('vega decreases as T decreases (less time = less sensitivity)', () => {
    const T_long = 10 / 252;
    const T_short = 1 / 252;
    const vegaLong = calcBSVega(spot, spot, sigma, T_long);
    const vegaShort = calcBSVega(spot, spot, sigma, T_short);
    expect(vegaLong).toBeGreaterThan(vegaShort);
  });
});

// ── blackScholesPrice ──────────────────────────────────────────

describe('blackScholesPrice', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(blackScholesPrice(spot, 5800, sigma, 0, 'call')).toBe(0);
    expect(blackScholesPrice(spot, 5800, sigma, -1, 'put')).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(blackScholesPrice(spot, 5800, 0, T, 'call')).toBe(0);
  });

  it('returns 0 when spot or strike <= 0', () => {
    expect(blackScholesPrice(0, 5800, sigma, T, 'call')).toBe(0);
    expect(blackScholesPrice(spot, 0, sigma, T, 'call')).toBe(0);
  });

  it('option prices are always non-negative', () => {
    const strikes = [5500, 5700, 5800, 5900, 6100];
    for (const K of strikes) {
      expect(
        blackScholesPrice(spot, K, sigma, T, 'call'),
      ).toBeGreaterThanOrEqual(0);
      expect(
        blackScholesPrice(spot, K, sigma, T, 'put'),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('ATM call and put have similar prices (r=0)', () => {
    // With r=0, put-call parity gives: C - P = S - K
    // ATM: S = K, so C = P
    const callPrice = blackScholesPrice(spot, spot, sigma, T, 'call');
    const putPrice = blackScholesPrice(spot, spot, sigma, T, 'put');
    expect(callPrice).toBeCloseTo(putPrice, 1);
  });

  it('satisfies put-call parity: C - P = S - K (r=0)', () => {
    const strikes = [5700, 5750, 5800, 5850, 5900];
    for (const K of strikes) {
      const C = blackScholesPrice(spot, K, sigma, T, 'call');
      const P = blackScholesPrice(spot, K, sigma, T, 'put');
      expect(C - P).toBeCloseTo(spot - K, 2);
    }
  });

  it('deep ITM call is approximately spot - strike', () => {
    const K = 5400;
    const C = blackScholesPrice(spot, K, sigma, T, 'call');
    expect(C).toBeCloseTo(spot - K, 0);
  });

  it('deep ITM put is approximately strike - spot', () => {
    const K = 6200;
    const P = blackScholesPrice(spot, K, sigma, T, 'put');
    expect(P).toBeCloseTo(K - spot, 0);
  });

  it('deep OTM call is near 0', () => {
    const C = blackScholesPrice(spot, 6200, sigma, T, 'call');
    expect(C).toBeLessThan(0.01);
  });

  it('deep OTM put is near 0', () => {
    const P = blackScholesPrice(spot, 5400, sigma, T, 'put');
    expect(P).toBeLessThan(0.01);
  });

  it('price increases with sigma (higher vol = higher option price)', () => {
    const p1 = blackScholesPrice(spot, spot, 0.1, T, 'call');
    const p2 = blackScholesPrice(spot, spot, 0.2, T, 'call');
    const p3 = blackScholesPrice(spot, spot, 0.3, T, 'call');
    expect(p3).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p1);
  });

  it('price increases with T (more time = higher option price)', () => {
    const p1 = blackScholesPrice(spot, spot, sigma, 1 / 252, 'call');
    const p2 = blackScholesPrice(spot, spot, sigma, 5 / 252, 'call');
    const p3 = blackScholesPrice(spot, spot, sigma, 20 / 252, 'call');
    expect(p3).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p1);
  });

  it('call price increases as strike decreases', () => {
    const c1 = blackScholesPrice(spot, 5900, sigma, T, 'call');
    const c2 = blackScholesPrice(spot, 5800, sigma, T, 'call');
    const c3 = blackScholesPrice(spot, 5700, sigma, T, 'call');
    expect(c3).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c1);
  });

  it('put price increases as strike increases', () => {
    const p1 = blackScholesPrice(spot, 5700, sigma, T, 'put');
    const p2 = blackScholesPrice(spot, 5800, sigma, T, 'put');
    const p3 = blackScholesPrice(spot, 5900, sigma, T, 'put');
    expect(p3).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p1);
  });
});

// ── calcIVAcceleration ─────────────────────────────────────────

describe('calcIVAcceleration', () => {
  it('returns 1.0 at market open (6.5 hours remaining)', () => {
    expect(calcIVAcceleration(MARKET.HOURS_PER_DAY)).toBe(1);
  });

  it('returns 1.0 for hours >= HOURS_PER_DAY', () => {
    expect(calcIVAcceleration(7)).toBe(1);
    expect(calcIVAcceleration(10)).toBe(1);
  });

  it('returns IV_ACCEL_MAX at 0 hours remaining', () => {
    expect(calcIVAcceleration(0)).toBe(DEFAULTS.IV_ACCEL_MAX);
  });

  it('returns IV_ACCEL_MAX for negative hours', () => {
    expect(calcIVAcceleration(-1)).toBe(DEFAULTS.IV_ACCEL_MAX);
  });

  it('acceleration increases as hours decrease', () => {
    const a6 = calcIVAcceleration(6);
    const a4 = calcIVAcceleration(4);
    const a2 = calcIVAcceleration(2);
    const a1 = calcIVAcceleration(1);
    expect(a1).toBeGreaterThan(a2);
    expect(a2).toBeGreaterThan(a4);
    expect(a4).toBeGreaterThan(a6);
  });

  it('acceleration is between 1 and IV_ACCEL_MAX for valid hours', () => {
    for (const h of [0.5, 1, 2, 3, 4, 5, 6]) {
      const accel = calcIVAcceleration(h);
      expect(accel).toBeGreaterThanOrEqual(1);
      expect(accel).toBeLessThanOrEqual(DEFAULTS.IV_ACCEL_MAX);
    }
  });

  it('matches expected values at key time points', () => {
    // At 2h: mult = 1 + 0.6 × (1/2 - 1/6.5) = 1 + 0.6 × 0.346 = ~1.208
    const at2h = calcIVAcceleration(2);
    expect(at2h).toBeCloseTo(1.208, 2);

    // At 1h: mult = 1 + 0.6 × (1/1 - 1/6.5) = 1 + 0.6 × 0.846 = ~1.508
    const at1h = calcIVAcceleration(1);
    expect(at1h).toBeCloseTo(1.508, 2);
  });
});

// ── impliedVolatility ──────────────────────────────────────────

describe('impliedVolatility', () => {
  // Round-trip check: pick a σ, price the option, invert it back → same σ.
  // Uses T = 1/365 (≈ 0DTE at open) so the test exercises the short-T
  // regime the Strike IV Anomaly Detector actually runs in.
  const roundTripCases: Array<{
    spot: number;
    strike: number;
    sigma: number;
    T: number;
    type: 'call' | 'put';
    label: string;
  }> = [
    {
      spot: 7100,
      strike: 7080,
      sigma: 0.2,
      T: 1 / 365,
      type: 'put',
      label: 'OTM SPX put, 1 DTE, 20% vol',
    },
    {
      spot: 7100,
      strike: 7150,
      sigma: 0.25,
      T: 1 / 365,
      type: 'call',
      label: 'OTM SPX call, 1 DTE, 25% vol',
    },
    {
      spot: 710,
      strike: 705,
      sigma: 0.18,
      T: 2 / 365,
      type: 'put',
      label: 'OTM SPY put, 2 DTE, 18% vol',
    },
    {
      spot: 500,
      strike: 510,
      sigma: 0.3,
      T: 5 / 365,
      type: 'call',
      label: 'OTM QQQ call, 5 DTE, 30% vol',
    },
    {
      spot: 7100,
      strike: 7100,
      sigma: 0.22,
      T: 1 / 365,
      type: 'call',
      label: 'ATM SPX call, 1 DTE',
    },
  ];

  for (const { spot, strike, sigma, T, type, label } of roundTripCases) {
    it(`round-trips σ=${sigma} for ${label}`, () => {
      const price = blackScholesPrice(spot, strike, sigma, T, type);
      const solved = impliedVolatility(price, spot, strike, T, type);
      expect(solved).not.toBeNull();
      // 4 decimal places is ~1bp — tighter than anyone trades.
      expect(solved).toBeCloseTo(sigma, 4);
    });
  }

  it('returns null for a price below intrinsic', () => {
    // Call with spot=7100, strike=7000 → intrinsic=100. Quote 50 = arbitrage.
    const iv = impliedVolatility(50, 7100, 7000, 1 / 365, 'call');
    expect(iv).toBeNull();
  });

  it('returns null for a price at or above the upper bound', () => {
    // Call upper bound (r=0) = spot. Price >= spot is infeasible.
    expect(impliedVolatility(7100, 7100, 7000, 1 / 365, 'call')).toBeNull();
    // Put upper bound = strike. Price >= strike is infeasible.
    expect(impliedVolatility(7000, 7100, 7000, 1 / 365, 'put')).toBeNull();
  });

  it('returns null for non-finite / non-positive inputs', () => {
    expect(impliedVolatility(NaN, 7100, 7080, 1 / 365, 'put')).toBeNull();
    expect(impliedVolatility(5, -1, 7080, 1 / 365, 'put')).toBeNull();
    expect(impliedVolatility(5, 7100, 0, 1 / 365, 'put')).toBeNull();
    expect(impliedVolatility(5, 7100, 7080, 0, 'put')).toBeNull();
    expect(impliedVolatility(-1, 7100, 7080, 1 / 365, 'put')).toBeNull();
  });

  it('handles deep-OTM options where vega is small but positive', () => {
    // 5% OTM with 1-day to expiry and moderate vol — mid vega is small but
    // inversion should still succeed (Newton falls back to bisection).
    // Precision falls off in the deep tail (vega ≈ 0) so we accept ~2
    // decimal places, which is still well within trading tolerance.
    const price = blackScholesPrice(7100, 6750, 0.2, 1 / 365, 'put');
    // Only test if there's enough premium to invert from (very deep OTM
    // prices can be below the default tolerance).
    if (price > 1e-6) {
      const solved = impliedVolatility(price, 7100, 6750, 1 / 365, 'put');
      expect(solved).not.toBeNull();
      expect(solved).toBeCloseTo(0.2, 2);
    }
  });

  // ── Bisection fallback path (lines 262-278) ────────────────────
  // These exercise the safety-net path that runs whenever Newton
  // breaks out (vega collapse, step out of bracket, or maxIter
  // exhausted). The bisection guarantees convergence whenever the
  // true σ lies inside [sigmaMin, sigmaMax], and returns null when
  // the bracket cannot contain the price.

  it('bisection-only path converges to the true σ when Newton is skipped', () => {
    // maxIter=0 forces the loop to no-op, so the entire result comes
    // from the bisection block. Confirms the bisection logic itself
    // is correct (within the ~1e-6 tolerance / 80 iter budget).
    const trueSigma = 0.2;
    const price = blackScholesPrice(7100, 7080, trueSigma, 1 / 365, 'put');
    const solved = impliedVolatility(price, 7100, 7080, 1 / 365, 'put', {
      maxIter: 0,
    });
    expect(solved).not.toBeNull();
    expect(solved).toBeCloseTo(trueSigma, 5);
  });

  it('bisection returns null when the price is below the bracket lower bound', () => {
    // True σ=0.2 but bracket = [0.5, 0.6]. price(0.5) > price(0.2),
    // so price < loPrice and the feasibility check rejects.
    const price = blackScholesPrice(7100, 7080, 0.2, 1 / 365, 'put');
    const iv = impliedVolatility(price, 7100, 7080, 1 / 365, 'put', {
      sigmaMin: 0.5,
      sigmaMax: 0.6,
      maxIter: 0,
    });
    expect(iv).toBeNull();
  });

  it('bisection returns null when the price is above the bracket upper bound', () => {
    // True σ=0.2 but bracket = [0.01, 0.05]. price(0.05) < price(0.2),
    // so price > hiPrice and the feasibility check rejects.
    const price = blackScholesPrice(7100, 7080, 0.2, 1 / 365, 'put');
    const iv = impliedVolatility(price, 7100, 7080, 1 / 365, 'put', {
      sigmaMin: 0.01,
      sigmaMax: 0.05,
      maxIter: 0,
    });
    expect(iv).toBeNull();
  });

  it('bisection exits early via the hi-lo<tol shortcut on a loose tolerance', () => {
    // tol=1 (one full vol point) is wider than any halving step from the
    // default bracket [1e-6, 5], so the `hi - lo < tol` shortcut on
    // line 275 fires before midPrice can converge. With trueSigma=0.2 the
    // bracket halves down to (1e-6, 0.625) on the third iteration; that's
    // when hi-lo first drops below 1 and the loop returns (lo+hi)/2 =
    // exactly 0.3125 (plus the lo/2 contribution from 1e-6).
    const targetPrice = blackScholesPrice(7100, 7080, 0.2, 1 / 365, 'put');
    const iv = impliedVolatility(targetPrice, 7100, 7080, 1 / 365, 'put', {
      tol: 1,
      maxIter: 0,
    });
    expect(iv).not.toBeNull();
    expect(iv).toBeCloseTo(0.3125, 5);
  });

  it('falls through to bisection when Newton steps outside the bracket', () => {
    // Cap sigmaMax below the true σ. Newton's first step will cross
    // sigmaMax and break (line 256), then bisection runs and rejects
    // because the price exceeds price(sigmaMax).
    const price = blackScholesPrice(7100, 7080, 0.2, 1 / 365, 'put');
    const iv = impliedVolatility(price, 7100, 7080, 1 / 365, 'put', {
      sigmaMax: 0.15,
    });
    expect(iv).toBeNull();
  });

  it('rejects when Newton converges but final σ is below sigmaMin', () => {
    // Newton converges on σ=0.2; sigmaMin=0.5 trips the post-convergence
    // bound check (line 246), then bisection rejects since price < loPrice.
    const price = blackScholesPrice(7100, 7080, 0.2, 1 / 365, 'put');
    const iv = impliedVolatility(price, 7100, 7080, 1 / 365, 'put', {
      sigmaMin: 0.5,
    });
    expect(iv).toBeNull();
  });

  // ── Extreme-input boundary tests ───────────────────────────────

  it('round-trips a very high IV (200%) round number', () => {
    // VIX-blowoff regime: 1 DTE 200% vol. Confirms the inverter
    // doesn't choke on large σ inside the default [1e-6, 5] bracket.
    const trueSigma = 2.0;
    const price = blackScholesPrice(7100, 7100, trueSigma, 1 / 365, 'call');
    const iv = impliedVolatility(price, 7100, 7100, 1 / 365, 'call');
    expect(iv).not.toBeNull();
    expect(iv).toBeCloseTo(trueSigma, 4);
  });

  it('round-trips a low-vol ATM option (5% vol)', () => {
    // Quiet-tape regime: ATM SPX 0DTE with 5% vol. ATM keeps vega
    // meaningful so the small-σ side of the bracket is invertible
    // without precision loss (deep-ITM at 1% vol collapses time value
    // below float epsilon — caller-side concern, not a bug).
    const trueSigma = 0.05;
    const price = blackScholesPrice(7100, 7100, trueSigma, 1 / 365, 'call');
    const iv = impliedVolatility(price, 7100, 7100, 1 / 365, 'call');
    expect(iv).not.toBeNull();
    expect(iv).toBeCloseTo(trueSigma, 4);
  });
});
