import { DEFAULT_SPX_SPY_RATIO, getKurtosisFactor } from '../constants';
import type { DeltaRow, BWBLegs } from '../types';
import {
  blackScholesPrice,
  calcBSDelta,
  calcBSGamma,
  calcBSTheta,
  calcBSVega,
} from './black-scholes';
import { snapToSpyHalf } from './formatting';
import { adjustPoPForKurtosis, calcSpreadPoP } from './iron-condor';
import { snapToIncrement } from './strikes';

/**
 * Builds a Put BWB (all puts) for a given delta row.
 *
 * Structure (from highest to lowest strike):
 *   Buy 1 put  at longNearStrike  (closer to money — credit side)
 *   Sell 2 puts at shortStrike     (sweet spot)
 *   Buy 1 put  at longFarStrike   (further OTM — risk side)
 *
 * narrowWidth = longNearStrike - shortStrike
 * wideWidth   = shortStrike - longFarStrike
 *
 * P&L at expiry:
 *   S >= longNear:  profit = netCredit (credit kept)
 *   S == short:     profit = narrowWidth + netCredit (max profit)
 *   S == breakeven: profit = 0
 *   S <= longFar:   loss = -(wideWidth - narrowWidth - netCredit) (max loss, capped)
 *
 * Breakeven = 2×shortStrike - longNearStrike - netCredit
 */
export function buildPutBWB(
  row: DeltaRow,
  narrowWidth: number,
  wideWidth: number,
  spotPrice: number,
  T: number,
  spxToSpyRatio: number = DEFAULT_SPX_SPY_RATIO,
  vix?: number,
): BWBLegs {
  const shortStrike = row.putSnapped;
  const longNearStrike = snapToIncrement(shortStrike + narrowWidth);
  const longFarStrike = snapToIncrement(shortStrike - wideWidth);
  const sigma = row.putSigma;

  // Price all legs
  const shortPremium = blackScholesPrice(
    spotPrice,
    shortStrike,
    sigma,
    T,
    'put',
  );
  const longNearPremium = blackScholesPrice(
    spotPrice,
    longNearStrike,
    sigma,
    T,
    'put',
  );
  const longFarPremium = blackScholesPrice(
    spotPrice,
    longFarStrike,
    sigma,
    T,
    'put',
  );

  const netCredit = 2 * shortPremium - longNearPremium - longFarPremium;
  const maxProfit = narrowWidth + netCredit;
  // Clamp to 0 so the field never reports a negative "loss": for symmetric
  // or inverted wings with positive net credit, the deep-wing payoff is
  // `narrow - wide + netCredit ≥ 0`, so there is no scenario that loses
  // money. Production UI constrains `wideWidth > narrowWidth` via
  // BWB_WIDE_MULTIPLIERS (>= 1.5), but the function is callable directly
  // from tests and exports, so clamping is defensive. (FE-MATH-004)
  const maxLoss = Math.max(0, wideWidth - narrowWidth - netCredit);
  const breakeven = 2 * shortStrike - longNearStrike - netCredit;
  const returnOnRisk = maxLoss > 0 ? netCredit / maxLoss : 0;

  // PoP uses base sigma (no IV acceleration) — settlement probability
  const popSigma = row.basePutSigma ?? row.putSigma;
  const probabilityOfProfit = calcSpreadPoP(
    spotPrice,
    breakeven,
    popSigma,
    T,
    'put',
  );
  const adjustedPoP = adjustPoPForKurtosis(
    probabilityOfProfit,
    getKurtosisFactor(vix),
    'put',
  );

  // Aggregate Greeks: +1 long near, -2 short, +1 long far
  const nearDelta = calcBSDelta(spotPrice, longNearStrike, sigma, T, 'put');
  const shortDelta = calcBSDelta(spotPrice, shortStrike, sigma, T, 'put');
  const farDelta = calcBSDelta(spotPrice, longFarStrike, sigma, T, 'put');
  // Put deltas are returned as absolute values; signed: long = -delta, short = +delta
  const netDelta = -nearDelta + 2 * shortDelta - farDelta;

  const nearGamma = calcBSGamma(spotPrice, longNearStrike, sigma, T);
  const shortGamma = calcBSGamma(spotPrice, shortStrike, sigma, T);
  const farGamma = calcBSGamma(spotPrice, longFarStrike, sigma, T);
  const netGamma = nearGamma - 2 * shortGamma + farGamma;

  const nearTheta = calcBSTheta(spotPrice, longNearStrike, sigma, T);
  const shortTheta = calcBSTheta(spotPrice, shortStrike, sigma, T);
  const farTheta = calcBSTheta(spotPrice, longFarStrike, sigma, T);
  // Theta is negative; long = negative theta, short = positive theta
  const netTheta = nearTheta - 2 * shortTheta + farTheta;

  const nearVega = calcBSVega(spotPrice, longNearStrike, sigma, T);
  const shortVega = calcBSVega(spotPrice, shortStrike, sigma, T);
  const farVega = calcBSVega(spotPrice, longFarStrike, sigma, T);
  const netVega = nearVega - 2 * shortVega + farVega;

  return {
    side: 'put',
    delta: row.delta,
    shortStrike,
    longNearStrike,
    longFarStrike,
    shortStrikeSpy: snapToSpyHalf(shortStrike, spxToSpyRatio),
    longNearStrikeSpy: snapToSpyHalf(longNearStrike, spxToSpyRatio),
    longFarStrikeSpy: snapToSpyHalf(longFarStrike, spxToSpyRatio),
    narrowWidth,
    wideWidth,
    shortPremium,
    longNearPremium,
    longFarPremium,
    netCredit,
    maxProfit,
    maxLoss,
    breakeven,
    sweetSpot: shortStrike,
    returnOnRisk,
    probabilityOfProfit,
    adjustedPoP,
    netDelta,
    netGamma,
    netTheta,
    netVega,
  };
}

