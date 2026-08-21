/**
 * GET /api/cron/capture-flow-regime-daily
 *
 * Self-maintaining flow-regime baseline — daily post-close accumulator
 * (resolves code-review finding #6: the frozen, manually-refreshed baseline).
 *
 * Once per trading day, after the cash close, this:
 *   1. Resolves TODAY's full RTH window [09:30 ET, 16:00 ET) as UTC bounds
 *      (DST-safe via etWallClockToUtcIso) and splits it into one CHUNK per
 *      30-min slot on the absolute 09:30-ET grid (`buildDayChunkWindows`).
 *   2. For each chunk, SEQUENTIALLY, reduces that window's ws_option_trades
 *      (canceled = FALSE) into per-ET-30min-slot component sums (nd_num/nd_den,
 *      idx_put_premium/total_premium, n_trades) IN SQL via the shared
 *      aggregateFlowWindowBySlot builder — no raw-row stream. (Streaming raw
 *      rows serialized past Neon's 64MB HTTP cap once the full ~50-ticker
 *      option_trades universe landed in the table.) The SQL algebra is
 *      byte-identical to the live cron's aggregateFlowWindow and mirrors
 *      computeFlowMetrics, so the accumulated distribution matches what the
 *      live cron scores against.
 *
 *      WHY CHUNKS (2026-08-18): ONE full-day GROUP BY over ~7.4M rows blew the
 *      10s per-attempt withDbRetry timeout three times in a row (33s total →
 *      TransientDbError 'db attempt timeout', HTTP 500, nothing written). Each
 *      slot-window chunk is a small executed_at range scan (the same shape the
 *      live 5-min cron runs all day), so no single query scans the whole day.
 *      The builder derives the slot from the ET wall clock of `executed_at`
 *      (NOT from the window start), so chunk rows already carry absolute slot
 *      indices 0..slot_count-1 and can be merged by slot (`mergeSlotRows`).
 *      Chunks are slot-aligned so each slot normally comes from exactly one
 *      chunk, but the merge sums components regardless — a slot is NEVER
 *      written twice, and the per-day quorum is applied to the MERGED totals.
 *   3. UPSERTs one row per populated slot into flow_regime_slot_daily via
 *      ON CONFLICT (date, slot) DO UPDATE — idempotent if the cron re-runs.
 *
 * FAILURE CONTRACT: a date is written only when ALL of its chunks succeeded
 * (a partially-accumulated date would persist truncated slot sums). If a
 * chunk exhausts withDbRetry, or the wall-clock budget (DAILY_WALL_BUDGET_MS)
 * runs out, the run stops, still writes any EARLIER fully-accumulated dates,
 * and returns `status: 'error'` with partial diagnostics (failed date/chunk,
 * chunks done, elapsed ms) — the Sentry cron monitor goes red and the error is
 * captured with those diagnostics. The LOOKBACK_DAYS catch-up re-tries the
 * unwritten date on the next run.
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
import {
  aggregateFlowWindowBySlot,
  type FlowAggSlotRow,
} from '../_lib/flow-regime-rows.js';
import { Sentry } from '../_lib/sentry.js';
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

/**
 * Chunk width in ET minutes: ONE slot per chunk (the plan's "per slot window").
 * Chunks start on the 09:30-ET slot grid, so every chunk maps to exactly one
 * slot of the builder's absolute slot index; `mergeSlotRows` still sums by
 * slot so a different width (e.g. 60 = two slots per chunk) stays correct.
 */
const CHUNK_MINUTES = FLOW_REGIME_BASELINE.bucket_minutes;

/**
 * Wall-clock budget for the chunk loop, in ms. The function runs on the
 * default Vercel Fluid maxDuration (300s — no vercel.json override); 240s
 * leaves headroom for the final batched UPSERT (≤ 33s worst case under
 * withDbRetry(2, 10s)), the Sentry check-in and the response. Checked before
 * every chunk so an overrun is bounded by one chunk's query, not the whole
 * day: a pathological day returns an honest `status: 'error'` with partial
 * diagnostics instead of a Vercel hard timeout.
 */
export const DAILY_WALL_BUDGET_MS = 240_000;

/** Per-chunk withDbRetry settings: 2 retries (3 attempts), 10s per attempt. */
const CHUNK_RETRIES = 2;
const CHUNK_ATTEMPT_TIMEOUT_MS = 10_000;

/** One [startIso, endIso) chunk window (UTC ISO bounds). */
export interface ChunkWindow {
  startIso: string;
  endIso: string;
}

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
 * Split `date`'s RTH window [rth_start, rth_end) ET into contiguous
 * CHUNK_MINUTES-wide [startIso, endIso) UTC windows on the 09:30-ET grid. The
 * last chunk is clipped to the RTH end. `[]` for a malformed date. DST-safe:
 * each bound is localized independently via etWallClockToUtcIso (a DST
 * transition never falls inside RTH, so the chunks stay contiguous).
 */
