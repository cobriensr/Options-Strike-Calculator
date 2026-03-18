/**
 * GET /api/analyses
 *
 * Browse past Claude chart analyses stored in Postgres.
 * No owner gating — this data is publicly accessible.
 * Rate limited to 30 requests per minute.
 *
 * Query params:
 *   ?dates=true           — List all dates that have analyses (with mode counts)
 *   ?date=2026-03-17      — Get all analyses for a specific date
 *   ?date=...&mode=entry  — Filter by mode (entry, midday, review)
 *   ?id=42                — Get a single analysis by ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfRateLimited } from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Rate limit: 30/min — generous since it's just DB reads
  const rateLimited = await rejectIfRateLimited(req, res, 'analyses', 30);
  if (rateLimited) return;

  try {
    const sql = getDb();
    const { dates, date, mode, id } = req.query;

    // ── Single analysis by ID ──────────────────────────────
    if (id) {
      const rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence,
               suggested_delta, spx, vix, vix1d, hedge,
               full_response, created_at
        FROM analyses
        WHERE id = ${String(id)}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Analysis not found' });
      }

      const row = rows[0]!;
      return res.status(200).json({
        id: row.id,
        date: row.date,
        entryTime: row.entry_time,
        mode: row.mode,
        structure: row.structure,
        confidence: row.confidence,
        suggestedDelta: row.suggested_delta,
        spx: row.spx,
        vix: row.vix,
        vix1d: row.vix1d,
        hedge: row.hedge,
        analysis: typeof row.full_response === 'string'
          ? JSON.parse(row.full_response as string)
          : row.full_response,
        createdAt: row.created_at,
      });
    }

    // ── List dates with analysis counts ────────────────────
    if (dates === 'true') {
      const rows = await sql`
        SELECT
          date,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE mode = 'entry') AS entries,
          COUNT(*) FILTER (WHERE mode = 'midday') AS middays,
          COUNT(*) FILTER (WHERE mode = 'review') AS reviews,
          MAX(created_at) AS last_analysis
        FROM analyses
        GROUP BY date
        ORDER BY date DESC
        LIMIT 90
      `;

      return res.status(200).json({
        dates: rows.map((r) => ({
          date: r.date,
          total: Number(r.total),
          entries: Number(r.entries),
          middays: Number(r.middays),
          reviews: Number(r.reviews),
          lastAnalysis: r.last_analysis,
        })),
      });
    }

    // ── Analyses for a specific date ──────────────────────
    if (date) {
      const dateStr = String(date);
      const modeFilter = mode ? String(mode) : null;

      let rows;
      if (modeFilter) {
        rows = await sql`
          SELECT id, date, entry_time, mode, structure, confidence,
                 suggested_delta, spx, vix, vix1d, hedge,
                 full_response, created_at
          FROM analyses
          WHERE date = ${dateStr} AND mode = ${modeFilter}
          ORDER BY created_at ASC
        `;
      } else {
        rows = await sql`
          SELECT id, date, entry_time, mode, structure, confidence,
                 suggested_delta, spx, vix, vix1d, hedge,
                 full_response, created_at
          FROM analyses
          WHERE date = ${dateStr}
          ORDER BY created_at ASC
        `;
      }

      return res.status(200).json({
        date: dateStr,
        analyses: rows.map((r) => ({
          id: r.id,
          entryTime: r.entry_time,
          mode: r.mode,
          structure: r.structure,
          confidence: r.confidence,
          suggestedDelta: r.suggested_delta,
          spx: r.spx,
          vix: r.vix,
          vix1d: r.vix1d,
          hedge: r.hedge,
          analysis: typeof r.full_response === 'string'
            ? JSON.parse(r.full_response as string)
            : r.full_response,
          createdAt: r.created_at,
        })),
      });
    }

    return res.status(400).json({
      error: 'Provide ?dates=true, ?date=YYYY-MM-DD, or ?id=N',
    });
  } catch (err) {
    logger.error({ err }, 'analyses endpoint error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch analyses',
    });
  }
}