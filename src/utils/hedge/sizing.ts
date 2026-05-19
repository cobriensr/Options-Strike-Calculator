/**
 * Hedge contract-count sizing — given a strike+premium pricing and an
 * IC max-loss target, recommend how many put / call hedge contracts to
 * buy so the hedge covers the IC loss at `breakevenTarget × distance`.
 *
 * Extracted from `hedge.ts` during the Phase 2Q split. Pure: no
 * scenario generation, no orchestration.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2Q)
 */

import { SPX_MULTIPLIER } from '../../constants/index.js';
import { blackScholesPrice } from '../black-scholes.js';
import type { HedgeLegPricing } from './pricing.js';

export interface HedgeContractRecommendation {
  recommendedPuts: number;
  recommendedCalls: number;
}

/**
 * Recommend put/call hedge contract counts targeting an IC max-loss
 * payout at `breakevenTarget × distanceToHedgeStrike`. Sized using the
 * NET payout (BS value at EOD minus entry premium) per contract — that's
 * the actual P&L each contract generates at the target move. Contracts
 * are floored at 1 even when the target payout is non-positive so the
 * UI always displays a buyable size.
 */
export function recommendHedgeContracts(params: {
  spot: number;
  pricing: HedgeLegPricing;
  icContracts: number;
  icMaxLossPts: number;
  breakevenTarget: number;
}): HedgeContractRecommendation {
  const { spot, pricing, icContracts, icMaxLossPts, breakevenTarget } = params;
  const {
    putStrikeSnapped,
    callStrikeSnapped,
    putSigma,
    callSigma,
    putPremium,
    callPremium,
    tHedgeEod,
  } = pricing;

  // IC max loss in dollars (total position)
  const icMaxLossDollars = icMaxLossPts * SPX_MULTIPLIER * icContracts;

  // Distance from spot to hedge strikes
  const distToPutHedge = spot - putStrikeSnapped;
  const distToCallHedge = callStrikeSnapped - spot;

  // Target crash: breakevenTarget × distance to hedge strike
  const targetPutSpot = spot - distToPutHedge * breakevenTarget;
  const targetCallSpot = spot + distToCallHedge * breakevenTarget;

  const putValueAtTarget =
    tHedgeEod > 0
      ? blackScholesPrice(
          targetPutSpot,
          putStrikeSnapped,
          putSigma,
          tHedgeEod,
          'put',
        )
      : Math.max(0, putStrikeSnapped - targetPutSpot);
  const callValueAtTarget =
    tHedgeEod > 0
      ? blackScholesPrice(
          targetCallSpot,
          callStrikeSnapped,
          callSigma,
          tHedgeEod,
          'call',
        )
      : Math.max(0, targetCallSpot - callStrikeSnapped);

  const putPayoutAtTarget =
    Math.max(0, putValueAtTarget - putPremium) * SPX_MULTIPLIER;
  const callPayoutAtTarget =
    Math.max(0, callValueAtTarget - callPremium) * SPX_MULTIPLIER;

  const recommendedPuts =
    putPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / putPayoutAtTarget))
      : 1;
  const recommendedCalls =
    callPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / callPayoutAtTarget))
      : 1;

  return { recommendedPuts, recommendedCalls };
}
