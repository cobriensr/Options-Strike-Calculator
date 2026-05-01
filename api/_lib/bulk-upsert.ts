/**
 * bulkUpsert<T> — single-statement multi-row INSERT ... ON CONFLICT helper.
 *
 * Crons across this repo have re-implemented the same per-row INSERT loop:
 *
 *   for (const row of rows) {
 *     await sql`INSERT ... VALUES (${row.a}, ${row.b}) ON CONFLICT ...`;
 *   }
 *
 * That pattern is N round-trips to Neon instead of one. Variants using
 * `sql.transaction((txn) => rows.map(...))` are better but still build N
 * statements server-side. This helper consolidates a row batch into one
 * parameterized `INSERT INTO ... VALUES ($1,...,$N), (...) ON CONFLICT
 * ... DO UPDATE SET ...` call via `sql.query()`.
 *
 * Transactional guarantees:
 *   - Single-chunk runs use a direct `sql.query()` — atomic per Postgres
 *     statement semantics.
 *   - Multi-chunk runs (rows.length > chunkSize) wrap every chunk in a
 *     single `sql.transaction(...)` so a failure on chunk N rolls back
 *     chunks 1..N-1. No half-upserted state.
 *
 * Adoption is staged — see Phase 3b in
 * docs/superpowers/specs/api-refactor-2026-05-02.md. This module is
 * greenfield; no consumer migrates here.
 *
 * Phase 1b of the refactor.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Default chunk size: how many rows we'll batch into a single
 * INSERT statement before splitting. Neon's parameter limit is 65k and
 * its max query size is generous, but extremely wide rows (40+ columns)
 * times very tall batches eventually trip parameter or response limits.
 *
 * 500 is conservative: at 22 columns per row (the widest in this repo —
 * `gex_strike_0dte`) one chunk uses 11_000 placeholders, well under the
 * driver limit. Callers with narrow rows can override upward; callers
 * with extremely wide rows can override downward.
 */
export const BULK_UPSERT_DEFAULT_CHUNK_SIZE = 500;

export interface BulkUpsertOptions<T extends Record<string, unknown>> {
  /** Neon SQL function from `getDb()`. */
  sql: NeonQueryFunction<false, false>;
  /** Target table name (must be a trusted constant — not user input). */
  table: string;
  /**
   * Column names to write. Order maps to the `T` row-object keys so the
   * helper can build the parameter array deterministically. Must be a
   * trusted constant — not user input.
   */
  columns: readonly (keyof T & string)[];
  /** Rows to upsert. Each row's keys must include every column in `columns`. */
  rows: readonly T[];
  /**
   * Conflict target clause, e.g. `'(date, ticker, strike)'` or
   * `'ON CONSTRAINT my_uniq'`. Must be a trusted constant.
   */
  conflictTarget: string;
  /**
   * Columns to update on conflict. Defaults to every column NOT named in
   * `conflictTarget`. Pass `[]` to make the upsert a no-op on conflict
   * (equivalent to `ON CONFLICT ... DO NOTHING`).
   */
  conflictUpdateColumns?: readonly (keyof T & string)[];
  /** Override chunk size. Default: BULK_UPSERT_DEFAULT_CHUNK_SIZE. */
  chunkSize?: number;
}

export interface BulkUpsertResult {
  /** Number of rows passed in (NOT the number of conflicts resolved). */
  rows: number;
}

