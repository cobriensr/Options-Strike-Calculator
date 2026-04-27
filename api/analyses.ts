/**
 * GET /api/analyses
 *
 * Browse past Claude chart analyses stored in Postgres.
 * Owner-or-guest — analysis output derives from licensed market data.
 * Rate limited to 30 requests per minute.
 *
 * Query params:
 *   ?dates=true                                        — List all dates that have analyses
 *   ?date=2026-03-17                                   — Get all analyses for a date
 *   ?date=2026-03-17&entryTime=9:00+AM+CT&mode=entry  — Get a specific analysis
 *   ?id=42                                             — Get a single analysis by ID
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfNotOwnerOrGuest,
  rejectIfRateLimited,
  checkBot,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';

function parseRow(r: Record<string, unknown>) {
  return {
    id: r.id as number,
    date: r.date as string,
    entryTime: r.entry_time as string,
    mode: r.mode as string,
    structure: r.structure as string,
    confidence: r.confidence as string,
    suggestedDelta: r.suggested_delta as number,
    spx: r.spx as number | null,
    vix: r.vix as number | null,
    vix1d: r.vix1d as number | null,
    hedge: r.hedge as string | null,
    analysis:
      typeof r.full_response === 'string'
        ? JSON.parse(r.full_response)
        : r.full_response,
    createdAt: r.created_at as string,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/analyses');

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

  const rateLimited = await rejectIfRateLimited(req, res, 'analyses', 30);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const sql = getDb();
    setCacheHeaders(res, 60, 30);
    const { dates, date, mode, entryTime, id } = req.query;

    // ── Single analysis by ID ──────────────────────────────
    if (id) {
      const rows = await sql`
        SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, entry_time, mode,
               structure, confidence, suggested_delta, spx, vix, vix1d, hedge,
               full_response, created_at
        FROM analyses WHERE id = ${String(id)} LIMIT 1
      `;
      if (rows.length === 0) {
        done({ status: 404 });
        return res.status(404).json({ error: 'Analysis not found' });
      }
      done({ status: 200 });
      return res.status(200).json(parseRow(rows[0]!));
    }

    // ── List dates ─────────────────────────────────────────
    if (dates === 'true') {
      const rows = await sql`
        SELECT
          TO_CHAR(date, 'YYYY-MM-DD') AS date,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE mode = 'entry') AS entries,
          COUNT(*) FILTER (WHERE mode = 'midday') AS middays,
          COUNT(*) FILTER (WHERE mode = 'review') AS reviews
        FROM analyses
        GROUP BY date ORDER BY date DESC
      `;
      done({ status: 200 });
      return res.status(200).json({
        dates: rows.map((r) => ({
          date: r.date as string,
          total: Number(r.total),
          entries: Number(r.entries),
          middays: Number(r.middays),
          reviews: Number(r.reviews),
        })),
      });
    }

    // ── Analyses for a date ────────────────────────────────
    if (date) {
      const dateStr = String(date);

      // Specific analysis by date + entryTime + mode
      if (entryTime && mode) {
        const rows = await sql`
          SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, entry_time, mode,
                 structure, confidence, suggested_delta, spx, vix, vix1d, hedge,
                 full_response, created_at
          FROM analyses
          WHERE date = ${dateStr} AND entry_time = ${String(entryTime)} AND mode = ${String(mode)}
          ORDER BY created_at DESC LIMIT 1
        `;
        if (rows.length === 0) {
          done({ status: 404 });
          return res.status(404).json({ error: 'Analysis not found' });
        }
        done({ status: 200 });
        return res.status(200).json(parseRow(rows[0]!));
      }

      // All analyses for the date
      const rows = await sql`
        SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, entry_time, mode,
               structure, confidence, suggested_delta, spx, vix, vix1d, hedge,
               full_response, created_at
        FROM analyses WHERE date = ${dateStr} ORDER BY created_at ASC
      `;
      done({ status: 200 });
      return res.status(200).json({
        date: dateStr,
        analyses: rows.map(parseRow),
      });
    }

    done({ status: 400 });
    return res
      .status(400)
      .json({ error: 'Provide ?dates=true, ?date=YYYY-MM-DD, or ?id=N' });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'analyses endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
