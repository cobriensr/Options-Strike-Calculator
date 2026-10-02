/**
 * GET /api/cron/capture-flow-regime-daily
 *
 * Post-close gap filler for the self-maintaining flow-regime baseline
 * (resolves code-review finding #6: the frozen, manually-refreshed baseline).
 *
 * The live capture-flow-regime cron persists each 30-min slot into
 * flow_regime_slot_daily as it closes. This cron fills only what is still
 * MISSING, one slot at a time:
 *   - normally just the final slot (15:30–16:00 ET), whose close the live
 *     cron's 16:00 tick never sees because it is outside RTH;
 *   - plus any slot a failed or missed live tick left behind.
 * It covers today and the previous weekday. Each fill runs the shared
 * per-window aggregation over that slot's [start, end) range, a bounded
 * executed_at index range. The old single full-day GROUP BY planned a
 * Parallel Seq Scan over the whole ws_option_trades heap and timed out every
 * weekday (Sentry ES). See flow-regime-slot-daily.ts and
 * docs/superpowers/specs/flow-regime-and-retention-2026-10-02.md.
 *
 * A lookback date older than the ws_option_trades retention horizon is
 * skipped rather than aggregated: the cleanup sweep may have pruned part of
 * it, and a partial window must never be persisted as a complete slot. Under
 * the 2-calendar-day retention this means Monday's lookback (Friday) is
 * always skipped, because Friday's tape is purged at Monday 00:00 ET.
 *
 * Slots outside the date's regular session (holidays, and half-day slots
 * after the 13:00 close) are never aggregated or persisted, so post-close
 * prints can't become a slot. Slots below the per-day quorum are never
 * persisted, so this run re-reads every one of them. A thin slot inside
 * today's regular session means trades were not ingested (uw-stream down),
 * so it raises one fingerprinted Sentry warning per run.
 *
 * The live cron then computes percentile breakpoints ON READ from this
 * accumulating table (flow-regime-baseline-live.ts), falling back per slot to
 * the committed flow-regime-baseline.json until a slot has ≥15 days.
 *
 * marketHours: false — runs once post-close, outside the RTH cron window.
 * requireApiKey: false — reads only our own ws_option_trades table.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { FLOW_REGIME_BASELINE } from '../_lib/flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from '../_lib/flow-regime-baseline-live.js';
import {
  finalizeSlot,
  isSlotSettled,
  isWithinTradeRetention,
  previousWeekdayEt,
  readPersistedSlots,
  slotWindow,
} from '../_lib/flow-regime-slot-daily.js';
import { Sentry } from '../_lib/sentry.js';
import { getETDateStr } from '../../src/utils/timezone.js';

export const config = { maxDuration: 300 };

/**
 * Start no new slot fill past this point in the run. Worst case after the
 * last check, against maxDuration = 300 s:
 *   120 s budget
 * + 126 s for one in-flight fill: aggregation 3 × 30 s + 3 s backoff, then
 *   upsert 3 × 10 s + 3 s
 * +  33 s for the next date's persisted-slot read (3 × 10 s + 3 s)
 * + ~10 s for the completion check-in and reportCronRun
 * = 289 s.
 * A normal run fills one slot in ~8 s; all 13 missing is ~100 s.
 */
const FILL_BUDGET_MS = 120_000;

/** Per-date outcome, for the log line and the cron metadata. */
interface DateFill {
  date: string;
  skipped?: 'outside-retention';
  alreadyPersisted?: number;
  written: number[];
  thin: number[];
  /** Not part of the session (holiday, post-half-day-close): never aggregated. */
  outsideSession: number[];
  unsettled: number[];
  failed: number[];
}

interface SlotFailure {
  date: string;
  slot: number;
  error: string;
}

/** A regular-session slot that came back below quorum: an ingest gap. */
interface ThinGap {
  date: string;
  slot: number;
  nTrades: number;
}

