/**
 * In-SQL aggregation for the two flow-regime crons (capture-flow-regime, the
 * live 5-min upsert; and capture-flow-regime-daily, the post-close per-slot
 * accumulator). Both push the metric reduction INTO Postgres so the raw
 * ws_option_trades rows never serialize back to the cron — once the full
 * ~50-ticker uw-stream option_trades universe writes to that table, streaming
 * raw rows serialized past Neon's serverless HTTP 64MB cap (NeonDbError 507
 * "response too large").
 *
 * The crons return five scalar component sums per window (or per slot):
 *   nd_num, nd_den, idx_put_premium, total_premium, n_trades
 * which `evaluateFlowRegime` (api/_lib/flow-regime.ts) scores against the
 * baseline. The column algebra below mirrors `computeFlowMetrics` — the JS
 * source of truth — AND `build_neon_metrics` in
 * scripts/build-flow-regime-baseline.py (the already-validated SQL reference).
 *
 * TESTABILITY: the actual SQL text + params are produced by pure statement
 * builders (`buildAggWindowStatement`, `buildAggSlotStatement`) that return
 * `{ text, params }`. Both the prod path (neon `sql.query`) and the pglite
 * integration test (`api/__tests__/flow-regime-sql-integration.test.ts`)
 * EXECUTE those exact statements via an injectable runner — both neon
 * `sql.query(text, params)` and pglite `db.query(text, params)` use `$1`
 * placeholders, so the same statement runs in both. This means the real
 * production SQL is exercised by a test against an in-process Postgres,
 * closing the "a SQL typo ships green" gap.
 *
 * CONSISTENCY RULE: these aggregates MUST score against the SAME population the
 * baseline was built on:
 *   - universe filter        → ticker = ANY($1)
 *   - side_sign map          → CASE side WHEN ... END, built programmatically
 *                              from FLOW_REGIME_BASELINE.side_sign_map (so a
 *                              baseline regen that changes the map can't
 *                              silently desync the SQL from the JS reducer)
 *   - premium                → price * size * 100
 *   - 0DTE index-put test    → ticker = ANY($2) AND option_type = 'P'
 *                              AND expiry = <ET trade date>
 * n_trades is count(*) over the time window WITHOUT the universe filter — it
 * matches the JS reducer's `rows.length` / `bucket.length` (which count every
 * row, not just universe rows). The component SUMs are universe-FILTERed.
 *
 * NULL delta / price are skipped by SUM (0 contribution), matching the JS
 * `null → 0` coercion numerically. COALESCE(..., 0) turns an empty window into
 * 0, not NULL.
 */

import {
  FLOW_REGIME_BASELINE,
  type FlowRegimeBaseline,
} from './flow-regime.js';
import { numOrNull } from './numeric-coercion.js';
import type { NeonQueryFunction } from '@neondatabase/serverless';

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

/** A parameterized SQL statement: `$N`-placeholder text + its ordered params. */
export interface FlowAggStatement {
  text: string;
  params: unknown[];
}

/**
 * A query runner that executes a parameterized statement and returns the rows.
 * In prod this is the neon `sql.query`; in the integration test it's pglite's
 * `db.query`. Both accept `(text, params)` with `$1` placeholders and return
 * `{ rows }`-shaped results — we accept either `Row[]` (neon `sql.query`
 * resolves to the row array) or `{ rows: Row[] }` (pglite) and normalize.
 */
export type FlowAggRunner = (
  text: string,
  params: unknown[],
) => Promise<unknown>;

/** A `getDb()` handle — needs `.query(stmt, params)` for parameterized SQL. */
type SqlQueryFn = Pick<NeonQueryFunction<false, false>, 'query'>;

/**
 * Build the `side_sign` CASE expression from the baseline's side_sign_map
 * rather than hardcoding it. This is the ONLY SQL algebra that would otherwise
 * not be sourced from FLOW_REGIME_BASELINE; deriving it means a baseline regen
 * that changes the map updates the SQL and the JS reducer in lockstep.
 *
 * The side tokens are trusted constants from the committed baseline JSON, but
 * we still build the WHEN list programmatically (and quote-escape each token)
 * so the SQL can't silently drift from `sideSign` in flow-regime.ts.
 */
