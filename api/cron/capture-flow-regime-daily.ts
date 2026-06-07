/**
 * GET /api/cron/capture-flow-regime-daily
 *
 * Self-maintaining flow-regime baseline — daily post-close accumulator
 * (resolves code-review finding #6: the frozen, manually-refreshed baseline).
 *
 * Once per trading day, after the cash close, this:
 *   1. Resolves TODAY's full RTH window [09:30 ET, 16:00 ET] as UTC bounds
 *      (DST-safe via etWallClockToUtcIso).
 *   2. Reads the whole day's ws_option_trades (canceled = FALSE) for that
 *      window in ONE query.
 *   3. Buckets every row into its ET 30-min slot (0..12) and runs the shared
 *      computeFlowMetrics per slot to get the component sums (nd_num/nd_den,
 *      idx_put_premium/total_premium) — the SAME bucketing + coercion the live
 *      capture-flow-regime cron uses, so the accumulated distribution matches
 *      what the live cron scores against.
 *   4. UPSERTs one row per populated slot into flow_regime_slot_daily via
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
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { FLOW_REGIME_BASELINE } from '../_lib/flow-regime.js';
import {
  accumulateDailySlots,
  type WsOptionTradeRow,
} from '../_lib/flow-regime-rows.js';
import { getETDateStr, etWallClockToUtcIso } from '../../src/utils/timezone.js';

export default withCronInstrumentation(
  'capture-flow-regime-daily',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    // ET trading day — matches the table's DATE semantics and the live cron.
    const date = getETDateStr(now);

    // Full RTH window for TODAY as UTC bounds. rth_start/end come from the
    // committed baseline (570 = 09:30 ET, 960 = 16:00 ET).
    const startIso = etWallClockToUtcIso(
      date,
      FLOW_REGIME_BASELINE.rth_start_minute,
    );
    const endIso = etWallClockToUtcIso(
      date,
      FLOW_REGIME_BASELINE.rth_end_minute,
    );
    if (startIso === null || endIso === null) {
      ctx.logger.warn(
        { date },
        'capture-flow-regime-daily: could not resolve RTH window, skipping',
      );
      return {
        status: 'skipped',
        message: 'invalid RTH window',
        metadata: { date },
      };
    }

    // ws_option_trades is already restricted to the WS universe, so no ticker
    // filter. canceled = FALSE matches the baseline convention. The full-day
    // window [09:30, 16:00) ET keeps the upper bound exclusive so a 16:00:00
    // print (the close auction edge) does not leak into a non-existent slot 13.
    const sql = getDb();
    const rows = (await withDbRetry(
      () => sql`
        SELECT
          ticker,
          option_type,
          expiry,
          executed_at,
          price,
          size,
          side,
          delta
        FROM ws_option_trades
        WHERE canceled = FALSE
          AND executed_at >= ${startIso}::timestamptz
          AND executed_at < ${endIso}::timestamptz
      `,
      2,
      10_000,
    )) as WsOptionTradeRow[];

    // Bucket by ET 30-min slot and reduce each bucket to component sums via the
    // shared accumulator (same coercion + computeFlowMetrics as the live cron).
    const slots = accumulateDailySlots(rows, date);

    if (slots.length === 0) {
      ctx.logger.info(
        { date, totalRows: rows.length },
        'capture-flow-regime-daily: no RTH trades to accumulate',
      );
      return {
        status: 'skipped',
        message: 'no RTH trades',
        metadata: { date, totalRows: rows.length },
      };
    }

    // UPSERT one row per populated slot. ON CONFLICT (date, slot) DO UPDATE so a
    // re-run for the same day overwrites rather than duplicates (idempotent).
    for (const { slot, sums, nTrades } of slots) {
      await withDbRetry(
        () => sql`
          INSERT INTO flow_regime_slot_daily (
            date, slot, nd_num, nd_den, idx_put_premium, total_premium,
            n_trades, computed_at
          ) VALUES (
            ${date}::date, ${slot}, ${sums.ndNum}, ${sums.ndDen},
            ${sums.idxPutPremium}, ${sums.totalPremium}, ${nTrades}, NOW()
          )
          ON CONFLICT (date, slot) DO UPDATE SET
            nd_num = EXCLUDED.nd_num,
            nd_den = EXCLUDED.nd_den,
            idx_put_premium = EXCLUDED.idx_put_premium,
            total_premium = EXCLUDED.total_premium,
            n_trades = EXCLUDED.n_trades,
            computed_at = NOW()
        `,
        2,
        10_000,
      );
    }

    ctx.logger.info(
      { date, slotsUpserted: slots.length, totalRows: rows.length },
      'capture-flow-regime-daily completed',
    );

    return {
      status: 'success',
      rows: slots.length,
      metadata: { date, slotsUpserted: slots.length, totalRows: rows.length },
    };
  },
  { marketHours: false, requireApiKey: false },
);