export default withCronInstrumentation(
  'capture-flow-regime-daily',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    const nowMs = now.getTime();
    const today = getETDateStr(now);
    const prior = previousWeekdayEt(today);
    const dates = prior ? [today, prior] : [today];

    const sql = getDb();
    const perDate: DateFill[] = [];
    const failures: SlotFailure[] = [];
    const thinGaps: ThinGap[] = [];
    let firstError: unknown = null;

    for (const date of dates) {
      const fill: DateFill = {
        date,
        written: [],
        thin: [],
        outsideSession: [],
        unsettled: [],
        failed: [],
      };
      perDate.push(fill);

      if (!isWithinTradeRetention(date, today)) {
        fill.skipped = 'outside-retention';
        ctx.logger.info(
          { date, today },
          'capture-flow-regime-daily: date is past ws_option_trades retention, skipping',
        );
        continue;
      }

      const persisted = await withDbRetry(
        () => readPersistedSlots(sql, date),
        2,
        10_000,
      );
      fill.alreadyPersisted = persisted.size;

      for (let slot = 0; slot < FLOW_REGIME_BASELINE.slot_count; slot++) {
        if (persisted.has(slot)) continue;
        const window = slotWindow(date, slot);
        if (!window) {
          // getETDateStr / previousWeekdayEt never yield a malformed date.
          fill.failed.push(slot);
          failures.push({ date, slot, error: 'invalid slot window' });
          continue;
        }
        if (!isSlotSettled(window, nowMs)) {
          fill.unsettled.push(slot);
          continue;
        }
        if (Date.now() - ctx.startTimeMs > FILL_BUDGET_MS) {
          fill.failed.push(slot);
          failures.push({ date, slot, error: 'fill budget exhausted' });
          continue;
        }
        try {
          const result = await finalizeSlot(sql, date, window);
          if (result.outcome === 'written') {
            fill.written.push(slot);
          } else if (result.outcome === 'outside-session') {
            fill.outsideSession.push(slot);
          } else {
            fill.thin.push(slot);
            // A thin slot is inside the regular session (finalizeSlot gates
            // the rest), so it is an ingest gap. Thin slots are never
            // persisted, so this run re-aggregates every one and is the place
            // to surface them. Only today's: the lookback date's gaps were
            // reported by yesterday's run.
            if (date === today) {
              thinGaps.push({ date, slot, nTrades: result.nTrades });
            }
          }
        } catch (err) {
          firstError ??= err;
          fill.failed.push(slot);
          failures.push({
            date,
            slot,
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.logger.error(
            { err, date, slot },
            'capture-flow-regime-daily: slot fill failed',
          );
        }
      }
    }

    const written = perDate.reduce((n, d) => n + d.written.length, 0);
    const thin = perDate.reduce((n, d) => n + d.thin.length, 0);
    const attempted = written + thin + failures.length;
    const metadata = { dates, perDate, written, thin, failures, thinGaps };

    if (thinGaps.length > 0) {
      const gapMessage =
        `capture-flow-regime-daily: ${thinGaps.length} regular-session ` +
        `slot(s) below the ${MIN_DAY_SLOT_TRADES}-trade quorum ` +
        '(ws_option_trades ingest gap?); not persisted';
      ctx.logger.warn({ thinGaps }, gapMessage);
      Sentry.captureMessage(gapMessage, {
        level: 'warning',
        fingerprint: ['capture-flow-regime-daily', 'thin-slot'],
        tags: { 'cron.anomaly': 'flow-regime-thin-slot' },
        extra: { thinGaps },
      });
    }

    if (failures.length > 0) {
      // One Sentry event per run, naming every slot left unfilled. A failed
      // slot was not written. The next run retries it while its date is
      // still inside retention.
      Sentry.captureException(
        firstError ??
          new Error(
            `capture-flow-regime-daily: ${failures.length} slot(s) not filled`,
          ),
        {
          tags: { 'flow_regime.step': 'slot-fill' },
          extra: { failures },
        },
      );
      ctx.logger.error(
        metadata,
        'capture-flow-regime-daily: some slots were not filled',
      );
      return {
        status: deriveCronStatus(failures.length, attempted),
        rows: written,
        message: `${failures.length} slot(s) not filled`,
        metadata,
      };
    }

    ctx.logger.info(metadata, 'capture-flow-regime-daily completed');
    if (written === 0 && thin > 0) {
      return {
        status: 'skipped',
        rows: 0,
        message: 'no missing slot above the per-day quorum',
        metadata,
      };
    }
    return { status: 'success', rows: written, metadata };
  },
  { marketHours: false, requireApiKey: false },
);
