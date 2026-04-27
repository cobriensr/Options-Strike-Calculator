/**
 * GET /api/ml/export
 *
 * Exports ML training data as JSON or CSV. Joins training_features,
 * outcomes, and day_labels on date for a complete dataset.
 *
 * Query params:
 *   after  — Only include days after this date (YYYY-MM-DD)
 *   before — Only include days before this date (YYYY-MM-DD)
 *   minFeatureCompleteness — Minimum feature completeness (0.0-1.0)
 *   minLabelCompleteness   — Minimum label completeness (0.0-1.0)
 *   format — "json" (default) or "csv"
 *
 * Owner-only endpoint (requires session cookie).
 *
 * Environment: DATABASE_URL, OWNER_SECRET
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwnerOrGuest, checkBot } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

/** Normalize Neon Date objects to YYYY-MM-DD strings in result rows. */
function normalizeDates(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      normalized[key] =
        val instanceof Date ? val.toISOString().split('T')[0] : val;
    }
    return normalized;
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/ml/export');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    return res.status(403).json({ error: 'Access denied' });
  }

  if (rejectIfNotOwnerOrGuest(req, res)) {
    done({ status: 401 });
    return;
  }

  const after = (req.query.after as string) || null;
  const before = (req.query.before as string) || null;
  const minFeature = Number(req.query.minFeatureCompleteness) || 0;
  const minLabel = Number(req.query.minLabelCompleteness) || 0;
  const format = (req.query.format as string) || 'json';

  // Validate date params if provided
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (after && !dateRe.test(after)) {
    return res.status(400).json({ error: 'after must be YYYY-MM-DD' });
  }
  if (before && !dateRe.test(before)) {
    return res.status(400).json({ error: 'before must be YYYY-MM-DD' });
  }

  const sql = getDb();

  try {
    // All params are parameterized — no string interpolation in SQL
    const rows = (await sql`
      SELECT f.*,
          o.settlement, o.day_open, o.day_high, o.day_low,
          o.day_range_pts, o.day_range_pct, o.close_vs_open,
          o.vix_close, o.vix1d_close,
          l.analysis_id AS label_analysis_id,
          l.structure_correct, l.recommended_structure,
          l.confidence AS label_confidence, l.suggested_delta AS label_delta,
          l.charm_diverged, l.naive_charm_signal,
          l.spx_flow_signal, l.market_tide_signal,
          l.spy_flow_signal, l.gex_signal,
          l.flow_was_directional, l.settlement_direction,
          l.range_category, l.label_completeness
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        LEFT JOIN day_labels l ON l.date = f.date
        WHERE (${after}::date IS NULL OR f.date > ${after}::date)
          AND (${before}::date IS NULL OR f.date < ${before}::date)
          AND f.feature_completeness >= ${minFeature}
          AND COALESCE(l.label_completeness, 0) >= ${minLabel}
        ORDER BY f.date ASC
    `) as Record<string, unknown>[];

    const normalized = normalizeDates(rows);

    if (format === 'csv' && normalized.length > 0) {
      const headers = Object.keys(normalized[0]!);
      const csvLines = [headers.join(',')];
      for (const row of normalized) {
        const values = headers.map((h) => {
          const val = row[h];
          if (val == null) return '';
          const str = String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replaceAll('"', '""')}"`;
          }
          return str;
        });
        csvLines.push(values.join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ml-training-data.csv"',
      );
      done({ status: 200 });
      return res.status(200).send(csvLines.join('\n'));
    }

    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    return res.status(200).json(normalized);
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'ml/export error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
