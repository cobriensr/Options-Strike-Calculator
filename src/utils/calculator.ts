/**
 * Calculator barrel — re-exports all calculation modules.
 *
 * Consumers import from '../utils/calculator' and get everything.
 * The actual implementations live in focused modules:
 *   black-scholes.ts — Core BS math (CDF, delta, gamma, theta, vega, pricing)
 *   strikes.ts       — Strike placement, skew curves, delta table
 *   iron-condor.ts   — IC P&L, PoP, kurtosis adjustments
 *   hedge.ts         — Hedge calculator (reinsurance model)
 *   time.ts          — Time utilities, IV resolution, market validation
 */

export {
  normalCDF,
  normalPDF,
  calcBSDelta,
  calcBSGamma,
  calcBSVega,
  calcBSTheta,
  blackScholesPrice,
  calcIVAcceleration,
} from './black-scholes';

export {
  snapToIncrement,
  calcScaledSkew,
  calcScaledCallSkew,
  calcStrikes,
  isStrikeError,
  calcAllDeltas,
  spxToSpy,
} from './strikes';

export {
  adjustPoPForKurtosis,
  adjustICPoPForKurtosis,
  calcPoP,
  calcSpreadPoP,
  buildIronCondor,
  calcThetaCurve,
} from './iron-condor';

export { stressedSigma, calcHedge } from './hedge';

export {
  validateMarketTime,
  calcTimeToExpiry,
  resolveIV,
  to24Hour,
  toETTime,
} from './time';