// Identifiers visible to the conflict clause, used to derive the default
// update columns. We compare lower-case strings against a tokenized form
// of `conflictTarget` so `'(Date, Ticker)'` and `'(date, ticker)'` both
// drop the right columns.
function parseConflictColumns(conflictTarget: string): Set<string> {
  // Strip parentheses and split on comma; tolerate extra whitespace and
  // optional `ON CONSTRAINT` syntax (which has no inline columns).
  const m = /^\s*\(([^)]+)\)\s*$/.exec(conflictTarget);
  if (!m) return new Set();
  return new Set(
    m[1]!
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Build a single INSERT...VALUES(...)...ON CONFLICT statement and its
 * flat parameter array for one chunk. Each row contributes one `(...)`
 * tuple of `$N` placeholders aligned to a flat params array.
 *
 * Returned as a `(stmt, params)` pair so callers can either run it
 * directly via `sql.query(stmt, params)` (single-chunk fast path) or
 * via `txn.query(stmt, params)` inside a `sql.transaction` callback
 * (multi-chunk all-or-nothing path).
 */
function buildChunkQuery<T extends Record<string, unknown>>(
  opts: BulkUpsertOptions<T>,
  chunk: readonly T[],
  updateColumns: readonly string[],
): { stmt: string; params: unknown[] } {
  const { table, columns, conflictTarget } = opts;

  const colCount = columns.length;
  const params: unknown[] = [];
  const tuples: string[] = [];

  for (const row of chunk) {
    const placeholders: string[] = [];
    for (let i = 0; i < colCount; i++) {
      placeholders.push(`$${params.length + 1}`);
      params.push(row[columns[i]!]);
    }
    tuples.push(`(${placeholders.join(',')})`);
  }

  const onConflict =
    updateColumns.length === 0
      ? `ON CONFLICT ${conflictTarget} DO NOTHING`
      : `ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateColumns
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(', ')}`;

  const stmt = `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES ${tuples.join(',')}
    ${onConflict}
  `;

  return { stmt, params };
}

/**
 * Upsert a row batch in one (or a few, when chunked) round-trips.
 *
 * Behavior:
 *   - Empty `rows` returns `{ rows: 0 }` immediately, no DB call.
 *   - `chunkSize` defaults to BULK_UPSERT_DEFAULT_CHUNK_SIZE (500).
 *   - `conflictUpdateColumns` defaults to every column not named in
 *     `conflictTarget`. Pass `[]` to coerce ON CONFLICT DO NOTHING.
 *   - Single-chunk path: one `sql.query()` call (no transaction
 *     overhead).
 *   - Multi-chunk path: ALL chunks run inside a single
 *     `sql.transaction(...)` so a mid-loop failure rolls back every
 *     prior chunk. The wrapper is all-or-nothing — callers don't need
 *     to reason about partial state.
 *   - `'ON CONSTRAINT <name>'` form: when `conflictTarget` is the
 *     `ON CONSTRAINT` form, default `conflictUpdateColumns` cannot be
 *     derived (we don't have access to the constraint definition).
 *     Callers MUST pass `conflictUpdateColumns` explicitly — we throw
 *     a clear error otherwise to avoid silently overwriting every
 *     column on conflict.
 *
 * IMPORTANT — caller responsibility: rows passed to a single
 * `bulkUpsert` call MUST be deduplicated by `conflictTarget`. Postgres
 * raises `cardinality_violation` ("ON CONFLICT DO UPDATE command
 * cannot affect row a second time") if two rows in the same statement
 * collide on the conflict target. This helper does NOT dedupe — that
 * would require knowing the precedence rule (last-wins vs first-wins
 * vs merged), which is caller-specific. Dedupe upstream.
 *
 * Returns `{ rows: rows.length }`. Note: this is the input row count,
 * NOT the number of rows that mutated the DB. Neon's serverless driver
 * doesn't return the exact rowCount from a multi-statement upsert, and
 * exposing the input count keeps the contract simple.
 */
export async function bulkUpsert<T extends Record<string, unknown>>(
  opts: BulkUpsertOptions<T>,
): Promise<BulkUpsertResult> {
  const { sql, rows, columns, conflictTarget, chunkSize: chunkOverride } = opts;

  if (rows.length === 0) return { rows: 0 };
  if (columns.length === 0) {
    throw new Error('bulkUpsert: columns must be a non-empty list');
  }

  const chunkSize = chunkOverride ?? BULK_UPSERT_DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0) {
    throw new Error('bulkUpsert: chunkSize must be > 0');
  }

  // Hoisted: parsing the conflict target every iteration of the
  // filter callback below would be wasted work + the closure misled
  // reviewers about the cost.
  const conflictSet = parseConflictColumns(conflictTarget);

  // Resolve the conflict-update column list once. Default to "every
  // column not in the conflict target" so callers don't have to repeat
  // the column list — matches the SQL pattern they already write by hand.
  let updateColumns: readonly string[];
  if (opts.conflictUpdateColumns) {
    updateColumns = [...opts.conflictUpdateColumns];
  } else {
    // ON CONSTRAINT <name> form yields an empty conflictSet; we cannot
    // safely derive a default because "every column not in the conflict
    // target" silently means "every column" — callers almost never want
    // an upsert that overwrites the conflict-key columns. Reject loudly.
    if (conflictSet.size === 0) {
      throw new Error(
        'bulkUpsert: ON CONSTRAINT form requires explicit conflictUpdateColumns (cannot derive default)',
      );
    }
    updateColumns = columns.filter((c) => !conflictSet.has(c.toLowerCase()));
  }

  // Single-chunk fast path: one query, no transaction overhead.
  if (rows.length <= chunkSize) {
    const { stmt, params } = buildChunkQuery(opts, rows, updateColumns);
    await sql.query(stmt, params);
    return { rows: rows.length };
  }

  // Multi-chunk path: wrap the entire loop in a single Postgres
  // transaction so a failure on chunk N rolls back chunks 1..N-1.
  // We pre-build every (stmt, params) pair so the callback is a pure
  // synchronous mapper — `sql.transaction` requires a non-async fn.
  const chunkQueries: { stmt: string; params: unknown[] }[] = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const slice = rows.slice(offset, offset + chunkSize);
    chunkQueries.push(buildChunkQuery(opts, slice, updateColumns));
  }

  await sql.transaction((txn) =>
    chunkQueries.map(({ stmt, params }) => txn.query(stmt, params)),
  );

  return { rows: rows.length };
}
