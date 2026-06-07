/**
 * Shared ws_option_trades → FlowTradeRow plumbing for the two flow-regime
 * crons (capture-flow-regime, the live 5-min upsert; and
 * capture-flow-regime-daily, the post-close per-slot accumulator). Both read
 * the same columns, coerce NUMERIC-as-string + nullable delta the same way,
 * and bucket rows by ET 30-min slot the same way — factored here so the two
 * stay byte-for-byte consistent (the consistency rule: divergent coercion or
 * bucketing would score the live metrics against an inconsistent baseline).
 */

import {
  computeFlowMetrics,
  slotForEtMinute,
  type FlowMetricSums,
  type FlowTradeRow,
} from './flow-regime.js';
import { parsedOrFallback } from './numeric-coercion.js';
import { neonDateStr } from './db-date.js';
import { getETTime } from '../../src/utils/timezone.js';

/**
 * Raw shape of one ws_option_trades row from Neon. NUMERIC columns come back
 * as STRINGS (price/delta); delta is NULLABLE. We coerce explicitly before
 * building FlowTradeRow so a raw null/string never reaches the metric math.
 * `executed_at` is needed by the daily cron to bucket rows into their ET slot.
 */
export interface WsOptionTradeRow {
  ticker: string;
  option_type: string;
  expiry: string | Date;
  executed_at: string | Date;
  price: string;
  size: number;
  side: string;
  delta: string | null;
}

/**
 * Coerce one raw ws_option_trades row to a FlowTradeRow for a given ET trade
 * date. delta null → 0 (contributes 0 to both the net-delta numerator and the
 * |delta| denominator); price null/invalid → 0 (computeFlowMetrics then
 * excludes that row from the put-share ratio). expiry + tradeDateEt are both
 * ET calendar-date strings so the 0DTE `expiry === tradeDateEt` test compares
 * like-for-like.
 */
export function toFlowTradeRow(
  r: WsOptionTradeRow,
  tradeDateEt: string,
): FlowTradeRow {
  return {
    ticker: r.ticker,
    optionType: r.option_type,
    expiry: neonDateStr(r.expiry),
    tradeDateEt,
    side: r.side,
    delta: parsedOrFallback(r.delta, 0),
    size: r.size,
    price: parsedOrFallback(r.price, 0),
  };
}

/**
 * Bucket raw ws_option_trades rows by their ET 30-min RTH slot, coercing each
 * to a FlowTradeRow stamped with `tradeDateEt`. Rows whose executed_at falls
 * outside RTH (slot === null) are dropped. Returns a Map slot → FlowTradeRow[].
 *
 * `executed_at` is a TIMESTAMPTZ; we localize it to ET via getETTime so the
 * slot derivation matches the live cron's `getETTotalMinutes(now)` path.
 */
export function bucketRowsBySlot(
  rows: readonly WsOptionTradeRow[],
  tradeDateEt: string,
): Map<number, FlowTradeRow[]> {
  const bySlot = new Map<number, FlowTradeRow[]>();
  for (const r of rows) {
    const executedAt =
      r.executed_at instanceof Date ? r.executed_at : new Date(r.executed_at);
    if (Number.isNaN(executedAt.getTime())) continue;
    const { hour, minute } = getETTime(executedAt);
    const slot = slotForEtMinute(hour * 60 + minute);
    if (slot === null) continue;
    const bucket = bySlot.get(slot);
    const tradeRow = toFlowTradeRow(r, tradeDateEt);
    if (bucket) bucket.push(tradeRow);
    else bySlot.set(slot, [tradeRow]);
  }
  return bySlot;
}

/** One slot's accumulated sums + trade count, ready to UPSERT. */
export interface SlotAccumulation {
  slot: number;
  sums: FlowMetricSums;
  nTrades: number;
}

/**
 * Reduce a full day's raw rows into per-slot accumulations (sums + n_trades)
 * via the shared bucketing + the Phase 1 computeFlowMetrics. Only slots that
 * actually had ≥1 RTH trade are returned (the daily cron upserts exactly these).
 */
export function accumulateDailySlots(
  rows: readonly WsOptionTradeRow[],
  tradeDateEt: string,
): SlotAccumulation[] {
  const bySlot = bucketRowsBySlot(rows, tradeDateEt);
  const out: SlotAccumulation[] = [];
  for (const [slot, bucket] of bySlot) {
    out.push({
      slot,
      sums: computeFlowMetrics(bucket),
      nTrades: bucket.length,
    });
  }
  out.sort((a, b) => a.slot - b.slot);
  return out;
}