export function buildDayChunkWindows(date: string): ChunkWindow[] {
  const rthStart = FLOW_REGIME_BASELINE.rth_start_minute;
  const rthEnd = FLOW_REGIME_BASELINE.rth_end_minute;
  const windows: ChunkWindow[] = [];
  for (let m = rthStart; m < rthEnd; m += CHUNK_MINUTES) {
    const startIso = etWallClockToUtcIso(date, m);
    const endIso = etWallClockToUtcIso(
      date,
      Math.min(m + CHUNK_MINUTES, rthEnd),
    );
    if (startIso === null || endIso === null) return [];
    windows.push({ startIso, endIso });
  }
  return windows;
}

/**
 * Merge one chunk's per-slot rows into the running per-slot accumulator by
 * SUMMING the five component fields. Slots are absolute (the builder derives
 * them from the ET wall clock), so rows for the same slot from different
 * chunks combine into ONE total — the per-day quorum and the single UPSERT row
 * are both computed from the merged totals.
 */
export function mergeSlotRows(
  acc: Map<number, FlowAggSlotRow>,
  rows: readonly FlowAggSlotRow[],
): void {
  for (const r of rows) {
    const cur = acc.get(r.slot);
    if (cur === undefined) {
      acc.set(r.slot, { ...r });
      continue;
    }
    cur.nTrades += r.nTrades;
    cur.ndNum += r.ndNum;
    cur.ndDen += r.ndDen;
    cur.idxPutPremium += r.idxPutPremium;
    cur.totalPremium += r.totalPremium;
  }
}

/** Why a date's accumulation stopped short of all its chunks. */
type AccumFailureReason = 'budget' | 'db';

/** Diagnostics for a date that did NOT fully accumulate. */
interface AccumFailure {
  reason: AccumFailureReason;
  /** The chunk index that failed (db) or was not started (budget). */
  chunk: number;
  chunksDone: number;
  chunksTotal: number;
  elapsedMs: number;
  /** The thrown error (db) or a synthesized budget error. */
  error: Error;
}

/** Outcome of accumulating ONE date: fully accumulated, or failed partway. */
type DateAccumResult =
  | {
      ok: true;
      rows: SlotDailyRow[];
      totalRows: number;
      skippedThin: number;
      chunks: number;
      ms: number;
    }
  | { ok: false; failure: AccumFailure };

/**
 * Read + accumulate one ET trading date's RTH window into per-slot rows, one
 * slot-window chunk at a time (sequential), applying the per-day volume quorum
 * to the merged per-slot totals. Returns the upsert rows for that date (slots
 * below MIN_DAY_SLOT_TRADES are dropped so degenerate holiday/partial slots
 * never get persisted — #1a) plus a per-date summary for logging. A malformed
 * date yields an empty ok result. A chunk that exhausts withDbRetry, or the
 * wall-clock deadline passing before a chunk starts, yields `ok: false` with
 * diagnostics — the caller must NOT write anything for that date.
 */
