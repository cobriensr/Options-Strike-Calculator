/**
 * GET /api/pre-market?date=2026-03-28
 *   Returns saved pre-market data for the given date.
 *
 * POST /api/pre-market
 *   Saves pre-market data (ES overnight + straddle cone).
 *   Body: { date, globexHigh, globexLow, globexClose, globexVwap?,
 *           straddleConeUpper?, straddleConeLower?, savedAt }
 *
 * Data is stored in the market_snapshots table as a JSON column
 * (pre_market_data) to avoid a new table. If no snapshot exists
 * for this date, creates one.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  checkBot,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { preMarketBodySchema } from './_lib/validation.js';

export type { PreMarketData } from '../src/types/api.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' });
  }
  const botCheck = await checkBot(req);
  if (botCheck.isBot) return res.status(403).json({ error: 'Access denied' });
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;
  const rateLimited = await rejectIfRateLimited(req, res, 'pre-market', 20);
  if (rateLimited) return;

  const db = getDb();

  if (req.method === 'GET') {
    const date = (req.query.date as string) || getTodayET();
    try {
      const rows = await db`
        SELECT pre_market_data FROM market_snapshots
        WHERE date = ${date} AND pre_market_data IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0 && rows[0]?.pre_market_data) {
        return res.status(200).json({ data: rows[0].pre_market_data });
      }
      return res.status(200).json({ data: null });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch pre-market data');
      return res.status(500).json({ error: 'Failed to fetch' });
    }
  }

  // POST
  try {
    const parsed = preMarketBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error: parsed.error.issues[0]?.message ?? 'Invalid request body',
        });
    }
    const { date, ...data } = parsed.data;

    if (data.globexHigh >= data.globexLow === false) {
      return res
        .status(400)
        .json({ error: 'globexHigh must be >= globexLow' });
    }

    const preMarketJson = JSON.stringify({
      globexHigh: data.globexHigh,
      globexLow: data.globexLow,
      globexClose: data.globexClose,
      globexVwap: data.globexVwap ?? null,
      straddleConeUpper: data.straddleConeUpper ?? null,
      straddleConeLower: data.straddleConeLower ?? null,
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

    return res.status(200).json({ saved: true });
  } catch (err) {
    logger.error({ err }, 'Failed to save pre-market data');
    return res.status(500).json({ error: 'Failed to save' });
  }
}

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}
