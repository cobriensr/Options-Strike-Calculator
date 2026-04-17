import {
  DELTA_Z_SCORES,
  DELTA_OPTIONS,
  DEFAULTS,
  MARKET,
  DEFAULT_SPX_SPY_RATIO,
} from '../constants/index.js';
import type {
  DeltaTarget,
  StrikeResult,
  StrikeError,
  DeltaRow,
  DeltaRowError,
} from '../types/index.js';
import {
  calcBSDelta,
  calcBSGamma,
  calcBSTheta,
  blackScholesPrice,
  calcIVAcceleration,
} from './black-scholes.js';
import { roundToHalf } from './formatting.js';

/**
 * Snaps a strike price to the nearest increment.
 */
export function snapToIncrement(
  strike: number,
  increment: number = DEFAULTS.STRIKE_INCREMENT,
): number {
  return Math.round(strike / increment) * increment;
}

/**
 * Calculates the skew-adjusted sigma for puts at a given z-score.
 * Uses a convex (power) curve: further OTM puts get disproportionately
 * more skew, matching real SPX volatility smile behavior.
 *
 * Put skew: skew × (z / z_ref)^convexity
 *   convexity > 1 → steeper far OTM (5Δ gets ~35% more skew than linear)
 *
 * Example with 3% skew at 10Δ reference (convexity = 1.35):
 *   5Δ (z=1.645): put skew = 0.03 × (1.645/1.28)^1.35 = 0.03 × 1.38 = 4.15%
 *  10Δ (z=1.280): put skew = 0.03 × 1.00                            = 3.00%
 *  20Δ (z=0.842): put skew = 0.03 × (0.842/1.28)^1.35 = 0.03 × 0.56 = 1.69%
 */
export function calcScaledSkew(skew: number, z: number): number {
  if (skew === 0 || !Number.isFinite(z) || z <= 0) return 0;
  const ratio = z / DEFAULTS.SKEW_REFERENCE_Z;
  return skew * Math.pow(ratio, DEFAULTS.SKEW_PUT_CONVEXITY);
}

/**
 * Calculates the skew-adjusted sigma for calls at a given z-score.
 * Call skew flattens further OTM (and sometimes inverts on rally days),
 * so we dampen the skew at high z-scores.
 *
 * Call skew: skew × (z / z_ref) × dampening_factor
 *   dampening = 1 / (1 + CALL_DAMPENING × max(0, z/z_ref - 1))
 *   At 10Δ: no dampening. At 5Δ: ~15-20% less skew than linear.
 */
export function calcScaledCallSkew(skew: number, z: number): number {
  if (skew === 0 || !Number.isFinite(z) || z <= 0) return 0;
  const ratio = z / DEFAULTS.SKEW_REFERENCE_Z;
  const dampening =
    1 / (1 + DEFAULTS.SKEW_CALL_DAMPENING * Math.max(0, ratio - 1));
  return skew * ratio * dampening;
}

/**
 * Calculates put and call strikes for a given delta.
 *
 * Exact delta-targeted strike formula (with log-normal drift correction):
 *   K_put  = S × e^(-z × σ_put × √T + (σ_put²/2) × T)
 *   K_call = S × e^(+z × σ_call × √T - (σ_call²/2) × T)
 *
 * The (σ²/2)T drift correction accounts for the convexity adjustment in the
 * log-normal distribution. For puts it brings the strike closer to spot (+ sign),
 * for calls it also brings the strike closer to spot (- sign). Without it,
 * strikes are placed ~0.5 SPX points too far OTM. Small for 0DTE but
 * mathematically correct.
 *
 * Skew uses convex put curve and dampened call curve to match
 * the real SPX volatility smile shape.
 */
export function calcStrikes(
  spotPrice: number,
  sigma: number,
  T: number,
  delta: DeltaTarget,
  skew: number = 0,
  callSkewOverride?: number,
): StrikeResult | StrikeError {
  const z = DELTA_Z_SCORES[delta];
  if (z === undefined) {
    return { error: `No z-score for delta ${String(delta)}` };
  }

  const sqrtT = Math.sqrt(T);
  const putSkew = calcScaledSkew(skew, z);
  // When callSkewOverride is provided, use it independently; otherwise derive from put skew
  const callSkew =
    callSkewOverride != null
      ? calcScaledCallSkew(callSkewOverride, z)
      : calcScaledCallSkew(skew, z);
  const putSigma = sigma * (1 + putSkew);
  const callSigma = sigma * (1 - callSkew);

  // Drift correction: (σ²/2) × T
  const putDrift = ((putSigma * putSigma) / 2) * T;
  const callDrift = ((callSigma * callSigma) / 2) * T;

  const putStrike = Math.round(
    spotPrice * Math.exp(-z * putSigma * sqrtT + putDrift),
  );
  const callStrike = Math.round(
    spotPrice * Math.exp(z * callSigma * sqrtT - callDrift),
  );

  return {
    putStrike,
    callStrike,
    putStrikeSnapped: snapToIncrement(putStrike),
    callStrikeSnapped: snapToIncrement(callStrike),
  };
}

