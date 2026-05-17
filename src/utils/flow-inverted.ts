/**
 * flow-inverted — did the ticker's net-flow direction agree with this
 * alert at fire time but no longer? This is the highest-edge exit
 * signal per the lottery-net-flow-eda simulation: when the matched
 * side stops winning, the trade has typically passed its peak.
 *
 * Composes computeFlowMatch (Phase 4) against two snapshots:
 *   - "fire-time": cum NCP/NPP at the moment the alert triggered
 *     (lottery-finder LATERAL → fire.macro.tickerCumNcpAtFire,
 *     silent-boom-feed LATERAL → alert.tickerCumNcpAtFire)
 *   - "current": live cumulative from useTickerNetFlowBatch
 *
 * inverted = fire-time matched AND current does NOT match. We
 * intentionally do NOT light up Inverted when fire-time was already
 * Mismatch — those alerts never had the flow tailwind in the first
 * place, so "the tailwind reversed" doesn't apply.
 */

import { computeFlowMatch } from './flow-match.js';

export type FlowInvertedState =
  /** Was matched at fire time, current snapshot is not match. */
  | 'inverted'
  /** Current state agrees with fire-time state. */
  | 'stable'
  /** Either snapshot is missing or fire-time wasn't a match. */
  | 'unknown';

interface FlowInvertedArgs {
  optionType: 'C' | 'P';
  fireTimeCumNcp: number | null | undefined;
  fireTimeCumNpp: number | null | undefined;
  currentCumNcp: number | null | undefined;
  currentCumNpp: number | null | undefined;
}

export function computeFlowInverted({
  optionType,
  fireTimeCumNcp,
  fireTimeCumNpp,
  currentCumNcp,
  currentCumNpp,
}: FlowInvertedArgs): FlowInvertedState {
  const wasMatch = computeFlowMatch(optionType, fireTimeCumNcp, fireTimeCumNpp);
  const isMatch = computeFlowMatch(optionType, currentCumNcp, currentCumNpp);
  // Both snapshots must resolve to a concrete state to make a call.
  if (wasMatch === 'unknown' || isMatch === 'unknown') return 'unknown';
  // Inversion is meaningful only when fire-time was matched. A fire
  // that triggered against a mismatched tape never had the tailwind,
  // so its reversal isn't an exit signal — it's just a coin flip.
  if (wasMatch !== 'match') return 'stable';
  if (isMatch === 'match') return 'stable';
  return 'inverted';
}
