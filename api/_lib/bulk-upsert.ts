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
 * Build a single INSERT...VALUES(...)...ON CONFLICT statement for one
 * chunk and run it via `sql.query()`. Each row contributes one
 * `(...)` tuple of `$N` placeholders aligned to a flat params array.
 */
async function runChunk<T extends Record<string, unknown>>(
  opts: BulkUpsertOptions<T>,
  chunk: readonly T[],
  updateColumns: readonly string[],
): Promise<void> {
  const { sql, table, columns, conflictTarget } = opts;

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

  await sql.query(stmt, params);
}

/**
 * Upsert a row batch in one (or a few, when chunked) round-trips.
 *
 * Behavior:
 *   - Empty `rows` returns `{ rows: 0 }` immediately, no DB call.
 *   - `chunkSize` defaults to BULK_UPSERT_DEFAULT_CHUNK_SIZE (500).
 *   - `conflictUpdateColumns` defaults to every column not named in
 *     `conflictTarget`. Pass `[]` to coerce ON CONFLICT DO NOTHING.
 *   - Multi-chunk: each chunk runs as its own statement. Failures
 *     bubble up (Neon throws — we don't swallow). Caller wraps in a
 *     transaction if it needs all-or-nothing semantics across chunks.
 *
 * Returns `{ rows: rows.length }`. Note: this is the input row count,
 * NOT the number of rows that mutated the DB. Neon's serverless driver
 * doesn't return the exact rowCount from a multi-statement upsert, and
 * exposing the input count keeps the contract simple.
 */
export async function bulkUpsert<T extends Record<string, unknown>>(
  opts: BulkUpsertOptions<T>,
): Promise<BulkUpsertResult> {
  const { rows, columns, conflictTarget, chunkSize: chunkOverride } = opts;

  if (rows.length === 0) return { rows: 0 };
  if (columns.length === 0) {
    throw new Error('bulkUpsert: columns must be a non-empty list');
  }

  const chunkSize = chunkOverride ?? BULK_UPSERT_DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0) {
    throw new Error('bulkUpsert: chunkSize must be > 0');
  }

  // Resolve the conflict-update column list once. Default to "every
  // column not in the conflict target" so callers don't have to repeat
  // the column list — matches the SQL pattern they already write by hand.
  const updateColumns = opts.conflictUpdateColumns
    ? [...opts.conflictUpdateColumns]
    : columns.filter((c) => {
        const conflictSet = parseConflictColumns(conflictTarget);
        return !conflictSet.has(c.toLowerCase());
      });

  // Single-chunk fast path skips the slicing arithmetic.
  if (rows.length <= chunkSize) {
    await runChunk(opts, rows, updateColumns);
    return { rows: rows.length };
  }

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const slice = rows.slice(offset, offset + chunkSize);
    await runChunk(opts, slice, updateColumns);
  }
  return { rows: rows.length };
}
