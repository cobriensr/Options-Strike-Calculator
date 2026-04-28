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

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint, rejectIfRateLimited } from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(req, res, 'journal', 20);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const sql = getDb();
    const { date, from, to, structure, confidence, mode, limit } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);

    // Filters are mutually exclusive — supplying multiple at once previously
    // let the first matching `else if` branch win silently, so a request
    // like `?date=X&structure=Y` ignored `structure`. Reject combinations
    // explicitly so callers know the filter they sent isn't being applied.
    const filterGroups = [
      date ? 'date' : null,
      from && to ? 'from/to' : null,
      structure ? 'structure' : null,
      confidence ? 'confidence' : null,
      mode ? 'mode' : null,
    ].filter((g): g is string => g !== null);
    if (filterGroups.length > 1) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Filters are mutually exclusive',
        conflicting: filterGroups,
      });
    }

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

    done({ status: 200 });
    return res.status(200).json({ analyses: rows, count: rows.length });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'Journal query error');
    return res.status(500).json({ error: 'Query failed' });
  }
}
