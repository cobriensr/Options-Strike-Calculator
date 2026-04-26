/**
 * GET /api/trace-live-list
 *
 * Index endpoint for the TRACE Live dashboard's historical browsing.
 * Returns a compact summary of every analysis recorded for an ET trading
 * day, suitable for populating the timestamp dropdown. Image bytes and
 * the full TraceAnalysis JSON live behind /api/trace-live-get?id=N.
 *
 * Query params:
 *   ?date=YYYY-MM-DD        — list captures for this ET trading day
 *   ?dates=true             — list every date that has analyses (for the
 *                             date picker's enabled-date set)
 *
 * Authorization: owner cookie (single-owner app). BotID gate also runs
 * via guardOwnerEndpoint. Rate limited to 60/min — frontend polls every
 * 60s in live mode and may scrub between dates rapidly in historical
 * mode, so headroom matters.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  getETMarketOpenUtcIso,
  getETCloseUtcIso,
} from '../src/utils/timezone.js';

interface TraceLiveSummaryRow {
  id: number;
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  regime: string | null;
  predictedClose: number | null;
  confidence: string | null;
  overrideApplied: boolean | null;
  headline: string | null;
  hasImages: boolean;
}

function parseSummaryRow(r: Record<string, unknown>): TraceLiveSummaryRow {
  return {
    id: Number(r.id),
    capturedAt: r.captured_at as string,
    spot: Number(r.spot),
    stabilityPct: r.stability_pct == null ? null : Number(r.stability_pct),
    regime: (r.regime as string | null) ?? null,
    predictedClose:
      r.predicted_close == null ? null : Number(r.predicted_close),
    confidence: (r.confidence as string | null) ?? null,
    overrideApplied: (r.override_applied as boolean | null) ?? null,
    headline: (r.headline as string | null) ?? null,
    hasImages: Boolean(r.has_images),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/trace-live-list');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-list',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const sql = getDb();
    setCacheHeaders(res, 30, 60);

    const { date, dates } = req.query;

    // ── List of dates that have analyses ─────────────────────────────
    if (dates === 'true') {
      // Group by the ET calendar date. Postgres' AT TIME ZONE handles DST.
      const rows = await sql`
        SELECT
          TO_CHAR((captured_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS et_date,
          COUNT(*) AS total
        FROM trace_live_analyses
        GROUP BY et_date
        ORDER BY et_date DESC
      `;
      done({ status: 200 });
      return res.status(200).json({
        dates: rows.map((r) => ({
          date: r.et_date as string,
          total: Number(r.total),
        })),
      });
    }

    // ── List captures for a specific ET trading day ──────────────────
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Provide ?date=YYYY-MM-DD or ?dates=true',
      });
    }

    const startUtc = getETMarketOpenUtcIso(date);
    const endUtc = getETCloseUtcIso(date);
    if (!startUtc || !endUtc) {
      done({ status: 400 });
      return res.status(400).json({ error: 'Invalid date' });
    }

    const rows = await sql`
      SELECT id,
             captured_at,
             spot,
             stability_pct,
             regime,
             predicted_close,
             confidence,
             override_applied,
             headline,
             (image_urls IS NOT NULL) AS has_images
      FROM trace_live_analyses
      WHERE captured_at >= ${startUtc} AND captured_at < ${endUtc}
      ORDER BY captured_at ASC
    `;

    done({ status: 200 });
    return res.status(200).json({
      date,
      count: rows.length,
      analyses: rows.map(parseSummaryRow),
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-list endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
