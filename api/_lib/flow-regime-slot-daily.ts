/**
 * Slot persistence for `flow_regime_slot_daily`: the per-(date, slot)
 * component sums that the self-maintaining flow-regime baseline is built from
 * (flow-regime-baseline-live.ts).
 *
 * Each 30-min ET slot is persisted once it has closed, by aggregating its full
 * [slotStart, slotEnd) window with the same per-window statement the live
 * cron scores with (`buildAggWindowStatement`). Two writers share this module:
 *   - capture-flow-regime (live, every 5 min) finalizes slot − 1 on the first
 *     tick past the settle margin (normally the second tick of the next
 *     slot);
 *   - capture-flow-regime-daily (post-close) fills whatever is still missing,
 *     normally only the final slot, whose close the live cron's RTH gate
 *     never sees.
 * Each statement is bounded to one slot's `executed_at` index range. That
 * replaces the old full-day GROUP BY, which planned a Parallel Seq Scan over
 * the whole ws_option_trades heap and timed out every weekday (Sentry ES).
 * See docs/superpowers/specs/flow-regime-and-retention-2026-10-02.md.
 *
 * A slot is only written from a complete window. It must be settled
 * (SLOT_SETTLE_MS past its close, so uw-stream has committed its last
 * trades), and its date must still be fully inside ws_option_trades retention
 * (so the cleanup sweep cannot have pruned part of it). A failed aggregation
 * writes nothing, and the row's presence is the "finalized" marker that both
 * writers check.
 */

import { WS_OPTION_TRADES_RETENTION_DAYS } from './constants.js';
import { withDbRetry, type getDb } from './db.js';
import { FLOW_REGIME_BASELINE, slotStartEtMinute } from './flow-regime.js';
import { MIN_DAY_SLOT_TRADES } from './flow-regime-baseline-live.js';
import { aggregateFlowWindow } from './flow-regime-rows.js';
import {
  etWallClockToUtcIso,
  getETDayOfWeekFromDateStr,
} from '../../src/utils/timezone.js';

type Sql = ReturnType<typeof getDb>;

/**
 * How long after a slot closes before its window counts as complete. A
 * finalized slot is never re-aggregated, so this must cover the worst normal
 * ingest delay, not the typical one.
 *
 * `received_at` is the DB's NOW() at insert, and received_at − executed_at
 * measured p99.9 ≈ 3.1 s (max 3.4 s) on 2026-10-01. During a Neon stall,
 * though, uw-stream's flush retries (command_timeout 30 s × 3 attempts, plus
 * ~2 s of backoff; uw-stream/src/db.py) can commit a trade ~90 s late, plus
 * the time to drain the queue behind it. 5 min covers that with room to spare.
 *
 * It costs nothing: the baseline loader reads only dates before today, so no
 * one reads today's rows until tomorrow. Live finalize simply moves to the
 * second tick of the next slot (slot end + ~5:45 with Vercel's ~45 s firing
 * delay). Slot 11 still finalizes inside slot 12 (15:35 ET), and the daily
 * cron fills slot 12 well after 16:05 ET.
 */
export const SLOT_SETTLE_MS = 300_000;

/**
 * Per-attempt timeout for one slot-window aggregation (withDbRetry runs up to
 * 3 attempts). The heaviest slot measured, 2026-10-01 15:30–16:00 ET at 670k
 * rows, took 7.7 s cold via a Parallel Index Scan on executed_idx. 30 s is ~4×
 * that. The live cron's 10 s timeout was sized for partial windows.
 */
const SLOT_AGG_ATTEMPT_TIMEOUT_MS = 30_000;

/** One slot's [start, end) window as UTC instants. */
export interface SlotWindow {
  slot: number;
  startIso: string;
  endIso: string;
  endMs: number;
}

/** What `finalizeSlot` did with a closed slot. */
export interface SlotFinalizeResult {
  /**
   * 'written' → upserted. 'thin' → below MIN_DAY_SLOT_TRADES and NOT
   * persisted (a holiday or partial-session straggler; see the quorum's
   * docstring).
   */
  outcome: 'written' | 'thin';
  slot: number;
  nTrades: number;
}

/**
 * The full [slotStart, slotEnd) window of `slot` on ET date `date`, as UTC ISO
 * bounds (DST-safe). Null for a slot outside the RTH grid or a malformed date.
 */
