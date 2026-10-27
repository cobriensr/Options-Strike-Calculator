import {
  DEFAULT_SPX_SPY_RATIO,
  DEFAULTS,
  getKurtosisFactor,
} from '../constants/index.js';
import type { DeltaRow, BWBLegs } from '../types/index.js';
import {
  blackScholesPrice,
  calcBSDelta,
  calcBSGamma,
  calcBSTheta,
  calcBSVega,
} from './black-scholes.js';
import { snapToSpyHalf } from './formatting.js';
import { adjustPoPForKurtosis, calcSpreadPoP } from './iron-condor.js';
import { snapToIncrement } from './strikes.js';

/**
 * Far-wing strike of a BWB: the short strike ∓ the requested wide width,
 * rounded onto the strike grid AWAY from the short strike (owner decision
 * Q2 in review-remediation-2026-10-26). Puts floor and calls ceil, so an
 * off-grid request (15 × 2.5 = 37.5) widens to 40 on both sides, and an
 * on-grid target stays exactly where it is.
 */
export function snapBWBFarStrike(
  shortStrike: number,
  wideWidth: number,
  side: 'put' | 'call',
): number {
  const inc = DEFAULTS.STRIKE_INCREMENT;
  // The 1e-9 keeps an on-grid target in place when the division lands a
  // hair off the integer.
  return side === 'put'
    ? Math.floor((shortStrike - wideWidth) / inc + 1e-9) * inc
    : Math.ceil((shortStrike + wideWidth) / inc - 1e-9) * inc;
}

/**
 * Wide-wing width a BWB actually trades for a requested width (37.5 → 40,
 * 40 → 40), for labels. Every production short strike sits on the strike
 * grid, where this equals the builders' wideWidth on both sides.
 */
export function snapBWBWideWidth(wideWidth: number): number {
  // + 0 turns the -0 that Math.ceil(-1e-9) gives for a 0 width into 0
  return snapBWBFarStrike(0, wideWidth, 'call') + 0;
}

/**
 * Payoff summary of a BWB, computed from its actual (snapped) strikes.
 *
 * A BWB whose far side loses (wide - narrow - netCredit > 0, every
 * production combo) has a far-side breakeven. A debit BWB (netCredit < 0)
 * also loses its debit when every leg expires worthless, so it has a
 * second, near-side breakeven and profits only between the two. PoP is
 * the log-normal mass of that zone. `calcSpreadPoP(level, side)` is the
 * probability of settling on the short-strike side of `level` for both
 * sides, so PoP = calcSpreadPoP(far BE) - calcSpreadPoP(near BE) for puts
 * and calls alike. When the far side can't lose (inverted or zero-width
 * far wing), `breakeven` is meaningless and the far term is 1.
 *
 * The fat-tail adjustment scales the profit band by the far-tail survival
 * ratio, adjustPoPForKurtosis(P_far) / P_far, which for a credit is the
 * credit-spread adjustment itself. H1 (Phase 3.10 of
 * review-remediation-2026-10-26) will revisit the fat-tail model.
 */
function summarizeBWBPayoff(
  side: 'put' | 'call',
  shortStrike: number,
  longNearStrike: number,
  longFarStrike: number,
  netCredit: number,
  spotPrice: number,
  popSigma: number,
  T: number,
  vix: number | undefined,
): Pick<
  BWBLegs,
  | 'narrowWidth'
  | 'wideWidth'
  | 'maxProfit'
  | 'maxLoss'
  | 'breakeven'
  | 'breakevenNear'
  | 'returnOnRisk'
  | 'probabilityOfProfit'
  | 'adjustedPoP'
