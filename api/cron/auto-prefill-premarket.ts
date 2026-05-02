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

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

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

export default withCronInstrumentation(
  'auto-prefill-premarket',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    // The cronGuard's `today` is the same getETDateStr(new Date()) the
    // pre-wrapper handler used; reusing it keeps test mocks (which stub
    // cronGuard's return value) in sync without recomputing.
    const tradeDate = ctx.today;
    const sql = getDb();

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
      return {
        status: 'skipped',
        message: 'No overnight bars',
        metadata: {
          skipped: true,
          reason: 'No overnight bars',
          tradeDate,
        },
      };
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

    return {
      status: 'success',
      metadata: {
        stored: true,
        tradeDate,
        globexHigh,
        globexLow,
        globexClose,
        globexVwap,
        barCount,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
