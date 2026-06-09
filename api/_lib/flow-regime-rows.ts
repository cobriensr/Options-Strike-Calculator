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
  FLOW_REGIME_BASELINE,
  type FlowMetricSums,
  type FlowTradeRow,
} from './flow-regime.js';
import { parsedOrFallback, numOrNull } from './numeric-coercion.js';
import { neonDateStr } from './db-date.js';
import { getETTime } from '../../src/utils/timezone.js';
import type { NeonQueryFunction } from '@neondatabase/serverless';

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
function bucketRowsBySlot(
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
 * Order is not significant — the caller only iterates to upsert.
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
  return out;
}

// ── In-SQL aggregation (replaces the raw-row stream + JS reducer) ─────────────
//
// The two crons used to SELECT every ws_option_trades row for a window and
// reduce them in JS via computeFlowMetrics / accumulateDailySlots. Now that the
// full ~50-ticker uw-stream option_trades universe writes to that table, the raw
// result set serializes past Neon's serverless HTTP 64MB cap (NeonDbError 507
// "response too large"). The fix is to push the metric reduction into SQL so the
// crons return scalar component sums instead of streaming raw rows.
//
// CONSISTENCY RULE: these aggregates MUST score against the SAME population the
// baseline was built on. The column algebra below mirrors `computeFlowMetrics`
// (the JS source of truth) AND `build_neon_metrics` in
// scripts/build-flow-regime-baseline.py (the already-validated SQL reference):
//   - universe filter        → ticker = ANY($universe)
//   - side_sign map          → CASE side WHEN 'ask' THEN 1 WHEN 'bid' THEN -1
//                              ELSE 0 END   (matches FLOW_REGIME_BASELINE.side_sign_map)
//   - premium                → price * size * 100
//   - 0DTE index-put test    → ticker = ANY($index) AND option_type = 'P'
//                              AND expiry = <ET trade date>
// n_trades is count(*) over the time window WITHOUT the universe filter — it
// matches the JS reducer's `rows.length` / `bucket.length` (which count every
// row, not just universe rows). The component SUMs are universe-FILTERed.
//
// NULL delta / price are skipped by SUM (0 contribution), matching the JS
// `null → 0` coercion numerically (parity test locks this). COALESCE(..., 0)
// turns an empty window into 0, not NULL.

/** The five scalar component sums for one aggregation window (or slot). */
export interface FlowAggRow {
  /** count(*) over the window (NOT universe-restricted — matches rows.length). */
  nTrades: number;
  /** Σ(side_sign · delta · size), universe-restricted. */
  ndNum: number;
  /** Σ(|delta| · size), universe-restricted. */
  ndDen: number;
  /** Σ(premium | 0DTE index put), universe-restricted. */
  idxPutPremium: number;
  /** Σ(premium), universe-restricted. */
  totalPremium: number;
}

/** One per-slot aggregation row (FlowAggRow + its slot index). */
export interface FlowAggSlotRow extends FlowAggRow {
  slot: number;
}

/** A `getDb()` handle — needs `.query(stmt, params)` for parameterized SQL. */
type SqlQueryFn = Pick<NeonQueryFunction<false, false>, 'query'>;

/**
 * The universe-FILTERed component-sum SELECT expressions, shared verbatim by
 * both crons so they issue byte-identical aggregation algebra. `$1`=universe,
 * `$2`=index_set arrays; `idxPutDateExpr` is the SQL expression for the ET trade
 * date the 0DTE index-put test compares `expiry` against (a bound `$N::date`
 * for the live single-window cron, or the per-row ET date for the daily
 * GROUP BY cron).
 */
function flowSumExprs(idxPutDateExpr: string): string {
  return `
    COALESCE(SUM(
      (CASE side WHEN 'ask' THEN 1 WHEN 'bid' THEN -1 ELSE 0 END)
        * delta::double precision * size
    ) FILTER (WHERE ticker = ANY($1)), 0) AS nd_num,
    COALESCE(SUM(
      abs(delta::double precision) * size
    ) FILTER (WHERE ticker = ANY($1)), 0) AS nd_den,
    COALESCE(SUM(
      price::double precision * size * 100
    ) FILTER (WHERE ticker = ANY($1)), 0) AS total_premium,
    COALESCE(SUM(
      price::double precision * size * 100
    ) FILTER (
      WHERE ticker = ANY($1)
        AND ticker = ANY($2)
        AND option_type = 'P'
        AND expiry = ${idxPutDateExpr}
    ), 0) AS idx_put_premium`;
}

