/**
 * GET /api/cron/auto-prefill-premarket
 *
 * Runs at the 8:30 AM CT cash open on weekdays. Queries overnight ES bars
 * from futures_bars (5:00 PM CT previous trading day through 8:30 AM CT
 * today), computes Globex high/low/close/VWAP, and writes to
 * market_snapshots.pre_market_data so the frontend auto-fills on load.
 *
 * Schedule: 30 13,14 * * 1-5 (DST-safe dual-slot; skips before cash open)
 *
 * DST handling — two independent fixes:
 *   1. The overnight window END is the cash-open INSTANT (9:30 ET / 8:30 CT)
 *      computed via getETMarketOpenUtcIso, so it covers the full Globex
 *      session through the CT cash open in BOTH CDT (13:30 UTC) and CST
 *      (14:30 UTC). The old hardcoded `T13:30:00Z` dropped the EST/CST last
 *      Globex hour (07:30–08:30 CT) from H/L/C/VWAP.
 *   2. The single `30 13` slot fired at 07:30 CT in CST — an hour BEFORE the
 *      08:30 CT data is complete (no window math can conjure bars that
 *      haven't printed). Mirroring compute-es-overnight, we fire at both
 *      13:30 and 14:30 UTC and gate with isAfterCashOpen so the early CST
 *      slot skips and the post-open slot does the work. The CDT 14:30-UTC
 *      slot is a harmless idempotent re-run (same upsert).
 *
 * Environment: CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { getETTime, getETMarketOpenUtcIso } from '../../src/utils/timezone.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// ── Time helpers ────────────────────────────────────────────

/**
 * True once the 8:30 AM CT cash open (== 9:30 AM ET) has passed. Gates the
 * dual-slot schedule: in CST the 13:30-UTC slot is 07:30 CT (before open →
 * skip) and the 14:30-UTC slot is 08:30 CT (run). In CDT the 13:30-UTC slot
 * is already 08:30 CT (run); the 14:30-UTC slot also passes but is an
 * idempotent re-run.
 */
function isAfterCashOpen(): boolean {
  const { hour, minute } = getETTime(new Date());
  return hour * 60 + minute >= 570; // 9:30 AM ET
}

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
 * Get today's 8:30 AM CT cash open as a UTC ISO string. This is the same
 * instant as 9:30 AM ET, so getETMarketOpenUtcIso gives the DST-aware UTC:
 * 13:30 UTC in CDT, 14:30 UTC in CST. The old hardcoded `T13:30:00Z`
 * excluded the CST last Globex hour (07:30–08:30 CT) from the aggregate.
 */
function getOvernightEndCT(todayET: string): string {
  const iso = getETMarketOpenUtcIso(todayET);
  if (!iso) {
    // todayET comes from cronGuard's getETDateStr(), always a valid
    // YYYY-MM-DD — a null here means an upstream contract broke. Throw
    // loudly rather than silently truncate the window to a bad bound.
    throw new Error(`Invalid trade date for overnight end: ${todayET}`);
  }
  return iso;
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
    const bars = await withDbRetry(
      () => sql`
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
      `,
      2,
      10_000,
    );

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
    const existing = await withDbRetry(
      () => sql`
        SELECT id FROM market_snapshots
        WHERE date = ${tradeDate}
        ORDER BY created_at DESC LIMIT 1
      `,
      2,
      10_000,
    );

    if (existing.length > 0) {
      await withDbRetry(
        () => sql`
          UPDATE market_snapshots
          SET pre_market_data = ${preMarketData}::jsonb
          WHERE id = ${existing[0]!.id}
        `,
        2,
        10_000,
      );
    } else {
      await withDbRetry(
        () => sql`
          INSERT INTO market_snapshots (date, entry_time, pre_market_data)
          VALUES (${tradeDate}, 'pre-market', ${preMarketData}::jsonb)
        `,
        2,
        10_000,
      );
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
  { timeCheck: isAfterCashOpen, requireApiKey: false },
);
