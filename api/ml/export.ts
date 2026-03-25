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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  if (rejectIfNotOwner(req, res)) return;

  const after = (req.query.after as string) || null;
  const before = (req.query.before as string) || null;
  const minFeature = Number(req.query.minFeatureCompleteness) || 0;
  const minLabel = Number(req.query.minLabelCompleteness) || 0;
  const format = (req.query.format as string) || 'json';

  const sql = getDb();

  try {
    // Build WHERE clauses
    const conditions: string[] = [];
    if (after) conditions.push(`f.date > '${after}'`);
    if (before) conditions.push(`f.date < '${before}'`);
    if (minFeature > 0)
      conditions.push(`f.feature_completeness >= ${minFeature}`);
    if (minLabel > 0)
      conditions.push(`COALESCE(l.label_completeness, 0) >= ${minLabel}`);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use raw SQL string since we need dynamic WHERE
    const rows = await sql.call(null, [
      `SELECT f.*,
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
        ${whereClause}
        ORDER BY f.date ASC`,
    ] as unknown as TemplateStringsArray);

    if (format === 'csv' && rows.length > 0) {
      const headers = Object.keys(rows[0]!);
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        const values = headers.map((h) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const val = (row as Record<string, any>)[h];
          if (val == null) return '';
          if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
          return String(val);
        });
        csvLines.push(values.join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ml-training-data.csv"',
      );
      return res.status(200).send(csvLines.join('\n'));
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Export failed',
    });
  }
}
