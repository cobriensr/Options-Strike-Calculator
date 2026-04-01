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
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';

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
  return uwFetch<OiStrikeRow>(apiKey, `/stock/SPX/oi-per-strike?date=${date}`);
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
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

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

    // Data quality check: alert if all OI values are zero
    if (result.stored > 10) {
      const qcRows = await sql`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE call_oi != 0 OR put_oi != 0) AS nonzero
        FROM oi_per_strike
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-oi-per-strike',
        table: 'oi_per_strike',
        date: today,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

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
