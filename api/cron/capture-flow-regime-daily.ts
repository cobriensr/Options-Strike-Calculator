/**
 * GET /api/cron/capture-flow-regime-daily
 *
 * Self-maintaining flow-regime baseline — daily post-close accumulator
 * (resolves code-review finding #6: the frozen, manually-refreshed baseline).
 *
 * Once per trading day, after the cash close, this:
 *   1. Resolves TODAY's full RTH window [09:30 ET, 16:00 ET] as UTC bounds
 *      (DST-safe via etWallClockToUtcIso).
 *   2. Reduces the whole day's ws_option_trades (canceled = FALSE) for that
 *      window into per-ET-30min-slot component sums (nd_num/nd_den,
 *      idx_put_premium/total_premium) IN SQL via the shared
 *      aggregateFlowWindowBySlot builder — one GROUP BY slot query, no raw-row
 *      stream. (Streaming raw rows serialized past Neon's 64MB HTTP cap once the
 *      full ~50-ticker option_trades universe landed in the table.) The SQL
 *      algebra is byte-identical to the live cron's aggregateFlowWindow and
 *      mirrors computeFlowMetrics, so the accumulated distribution matches what
 *      the live cron scores against.
 *   3. UPSERTs one row per populated slot into flow_regime_slot_daily via
 *      ON CONFLICT (date, slot) DO UPDATE — idempotent if the cron re-runs.
 *
 * The live capture-flow-regime cron then computes percentile breakpoints ON
 * READ from this accumulating table (flow-regime-baseline-live.ts), falling
 * back per-slot to the committed flow-regime-baseline.json until a slot has
 * ≥15 days. The baseline therefore self-maintains from Neon — no parquet, no
 * Desktop dependency.
 *
 * marketHours: false — runs once post-close, outside the RTH cron window.
 * requireApiKey: false — reads only our own ws_option_trades table.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { FLOW_REGIME_BASELINE } from '../_lib/flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import { aggregateFlowWindowBySlot } from '../_lib/flow-regime-rows.js';
import { getETDateStr, etWallClockToUtcIso } from '../../src/utils/timezone.js';

/**
 * ws_option_trades retention horizon, mirrored from
 * api/cron/cleanup-ws-option-trades.ts (RETENTION_DAYS = 2). The cleanup cron
 * deletes rows older than today's ET date minus this many days, so this
 * accumulator can only re-read dates strictly NEWER than that horizon.
 */
const RETENTION_DAYS = 2;

/**
 * Catch-up lookback: re-accumulate the last (LOOKBACK_DAYS + 1) ET trading
 * dates each run (today + N prior days), idempotent via ON CONFLICT(date, slot).
 * A missed run (Vercel cron blip) would otherwise lose that day forever once
 * cleanup-ws-option-trades purges it. LOOKBACK_DAYS MUST stay < RETENTION_DAYS
 * of cleanup-ws-option-trades so it can never read a purged date. We want one
 * prior day (RETENTION_DAYS - 1 = 1) but clamp to RETENTION_DAYS - 1 as a hard
 * ceiling so the coupling can never be silently violated. (#2 / #9)
 */
const LOOKBACK_DAYS = Math.min(1, RETENTION_DAYS - 1);

/** One flow_regime_slot_daily upsert row, ready for bulkUpsert. */
interface SlotDailyRow extends Record<string, unknown> {
  date: string;
  slot: number;
  nd_num: number;
  nd_den: number;
  idx_put_premium: number;
  total_premium: number;
  n_trades: number;
  computed_at: Date;
}

/**
 * Read + accumulate one ET trading date's RTH window into per-slot rows, applying
 * the per-day volume quorum. Returns the upsert rows for that date (slots below
 * MIN_DAY_SLOT_TRADES are dropped so degenerate holiday/partial slots never get
 * persisted — #1a) plus a small per-date summary for logging. `null` window
 * (malformed date) yields an empty result.
 */
