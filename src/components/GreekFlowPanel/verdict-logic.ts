/**
 * verdict-logic — pure verdict computation extracted from Verdict.tsx
 * so the React component file only exports components (Fast Refresh
 * requirement).
 *
 * Framework:
 *   - When SPY and QQQ delta agree (same non-zero sign) you have a
 *     directional bias (bullish if positive, bearish if negative).
 *   - When SPY and QQQ vega agree you have a vol regime (long = vol
 *     expansion expected, short = premium-harvest / pin).
 *   - The combination of (delta agreement, vega agreement) maps to one
 *     of five verdicts. Anything other than a clean directional or
 *     pin-harvest read defaults to "no trade."
 *
 * Sign comes from the server-side `divergence(spyCum, qqqCum)` helper,
 * which signs the latest cumulative value — the same gradient stop the
 * FlowChart uses, so the verdict matches the chart colors visually.
 *
 * For backtest replay: `computeVerdictTimeline` re-runs the verdict at
 * each per-minute row (joined by timestamp across SPY+QQQ) so the
 * VerdictTimeline strip shows when verdicts changed historically.
 */

import type {
  DivergenceResult,
  GreekFlowRow,
  Sign,
} from '../../hooks/useGreekFlow';

export type DeltaState = 'bullish' | 'bearish' | 'mixed';
export type VegaState = 'long' | 'short' | 'mixed';
export type VerdictKind =
  | 'directional-bull'
  | 'directional-bear'
  | 'pin-harvest'
  | 'vol-expansion'
  | 'no-trade';

export interface VerdictResult {
  kind: VerdictKind;
  delta: DeltaState;
  vega: VegaState;
  headline: string;
  action: string;
}

export interface TimelinePoint {
  timestamp: string;
  kind: VerdictKind;
}

export interface TimelineSummary {
  points: TimelinePoint[];
  /** Total verdict changes across the session (includes flips in/out of `no-trade`). */
  transitions: number;
  /**
   * Verdict changes between two non-`no-trade` kinds. Filters out the
   * early-session "still gathering signal" churn so the displayed metric
   * reflects how many real regime shifts the day actually produced.
   */
  decisiveTransitions: number;
  currentSince: string | null;
}

function agreedSign(spy: Sign, qqq: Sign): Sign {
  if (spy === 0 || qqq === 0 || spy !== qqq) return 0;
  return spy;
}

function actionForDirectional(side: 'long' | 'short', vega: VegaState): string {
  const verb = side === 'long' ? 'Long' : 'Short';
  if (vega === 'long') return `${verb} bias — vol expanding, can size up.`;
  if (vega === 'short')
    return `${verb} bias — vol compressing, watch theta decay.`;
  return `${verb} bias — vol regime mixed, normal size.`;
}

export function computeVerdict(
  delta: DivergenceResult,
  vega: DivergenceResult,
): VerdictResult {
  const deltaSign = agreedSign(delta.spySign, delta.qqqSign);
  const vegaSign = agreedSign(vega.spySign, vega.qqqSign);

  const deltaState: DeltaState =
    deltaSign === 1 ? 'bullish' : deltaSign === -1 ? 'bearish' : 'mixed';
  const vegaState: VegaState =
    vegaSign === 1 ? 'long' : vegaSign === -1 ? 'short' : 'mixed';

  if (deltaState === 'bullish') {
    return {
      kind: 'directional-bull',
      delta: deltaState,
      vega: vegaState,
      headline: 'Directional bull confluence',
      action: actionForDirectional('long', vegaState),
    };
  }
  if (deltaState === 'bearish') {
    return {
      kind: 'directional-bear',
      delta: deltaState,
      vega: vegaState,
      headline: 'Directional bear confluence',
      action: actionForDirectional('short', vegaState),
    };
  }
  if (vegaState === 'short') {
    return {
      kind: 'pin-harvest',
      delta: deltaState,
      vega: vegaState,
      headline: 'Pin / premium-harvest regime',
      action: 'Sell premium (iron condor / strangle). No directional trade.',
    };
  }
  if (vegaState === 'long') {
    return {
      kind: 'vol-expansion',
      delta: deltaState,
      vega: vegaState,
      headline: 'Vol expansion — event positioning',
      action: 'Stand down on direction. Wait for SPY/QQQ to align.',
    };
  }
  return {
    kind: 'no-trade',
    delta: deltaState,
    vega: vegaState,
    headline: 'No confluence',
    action: 'Stand down. Wait for SPY/QQQ to align on delta or vega.',
  };
}

function signOf(value: number): Sign {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

function divergenceFromCum(spyCum: number, qqqCum: number): DivergenceResult {
  const spySign = signOf(spyCum);
  const qqqSign = signOf(qqqCum);
  return {
    spySign,
    qqqSign,
    diverging: spySign !== 0 && qqqSign !== 0 && spySign !== qqqSign,
  };
}

/**
 * Round an ISO timestamp to the start of its UTC minute. Two minute-aligned
 * UW bars from SPY and QQQ may differ by a few hundred ms in their `Date`
 * representations — bucketing both sides ensures the join doesn't silently
 * drop a minute on either ticker.
 */
function minuteBucket(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return Number.NaN;
  return Math.floor(ms / 60_000) * 60_000;
}

export function computeVerdictTimeline(
  spyRows: readonly GreekFlowRow[],
  qqqRows: readonly GreekFlowRow[],
): TimelineSummary {
  // Bucket both tickers to the same minute so sub-second timestamp drift
  // between SPY and QQQ bars doesn't drop a minute from the timeline.
  const qqqByMinute = new Map<number, GreekFlowRow>();
  for (const r of qqqRows) {
    const bucket = minuteBucket(r.timestamp);
    if (Number.isNaN(bucket)) continue;
    // First entry wins on duplicate buckets — UW emits one bar per minute,
    // so duplicates are an upstream anomaly we don't want to mask.
    if (!qqqByMinute.has(bucket)) qqqByMinute.set(bucket, r);
  }

  const points: TimelinePoint[] = [];
  for (const spy of spyRows) {
    const bucket = minuteBucket(spy.timestamp);
    if (Number.isNaN(bucket)) continue;
    const qqq = qqqByMinute.get(bucket);
    if (qqq == null) continue;
    const v = computeVerdict(
      divergenceFromCum(spy.cum_otm_dir_delta_flow, qqq.cum_otm_dir_delta_flow),
      divergenceFromCum(spy.cum_otm_dir_vega_flow, qqq.cum_otm_dir_vega_flow),
    );
    points.push({ timestamp: spy.timestamp, kind: v.kind });
  }

  let transitions = 0;
  let decisiveTransitions = 0;
  let currentSince: string | null = points[0]?.timestamp ?? null;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    const prev = points[i - 1];
    if (cur == null || prev == null) continue;
    if (cur.kind !== prev.kind) {
      transitions++;
      if (cur.kind !== 'no-trade' && prev.kind !== 'no-trade') {
        decisiveTransitions++;
      }
      currentSince = cur.timestamp;
    }
  }
  return { points, transitions, decisiveTransitions, currentSince };
}

export const KIND_LABEL: Record<VerdictKind, string> = {
  'directional-bull': 'Bull',
  'directional-bear': 'Bear',
  'pin-harvest': 'Pin',
  'vol-expansion': 'Vol expansion',
  'no-trade': 'No trade',
};