/**
 * Builds a Call BWB (all calls) for a given delta row.
 *
 * Structure (from lowest to highest strike):
 *   Buy 1 call at longNearStrike  (closer to money — credit side)
 *   Sell 2 calls at shortStrike    (sweet spot)
 *   Buy 1 call at longFarStrike   (further OTM — risk side)
 *
 * narrowWidth = shortStrike - longNearStrike
 * wideWidth   = longFarStrike - shortStrike
 *
 * P&L at expiry:
 *   S <= longNear:  profit = netCredit (credit kept)
 *   S == short:     profit = narrowWidth + netCredit (max profit)
 *   S == breakeven: profit = 0
 *   S >= longFar:   loss = -(wideWidth - narrowWidth - netCredit) (max loss, capped)
 *
 * Breakeven = 2×shortStrike - longNearStrike + netCredit
 */
export function buildCallBWB(
  row: DeltaRow,
  narrowWidth: number,
  wideWidth: number,
  spotPrice: number,
  T: number,
  spxToSpyRatio: number = DEFAULT_SPX_SPY_RATIO,
  vix?: number,
): BWBLegs {
  const shortStrike = row.callSnapped;
  const longNearStrike = snapToIncrement(shortStrike - narrowWidth);
  const longFarStrike = snapToIncrement(shortStrike + wideWidth);
  const sigma = row.callSigma;

  // Price all legs
  const shortPremium = blackScholesPrice(
    spotPrice,
    shortStrike,
    sigma,
    T,
    'call',
  );
  const longNearPremium = blackScholesPrice(
    spotPrice,
    longNearStrike,
    sigma,
    T,
    'call',
  );
  const longFarPremium = blackScholesPrice(
    spotPrice,
    longFarStrike,
    sigma,
    T,
    'call',
  );

  const netCredit = 2 * shortPremium - longNearPremium - longFarPremium;
  const maxProfit = narrowWidth + netCredit;
  // See FE-MATH-004 note in buildPutBWB — same clamp semantics apply.
  const maxLoss = Math.max(0, wideWidth - narrowWidth - netCredit);
  const breakeven = 2 * shortStrike - longNearStrike + netCredit;
  const returnOnRisk = maxLoss > 0 ? netCredit / maxLoss : 0;

  // PoP uses base sigma (no IV acceleration) — settlement probability
  const popSigma = row.baseCallSigma ?? row.callSigma;
  const probabilityOfProfit = calcSpreadPoP(
    spotPrice,
    breakeven,
    popSigma,
    T,
    'call',
  );
  const adjustedPoP = adjustPoPForKurtosis(
    probabilityOfProfit,
    getKurtosisFactor(vix),
    'call',
  );

  // Aggregate Greeks: +1 long near, -2 short, +1 long far
  const nearDelta = calcBSDelta(spotPrice, longNearStrike, sigma, T, 'call');
  const shortDelta = calcBSDelta(spotPrice, shortStrike, sigma, T, 'call');
  const farDelta = calcBSDelta(spotPrice, longFarStrike, sigma, T, 'call');
  // Call deltas are positive; long = +delta, short = -delta
  const netDelta = nearDelta - 2 * shortDelta + farDelta;

  const nearGamma = calcBSGamma(spotPrice, longNearStrike, sigma, T);
  const shortGamma = calcBSGamma(spotPrice, shortStrike, sigma, T);
  const farGamma = calcBSGamma(spotPrice, longFarStrike, sigma, T);
  const netGamma = nearGamma - 2 * shortGamma + farGamma;

  const nearTheta = calcBSTheta(spotPrice, longNearStrike, sigma, T);
  const shortTheta = calcBSTheta(spotPrice, shortStrike, sigma, T);
  const farTheta = calcBSTheta(spotPrice, longFarStrike, sigma, T);
  const netTheta = nearTheta - 2 * shortTheta + farTheta;

  const nearVega = calcBSVega(spotPrice, longNearStrike, sigma, T);
  const shortVega = calcBSVega(spotPrice, shortStrike, sigma, T);
  const farVega = calcBSVega(spotPrice, longFarStrike, sigma, T);
  const netVega = nearVega - 2 * shortVega + farVega;

  return {
    side: 'call',
    delta: row.delta,
    shortStrike,
    longNearStrike,
    longFarStrike,
    shortStrikeSpy: snapToSpyHalf(shortStrike, spxToSpyRatio),
    longNearStrikeSpy: snapToSpyHalf(longNearStrike, spxToSpyRatio),
    longFarStrikeSpy: snapToSpyHalf(longFarStrike, spxToSpyRatio),
    narrowWidth,
    wideWidth,
    shortPremium,
    longNearPremium,
    longFarPremium,
    netCredit,
    maxProfit,
    maxLoss,
    breakeven,
    sweetSpot: shortStrike,
    returnOnRisk,
    probabilityOfProfit,
    adjustedPoP,
    netDelta,
    netGamma,
    netTheta,
    netVega,
  };
}

/**
 * Computes the P&L at a given SPX price at expiry for a BWB.
 * Used by the P&L profile table to show payoff at 5-pt intervals.
 */
export function bwbPnLAtExpiry(bwb: BWBLegs, spxAtExpiry: number): number {
  if (bwb.side === 'put') {
    // Put BWB: longNear > short > longFar
    const nearIntrinsic = Math.max(bwb.longNearStrike - spxAtExpiry, 0);
    const shortIntrinsic = Math.max(bwb.shortStrike - spxAtExpiry, 0);
    const farIntrinsic = Math.max(bwb.longFarStrike - spxAtExpiry, 0);
    return nearIntrinsic - 2 * shortIntrinsic + farIntrinsic + bwb.netCredit;
  }
  // Call BWB: longNear < short < longFar
  const nearIntrinsic = Math.max(spxAtExpiry - bwb.longNearStrike, 0);
  const shortIntrinsic = Math.max(spxAtExpiry - bwb.shortStrike, 0);
  const farIntrinsic = Math.max(spxAtExpiry - bwb.longFarStrike, 0);
  return nearIntrinsic - 2 * shortIntrinsic + farIntrinsic + bwb.netCredit;
}