> {
  // +1 when the near wing sits above the short strike (put), -1 below (call)
  const dir = side === 'put' ? 1 : -1;
  const narrowWidth = Math.abs(longNearStrike - shortStrike);
  const wideWidth = Math.abs(shortStrike - longFarStrike);
  const maxProfit = narrowWidth + netCredit;
  // Worst of the two flat regions: beyond the near wing the trade keeps
  // netCredit (a loss when it is a debit); beyond the far wing it loses
  // wide - narrow - netCredit. Clamped to 0 so a structure that cannot
  // lose never shows a negative "loss". Production UI keeps
  // wide >= 1.5 × narrow, but the builders are callable directly.
  // (FE-MATH-004)
  const maxLoss = Math.max(0, -netCredit, wideWidth - narrowWidth - netCredit);
  const breakeven = shortStrike - dir * maxProfit;
  const breakevenNear = netCredit < 0 ? longNearStrike + dir * netCredit : null;
  const returnOnRisk = maxLoss > 0 ? netCredit / maxLoss : 0;

  // With inverted or zero-width far wings the far flat region never loses
  // (wide - narrow - netCredit <= 0), so the profit zone runs all the way
  // out on that side: there is no far tail to breach or to fatten.
  const farSideLoses = wideWidth - narrowWidth - netCredit > 0;
  const pFar = farSideLoses
    ? calcSpreadPoP(spotPrice, breakeven, popSigma, T, side)
    : 1;
  const pNear =
    breakevenNear == null
      ? 0
      : calcSpreadPoP(spotPrice, breakevenNear, popSigma, T, side);
  const probabilityOfProfit = Math.max(0, pFar - pNear);
  // Fat tails: scale the profit band by the far-tail survival ratio. With
  // no near breakeven (a credit) this is exactly adjustPoPForKurtosis(PoP).
  const farTailSurvival =
    farSideLoses && pFar > 0
      ? adjustPoPForKurtosis(pFar, getKurtosisFactor(vix), side) / pFar
      : 1;
  const adjustedPoP = probabilityOfProfit * farTailSurvival;

  return {
    narrowWidth,
    wideWidth,
    maxProfit,
    maxLoss,
    breakeven,
    breakevenNear,
    returnOnRisk,
    probabilityOfProfit,
    adjustedPoP,
  };
}

/**
 * Builds a Put BWB (all puts) for a given delta row.
 *
 * Structure (from highest to lowest strike):
 *   Buy 1 put  at longNearStrike  (closer to money — credit side)
 *   Sell 2 puts at shortStrike     (sweet spot)
 *   Buy 1 put  at longFarStrike   (further OTM — risk side)
 *
 * The `narrowWidth` / `wideWidth` arguments are the requested widths. The
 * wings are snapped to the strike grid, and the far wing snaps away from
 * the short strike (snapBWBFarStrike), so 15 × 2.5 = 37.5 trades 40 wide
 * here and on the call side. Every returned width and payoff number comes
 * from the snapped strikes:
 *
 * narrowWidth = longNearStrike - shortStrike
 * wideWidth   = shortStrike - longFarStrike
 *
 * P&L at expiry:
 *   S >= longNear:  profit = netCredit (credit kept, or debit lost)
 *   S == short:     profit = narrowWidth + netCredit (max profit)
 *   S == breakeven: profit = 0
 *   S <= longFar:   loss = -(wideWidth - narrowWidth - netCredit) (max loss, capped)
 *
 * Breakeven     = 2×shortStrike - longNearStrike - netCredit
 * BreakevenNear = longNearStrike + netCredit (debit BWBs only)
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
  const longFarStrike = snapBWBFarStrike(shortStrike, wideWidth, 'put');
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
  // PoP uses base sigma (no IV acceleration) — settlement probability
  const payoff = summarizeBWBPayoff(
    'put',
    shortStrike,
    longNearStrike,
    longFarStrike,
    netCredit,
    spotPrice,
    row.basePutSigma ?? row.putSigma,
    T,
    vix,
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
    shortPremium,
    longNearPremium,
    longFarPremium,
    netCredit,
    ...payoff,
    sweetSpot: shortStrike,
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
 * Widths come from the snapped strikes, and the far wing snaps away from
 * the short strike, as in buildPutBWB:
 *
 * narrowWidth = shortStrike - longNearStrike
 * wideWidth   = longFarStrike - shortStrike
 *
 * P&L at expiry:
 *   S <= longNear:  profit = netCredit (credit kept, or debit lost)
 *   S == short:     profit = narrowWidth + netCredit (max profit)
 *   S == breakeven: profit = 0
 *   S >= longFar:   loss = -(wideWidth - narrowWidth - netCredit) (max loss, capped)
 *
 * Breakeven     = 2×shortStrike - longNearStrike + netCredit
 * BreakevenNear = longNearStrike - netCredit (debit BWBs only)
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
  const longFarStrike = snapBWBFarStrike(shortStrike, wideWidth, 'call');
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
  // PoP uses base sigma (no IV acceleration) — settlement probability
  const payoff = summarizeBWBPayoff(
    'call',
    shortStrike,
    longNearStrike,
    longFarStrike,
    netCredit,
    spotPrice,
    row.baseCallSigma ?? row.callSigma,
    T,
    vix,
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
    shortPremium,
    longNearPremium,
    longFarPremium,
    netCredit,
    ...payoff,
    sweetSpot: shortStrike,
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
