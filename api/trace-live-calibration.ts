/**
 * GET /api/trace-live-calibration
 *
 * Owner-or-guest endpoint that surfaces the calibration loop's outputs:
 *
 *   - rows  : every per-bucket residual stat from trace_live_calibration
 *   - scatter : the underlying (predicted, actual, regime, captured_at)
 *               points so the dashboard can plot them on a scatter and
 *               render a residual histogram. Bounded to the last 30 ET
 *               days so the table (lifetime aggregate) and the scatter
 *               (recent points) refer to overlapping samples — using
 *               LIMIT N alone would have produced the table referencing
 *               buckets whose contributing points weren't on the chart.
 *
 * Read-only. Cached 5 min on the edge — the upstream table updates
 * once per day from the resolve-trace-residuals cron.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
  setCacheHeaders,
} from './_lib/api-helpers.js';

interface CalibrationRowOut {
  regime: string;
  ttc_bucket: string;
  n: number;
  residual_mean: number | null;
  residual_median: number | null;
  residual_p25: number | null;
  residual_p75: number | null;
  updated_at: string;
}

interface ScatterPoint {
  id: number;
  capturedAt: string;
  regime: string;
  predicted: number;
  actual: number;
  residual: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/trace-live-calibration');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-calibration',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const db = getDb();
    const [rowsRes, scatterRes] = (await Promise.all([
      db`
        SELECT
          regime,
          ttc_bucket,
          n,
          residual_mean::float8 AS residual_mean,
          residual_median::float8 AS residual_median,
          residual_p25::float8 AS residual_p25,
          residual_p75::float8 AS residual_p75,
          updated_at
        FROM trace_live_calibration
        ORDER BY regime, ttc_bucket
      `,
      db`
        SELECT
          id,
          captured_at,
          full_response->>'regime' AS regime,
          (full_response->'synthesis'->>'predictedClose')::float8 AS predicted,
          actual_close::float8 AS actual
        FROM trace_live_analyses
        WHERE actual_close IS NOT NULL
          AND full_response->>'regime' IS NOT NULL
          AND jsonb_typeof(full_response->'synthesis'->'predictedClose') = 'number'
          AND captured_at >= NOW() - INTERVAL '30 days'
        ORDER BY captured_at DESC
      `,
    ])) as [
      Array<{
        regime: string;
        ttc_bucket: string;
        n: number;
        residual_mean: number | null;
        residual_median: number | null;
        residual_p25: number | null;
        residual_p75: number | null;
        updated_at: string | Date;
      }>,
      Array<{
        id: number;
        captured_at: string | Date;
        regime: string;
        predicted: number;
        actual: number;
      }>,
    ];

    const toIso = (v: string | Date): string =>
      typeof v === 'string' ? v : v.toISOString();

    const rows: CalibrationRowOut[] = rowsRes.map((r) => ({
      regime: r.regime,
      ttc_bucket: r.ttc_bucket,
      n: Number(r.n),
      residual_mean: r.residual_mean,
      residual_median: r.residual_median,
      residual_p25: r.residual_p25,
      residual_p75: r.residual_p75,
      updated_at: toIso(r.updated_at),
    }));

    const scatter: ScatterPoint[] = scatterRes.map((p) => ({
      id: Number(p.id),
      capturedAt: toIso(p.captured_at),
      regime: p.regime,
      predicted: Number(p.predicted),
      actual: Number(p.actual),
      residual: Number(p.actual) - Number(p.predicted),
    }));

    setCacheHeaders(res, 300, 60);
    done({ status: 200 });
    return res.status(200).json({ rows, scatter });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-calibration error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
