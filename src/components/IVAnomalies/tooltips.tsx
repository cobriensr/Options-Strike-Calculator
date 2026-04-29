/**
 * Tooltip copy for the IV Anomalies row badges.
 *
 * Centralized so the row component stays scannable. Phrasing follows
 * the audience set in `docs/tmp/tooltip-copy-draft-2026-04-28.md` —
 * an experienced options trader who's new to this app's vocabulary.
 * Lead with rule/formula, follow with one-line interpretation.
 */

import type { ReactNode } from 'react';
import type {
  AnomalyPattern,
  DPCluster,
  IVAnomalyFlowPhase,
  IVAnomalyPhase,
  IVAnomalySideDominant,
} from './types';

export const VOL_OI_TIP: ReactNode = (
  <>
    <strong>Volume / Open Interest, last 5 min.</strong> Today's traded volume
    at this strike divided by yesterday's open interest.{' '}
    <strong>&gt;20× = unusual</strong>,{' '}
    <strong>&gt;50× = often informed flow positioning before a move</strong>.
    Color saturation tracks the ratio. Capped at 999×.
  </>
);

export const EXP_TIP: ReactNode = (
  <>
    <strong>Contract expiration.</strong> 0DTE = today, 1DTE = tomorrow. The
    anomaly detector only watches 0DTE / 1DTE strikes.
  </>
);

export const ACTIVE_DURATION_TIP: ReactNode = (
  <>
    <strong>Wall-clock time the alert has been firing today.</strong>{' '}
    Long-active alerts (&gt;2h) are typically real positions, not algo noise.
  </>
);

export const LAST_FIRE_TIP: ReactNode = (
  <>
    <strong>Time since the most recent re-fire.</strong> If this is much smaller
    than &quot;active&quot; duration, the alert is currently quiet but hasn't
    cleared yet.
  </>
);

export const FIRINGS_TIP: ReactNode = (
  <>
    <strong>Re-fire count today.</strong> Each firing means vol/OI re-crossed
    the threshold after a quiet window.{' '}
    <strong>5+ firings on one strike = sustained interest</strong> rather than a
    single sweep.
  </>
);

export const FLAG_REASON_TIP: ReactNode = (
  <>
    <strong>Detector flag — why the row qualified.</strong> Common reasons:{' '}
    <code>z_score</code> (≥2σ above this strike's own 30-day baseline),{' '}
    <code>iv_pop</code> (sudden IV spike), or surge gates on the tape side.
  </>
);

export const ANOMALY_PHASE_TIPS: Record<IVAnomalyPhase, ReactNode> = {
  active: (
    <>
      <strong>Alert is currently firing.</strong> vol/OI is above the activation
      threshold right now.
    </>
  ),
  cooling: (
    <>
      <strong>Cooling — past peak, not yet cleared.</strong> Volume has slowed
      but hasn't reverted; the position is still being held.
    </>
  ),
  distributing: (
    <>
      <strong>Distributing.</strong> Bid-side volume is surging — the built
      position is likely being unwound.
    </>
  ),
};

export const FLOW_PHASE_TIPS: Record<IVAnomalyFlowPhase, ReactNode> = {
  early: (
    <>
      <strong>Early flow.</strong> Detected close to the start of the vol/OI
      ramp — the build is still in progress.
    </>
  ),
  mid: (
    <>
      <strong>Mid-life flow.</strong> Build has been in progress for a while;
      positioning is partially in place.
    </>
  ),
  reactive: (
    <>
      <strong>Reactive flow.</strong> Volume picked up after a price move —
      likely chasing rather than leading.
    </>
  ),
};

export const FLOW_PHASE_UNCLASSIFIED_TIP: ReactNode = (
  <>
    <strong>Flow phase not yet classified.</strong> The early/mid/reactive
    classifier needs a few minutes of context after the alert fires.
  </>
);

export const PATTERN_TIPS: Record<AnomalyPattern, ReactNode> = {
  flash: (
    <>
      <strong>Flash: &lt;5 min, &lt;3 firings.</strong> Phase D4 backtest showed
      flash alerts have the highest call-side win rate (≈2× persistent).
    </>
  ),
  medium: (
    <>
      <strong>Medium duration / firing count.</strong> Between flash and
      persistent — no specific edge in the backtest.
    </>
  ),
  persistent: (
    <>
      <strong>Persistent: ≥60 min or ≥20 firings.</strong> Phase D4 backtest
      showed persistent alerts have a meaningfully lower call win rate than
      flash.
    </>
  ),
};

export const REGIME_TIP: ReactNode = (
  <>
    <strong>Underlying's same-day % change vs. alert direction</strong> (Phase
    D0 regime spine). Green = trend supports the alert side; red = trend
    against; gray = chop or unknown.
  </>
);