function sideSignCase(
  sideSignMap: Record<string, number> = FLOW_REGIME_BASELINE.side_sign_map,
): string {
  const whens = Object.entries(sideSignMap)
    // Only non-zero mappings need an explicit WHEN; unmapped/0 sides fall to
    // ELSE 0, matching `sideSign`'s `map[side] ?? 0`.
    .filter(([, sign]) => sign !== 0)
    .map(([side, sign]) => {
      // Single-quote-escape the side token (SQL string literal). These are
      // trusted constants, but escaping keeps the builder injection-safe if
      // the baseline map ever carries an odd token.
      const lit = side.replace(/'/g, "''");
      return `WHEN '${lit}' THEN ${Number(sign)}`;
    })
    .join(' ');
  return `CASE side ${whens} ELSE 0 END`;
}

/**
 * The universe-FILTERed component-sum SELECT expressions, shared verbatim by
 * both statement builders so they issue byte-identical aggregation algebra.
 * `$1`=universe, `$2`=index_set arrays; `idxPutDateExpr` is the SQL expression
 * for the ET trade date the 0DTE index-put test compares `expiry` against (a
 * bound `$N::date` for the live single-window cron, or the per-row ET date for
 * the daily GROUP BY cron). `sideSignExpr` is the baseline-derived CASE.
 */
function flowSumExprs(idxPutDateExpr: string, sideSignExpr: string): string {
  return `
    COALESCE(SUM(
      (${sideSignExpr})
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

/** Normalize a runner result to a row array (neon → Row[], pglite → {rows}). */
function runnerRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (
    result != null &&
    typeof result === 'object' &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/**
 * Build the single-window aggregation statement (the live capture-flow-regime
 * cron). Aggregates ONE in-progress window [startIso, endIso) into the five
 * scalar component sums. The 0DTE index-put test compares `expiry` against the
 * supplied ET trade date (`$5::date`). Always returns exactly one row
 * (COALESCE makes an empty window all-zero).
 *
 * Pure — produces `{ text, params }` with no I/O so the exact SQL can be
 * executed against either neon (prod) or pglite (integration test).
 */
export function buildAggWindowStatement(
  startIso: string,
  endIso: string,
  tradeDateEt: string,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): FlowAggStatement {
  const text = `
    SELECT
      count(*) AS n_trades,${flowSumExprs('$5::date', sideSignCase(baseline.side_sign_map))}
    FROM ws_option_trades
    WHERE canceled = FALSE
      AND executed_at >= $3::timestamptz
      AND executed_at < $4::timestamptz
  `;
  return {
    text,
    params: [
      baseline.universe,
      baseline.index_set,
      startIso,
      endIso,
      tradeDateEt,
    ],
  };
}

/**
 * Build the per-slot aggregation statement (the daily
 * capture-flow-regime-daily accumulator). Aggregates a full-day window
 * [startIso, endIso) into per-ET-30min-slot scalar component sums. The slot is
 * computed in SQL from the ET localization of executed_at and bounded to the
 * RTH grid [0, slot_count). The 0DTE index-put test compares `expiry` against
 * each row's own ET trade date. Returns one row per populated slot.
 *
 * Pure — produces `{ text, params }` with no I/O.
 */
export function buildAggSlotStatement(
  startIso: string,
  endIso: string,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): FlowAggStatement {
  const slotCount = baseline.slot_count;
  const rthStart = baseline.rth_start_minute;
  const bucket = baseline.bucket_minutes;
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
  const text = `
    SELECT
      ${slotExpr} AS slot,
      count(*) AS n_trades,${flowSumExprs(etDateExpr, sideSignCase(baseline.side_sign_map))}
    FROM ws_option_trades
    WHERE canceled = FALSE
      AND executed_at >= $3::timestamptz
      AND executed_at < $4::timestamptz
      AND ${slotExpr} >= 0
      AND ${slotExpr} < ${slotCount}
    GROUP BY slot
  `;
  return {
    text,
    params: [baseline.universe, baseline.index_set, startIso, endIso],
  };
}

/**
 * Execute the single-window statement against `run` and coerce the one result
 * row to a FlowAggRow. Shared by the prod cron (run = neon `sql.query`) and the
 * integration test (run = pglite `db.query`). Always returns one FlowAggRow.
 */
export async function runAggWindow(
  run: FlowAggRunner,
  startIso: string,
  endIso: string,
  tradeDateEt: string,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): Promise<FlowAggRow> {
  const { text, params } = buildAggWindowStatement(
    startIso,
    endIso,
    tradeDateEt,
    baseline,
  );
  const rows = runnerRows(await run(text, params));
  const first = rows[0];
  return first
    ? toFlowAggRow(first)
    : { nTrades: 0, ndNum: 0, ndDen: 0, idxPutPremium: 0, totalPremium: 0 };
}

/**
 * Execute the per-slot statement against `run` and coerce each result row to a
 * FlowAggSlotRow. Shared by the prod daily cron and the integration test.
 */
export async function runAggSlot(
  run: FlowAggRunner,
  startIso: string,
  endIso: string,
  baseline: FlowRegimeBaseline = FLOW_REGIME_BASELINE,
): Promise<FlowAggSlotRow[]> {
  const { text, params } = buildAggSlotStatement(startIso, endIso, baseline);
  const rows = runnerRows(await run(text, params));
  return rows.map((r) => ({
    slot: numOrNull(r.slot) ?? 0,
    ...toFlowAggRow(r),
  }));
}

/**
 * Aggregate ONE in-progress window into the five scalar component sums in SQL
 * (the live capture-flow-regime cron). Thin wrapper that runs the exact
 * `buildAggWindowStatement` SQL against neon. Always returns exactly one row.
 */
export async function aggregateFlowWindow(
  sql: SqlQueryFn,
  startIso: string,
  endIso: string,
  tradeDateEt: string,
): Promise<FlowAggRow> {
  return runAggWindow(
    (text, params) => sql.query(text, params),
    startIso,
    endIso,
    tradeDateEt,
  );
}

/**
 * Aggregate a full-day window into per-ET-30min-slot scalar component sums in
 * SQL (the daily capture-flow-regime-daily accumulator). Thin wrapper that runs
 * the exact `buildAggSlotStatement` SQL against neon. One row per populated
 * slot.
 */
export async function aggregateFlowWindowBySlot(
  sql: SqlQueryFn,
  startIso: string,
  endIso: string,
): Promise<FlowAggSlotRow[]> {
  return runAggSlot(
    (text, params) => sql.query(text, params),
    startIso,
    endIso,
  );
}
