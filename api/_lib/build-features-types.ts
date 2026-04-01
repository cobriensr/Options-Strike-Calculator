/**
 * Shared types, constants, and helpers for the build-features modules.
 */

import { getETTime, getETDateStr } from '../../src/utils/timezone.js';

// ── Types ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FeatureRow = Record<string, any>;

export interface FlowRow {
  timestamp: string;
  source: string;
  ncp: string | null;
  npp: string | null;
}

export interface SpotRow {
  timestamp: string;
  gamma_oi: string | null;
  gamma_vol: string | null;
  gamma_dir: string | null;
  charm_oi: string | null;
  price: string | null;
}

export interface StrikeRow {
  strike: string;
  price: string | null;
  call_gamma_oi: string | null;
  put_gamma_oi: string | null;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
}

export interface GreekRow {
  expiry: string;
  dte: string;
  call_gamma: string | null;
  put_gamma: string | null;
  call_charm: string | null;
  put_charm: string | null;
}

export interface SnapshotRow {
  vix: string | null;
  vix1d: string | null;
  vix9d: string | null;
  vvix: string | null;
  vix1d_vix_ratio: string | null;
  vix_vix9d_ratio: string | null;
  regime_zone: string | null;
  cluster_mult: string | null;
  dow_mult_hl: string | null;
  dow_label: string | null;
  spx_open: string | null;
  sigma: string | null;
  hours_remaining: string | null;
  ic_ceiling: string | null;
  put_spread_ceiling: string | null;
  call_spread_ceiling: string | null;
  opening_range_signal: string | null;
  opening_range_pct_consumed: string | null;
  is_event_day: boolean | null;
}

// ── Checkpoint times (minutes after midnight ET) ───────────

export const CHECKPOINTS = [
  { label: 't1', minutes: 600 }, // 10:00 AM
  { label: 't2', minutes: 630 }, // 10:30 AM
  { label: 't3', minutes: 660 }, // 11:00 AM
  { label: 't4', minutes: 690 }, // 11:30 AM
] as const;

export const TOLERANCE_MINUTES = 5;

// ── Flow sources ───────────────────────────────────────────

interface FlowSource {
  source: string;
  prefix: string;
}

export const FLOW_SOURCES: FlowSource[] = [
  { source: 'market_tide', prefix: 'mt' },
  { source: 'spx_flow', prefix: 'spx' },
  { source: 'spy_flow', prefix: 'spy' },
  { source: 'qqq_flow', prefix: 'qqq' },
  { source: 'spy_etf_tide', prefix: 'spy_etf' },
  { source: 'qqq_etf_tide', prefix: 'qqq_etf' },
  { source: 'zero_dte_index', prefix: 'zero_dte' },
  { source: 'zero_dte_greek_flow', prefix: 'delta_flow' },
];

// Sources that contribute to flow agreement
export const AGREEMENT_SOURCES = [
  'market_tide',
  'market_tide_otm',
  'spx_flow',
  'spy_flow',
  'qqq_flow',
  'spy_etf_tide',
  'qqq_etf_tide',
  'zero_dte_index',
  'zero_dte_greek_flow',
];

// ── Helpers ────────────────────────────────────────────────

export function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Find the flow row closest to a target ET minute, within tolerance. */
export function findNearestCandle(
  rows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): FlowRow | null {
  let best: FlowRow | null = null;
  let bestDiff = Infinity;

  for (const row of rows) {
    const ts = new Date(row.timestamp);
    const tsDate = getETDateStr(ts);
    if (tsDate !== dateStr) continue;

    const { hour, minute } = getETTime(ts);
    const totalMin = hour * 60 + minute;
    const diff = Math.abs(totalMin - targetMinutes);

    if (diff < bestDiff && diff <= TOLERANCE_MINUTES) {
      best = row;
      bestDiff = diff;
    }
  }

  return best;
}

export function findNearestSpot(
  rows: SpotRow[],
  targetMinutes: number,
  dateStr: string,
): SpotRow | null {
  let best: SpotRow | null = null;
  let bestDiff = Infinity;

  for (const row of rows) {
    const ts = new Date(row.timestamp);
    const tsDate = getETDateStr(ts);
    if (tsDate !== dateStr) continue;

    const { hour, minute } = getETTime(ts);
    const totalMin = hour * 60 + minute;
    const diff = Math.abs(totalMin - targetMinutes);

    if (diff < bestDiff && diff <= TOLERANCE_MINUTES) {
      best = row;
      bestDiff = diff;
    }
  }

  return best;
}
