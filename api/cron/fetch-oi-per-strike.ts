/**
 * GET /api/cron/fetch-oi-per-strike
 *
 * Fetches daily open interest per strike for SPX from Unusual Whales API.
 * OI is a daily figure (settled from prior day), not intraday — runs ONCE
 * per day near market open (14:00 UTC / 10:00 AM ET).
 *
 * Skips if data already exists for today to avoid duplicate work on retries.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { TIMEOUTS } from '../_lib/constants.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { isMarketHours, withRetry } from '../_lib/api-helpers.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Types ───────────────────────────────────────────────────

interface OiStrikeRow {
  call_oi: string | number;
  put_oi: string | number;
  strike: string | number;
  date: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchOiPerStrike(
  apiKey: string,
  date: string,
): Promise<OiStrikeRow[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/oi-per-strike?date=${date}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `UW API ${res.status} for SPX OI per strike: ${text.slice(0, 200)}`,
    );
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  rows: OiStrikeRow[],
  date: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    const callOi = Number.parseInt(String(row.call_oi), 10) || 0;
    const putOi = Number.parseInt(String(row.put_oi), 10) || 0;
    const strike = Number.parseFloat(String(row.strike));

    const result = await sql`
      INSERT INTO oi_per_strike (date, strike, call_oi, put_oi)
      VALUES (${date}, ${strike}, ${callOi}, ${putOi})
      ON CONFLICT (date, strike) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) stored++;
    else skipped++;
  }

  return { stored, skipped };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isMarketHours()) {
    return res
      .status(200)
      .json({ skipped: true, reason: 'Outside market hours' });
  }

  const startTime = Date.now();
  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    logger.error('UW_API_KEY not configured');
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  // Get today's date in ET
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });

  try {
    // Skip if data already exists for today
    const sql = getDb();
    const existing = await sql`
      SELECT COUNT(*)::int AS cnt FROM oi_per_strike WHERE date = ${today}
    `;
    const existingCount = (existing[0]?.cnt as number) ?? 0;
    if (existingCount > 0) {
      return res.status(200).json({
        skipped: true,
        reason: `Data already exists for ${today} (${existingCount} strikes)`,
      });
    }

    const rows = await withRetry(() => fetchOiPerStrike(apiKey, today));
    const result = await storeStrikes(rows, today);

    logger.info(
      { date: today, ...result, total: rows.length },
      'fetch-oi-per-strike completed',
    );

    return res.status(200).json({
      job: 'fetch-oi-per-strike',
      date: today,
      total: rows.length,
      ...result,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-oi-per-strike');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-oi-per-strike error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
