/**
 * Monitor feature engineering — derives ML features from the 1-minute
 * iv_monitor and flow_ratio_monitor tables.
 *
 * These capture intraday dynamics that checkpoint snapshots miss:
 * IV stability vs chaos, put/call ratio momentum, and spike frequency.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { FeatureRow } from './build-features-types.js';
import {
  CHECKPOINTS,
  TOLERANCE_MINUTES,
  num,
} from './build-features-types.js';
import { getETTime, getETDateStr } from '../../src/utils/timezone.js';
import { ALERT_THRESHOLDS } from './alert-thresholds.js';

// ── Types ──────────────────────────────────────────────────

interface IvRow {
  timestamp: string;
  volatility: string | null;
  spx_price: string | null;
}

interface RatioRow {
  timestamp: string;
  ratio: string | null;
}

// ── Helpers ────────────────────────────────────────────────

/** Find the row closest to a target ET minute, within tolerance. */
function findNearest<T extends { timestamp: string }>(
  rows: T[],
  targetMinutes: number,
  dateStr: string,
): T | null {
  let best: T | null = null;
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

/**
 * Count "spikes" — readings where a value jumped by at least `threshold`
 * compared to the reading ~5 minutes prior in the sorted array.
 * For IV spikes, also checks that SPX price moved less than
 * ALERT_THRESHOLDS.IV_PRICE_MAX_MOVE.
 */
function countIvSpikes(rows: IvRow[]): number {
  if (rows.length < 6) return 0;
  let count = 0;

  for (let i = 5; i < rows.length; i++) {
    const current = num(rows[i]!.volatility);
    const prev = num(rows[i - 5]!.volatility);
    if (current == null || prev == null) continue;

    const ivDelta = current - prev;
    if (ivDelta < ALERT_THRESHOLDS.IV_JUMP_MIN) continue;

    // Check SPX didn't move much (informed positioning, not reaction)
    const curPrice = num(rows[i]!.spx_price);
    const prevPrice = num(rows[i - 5]!.spx_price);
    if (
      curPrice != null &&
      prevPrice != null &&
      Math.abs(curPrice - prevPrice) >= ALERT_THRESHOLDS.IV_PRICE_MAX_MOVE
    ) {
      continue;
    }

    count++;
  }

  return count;
}

function countRatioSpikes(rows: RatioRow[]): number {
  if (rows.length < 6) return 0;
  let count = 0;

  for (let i = 5; i < rows.length; i++) {
    const current = num(rows[i]!.ratio);
    const prev = num(rows[i - 5]!.ratio);
    if (current == null || prev == null) continue;

    if (Math.abs(current - prev) >= ALERT_THRESHOLDS.RATIO_DELTA_MIN) {
      count++;
    }
  }

  return count;
}

// ── Main ───────────────────────────────────────────────────

export async function engineerMonitorFeatures(
  sql: NeonQueryFunction<false, false>,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  // ── IV monitor features ────────────────────────────────
  const ivRows = (await sql`
    SELECT timestamp, volatility, spx_price
    FROM iv_monitor
    WHERE date = ${dateStr}
    ORDER BY timestamp ASC
  `) as IvRow[];

  if (ivRows.length > 0) {
    const vols = ivRows
      .map((r) => num(r.volatility))
      .filter((v): v is number => v != null);

    if (vols.length > 0) {
      features.iv_open = vols[0]!;
      features.iv_max = Math.max(...vols);
      features.iv_range = Math.max(...vols) - Math.min(...vols);
    }

    // IV at T2 checkpoint (10:30 AM = 630 min)
    const t2Cp = CHECKPOINTS.find((c) => c.label === 't2');
    if (t2Cp) {
      const t2Row = findNearest(ivRows, t2Cp.minutes, dateStr);
      features.iv_at_t2 = t2Row ? num(t2Row.volatility) : null;
    }

    // IV crush rate: change in final 90 min (2:30 PM = 870 min to close)
    const crushStart = findNearest(ivRows, 870, dateStr);
    const lastIv = ivRows.at(-1);
    if (crushStart && lastIv) {
      const startVol = num(crushStart.volatility);
      const endVol = num(lastIv.volatility);
      features.iv_crush_rate =
        startVol != null && endVol != null ? endVol - startVol : null;
    }

    // IV spike count
    features.iv_spike_count = countIvSpikes(ivRows);
  }

  // ── Flow ratio monitor features ────────────────────────
  const ratioRows = (await sql`
    SELECT timestamp, ratio
    FROM flow_ratio_monitor
    WHERE date = ${dateStr}
    ORDER BY timestamp ASC
  `) as RatioRow[];

  if (ratioRows.length > 0) {
    const ratios = ratioRows
      .map((r) => num(r.ratio))
      .filter((v): v is number => v != null);

    if (ratios.length > 0) {
      features.pcr_open = ratios[0]!;
      features.pcr_max = Math.max(...ratios);
      features.pcr_min = Math.min(...ratios);
      features.pcr_range = Math.max(...ratios) - Math.min(...ratios);
    }

    // PCR trend T1→T2
    const t1Cp = CHECKPOINTS.find((c) => c.label === 't1');
    const t2Cp = CHECKPOINTS.find((c) => c.label === 't2');
    if (t1Cp && t2Cp) {
      const t1Row = findNearest(ratioRows, t1Cp.minutes, dateStr);
      const t2Row = findNearest(ratioRows, t2Cp.minutes, dateStr);
      if (t1Row && t2Row) {
        const r1 = num(t1Row.ratio);
        const r2 = num(t2Row.ratio);
        features.pcr_trend_t1_t2 =
          r1 != null && r2 != null ? r2 - r1 : null;
      }
    }

    // PCR spike count
    features.pcr_spike_count = countRatioSpikes(ratioRows);
  }
}
