/**
 * GET /api/cron/auto-prefill-premarket
 *
 * Runs at the 8:30 AM CT cash open on weekdays. Queries overnight ES bars
 * from futures_bars (5:00 PM CT previous trading day through 8:30 AM CT
 * today), computes Globex high/low/close/VWAP, and writes to
 * market_snapshots.pre_market_data so the frontend auto-fills on load.
 *
 * Schedule: 30 13,14 * * 1-5 (DST-safe dual-slot; skips before cash open
 * and on market holidays)
 *
 * DST handling — two independent fixes:
 *   1. The overnight window END is the cash-open INSTANT (9:30 ET / 8:30 CT)
 *      computed via getETMarketOpenUtcIso, so it covers the full Globex
 *      session through the CT cash open in BOTH CDT (13:30 UTC) and CST
 *      (14:30 UTC). The old hardcoded `T13:30:00Z` dropped the EST/CST last
 *      Globex hour (07:30–08:30 CT) from H/L/C/VWAP.
 *   2. The single `30 13` slot fired at 07:30 CT in CST — an hour BEFORE the
 *      08:30 CT data is complete (no window math can conjure bars that
 *      haven't printed). Vercel crons run on fixed UTC, so no one slot hits
 *      the open in both regimes: we fire at 13:30 UTC (the CDT open) and
 *      14:30 UTC (the CST open) and gate with isPastCashOpen so the early
 *      CST slot skips and the post-open slot does the work. isPastCashOpen
 *      reads the market calendar, so a holiday skips both slots.
 *
 * Hand-saved data wins. In CDT the 14:30-UTC slot is a second run 60 minutes
 * after the first, by which time the owner may have saved the levels by hand
 * (POST /api/pre-market stores no `autoFilled` key). The UPDATE therefore only
 * writes a row whose pre_market_data is NULL or carries `autoFilled: true`,
 * and the run reports `skipped` when the row holds a hand save. The target
 * row is the one GET /api/pre-market would return (newest row that already
 * has pre_market_data, else the newest row), so auto data can never land in a
 * newer empty row and shadow an older hand save.
 *
 * Environment: CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { getETMarketOpenUtcIso } from '../../src/utils/timezone.js';
import { isPastCashOpen } from '../_lib/cron-helpers.js';
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
export function getOvernightStartCT(todayET: string): string {
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
export function getOvernightEndCT(todayET: string): string {
  const iso = getETMarketOpenUtcIso(todayET);
  if (!iso) {
    // todayET comes from cronGuard's getETDateStr(), always a valid
    // YYYY-MM-DD — a null here means an upstream contract broke. Throw
    // loudly rather than silently truncate the window to a bad bound.
    throw new Error(`Invalid trade date for overnight end: ${todayET}`);
  }
  return iso;
}

/** The four numbers the cron stores for one trade date's overnight window. */
export interface Globex {
  globexHigh: number;
  globexLow: number;
  globexClose: number;
  globexVwap: number | null;
  barCount: number;
}

/**
 * Globex H/L/C/VWAP of the overnight ES bars for `tradeDate`, or null when the
 * window holds no bars. The cron and scripts/recompute-futures-derived.ts both
 * read the window through this, so the stored numbers cannot drift apart.
 */
export async function queryGlobex(
  sql: ReturnType<typeof getDb>,
  tradeDate: string,
): Promise<Globex | null> {
  const overnightStart = getOvernightStartCT(tradeDate);
  const overnightEnd = getOvernightEndCT(tradeDate);

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

  const row = bars[0];
  if (!row?.globex_high) return null;
  return {
    globexHigh: Number.parseFloat(String(row.globex_high)),
    globexLow: Number.parseFloat(String(row.globex_low)),
    globexClose: Number.parseFloat(String(row.globex_close)),
    globexVwap: row.vwap ? Number.parseFloat(String(row.vwap)) : null,
    barCount: Number.parseInt(String(row.bar_count), 10),
  };
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

    // Query overnight ES bars from futures_bars
    const globex = await queryGlobex(sql, tradeDate);

    if (globex == null) {
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

    const { globexHigh, globexLow, globexClose, globexVwap, barCount } = globex;

    // Build pre_market_data JSON
    const preMarketData = JSON.stringify({
      globexHigh,
      globexLow,
      globexClose,
      globexVwap,
      savedAt: new Date().toISOString(),
      autoFilled: true,
    });

    // Upsert: update the snapshot GET /api/pre-market would return (the
    // newest row that already has pre_market_data, else the newest row), or
    // create a minimal one.
    const existing = await withDbRetry(
      () => sql`
        SELECT id FROM market_snapshots
        WHERE date = ${tradeDate}
        ORDER BY (pre_market_data IS NOT NULL) DESC, created_at DESC
        LIMIT 1
      `,
      2,
      10_000,
    );

    if (existing.length > 0) {
      // Conditional UPDATE ... RETURNING: it writes only a row that is empty
      // or was auto-filled by an earlier run. Zero rows back means the owner
      // saved this one by hand, which a re-run must not overwrite.
      const updated = await withDbRetry(
        () => sql`
          UPDATE market_snapshots
          SET pre_market_data = ${preMarketData}::jsonb
          WHERE id = ${existing[0]!.id}
            AND (
              pre_market_data IS NULL
              OR pre_market_data->>'autoFilled' = 'true'
            )
          RETURNING id
        `,
        2,
        10_000,
      );
      if (updated.length === 0) {
        logger.info(
          { tradeDate, snapshotId: existing[0]!.id },
          'Pre-market auto-fill left alone: the row holds hand-saved data',
        );
        return {
          status: 'skipped',
          message: 'Hand-saved pre-market data',
          metadata: {
            skipped: true,
            reason: 'manual_pre_market_data',
            tradeDate,
          },
        };
      }
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
  // Wrapped, not passed by value: isPastCashOpen's parameter is a grace in
  // minutes, so an argument added by the caller would land there.
  { timeCheck: () => isPastCashOpen(), requireApiKey: false },
);
