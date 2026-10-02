/**
 * In-SQL aggregation for the flow-regime crons: capture-flow-regime's live
 * 5-min window, and the per-slot persistence that capture-flow-regime and
 * capture-flow-regime-daily share (flow-regime-slot-daily.ts, one bounded
 * [slotStart, slotEnd) window per statement). The metric reduction runs INTO
 * Postgres so the raw ws_option_trades rows never serialize back to the cron.
 * Once the full ~50-ticker uw-stream option_trades universe wrote to that
 * table, streaming raw rows overflowed Neon's serverless HTTP 64MB cap
 * (NeonDbError 507 "response too large").
 *
 * Each statement returns five scalar component sums for one window:
 *   nd_num, nd_den, idx_put_premium, total_premium, n_trades
 * which `evaluateFlowRegime` (api/_lib/flow-regime.ts) scores against the
 * baseline. The column algebra below mirrors `computeFlowMetrics` — the JS
 * source of truth — AND `build_neon_metrics` in
 * scripts/build-flow-regime-baseline.py (the already-validated SQL reference).
 *
 * TESTABILITY: the actual SQL text + params are produced by a pure statement
 * builder (`buildAggWindowStatement`) that returns `{ text, params }`. Both
 * the prod path (neon `sql.query`) and the pglite
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
 * The universe-FILTERed component-sum SELECT expressions. `$1`=universe,
 * `$2`=index_set arrays; `idxPutDateExpr` is the SQL expression for the ET
 * trade date the 0DTE index-put test compares `expiry` against (the bound
 * `$5::date`). `sideSignExpr` is the baseline-derived CASE.
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
 * Build the single-window aggregation statement. It aggregates ONE window
 * [startIso, endIso) into the five scalar component sums: the live cron's
 * in-progress slot, or one closed slot's full window in the slot
 * persistence. The 0DTE index-put test compares `expiry` against the
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
 * Aggregate ONE window into the five scalar component sums in SQL, for the
 * live cron's in-progress slot or a closed slot's persistence. Thin wrapper
 * that runs the exact `buildAggWindowStatement` SQL against neon. Always
 * returns exactly one row.
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