export const TAPE_ALIGN_TIP: ReactNode = (
  <>
    <strong>Tape alignment (NQ/ES/RTY/SPX, last 15 min) vs. alert side</strong>{' '}
    (Phase E1). Edge is small — +2pt on mild_trend_up days; on chop days,
    contradicted slightly outperforms aligned.
  </>
);

export function dpClusterTip(cluster: DPCluster): ReactNode {
  if (cluster === 'large') {
    return (
      <>
        <strong>Large dark-pool cluster (&gt;$200M at this strike).</strong>{' '}
        Phase E2: SPXW calls with large DP confluence won 91.7% on mild-trend-up
        days (n=36 — tentative).
      </>
    );
  }
  if (cluster === 'medium') {
    return (
      <>
        <strong>Medium dark-pool cluster ($50–200M at this strike).</strong>{' '}
        Phase E2: SPXW calls won 71.4% on mild-trend-up days (n=42).
      </>
    );
  }
  if (cluster === 'small') {
    return (
      <>
        <strong>Small dark-pool cluster (&lt;$50M).</strong> No directional
        edge.
      </>
    );
  }
  if (cluster === 'na') {
    return (
      <>
        <strong>DP not attributed.</strong> Dark-pool data is only joined for
        SPXW alerts in this dataset.
      </>
    );
  }
  return <strong>No dark-pool premium clustered at this strike.</strong>;
}

export const GEX_ZONE_TIP: ReactNode = (
  <>
    <strong>Nearest top-3 abs_gex strike vs. spot</strong> (Phase E4). Calls
    with GEX <em>below</em> spot have room to run; puts mirror. Phase E4 win
    rates: 68.7% (below, n=195) vs. 39.7% (above, n=827) for calls on
    mild_trend_up days.
  </>
);

export const VIX_DIR_TIP: ReactNode = (
  <>
    <strong>VIX 30-min change at alert time</strong> (Phase E3). Green =
    falling, red = rising. Chop + falling-VIX puts is the only put-side cell
    with positive mean dollar (27.7% win, +$66 mean, n=137).
  </>
);

export function sideSkewTip(args: {
  sideDominant: IVAnomalySideDominant;
  pct: number;
  hasRealTape: boolean;
  totalVol: number | null;
  formatVolume: (n: number) => string;
}): ReactNode {
  const { sideDominant, pct, hasRealTape, totalVol, formatVolume } = args;
  const sideLabel = sideDominant.toUpperCase();
  const action =
    sideDominant === 'ask'
      ? 'buyers lifting the offer (accumulation)'
      : 'sellers hitting the bid (distribution)';
  if (hasRealTape && totalVol != null) {
    return (
      <>
        <strong>
          {sideLabel} {pct}%
        </strong>{' '}
        of {formatVolume(totalVol)} cumulative tape volume printed on the{' '}
        {sideDominant} side — {action}.
      </>
    );
  }
  return (
    <>
      <strong>
        {sideLabel} {pct}%
      </strong>{' '}
      — legacy IV-spread proxy. {sideLabel} side carries {pct}% of the bid-ask
      IV spread.
    </>
  );
}