/**
 * Type guard: checks if a strike result is an error.
 */
export function isStrikeError(
  result: StrikeResult | StrikeError,
): result is StrikeError {
  return 'error' in result;
}

/**
 * Calculates strikes and theoretical premiums for all delta targets.
 * spxToSpyRatio is used for SPY equivalents (default 10).
 * hoursRemaining is used for IV acceleration (default: derive from T).
 *
 * Strike placement uses the base σ (no acceleration) because strikes
 * are chosen based on the full-session probability of the move.
 * Premium pricing uses accelerated σ because it reflects current market
 * conditions and what you'd actually pay/receive now.
 */
export function calcAllDeltas(
  spotPrice: number,
  sigma: number,
  T: number,
  skew: number = 0,
  spxToSpyRatio: number = DEFAULT_SPX_SPY_RATIO,
  callSkewOverride?: number,
): ReadonlyArray<DeltaRow | DeltaRowError> {
  // IV acceleration based on time remaining
  const hoursRemaining = T * MARKET.ANNUAL_TRADING_HOURS;
  const ivAccelMult = calcIVAcceleration(hoursRemaining);
  // Effective call skew: independent override or derived from put skew
  const effectiveCallSkew = callSkewOverride ?? skew;

  return DELTA_OPTIONS.map((d: DeltaTarget): DeltaRow | DeltaRowError => {
    // Strikes placed using base σ (full-session probability)
    const result = calcStrikes(spotPrice, sigma, T, d, skew, callSkewOverride);

    if (isStrikeError(result)) {
      return { delta: d, error: result.error };
    }

    // Base σ (skew only, no acceleration) — used for settlement PoP
    const basePutSigma = sigma * (1 + calcScaledSkew(skew, DELTA_Z_SCORES[d]));
    const baseCallSigma =
      sigma * (1 - calcScaledCallSkew(effectiveCallSkew, DELTA_Z_SCORES[d]));

    // Premiums and Greeks use accelerated σ (current market conditions)
    const accelSigma = sigma * ivAccelMult;
    const putSigma = accelSigma * (1 + calcScaledSkew(skew, DELTA_Z_SCORES[d]));
    const callSigma =
      accelSigma *
      (1 - calcScaledCallSkew(effectiveCallSkew, DELTA_Z_SCORES[d]));
    const spyPutRaw = result.putStrike / spxToSpyRatio;
    const spyCallRaw = result.callStrike / spxToSpyRatio;

    const putPremium = blackScholesPrice(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
      'put',
    );
    const callPremium = blackScholesPrice(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
      'call',
    );

    // Actual BS Greeks at the snapped strikes (using accelerated σ)
    const putActualDelta = calcBSDelta(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
      'put',
    );
    const callActualDelta = calcBSDelta(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
      'call',
    );
    const putGamma = calcBSGamma(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
    );
    const callGamma = calcBSGamma(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
    );
    const putTheta = calcBSTheta(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
    );
    const callTheta = calcBSTheta(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
    );

    return {
      delta: d,
      z: DELTA_Z_SCORES[d],
      putStrike: result.putStrike,
      callStrike: result.callStrike,
      putSnapped: result.putStrikeSnapped,
      callSnapped: result.callStrikeSnapped,
      putSpySnapped: roundToHalf(spyPutRaw),
      callSpySnapped: roundToHalf(spyCallRaw),
      spyPut: spyPutRaw.toFixed(2),
      spyCall: spyCallRaw.toFixed(2),
      putDistance: spotPrice - result.putStrike,
      callDistance: result.callStrike - spotPrice,
      putPct: (((spotPrice - result.putStrike) / spotPrice) * 100).toFixed(2),
      callPct: (((result.callStrike - spotPrice) / spotPrice) * 100).toFixed(2),
      putPremium,
      callPremium,
      putSigma,
      callSigma,
      basePutSigma,
      baseCallSigma,
      putActualDelta,
      callActualDelta,
      putGamma,
      callGamma,
      putTheta,
      callTheta,
      ivAccelMult,
    };
  });
}

/**
 * Converts SPX strike to approximate SPY equivalent.
 */
export function spxToSpy(strike: number): string {
  return (strike / DEFAULT_SPX_SPY_RATIO).toFixed(2);
}
