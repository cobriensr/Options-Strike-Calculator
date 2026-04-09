/**
 * Pure helpers for aggregate portfolio risk calculations.
 *
 * These compute account-level max loss across open credit spreads and iron
 * condors, optionally adjusted by a per-spread stop-loss multiplier, and
 * then gate that total against a % of NLV threshold (audit FE-STATE-006).
 *
 * ── IC MAX-not-SUM convention ──────────────────────────────────────
 * An iron condor is a put credit spread + call credit spread on the same
 * underlying at the same expiry. Price can only land inside one wing at
 * close, so only ONE side can realise its max loss. We therefore sum
 * effective losses per side across all verticals (stand-alone spreads
 * contribute to their own side; each IC contributes to both sides
 * independently) and then return `max(callSide, putSide)` as the
 * conservative aggregate.
 */

import type {
  IronCondor,
  Spread,
} from '../components/PositionMonitor/types';

/**
 * Compute effective max loss using per-spread stop multiplier.
 *
 * Each spread's effective loss = min(credit x multiplier, theoretical max).
 * For ICs, apply to each side independently (only one side can lose).
 *
 * `creditReceived` and `maxLoss` are already total dollar values
 * (per-contract credit * $100 multiplier * contracts), so no additional
 * scaling is applied here.
 *
 * @param spreads Open stand-alone credit spreads.
 * @param ironCondors Open iron condors.
 * @param multiplier Per-spread stop multiplier. `0` disables the stop
 *   semantic at this layer — callers pass the theoretical risk instead.
 */
export function computeEffectiveMaxLoss(
  spreads: readonly Spread[],
  ironCondors: readonly IronCondor[],
  multiplier: number,
): number {
  let callSideRisk = 0;
  let putSideRisk = 0;

  for (const s of spreads) {
    const effectiveLoss = Math.min(s.creditReceived * multiplier, s.maxLoss);
    if (s.spreadType === 'CALL_CREDIT_SPREAD') {
      callSideRisk += effectiveLoss;
    } else {
      putSideRisk += effectiveLoss;
    }
  }

  for (const ic of ironCondors) {
    const callEffective = Math.min(
      ic.callSpread.creditReceived * multiplier,
      ic.callSpread.maxLoss,
    );
    const putEffective = Math.min(
      ic.putSpread.creditReceived * multiplier,
      ic.putSpread.maxLoss,
    );
    callSideRisk += callEffective;
    putSideRisk += putEffective;
  }

  // ICs can only lose on one side — return the larger wing total.
  return Math.max(callSideRisk, putSideRisk);
}

/** Result shape for `computeAggregatePortfolioRisk`. */
export interface AggregatePortfolioRisk {
  /**
   * Effective max loss in dollars across all open spreads + ICs. If a
   * positive `multiplier` is provided this is the stop-capped loss; if
   * `multiplier` is `0` the caller should have passed a fallback via the
   * `theoreticalMaxLoss` parameter (we honour that path here too).
   */
  readonly effectiveMaxLoss: number;
  /** `effectiveMaxLoss / nlv * 100`. `0` if `nlv <= 0`. */
  readonly pctOfNlv: number;
  /** `pctOfNlv > thresholdPct`. Primitive boolean — safe effect dep. */
  readonly isOverThreshold: boolean;
}

/**
 * Compute the aggregate portfolio risk gate (audit FE-STATE-006).
 *
 * Sums effective max loss across all open credit spreads and ICs using
 * `computeEffectiveMaxLoss`, expresses it as a percentage of NLV, and
 * flags whether the total exceeds the supplied threshold percentage.
 *
 * Callers that only care about "should I show the warning banner?"
 * should destructure `isOverThreshold` and subscribe to that primitive
 * rather than the whole object — see `rerender-derived-state`.
 *
 * @param spreads Open stand-alone credit spreads.
 * @param ironCondors Open iron condors.
 * @param multiplier Per-spread stop multiplier. `0` means use theoretical.
 * @param nlv Account net liquidating value in dollars.
 * @param thresholdPct Warning threshold as a percent of NLV (e.g. `12`).
 * @param theoreticalMaxLoss Fallback total used when `multiplier === 0`.
 *   This is the `portfolioRisk.totalMaxLoss` already computed by the
 *   statement parser, so we do not duplicate its hedge-netting logic.
 */
export function computeAggregatePortfolioRisk(
  spreads: readonly Spread[],
  ironCondors: readonly IronCondor[],
  multiplier: number,
  nlv: number,
  thresholdPct: number,
  theoreticalMaxLoss: number,
): AggregatePortfolioRisk {
  const effectiveMaxLoss =
    multiplier > 0
      ? computeEffectiveMaxLoss(spreads, ironCondors, multiplier)
      : theoreticalMaxLoss;

  const pctOfNlv =
    nlv > 0 ? (Math.abs(effectiveMaxLoss) / nlv) * 100 : 0;

  const isOverThreshold = pctOfNlv > thresholdPct;

  return { effectiveMaxLoss, pctOfNlv, isOverThreshold };
}
