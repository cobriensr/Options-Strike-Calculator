/**
 * GET /api/cron/fetch-oi-change
 *
 * Fetches daily OI change data for SPX from Unusual Whales API.
 * Shows which contracts had the largest open interest changes,
 * with aggressor direction (ask vs bid volume) and multi-leg %.
 *
 * Runs post-close daily. OI settles from prior day's activity.
 * Skips if data already exists for today.
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

interface OiChangeRow {
  option_symbol: string;
  oi_diff_plain: string | number;
  curr_oi: string | number;
  last_oi: string | number;
  avg_price: string;
  prev_ask_volume: string | number;
  prev_bid_volume: string | number;
  prev_multi_leg_volume: string | number;
  prev_total_premium: string;
}

// ── Parse OCC option symbol ────────────────────────────────

/**
 * Extract strike and call/put flag from OCC option symbol.
 * Format: `SPX   260403C06500000` or `SPXW  260403P05800000`
 * The char before the last 8 digits is C or P.
 * The 8 digits encode strike as 5 integer + 3 decimal (divide by 1000).
 */
function parseOptionSymbol(symbol: string): {
  strike: number;
  isCall: boolean;
} | null {
  const trimmed = symbol.trim();
  // Match: C or P followed by exactly 8 digits at end of string
  const match = /([CP])(\d{8})$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  const isCall = match[1] === 'C';
  const strike = Number.parseInt(match[2], 10) / 1000;
  return { strike, isCall };
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchOiChange(
  apiKey: string,
  date: string,
): Promise<OiChangeRow[]> {
  return uwFetch<OiChangeRow>(apiKey, `/stock/SPX/oi-change?date=${date}`);
}

// ── Store helper ────────────────────────────────────────────

async function storeOiChanges(
  rows: OiChangeRow[],
  date: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    const parsed = parseOptionSymbol(row.option_symbol);
    const strike = parsed?.strike ?? null;
    const isCall = parsed?.isCall ?? null;
    const oiDiff = Number.parseInt(String(row.oi_diff_plain), 10) || 0;
    const currOi = Number.parseInt(String(row.curr_oi), 10) || 0;
    const lastOi = Number.parseInt(String(row.last_oi), 10) || 0;
    const avgPrice = Number.parseFloat(String(row.avg_price)) || null;
    const prevAskVolume = Number.parseInt(String(row.prev_ask_volume), 10) || 0;
    const prevBidVolume = Number.parseInt(String(row.prev_bid_volume), 10) || 0;
    const prevMultiLegVolume =
      Number.parseInt(String(row.prev_multi_leg_volume), 10) || 0;
    const prevTotalPremium =
      Number.parseFloat(String(row.prev_total_premium)) || null;

    const result = await sql`
      INSERT INTO oi_changes (
        date, option_symbol, strike, is_call, oi_diff,
        curr_oi, last_oi, avg_price,
        prev_ask_volume, prev_bid_volume,
        prev_multi_leg_volume, prev_total_premium
      )
      VALUES (
        ${date}, ${row.option_symbol}, ${strike}, ${isCall},
        ${oiDiff}, ${currOi}, ${lastOi}, ${avgPrice},
        ${prevAskVolume}, ${prevBidVolume},
        ${prevMultiLegVolume}, ${prevTotalPremium}
      )
      ON CONFLICT (date, option_symbol) DO NOTHING
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
      SELECT COUNT(*)::int AS cnt
      FROM oi_changes
      WHERE date = ${today}
    `;
    const existingCount = (existing[0]?.cnt as number) ?? 0;
    if (existingCount > 0) {
      return res.status(200).json({
        skipped: true,
        reason: `Data already exists for ${today} (${existingCount} rows)`,
      });
    }

    const rows = await withRetry(() => fetchOiChange(apiKey, today));
    const result = await storeOiChanges(rows, today);

    // Data quality check: alert if all oi_diff values are zero
    if (result.stored > 10) {
      const qcRows = await sql`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE oi_diff != 0) AS nonzero
        FROM oi_changes
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-oi-change',
        table: 'oi_changes',
        date: today,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    logger.info(
      { date: today, ...result, total: rows.length },
      'fetch-oi-change completed',
    );

    return res.status(200).json({
      job: 'fetch-oi-change',
      date: today,
      total: rows.length,
      ...result,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-oi-change');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-oi-change error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