/** Coerce a raw aggregation result row (NUMERIC → string) to a FlowAggRow. */
function toFlowAggRow(r: Record<string, unknown>): FlowAggRow {
  return {
    nTrades: numOrNull(r.n_trades) ?? 0,
    ndNum: numOrNull(r.nd_num) ?? 0,
    ndDen: numOrNull(r.nd_den) ?? 0,
    idxPutPremium: numOrNull(r.idx_put_premium) ?? 0,
    totalPremium: numOrNull(r.total_premium) ?? 0,
  };
}

/**
 * Aggregate ONE in-progress window [startIso, nowIso) into the five scalar
 * component sums in SQL (the live capture-flow-regime cron). The 0DTE index-put
 * test compares `expiry` against the supplied ET trade date (`tradeDateEt`).
 * Always returns exactly one row (COALESCE makes an empty window all-zero).
 */
export async function aggregateFlowWindow(
  sql: SqlQueryFn,
  startIso: string,
  endIso: string,
  tradeDateEt: string,
): Promise<FlowAggRow> {
  const stmt = `
    SELECT
      count(*) AS n_trades,${flowSumExprs('$5::date')}
    FROM ws_option_trades
    WHERE canceled = FALSE
      AND executed_at >= $3::timestamptz
      AND executed_at < $4::timestamptz
  `;
  const rows = (await sql.query(stmt, [
    FLOW_REGIME_BASELINE.universe,
    FLOW_REGIME_BASELINE.index_set,
    startIso,
    endIso,
    tradeDateEt,
  ])) as Record<string, unknown>[];
  const first = rows[0];
  return first
    ? toFlowAggRow(first)
    : { nTrades: 0, ndNum: 0, ndDen: 0, idxPutPremium: 0, totalPremium: 0 };
}

/**
 * Aggregate a full-day window [startIso, endIso) into per-ET-30min-slot scalar
 * component sums in SQL (the daily capture-flow-regime-daily accumulator). The
 * slot is computed in SQL from the ET localization of executed_at and bounded to
 * the RTH grid [0, slot_count). The 0DTE index-put test compares `expiry`
 * against each row's own ET trade date. Returns one row per populated slot.
 */
export async function aggregateFlowWindowBySlot(
  sql: SqlQueryFn,
  startIso: string,
  endIso: string,
): Promise<FlowAggSlotRow[]> {
  const slotCount = FLOW_REGIME_BASELINE.slot_count;
  const rthStart = FLOW_REGIME_BASELINE.rth_start_minute;
  const bucket = FLOW_REGIME_BASELINE.bucket_minutes;
  // ET-localized executed_at; the slot index and the per-row 0DTE trade date are
  // both derived from it. et_date mirrors build-flow-regime-baseline.py's Neon
  // path.
  const etExpr = `(executed_at AT TIME ZONE 'America/New_York')`;
  // CONSISTENCY (slot-boundary): we use floor((etMinute − rthStart) / bucket) so
  // this matches the live cron's slot derivation EXACTLY — `slotForEtMinute`
  // (api/_lib/flow-regime.ts) is `Math.floor(...)`. We deliberately do NOT mirror
  // build-flow-regime-baseline.py's `CAST(... AS INTEGER)`: Postgres CAST rounds
  // half-to-even, which shifts the back half of each 30-min window into the NEXT
  // slot (e.g. 10:15..10:29 → slot 1 under floor but slot 2 under CAST). The
  // daily cron BUILDS the per-slot distribution the live cron scores against, so
  // its bucketing MUST agree with the live cron's floor — otherwise a live slot's
  // metric would be scored against a misaligned baseline population. Both extract
  // terms are numeric, so `/ bucket` is float division and `floor()` truncates
  // toward −∞ identically to JS Math.floor.
  const slotExpr =
    `CAST(floor((extract(hour FROM ${etExpr}) * 60 ` +
    `+ extract(minute FROM ${etExpr}) - ${rthStart}) / ${bucket}) AS INTEGER)`;
  const etDateExpr = `CAST(${etExpr} AS DATE)`;
  const stmt = `
    SELECT
      ${slotExpr} AS slot,
      count(*) AS n_trades,${flowSumExprs(etDateExpr)}
    FROM ws_option_trades
    WHERE canceled = FALSE
      AND executed_at >= $3::timestamptz
      AND executed_at < $4::timestamptz
      AND ${slotExpr} >= 0
      AND ${slotExpr} < ${slotCount}
    GROUP BY slot
  `;
  const rows = (await sql.query(stmt, [
    FLOW_REGIME_BASELINE.universe,
    FLOW_REGIME_BASELINE.index_set,
    startIso,
    endIso,
  ])) as Record<string, unknown>[];
  return rows.map((r) => ({
    slot: numOrNull(r.slot) ?? 0,
    ...toFlowAggRow(r),
  }));
}
