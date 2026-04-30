/**
 * Stratified residual statistics for the TRACE Live predictor.
 *
 * Reads from `trace_live_calibration` (populated daily by the
 * resolve-trace-residuals cron) and exposes a lookup function used at
 * inference time to bias-correct the model's predictedClose. The
 * correction is applied as `calibratedClose = predictedClose + residual_median`
 * stratified by (regime, ttc_bucket).
 *
 * Lookup is in-memory cached with a 1-hour TTL — the table is rewritten
 * once per day so a 1-hour TTL keeps the cron's writes propagating
 * within the same trading session if the daemon restarts.
 *
 * Sample-size guard: when `n < MIN_SAMPLES_FOR_CALIBRATION` for the
 * (regime, ttc_bucket) bucket, the lookup returns null and the caller
 * uses the raw model output. Avoids over-fitting to <30 historical
 * samples.
 */

import { getDb } from './db.js';
import logger from './logger.js';

export type TtcBucket = '0-15min' | '15-60min' | '60-180min' | '>180min';

export interface CalibrationRow {
  regime: string;
  ttc_bucket: TtcBucket;
  n: number;
  residual_mean: number | null;
  residual_median: number | null;
  residual_p25: number | null;
  residual_p75: number | null;
  updated_at: string;
}

/** Below this sample count the bucket's residual is too noisy to apply. */
export const MIN_SAMPLES_FOR_CALIBRATION = 5;

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  byKey: Map<string, CalibrationRow>;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

function bucketKey(regime: string, ttc: TtcBucket): string {
  return `${regime}|${ttc}`;
}

/** Reset the in-process cache. Test-only. */
export function _resetCalibrationCache(): void {
  cache = null;
}

/**
 * Pick the right ttc_bucket for a given minutes-to-close value.
 *
 * Buckets target the failure modes the residual analysis flagged:
 *   - 0-15min: MOC risk window — residuals are large (path is
 *     determined by close-auction flow not visible in the chart).
 *   - 15-60min: late session, charm pressure dominant, pin/no-pin
 *     boundary.
 *   - 60-180min: middle of session, gamma topology stable.
 *   - >180min: open / early session, residuals dominated by morning
 *     drift, not chart predictions.
 */
export function ttcBucketFor(minutesToClose: number): TtcBucket {
  if (minutesToClose <= 15) return '0-15min';
  if (minutesToClose <= 60) return '15-60min';
  if (minutesToClose <= 180) return '60-180min';
  return '>180min';
}

async function loadAll(): Promise<Map<string, CalibrationRow>> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.byKey;
  }
  const db = getDb();
  try {
    const rows = (await db`
      SELECT regime, ttc_bucket, n,
             residual_mean::float8 AS residual_mean,
             residual_median::float8 AS residual_median,
             residual_p25::float8 AS residual_p25,
             residual_p75::float8 AS residual_p75,
             updated_at
      FROM trace_live_calibration
    `) as CalibrationRow[];
    const byKey = new Map<string, CalibrationRow>();
    for (const r of rows) {
      byKey.set(bucketKey(r.regime, r.ttc_bucket as TtcBucket), r);
    }
    cache = { byKey, expiresAt: Date.now() + CACHE_TTL_MS };
    return byKey;
  } catch (err) {
    logger.warn(
      { err },
      'Failed to load trace_live_calibration; returning empty map',
    );
    return new Map();
  }
}

/**
 * Apply the residual correction to a raw predicted close.
 *
 * Returns:
 *   - { calibratedClose, residualMedian, n, ttcBucket } when the bucket
 *     has enough samples to apply.
 *   - null when no calibration row exists OR n < MIN_SAMPLES_FOR_CALIBRATION
 *     OR the database read fails (caller falls back to raw model output).
 */
export async function applyResidualCorrection(args: {
  regime: string;
  predictedClose: number;
  minutesToClose: number;
}): Promise<{
  calibratedClose: number;
  residualMedian: number;
  n: number;
  ttcBucket: TtcBucket;
} | null> {
  const ttcBucket = ttcBucketFor(args.minutesToClose);
  const map = await loadAll();
  const row = map.get(bucketKey(args.regime, ttcBucket));
  if (!row) return null;
  if (row.n < MIN_SAMPLES_FOR_CALIBRATION) return null;
  if (row.residual_median == null) return null;
  return {
    calibratedClose: args.predictedClose + Number(row.residual_median),
    residualMedian: Number(row.residual_median),
    n: row.n,
    ttcBucket,
  };
}

/**
 * Pull all calibration rows. Used by the calibration plot endpoint and
 * the resolve-trace-residuals cron's "before/after" diff log.
 */
export async function listCalibrationRows(): Promise<CalibrationRow[]> {
  const map = await loadAll();
  return [...map.values()];
}
