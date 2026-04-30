/**
 * GET /api/cron/resolve-trace-residuals
 *
 * Daily cron — recomputes stratified residual statistics from
 * trace_live_analyses where actual_close is populated. Writes the
 * results to trace_live_calibration for inference-time bias correction.
 *
 * Strategy:
 *   1. Pull every trace_live_analyses row with actual_close non-null
 *      and full_response->>'regime' set.
 *   2. Compute residual = actual_close - predicted_close.
 *   3. Bucket by regime × ttc (minutes from captured_at to ET close
 *      = 21:00 UTC roughly) using the same buckets as
 *      api/_lib/trace-live-residuals.ts: 0-15, 15-60, 60-180, >180.
 *   4. For each bucket, compute mean / median / p25 / p75 / count.
 *   5. UPSERT into trace_live_calibration (regime, ttc_bucket).
 *
 * Schedule: nightly at 02:00 UTC after fetch-outcomes has run. Idempotent
 * — UPSERT replaces every row each invocation.
 *
 * Environment: CRON_SECRET (DB-only; no UW or Anthropic calls).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import {
  _resetCalibrationCache,
  ttcBucketFor,
} from '../_lib/trace-live-residuals.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

interface ResolvedRow {
  captured_at: string | Date;
  actual_close: string | number;
  predicted_close: string | number | null;
  regime: string;
}

interface BucketAccum {
  regime: string;
  ttc_bucket: string;
  residuals: number[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Minutes from a captured_at timestamp to the ET equity close at 16:00
 * America/New_York. Returns 0 if capture is at or after close.
 *
 * DST-aware: SPX cash close is 21:00 UTC during EDT (Mar–Nov) and 22:00
 * UTC during EST (Nov–Mar). The earlier hard-coded `setUTCHours(21, 0)`
 * silently bucketed every winter capture 60 min short. We derive the
 * UTC close instant by reading the ET-shifted date components and
 * rebuilding the timestamp through Intl, which respects the active
 * tz offset for that calendar day.
 */
function minutesToClose(capturedAt: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(capturedAt);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value;
  // tzName is "EDT" (UTC-4) or "EST" (UTC-5).
  const closeOffsetHours = tzName === 'EDT' ? 4 : 5;
  // Build the UTC instant for 16:00 ET on the same calendar date as
  // the capture (relative to ET).
  const yyyy = parts.find((p) => p.type === 'year')!.value;
  const mm = parts.find((p) => p.type === 'month')!.value;
  const dd = parts.find((p) => p.type === 'day')!.value;
  const closeUtcMs = Date.UTC(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    16 + closeOffsetHours,
    0,
    0,
    0,
  );
  return Math.max(0, (closeUtcMs - capturedAt.getTime()) / 60_000);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    requireApiKey: false,
    marketHours: false,
  });
  if (!guard) return;
  const startedAt = Date.now();

  try {
    const db = getDb();
    // jsonb_typeof guard: hardens against stray model output where
    // predictedClose was emitted as a string ("7125") rather than a
    // number. The earlier `::numeric` cast would throw on the first
    // bad row and abort the cron; filtering at the WHERE level skips
    // them silently and lets the rest of the day's data through.
    const rows = (await db`
      SELECT
        captured_at,
        actual_close,
        full_response->'synthesis'->>'predictedClose' AS predicted_close,
        full_response->>'regime' AS regime
      FROM trace_live_analyses
      WHERE actual_close IS NOT NULL
        AND full_response->>'regime' IS NOT NULL
        AND jsonb_typeof(full_response->'synthesis'->'predictedClose') = 'number'
    `) as ResolvedRow[];

    if (rows.length === 0) {
      return res.status(200).json({
        job: 'resolve-trace-residuals',
        rows: 0,
        buckets: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // Group residuals by (regime, ttc_bucket).
    const byBucket = new Map<string, BucketAccum>();
    for (const r of rows) {
      const captured =
        r.captured_at instanceof Date ? r.captured_at : new Date(r.captured_at);
      const ttcMin = minutesToClose(captured);
      const ttc = ttcBucketFor(ttcMin);
      const actual = Number(r.actual_close);
      const predicted = Number(r.predicted_close);
      if (!Number.isFinite(actual) || !Number.isFinite(predicted)) continue;
      const residual = actual - predicted;
      const key = `${r.regime}|${ttc}`;
      const acc = byBucket.get(key);
      if (acc) {
        acc.residuals.push(residual);
      } else {
        byBucket.set(key, {
          regime: r.regime,
          ttc_bucket: ttc,
          residuals: [residual],
        });
      }
    }

    // UPSERT each bucket.
    let upserted = 0;
    for (const acc of byBucket.values()) {
      const sorted = [...acc.residuals].sort((a, b) => a - b);
      const m = mean(sorted);
      const med = quantile(sorted, 0.5);
      const p25 = quantile(sorted, 0.25);
      const p75 = quantile(sorted, 0.75);
      await db`
        INSERT INTO trace_live_calibration (
          regime, ttc_bucket, n, residual_mean, residual_median,
          residual_p25, residual_p75, updated_at
        ) VALUES (
          ${acc.regime}, ${acc.ttc_bucket}, ${sorted.length},
          ${m}, ${med}, ${p25}, ${p75}, now()
        )
        ON CONFLICT (regime, ttc_bucket) DO UPDATE SET
          n = EXCLUDED.n,
          residual_mean = EXCLUDED.residual_mean,
          residual_median = EXCLUDED.residual_median,
          residual_p25 = EXCLUDED.residual_p25,
          residual_p75 = EXCLUDED.residual_p75,
          updated_at = now()
      `;
      upserted++;
    }

    // Reset the in-process cache so the next /api/trace-live-analyze call
    // sees the fresh values.
    _resetCalibrationCache();

    logger.info(
      {
        rows: rows.length,
        buckets: upserted,
        durationMs: Date.now() - startedAt,
      },
      'resolve-trace-residuals completed',
    );

    return res.status(200).json({
      job: 'resolve-trace-residuals',
      rows: rows.length,
      buckets: upserted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'resolve-trace-residuals');
    Sentry.captureException(err);
    logger.error({ err }, 'resolve-trace-residuals error');
    return res.status(500).json({
      job: 'resolve-trace-residuals',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