async function accumulateDate(
  sql: ReturnType<typeof getDb>,
  date: string,
  computedAt: Date,
  deadlineMs: number,
): Promise<DateAccumResult> {
  const t0 = Date.now();
  // Full RTH window for `date`, split on the 09:30-ET slot grid. rth_start/end
  // come from the committed baseline (570 = 09:30 ET, 960 = 16:00 ET). The
  // day's upper bound stays exclusive so a 16:00:00 print (close auction edge)
  // does not leak into a non-existent slot 13 (the slot expression is bounded
  // [0, slot_count) in SQL as well).
  const windows = buildDayChunkWindows(date);
  if (windows.length === 0) {
    return {
      ok: true,
      rows: [],
      totalRows: 0,
      skippedThin: 0,
      chunks: 0,
      ms: 0,
    };
  }

  // ws_option_trades is already restricted to the WS universe, but the
  // aggregation re-applies the baseline universe/index filters (consistency
  // rule) and reduces each chunk to per-slot component sums IN SQL via the
  // shared builder (byte-identical algebra to the live cron). canceled = FALSE
  // matches the baseline convention. Chunks run SEQUENTIALLY so at most one
  // range scan is in flight against Neon.
  const acc = new Map<number, FlowAggSlotRow>();
  for (const [i, { startIso, endIso }] of windows.entries()) {
    if (Date.now() > deadlineMs) {
      return {
        ok: false,
        failure: {
          reason: 'budget',
          chunk: i,
          chunksDone: i,
          chunksTotal: windows.length,
          elapsedMs: Date.now() - t0,
          error: new Error(
            `capture-flow-regime-daily: wall-clock budget ${DAILY_WALL_BUDGET_MS}ms ` +
              `exhausted on ${date} after ${i}/${windows.length} chunks`,
          ),
        },
      };
    }
    try {
      const chunkRows = await withDbRetry(
        () => aggregateFlowWindowBySlot(sql, startIso, endIso),
        CHUNK_RETRIES,
        CHUNK_ATTEMPT_TIMEOUT_MS,
      );
      mergeSlotRows(acc, chunkRows);
    } catch (err) {
      return {
        ok: false,
        failure: {
          reason: 'db',
          chunk: i,
          chunksDone: i,
          chunksTotal: windows.length,
          elapsedMs: Date.now() - t0,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      };
    }
  }

  let skippedThin = 0;
  let totalRows = 0;
  const rows: SlotDailyRow[] = [];
  // Ascending slot order keeps the UPSERT params deterministic.
  const merged = [...acc.values()].sort((a, b) => a.slot - b.slot);
  for (const {
    slot,
    nTrades,
    ndNum,
    ndDen,
    idxPutPremium,
    totalPremium,
  } of merged) {
    // n_trades counts every row in the slot (NOT universe-restricted) — matches
    // the old JS `bucket.length`. Accumulate it for the per-date log summary.
    totalRows += nTrades;
    // Per-day volume quorum on the MERGED per-slot total: a slot with
    // < MIN_DAY_SLOT_TRADES is a holiday/partial-session straggler. Don't
    // persist it — a degenerate daily ratio would skew the thin percentile
    // population the loader builds (#1a).
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

  return {
    ok: true,
    rows,
    totalRows,
    skippedThin,
    chunks: windows.length,
    ms: Date.now() - t0,
  };
}

/** Per-date summary (logged + returned in the cron metadata). */
interface PerDateSummary {
  date: string;
  slots: number;
  totalRows: number;
  chunks: number;
  ms: number;
}

export default withCronInstrumentation(
  'capture-flow-regime-daily',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    const computedAt = now;
    const deadlineMs = ctx.startTimeMs + DAILY_WALL_BUDGET_MS;

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
    const perDate: PerDateSummary[] = [];
    const datesWritten: string[] = [];
    let totalSkippedThin = 0;
    let failed: { date: string; failure: AccumFailure } | null = null;

    // Today first, then the lookback date(s). On the first failure we stop:
    // the budget is shared across dates, and a transient Neon issue will not
    // clear between two back-to-back dates. Dates that fully accumulated
    // BEFORE the failure are still written below; the failed date is left for
    // the next run's catch-up lookback.
    for (const date of dates) {
      const result = await accumulateDate(sql, date, computedAt, deadlineMs);
      if (!result.ok) {
        failed = { date, failure: result.failure };
        break;
      }
      const { rows, totalRows, skippedThin, chunks, ms } = result;
      totalSkippedThin += skippedThin;
      perDate.push({ date, slots: rows.length, totalRows, chunks, ms });
      ctx.logger.info(
        { date, chunks, ms, slots: rows.length, totalRows, skippedThin },
        'capture-flow-regime-daily: date accumulated',
      );
      if (rows.length > 0) datesWritten.push(date);
      allRows.push(...rows);
    }

    if (allRows.length > 0) {
      // ONE multi-row INSERT ... ON CONFLICT (date, slot) DO UPDATE for all
      // fully-accumulated dates' slots (≤ 26 rows with the 2-date lookback, far
      // under the 500 chunk cap). Idempotent: a re-run for the same day
      // overwrites rather than duplicates.
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
    }

    if (failed) {
      const { date, failure } = failed;
      const diagnostics = {
        date,
        reason: failure.reason,
        chunk: failure.chunk,
        chunksDone: failure.chunksDone,
        chunksTotal: failure.chunksTotal,
        elapsedMs: failure.elapsedMs,
        datesWritten,
        slotsUpserted: allRows.length,
      };
      ctx.logger.error(
        { err: failure.error, ...diagnostics, perDate },
        'capture-flow-regime-daily: date accumulation failed — ' +
          'that date was NOT written (next run’s catch-up lookback retries it)',
      );
      Sentry.captureException(failure.error, {
        level: 'error',
        tags: { cron: 'capture-flow-regime-daily', stage: 'accumulate' },
        extra: diagnostics,
      });
      const what =
        failure.reason === 'budget'
          ? 'wall-clock budget exhausted'
          : 'chunk failed';
      return {
        status: 'error',
        rows: allRows.length,
        message:
          `${date}: ${what} at chunk ${failure.chunk}/${failure.chunksTotal} ` +
          `after ${failure.elapsedMs}ms — ${failure.error.message}`,
        metadata: {
          dates,
          perDate,
          failedDate: date,
          failedChunk: failure.chunk,
          chunksDone: failure.chunksDone,
          chunksTotal: failure.chunksTotal,
          budgetHit: failure.reason === 'budget',
          datesWritten,
          slotsUpserted: allRows.length,
          skippedThin: totalSkippedThin,
        },
      };
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