async function accumulateDate(
  sql: ReturnType<typeof getDb>,
  date: string,
  computedAt: Date,
): Promise<{ rows: SlotDailyRow[]; totalRows: number; skippedThin: number }> {
  // Full RTH window for `date` as UTC bounds. rth_start/end come from the
  // committed baseline (570 = 09:30 ET, 960 = 16:00 ET).
  const startIso = etWallClockToUtcIso(
    date,
    FLOW_REGIME_BASELINE.rth_start_minute,
  );
  const endIso = etWallClockToUtcIso(date, FLOW_REGIME_BASELINE.rth_end_minute);
  if (startIso === null || endIso === null) {
    return { rows: [], totalRows: 0, skippedThin: 0 };
  }

  // ws_option_trades is already restricted to the WS universe, but the
  // aggregation re-applies the baseline universe/index filters (consistency
  // rule) and reduces the full day to per-slot component sums IN SQL via the
  // shared builder (byte-identical algebra to the live cron). Streaming raw rows
  // here serialized past Neon's 64MB HTTP cap once the full ~50-ticker
  // option_trades universe landed in the table (NeonDbError 507). canceled =
  // FALSE matches the baseline convention; the full-day window [09:30, 16:00) ET
  // keeps the upper bound exclusive so a 16:00:00 print (close auction edge) does
  // not leak into a non-existent slot 13 (the slot expression is bounded
  // [0, slot_count) in SQL).
  const accum = await withDbRetry(
    () => aggregateFlowWindowBySlot(sql, startIso, endIso),
    2,
    10_000,
  );

  let skippedThin = 0;
  let totalRows = 0;
  const rows: SlotDailyRow[] = [];
  for (const {
    slot,
    nTrades,
    ndNum,
    ndDen,
    idxPutPremium,
    totalPremium,
  } of accum) {
    // n_trades counts every row in the slot (NOT universe-restricted) — matches
    // the old JS `bucket.length`. Accumulate it for the per-date log summary.
    totalRows += nTrades;
    // Per-day volume quorum: a slot with < MIN_DAY_SLOT_TRADES is a
    // holiday/partial-session straggler. Don't persist it — a degenerate daily
    // ratio would skew the thin percentile population the loader builds (#1a).
    if (nTrades < MIN_DAY_SLOT_TRADES) {
      skippedThin += 1;
      continue;
    }
    rows.push({
      date,
      slot,
      nd_num: ndNum,
      nd_den: ndDen,
      idx_put_premium: idxPutPremium,
      total_premium: totalPremium,
      n_trades: nTrades,
      computed_at: computedAt,
    });
  }

  return { rows, totalRows, skippedThin };
}

export default withCronInstrumentation(
  'capture-flow-regime-daily',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    const computedAt = now;

    // Catch-up lookback: today + LOOKBACK_DAYS prior ET trading dates. A missed
    // run loses the day forever once cleanup-ws-option-trades purges it, so we
    // re-accumulate the recent window each run (idempotent via the daily UPSERT).
    // Each date is derived by subtracting whole calendar days from `now` then
    // re-localizing to ET, then bounded to its own RTH window. Bounded < the
    // cleanup RETENTION_DAYS so we never read a purged date (#2 / #9).
    const dates: string[] = [];
    for (let back = 0; back <= LOOKBACK_DAYS; back++) {
      const d = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
      dates.push(getETDateStr(d));
    }

    const sql = getDb();
    const allRows: SlotDailyRow[] = [];
    const perDate: { date: string; slots: number; totalRows: number }[] = [];
    let totalSkippedThin = 0;

    for (const date of dates) {
      const { rows, totalRows, skippedThin } = await accumulateDate(
        sql,
        date,
        computedAt,
      );
      totalSkippedThin += skippedThin;
      perDate.push({ date, slots: rows.length, totalRows });
      allRows.push(...rows);
    }

    if (allRows.length === 0) {
      ctx.logger.info(
        { dates, perDate, skippedThin: totalSkippedThin },
        'capture-flow-regime-daily: no RTH slots above quorum to accumulate',
      );
      return {
        status: 'skipped',
        message: 'no RTH slots above quorum',
        metadata: { dates, perDate },
      };
    }

    // ONE multi-row INSERT ... ON CONFLICT (date, slot) DO UPDATE for all dates'
    // slots (≤ 26 rows with the 2-date lookback, far under the 500 chunk cap).
    // Idempotent: a re-run for the same day overwrites rather than duplicates.
    await withDbRetry(
      () =>
        bulkUpsert<SlotDailyRow>({
          sql,
          table: 'flow_regime_slot_daily',
          columns: [
            'date',
            'slot',
            'nd_num',
            'nd_den',
            'idx_put_premium',
            'total_premium',
            'n_trades',
            'computed_at',
          ],
          rows: allRows,
          conflictTarget: '(date, slot)',
        }),
      2,
      10_000,
    );

    ctx.logger.info(
      {
        dates,
        perDate,
        slotsUpserted: allRows.length,
        skippedThin: totalSkippedThin,
      },
      'capture-flow-regime-daily completed',
    );

    return {
      status: 'success',
      rows: allRows.length,
      metadata: {
        dates,
        perDate,
        slotsUpserted: allRows.length,
        skippedThin: totalSkippedThin,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
