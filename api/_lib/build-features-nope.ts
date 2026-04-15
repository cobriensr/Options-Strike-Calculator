/**
 * NOPE feature engineering for build-features cron.
 *
 * Computes per-checkpoint NOPE values (T1–T4) and AM-window aggregates
 * (mean, sign flips, cumulative hedging delta) from the nope_ticks table.
 *
 * AM window is defined as 09:30–11:30 ET (open through T4 checkpoint).
 * Sign flips count regime shifts in intraday dealer hedging demand.
 */

import type { FeatureRow } from './build-features-types.js';
import { CHECKPOINTS, TOLERANCE_MINUTES } from './build-features-types.js';
import { getETDateStr, getETTime } from '../../src/utils/timezone.js';

export interface NopeTickRow {
  timestamp: Date | string;
  call_delta: string | number;
  put_delta: string | number;
  nope: string | number;
}

// ── AM window — 09:30 to 11:30 ET (open through T4) ─────────

const AM_WINDOW_START_MIN = 570; // 09:30 ET
const AM_WINDOW_END_MIN = 690; // 11:30 ET (matches T4)

// ── Helpers ──────────────────────────────────────────────────

function toNumber(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Find the NOPE row closest to a target ET minute, within tolerance. */
function findNearestNope(
  rows: NopeTickRow[],
  targetMinutes: number,
  dateStr: string,
): NopeTickRow | null {
  let best: NopeTickRow | null = null;
  let bestDiff = Infinity;

  for (const row of rows) {
    const ts = new Date(row.timestamp);
    if (getETDateStr(ts) !== dateStr) continue;

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

/** Filter rows to the AM window on a given ET date. */
function amWindowRows(rows: NopeTickRow[], dateStr: string): NopeTickRow[] {
  return rows.filter((row) => {
    const ts = new Date(row.timestamp);
    if (getETDateStr(ts) !== dateStr) return false;
    const { hour, minute } = getETTime(ts);
    const totalMin = hour * 60 + minute;
    return totalMin >= AM_WINDOW_START_MIN && totalMin <= AM_WINDOW_END_MIN;
  });
}

/**
 * Engineer NOPE features for a given trading date.
 *
 * Returns a partial FeatureRow with keys: nope_t1..t4, nope_am_mean,
 * nope_am_sign_flips, nope_am_cum_delta. All values are null when
 * there's insufficient NOPE data for that field.
 */
export function engineerNopeFeatures(
  rows: NopeTickRow[],
  dateStr: string,
): FeatureRow {
  const features: FeatureRow = {
    nope_t1: null,
    nope_t2: null,
    nope_t3: null,
    nope_t4: null,
    nope_am_mean: null,
    nope_am_sign_flips: null,
    nope_am_cum_delta: null,
  };

  // Per-checkpoint NOPE snapshots (nearest-minute match ±5 min).
  for (const cp of CHECKPOINTS) {
    const match = findNearestNope(rows, cp.minutes, dateStr);
    if (match) features[`nope_${cp.label}`] = toNumber(match.nope);
  }

  // AM-window aggregates.
  const windowRows = amWindowRows(rows, dateStr).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  if (windowRows.length === 0) return features;

  const nopeValues = windowRows
    .map((r) => toNumber(r.nope))
    .filter((v): v is number => v != null);

  if (nopeValues.length > 0) {
    const sum = nopeValues.reduce((a, b) => a + b, 0);
    features.nope_am_mean = sum / nopeValues.length;

    let flips = 0;
    for (let i = 1; i < nopeValues.length; i++) {
      const prev = nopeValues[i - 1]!;
      const curr = nopeValues[i]!;
      if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) flips++;
    }
    features.nope_am_sign_flips = flips;
  }

  // Cumulative hedging delta: Σ (call_delta − put_delta) across AM window.
  let cum = 0;
  let anyValid = false;
  for (const r of windowRows) {
    const cd = toNumber(r.call_delta);
    const pd = toNumber(r.put_delta);
    if (cd == null || pd == null) continue;
    cum += cd - pd;
    anyValid = true;
  }
  if (anyValid) features.nope_am_cum_delta = cum;

  return features;
}
