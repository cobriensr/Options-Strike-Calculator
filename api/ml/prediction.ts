/**
 * GET /api/ml/prediction
 *
 * Returns the latest ML model prediction for today (or the most recent
 * available date). Reads from the `predictions` table populated by the
 * Phase 2 training pipeline.
 *
 * Query params:
 *   date — Specific date to look up (YYYY-MM-DD). Defaults to today.
 *
 * Owner-or-guest — predictions derive from licensed market data.
 *
 * Environment: DATABASE_URL, OWNER_SECRET
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/ml/prediction');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const dateParam = req.query.date as string | undefined;
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    done({ status: 400 });
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const sql = getDb();

  try {
    let rows;
    if (dateParam) {
      rows = await sql`
        SELECT date, ccs_prob, pcs_prob, ic_prob, sit_out_prob,
               predicted_class, model_version, feature_count,
               top_features, created_at
        FROM predictions
        WHERE date = ${dateParam}::date
        LIMIT 1
      `;
    } else {
      // Most recent prediction
      rows = await sql`
        SELECT date, ccs_prob, pcs_prob, ic_prob, sit_out_prob,
               predicted_class, model_version, feature_count,
               top_features, created_at
        FROM predictions
        ORDER BY date DESC
        LIMIT 1
      `;
    }

    if (!rows || rows.length === 0) {
      done({ status: 200 });
      return res.status(200).json({
        prediction: null,
        message: 'No predictions available yet. Model training in progress.',
      });
    }

    const r = rows[0]!;
    const prediction = {
      date:
        r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date,
      probabilities: {
        ccs: Number(r.ccs_prob),
        pcs: Number(r.pcs_prob),
        ic: Number(r.ic_prob),
        sit_out: Number(r.sit_out_prob),
      },
      predicted_class: r.predicted_class,
      model_version: r.model_version,
      feature_count: r.feature_count,
      top_features: r.top_features,
      created_at: r.created_at,
    };

    done({ status: 200 });
    return res.status(200).json({ prediction });
  } catch (err) {
    logger.error({ err }, 'ML prediction query failed');
    Sentry.captureException(err);
    done({ status: 500 });
    return res.status(500).json({ error: 'Failed to fetch prediction' });
  }
}
