/**
 * GET /api/journal
 *
 * Query saved analyses. Supports filtering by date, structure, confidence, mode.
 *
 * Query params:
 *   date       — specific date (YYYY-MM-DD)
 *   from       — start date (YYYY-MM-DD)
 *   to         — end date (YYYY-MM-DD)
 *   structure  — IRON CONDOR, PUT CREDIT SPREAD, etc.
 *   confidence — HIGH, MODERATE, LOW
 *   mode       — entry, midday, review
 *   limit      — max results (default 50)
 *
 * Response: { analyses: [...], count: N }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectIfNotOwner, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  const rateLimited = await rejectIfRateLimited(req, res, 'journal', 20);
  if (rateLimited) return;

  try {
    const sql = getDb();
    const { date, from, to, structure, confidence, mode, limit } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);

    // Build dynamic query — Neon's tagged template doesn't support dynamic WHERE
    // so we fetch with broad filters and let Postgres handle it
    let rows;

    if (date) {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        WHERE date = ${String(date)}
        ORDER BY created_at DESC
        LIMIT ${lim}
      `;
    } else if (from && to) {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        WHERE date >= ${String(from)} AND date <= ${String(to)}
        ORDER BY date DESC, created_at DESC
        LIMIT ${lim}
      `;
    } else if (structure) {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        WHERE structure = ${String(structure)}
        ORDER BY date DESC, created_at DESC
        LIMIT ${lim}
      `;
    } else if (confidence) {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        WHERE confidence = ${String(confidence)}
        ORDER BY date DESC, created_at DESC
        LIMIT ${lim}
      `;
    } else if (mode) {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        WHERE mode = ${String(mode)}
        ORDER BY date DESC, created_at DESC
        LIMIT ${lim}
      `;
    } else {
      rows = await sql`
        SELECT id, date, entry_time, mode, structure, confidence, suggested_delta,
               spx, vix, vix1d, hedge, full_response, created_at
        FROM analyses
        ORDER BY date DESC, created_at DESC
        LIMIT ${lim}
      `;
    }

    return res.status(200).json({ analyses: rows, count: rows.length });
  } catch (err) {
    console.error('Journal query error:', err);
    return res.status(500).json({ error: 'Query failed' });
  }
}
