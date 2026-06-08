/**
 * GET /api/cron/capture-flow-regime
 *
 * Flow Regime Recognition badge — live capture cron (Phase 2 of
 * docs/superpowers/specs/flow-regime-badge-2026-06-06.md).
 *
 * Every 5 min during market hours this:
 *   1. Computes the CURRENT 30-min ET RTH slot
 *      (slot = (et_minute − 570) / 30, RTH = [09:30, 16:00) ET).
 *   2. Reads ws_option_trades for TODAY (ET) from the slot's start
 *      minute up to "now".
 *   3. Builds FlowTradeRow[] and computes the two detrend-robust ratio
 *      metrics via the Phase 1 lib (computeFlowMetrics), scores them
 *      against the committed baseline (evaluateFlowRegime).
 *   4. UPSERTs the (date, slot) snapshot via ON CONFLICT DO UPDATE so
 *      the in-progress bucket is refined on every tick until it closes.
 *
 * Outside RTH the cron no-ops (status 'skipped') — there is no current
 * slot to capture. ws_option_trades is ALREADY restricted to the
 * ~50-ticker WS Lottery universe, so no extra ticker filter is needed in
 * SQL; computeFlowMetrics additionally restricts ALL sums to the baseline
 * universe (defence-in-depth if the WS subscription ever widens) and
 * applies the index-set restriction for the idx0dte_put_share numerator.
 *
 * RECOGNITION ONLY — the snapshot scores "is today's flow abnormal for
 * this time of day, as it forms"; it does NOT forecast direction.
 *
 * marketHours: true — only runs inside the RTH cron window.
 * requireApiKey: false — reads only our own ws_option_trades table.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  computeFlowMetrics,
  evaluateFlowRegime,
  slotForEtMinute,
  slotStartEtMinute,
} from '../_lib/flow-regime.js';
import { loadFlowRegimeBaseline } from '../_lib/flow-regime-baseline-live.js';
import {
  toFlowTradeRow,
  type WsOptionTradeRow,
} from '../_lib/flow-regime-rows.js';
import type { FlowTradeRow } from '../_lib/flow-regime.js';
import {
  getETDateStr,
  getETTotalMinutes,
  etWallClockToUtcIso,
} from '../../src/utils/timezone.js';

export default withCronInstrumentation(
  'capture-flow-regime',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    // ET trading day — matches the table's DATE semantics and the
    // endpoint's default, keeping date alignment across cron/endpoint.
    const date = getETDateStr(now);

    // Current 30-min RTH slot. Null outside [09:30, 16:00) ET → no-op.
    const etMinute = getETTotalMinutes(now);
    const slot = slotForEtMinute(etMinute);
    if (slot === null) {
      ctx.logger.info(
        { date, etMinute },
        'capture-flow-regime: outside RTH, skipping',
      );
      return {
        status: 'skipped',
        message: 'outside RTH',
        metadata: { date, etMinute },
      };
    }

    // Lower bound = the slot's start minute as a UTC instant; upper
    // bound = now. This window is the in-progress bucket so far. The
    // slot↔minute inverse is deduped into slotStartEtMinute (#10c).
    const startMinute = slotStartEtMinute(slot);
    const slotStartIso = etWallClockToUtcIso(date, startMinute);
    if (slotStartIso === null) {
      // getETDateStr should never produce a malformed date; defensive.
      ctx.logger.warn(
        { date, slotStartEtMinute: startMinute },
        'capture-flow-regime: could not resolve slot start, skipping',
      );
      return {
        status: 'skipped',
        message: 'invalid slot start',
        metadata: { date, slot },
      };
    }
    const nowIso = now.toISOString();

    // ws_option_trades is already restricted to the WS universe, so no
    // ticker filter. canceled = FALSE matches the parquet/baseline
    // convention. withDbRetry: Neon HTTP serverless can blip.
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
          AND executed_at >= ${slotStartIso}::timestamptz
          AND executed_at < ${nowIso}::timestamptz
      `,
      2,
      10_000,
    )) as WsOptionTradeRow[];

    // Coerce NUMERIC-as-string + nullable columns to plain finite numbers
    // BEFORE the metric math via the shared mapper (same coercion the daily
    // accumulator cron uses, so both score the same population). delta null →
    // 0; price null/invalid → 0 (excluded from the put-share ratio). expiry +
    // tradeDateEt are ET-consistent calendar-date strings so the 0DTE
    // `expiry === tradeDateEt` test compares like-for-like.
    const tradeRows: FlowTradeRow[] = rows.map((r) => toFlowTradeRow(r, date));

    // Self-maintaining baseline: compute percentile breakpoints ON READ from
    // the accumulating flow_regime_slot_daily table (per-slot, ≥15 days), with
    // a per-slot fallback to the committed JSON. One query per run. Empty table
    // → everything falls back to the committed JSON (identical to pre-self-
    // maintaining behavior).
    const { baseline, liveSlots } = await withDbRetry(
      () => loadFlowRegimeBaseline(sql),
      2,
      10_000,
    );

    // The evaluator OWNS the low-confidence floor: pass nTrades so a thin
    // bucket is suppressed to normal/gray with null percentiles INSIDE the
    // evaluator. The raw nd_tilt / idx0dte_put_share are still returned (and
    // persisted) for transparency; the percentiles are NULL whenever
    // confidence is 'low' (thin bucket OR thin baseline), keeping the pill
    // color and the frontend detail copy from ever disagreeing.
    const sums = computeFlowMetrics(tradeRows);
    const result = evaluateFlowRegime({
      sums,
      slot,
      nTrades: tradeRows.length,
      baseline,
    });

    // UPSERT — ON CONFLICT (date, slot) refines the in-progress bucket on each
    // 5-min tick. baseline_version records WHICH distribution scored this slot:
    //   2 → DB-computed (live) breakpoints from flow_regime_slot_daily,
    //   1 → fell back to the committed flow-regime-baseline.json (slot < 15d).
    // So a snapshot is self-describing about its scoring distribution. When the
    // accumulator table is empty every slot falls back → version 1 (same as the
    // pre-self-maintaining cron, which always stamped schema_version 1).
    const baselineVersion = liveSlots.has(slot) ? 2 : 1;
    await withDbRetry(
      () => sql`
        INSERT INTO flow_regime_snapshots (
          date, slot, computed_at,
          nd_tilt, idx0dte_put_share,
          nd_percentile, idxput_percentile,
          regime, color, n_trades, baseline_version
        ) VALUES (
          ${date}::date, ${slot}, NOW(),
          ${result.ndTilt}, ${result.idx0dtePutShare},
          ${result.ndPercentile}, ${result.idxputPercentile},
          ${result.regime}, ${result.color}, ${tradeRows.length},
          ${baselineVersion}
        )
        ON CONFLICT (date, slot) DO UPDATE SET
          computed_at = NOW(),
          nd_tilt = EXCLUDED.nd_tilt,
          idx0dte_put_share = EXCLUDED.idx0dte_put_share,
          nd_percentile = EXCLUDED.nd_percentile,
          idxput_percentile = EXCLUDED.idxput_percentile,
          regime = EXCLUDED.regime,
          color = EXCLUDED.color,
          n_trades = EXCLUDED.n_trades,
          baseline_version = EXCLUDED.baseline_version
      `,
      2,
      10_000,
    );

    ctx.logger.info(
      {
        date,
        slot,
        nTrades: tradeRows.length,
        regime: result.regime,
        color: result.color,
        hasBaseline: result.hasBaseline,
        confidence: result.confidence,
        confidenceReason: result.confidenceReason,
      },
      'capture-flow-regime completed',
    );

    return {
      status: 'success',
      rows: 1,
      metadata: {
        date,
        slot,
        nTrades: tradeRows.length,
        regime: result.regime,
        hasBaseline: result.hasBaseline,
        confidence: result.confidence,
      },
    };
  },
  { marketHours: true, requireApiKey: false },
);
