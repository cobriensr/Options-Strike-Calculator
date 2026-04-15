/**
 * VIX regime classification — drives the "should I be holding short-gamma
 * through MOC?" banner above BWB + iron-condor sections.
 *
 * Thresholds and tail statistics come from the MOC imbalance study in
 * ml/docs/MOC-IMBALANCE-FINDING.md (8 years of QQQ NOII + minute bars).
 *
 * Pearson r(vix_close -> mae_down_bps) = +0.560, R^2 = 0.31 — the strongest
 * single-variable predictor of last-10-min chaos measured in that study.
 */

export type RegimeSeverity = 'ok' | 'note' | 'warn' | 'danger';

export interface RegimeInfo {
  readonly key: 'calm' | 'normal' | 'elevated' | 'stress';
  readonly label: string;
  readonly rule: string;
  readonly detail: string;
  readonly severity: RegimeSeverity;
}

const CALM: RegimeInfo = {
  key: 'calm',
  label: 'Calm',
  rule: 'Short-gamma through MOC is acceptable',
  detail: 'p95 MAE 20 bps — close is usually uneventful',
  severity: 'ok',
};

const NORMAL: RegimeInfo = {
  key: 'normal',
  label: 'Normal',
  rule: 'Moderate size; stay alert into the close',
  detail: 'p95 MAE 28 bps, p99 41 bps',
  severity: 'note',
};

const ELEVATED: RegimeInfo = {
  key: 'elevated',
  label: 'Elevated',
  rule: 'Flat short-gamma by 2:45 CT',
  detail: 'p95 MAE 45 bps, p99 69 bps — fly ladders get overrun here',
  severity: 'warn',
};

const STRESS: RegimeInfo = {
  key: 'stress',
  label: 'Stress',
  rule: 'Do NOT sell iron flies or BWBs for MOC — flat by 2:30 CT',
  detail: 'p95 MAE 80 bps, p99 192 bps — 1 day in 100 costs a month of theta',
  severity: 'danger',
};

export function classifyVix(vixClose: number): RegimeInfo {
  if (vixClose < 15) return CALM;
  if (vixClose < 20) return NORMAL;
  if (vixClose < 30) return ELEVATED;
  return STRESS;
}
