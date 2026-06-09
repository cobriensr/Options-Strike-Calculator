/**
 * GET /api/pre-market?date=2026-03-28
 *   Returns saved pre-market data for the given date.
 *
 * POST /api/pre-market
 *   Saves pre-market data (ES overnight Globex H/L/C/VWAP).
 *   Body: { date, globexHigh, globexLow, globexClose, globexVwap?, savedAt }
 *
 *   The 0DTE straddle cone is auto-computed by the `compute-cone` cron
 *   into `cone_levels` (date PK) and is no longer accepted on this
 *   endpoint.
 *
 * Data is stored in the market_snapshots table as a JSON column
 * (pre_market_data) to avoid a new table. If no snapshot exists
 * for this date, creates one.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  setCacheHeaders,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { metrics } from './_lib/sentry.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from './_lib/constants.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import logger from './_lib/logger.js';
import { preMarketBodySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

export type { PreMarketData } from '../src/types/api.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/pre-market');

  if (req.method !== 'GET' && req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET or POST only' });
  }
  if (await guardOwnerEndpoint(req, res, done)) return;
  const rateLimited = await rejectIfRateLimited(req, res, 'pre-market', 20);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    const date = (req.query.date as string) || getTodayET();
    try {
      const rows = await withDbRetry(
        () => db`
        SELECT pre_market_data FROM market_snapshots
        WHERE date = ${date} AND pre_market_data IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `,
        DB_RETRY_ATTEMPTS,
        DB_RETRY_TIMEOUT_MS,
      );
      setCacheHeaders(res, 120, 60);
      if (rows.length > 0 && rows[0]?.pre_market_data) {
        done({ status: 200 });
        return res.status(200).json({ data: rows[0].pre_market_data });
      }
      done({ status: 200 });
      return res.status(200).json({ data: null });
    } catch (err) {
      done({ status: 500 });
      sendDbErrorResponse(res, err, {
        label: 'pre_market',
        serverErrorBody: { error: 'Failed to fetch' },
      });
      return;
    }
  }

  // POST
  try {
    const parsed = preMarketBodySchema.safeParse(req.body);
    if (respondIfInvalid(parsed, res, done)) return;
    const { date, ...data } = parsed.data;

    if (data.globexHigh >= data.globexLow === false) {
      done({ status: 400 });
      return res.status(400).json({ error: 'globexHigh must be >= globexLow' });
    }

    const preMarketJson = JSON.stringify({
      globexHigh: data.globexHigh,
      globexLow: data.globexLow,
      globexClose: data.globexClose,
      globexVwap: data.globexVwap ?? null,
      savedAt: data.savedAt ?? new Date().toISOString(),
    });

    // Upsert: update existing snapshot or create minimal one
    const existing = await db`
      SELECT id FROM market_snapshots
      WHERE date = ${date}
      ORDER BY created_at DESC LIMIT 1
    `;

    if (existing.length > 0) {
      await db`
        UPDATE market_snapshots
        SET pre_market_data = ${preMarketJson}::jsonb
        WHERE id = ${existing[0]!.id}
      `;
    } else {
      await db`
        INSERT INTO market_snapshots (date, entry_time, pre_market_data)
        VALUES (${date}, 'pre-market', ${preMarketJson}::jsonb)
      `;
    }

    done({ status: 200 });
    return res.status(200).json({ saved: true });
  } catch (err) {
    done({ status: 500 });
    logger.error({ err }, 'Failed to save pre-market data');
    return res.status(500).json({ error: 'Failed to save' });
  }
}

function getTodayET(): string {
  return getETDateStr(new Date());
}
