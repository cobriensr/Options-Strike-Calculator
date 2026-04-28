/**
 * GET /api/cron/auto-prefill-premarket
 *
 * Runs at 8:30 AM CT (13:30 UTC) on weekdays. Queries overnight ES bars
 * from futures_bars (5:00 PM CT previous trading day through 8:30 AM CT
 * today), computes Globex high/low/close/VWAP, and writes to
 * market_snapshots.pre_market_data so the frontend auto-fills on load.
 *
 * Schedule: 30 13 * * 1-5
 *
 * Environment: CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Time helpers ────────────────────────────────────────────

/**
 * Get previous trading day's 5:00 PM CT as a UTC ISO string.
 * On Monday → Friday 5:00 PM CT. On Tue-Fri → yesterday 5:00 PM CT.
 * 5:00 PM CT = 22:00 UTC (CDT) or 23:00 UTC (CST).
 * Using 22:00 UTC (CDT) — close enough for the query window.
 */
function getOvernightStartCT(todayET: string): string {
  const today = new Date(todayET + 'T12:00:00Z');
  const dayOfWeek = today.getUTCDay();
  const daysBack = dayOfWeek === 1 ? 3 : 1; // Monday → go back to Friday
  const prevDay = new Date(today);
  prevDay.setUTCDate(prevDay.getUTCDate() - daysBack);
  const dateStr = prevDay.toISOString().slice(0, 10);
  return `${dateStr}T22:00:00Z`;
}

/**
 * Get today's 8:30 AM CT as a UTC ISO string.
 * 8:30 AM CT = 13:30 UTC (CDT) or 14:30 UTC (CST).
 */
function getOvernightEndCT(todayET: string): string {
  return `${todayET}T13:30:00Z`;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const tradeDate = getETDateStr(new Date());
  const sql = getDb();

  try {
    const overnightStart = getOvernightStartCT(tradeDate);
    const overnightEnd = getOvernightEndCT(tradeDate);

    // Query overnight ES bars from futures_bars
    const bars = await sql`
      SELECT
        MAX(high)                                      AS globex_high,
        MIN(low)                                       AS globex_low,
        (ARRAY_AGG(close ORDER BY ts DESC))[1]         AS globex_close,
        SUM(close * volume) / NULLIF(SUM(volume), 0)   AS vwap,
        COUNT(*)                                       AS bar_count
      FROM futures_bars
      WHERE symbol = 'ES'
        AND ts >= ${overnightStart}
        AND ts <  ${overnightEnd}
    `;

    if (!bars[0]?.globex_high) {
      logger.info({ tradeDate }, 'No overnight ES bars found for pre-fill');
      await reportCronRun('auto-prefill-premarket', {
        status: 'skipped',
        tradeDate,
        reason: 'No overnight bars',
        durationMs: Date.now() - startTime,
      });
      return res
        .status(200)
        .json({ skipped: true, reason: 'No overnight bars' });
    }

    const row = bars[0];
    const globexHigh = Number.parseFloat(String(row.globex_high));
    const globexLow = Number.parseFloat(String(row.globex_low));
    const globexClose = Number.parseFloat(String(row.globex_close));
    const globexVwap = row.vwap ? Number.parseFloat(String(row.vwap)) : null;
    const barCount = Number.parseInt(String(row.bar_count), 10);

    // Build pre_market_data JSON
    const preMarketData = JSON.stringify({
      globexHigh,
      globexLow,
      globexClose,
      globexVwap,
      savedAt: new Date().toISOString(),
      autoFilled: true,
    });

    // Upsert: update existing snapshot or create minimal one
    const existing = await sql`
      SELECT id FROM market_snapshots
      WHERE date = ${tradeDate}
      ORDER BY created_at DESC LIMIT 1
    `;

    if (existing.length > 0) {
      await sql`
        UPDATE market_snapshots
        SET pre_market_data = ${preMarketData}::jsonb
        WHERE id = ${existing[0]!.id}
      `;
    } else {
      await sql`
        INSERT INTO market_snapshots (date, entry_time, pre_market_data)
        VALUES (${tradeDate}, 'pre-market', ${preMarketData}::jsonb)
      `;
    }

    logger.info(
      {
        tradeDate,
        globexHigh,
        globexLow,
        globexClose,
        globexVwap,
        barCount,
      },
      `Pre-market auto-filled: Globex H/L/C/VWAP = ${globexHigh}/${globexLow}/${globexClose}/${globexVwap?.toFixed(2) ?? 'N/A'}`,
    );

    const durationMs = Date.now() - startTime;
    await reportCronRun('auto-prefill-premarket', {
      status: 'ok',
      tradeDate,
      globexHigh,
      globexLow,
      globexClose,
      globexVwap,
      barCount,
      durationMs,
    });

    return res.status(200).json({
      job: 'auto-prefill-premarket',
      stored: true,
      tradeDate,
      globexHigh,
      globexLow,
      globexClose,
      globexVwap,
      barCount,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'auto-prefill-premarket');
    Sentry.captureException(err);
    logger.error({ err }, 'auto-prefill-premarket failed');
    await reportCronRun('auto-prefill-premarket', {
      status: 'error',
      tradeDate,
      error: err instanceof Error ? err.message : 'Unknown',
      durationMs: Date.now() - startTime,
    });
    return res.status(500).json({ error: 'Internal error' });
  }
}