export function slotWindow(date: string, slot: number): SlotWindow | null {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= FLOW_REGIME_BASELINE.slot_count
  ) {
    return null;
  }
  const startMinute = slotStartEtMinute(slot);
  const startIso = etWallClockToUtcIso(date, startMinute);
  const endIso = etWallClockToUtcIso(
    date,
    startMinute + FLOW_REGIME_BASELINE.bucket_minutes,
  );
  if (startIso === null || endIso === null) return null;
  return { slot, startIso, endIso, endMs: Date.parse(endIso) };
}

/** True once `window` closed at least SLOT_SETTLE_MS before `nowMs`. */
export function isSlotSettled(window: SlotWindow, nowMs: number): boolean {
  return nowMs >= window.endMs + SLOT_SETTLE_MS;
}

/** Shift a YYYY-MM-DD calendar date by whole days (UTC arithmetic, no TZ). */
function shiftDate(date: string, days: number): string | null {
  if (getETDayOfWeekFromDateStr(date) === null) return null;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * The weekday before ET date `date`: Monday → Friday, Sunday/Saturday →
 * Friday, otherwise the day before. Market holidays are not skipped. A holiday
 * date simply aggregates to empty (thin) windows and writes nothing.
 */
export function previousWeekdayEt(date: string): string | null {
  const dow = getETDayOfWeekFromDateStr(date);
  if (dow === null) return null;
  let back = 1;
  if (dow === 1) back = 3;
  else if (dow === 0) back = 2;
  return shiftDate(date, -back);
}

/**
 * True when every ws_option_trades row of ET date `date` is still present. The
 * cleanup cron deletes `executed_at < (todayEt − N days) 00:00 ET` with N =
 * WS_OPTION_TRADES_RETENTION_DAYS, so dates on or after todayEt − N are
 * intact. An older date may be partially pruned, and aggregating it would
 * persist a partial slot as if it were complete.
 */
export function isWithinTradeRetention(date: string, todayEt: string): boolean {
  const oldestIntact = shiftDate(todayEt, -WS_OPTION_TRADES_RETENTION_DAYS);
  return oldestIntact !== null && date >= oldestIntact;
}

/** The slots already persisted for `date` (≤ slot_count rows, PK-indexed). */
export async function readPersistedSlots(
  sql: Sql,
  date: string,
): Promise<Set<number>> {
  const rows = (await sql`
    SELECT slot FROM flow_regime_slot_daily WHERE date = ${date}::date
  `) as { slot: number | string }[];
  return new Set(rows.map((r) => Number(r.slot)));
}

/**
 * Aggregate one closed slot's full window and persist it. The caller has
 * already checked that the window is settled and its date is inside
 * retention. Idempotent: the upsert conflicts on (date, slot), a key derived
 * from the source data, so a re-run or a concurrent duplicate tick converges
 * on the same full-window values. Throws on any DB failure; nothing is
 * written unless the aggregation succeeded.
 */
export async function finalizeSlot(
  sql: Sql,
  date: string,
  window: SlotWindow,
): Promise<SlotFinalizeResult> {
  const sums = await withDbRetry(
    () => aggregateFlowWindow(sql, window.startIso, window.endIso, date),
    2,
    SLOT_AGG_ATTEMPT_TIMEOUT_MS,
  );
  if (sums.nTrades < MIN_DAY_SLOT_TRADES) {
    return { outcome: 'thin', slot: window.slot, nTrades: sums.nTrades };
  }
  await withDbRetry(
    () => sql`
      INSERT INTO flow_regime_slot_daily (
        date, slot, nd_num, nd_den, idx_put_premium, total_premium,
        n_trades, computed_at
      ) VALUES (
        ${date}::date, ${window.slot}, ${sums.ndNum}, ${sums.ndDen},
        ${sums.idxPutPremium}, ${sums.totalPremium}, ${sums.nTrades}, NOW()
      )
      ON CONFLICT (date, slot) DO UPDATE SET
        nd_num = EXCLUDED.nd_num,
        nd_den = EXCLUDED.nd_den,
        idx_put_premium = EXCLUDED.idx_put_premium,
        total_premium = EXCLUDED.total_premium,
        n_trades = EXCLUDED.n_trades,
        computed_at = EXCLUDED.computed_at
    `,
    2,
    10_000,
  );
  return { outcome: 'written', slot: window.slot, nTrades: sums.nTrades };
}
