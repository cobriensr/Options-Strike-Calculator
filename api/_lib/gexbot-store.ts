/**
 * Shared INSERT helpers for the GEXBot capture pipeline.
 *
 * `insertCaptureRows` batches the `gexbot_api_capture` writes into a
 * single UNNEST round-trip, matching the pattern in
 * `greek-flow-etf-store.ts`. Per the feedback_batched_inserts memory
 * (2026-05-03), per-row INSERT in a loop is 50–100× slower at the
 * volumes the strikes cron handles (128 rows/min, ~30 KB JSONB each).
 *
 * Snapshots (16 rows/min) stay per-row inline in the fast cron —
 * the INSERT writes 48 columns (the table is 50 wide with id and
 * captured_at), so an UNNEST INSERT would need 48 arrays, which is
 * unmaintainable for marginal benefit at that row count.
 */

import { getDb, withDbRetry } from './db.js';

export interface CaptureRow {
  ticker: string;
  endpoint: string;
  category: string;
  /** GEXBot response.timestamp (epoch seconds) — null if absent. */
  sourceTimestamp: number | null;
  /** Stringified JSON payload destined for the JSONB column. */
  rawJson: string;
}

/**
 * Batch-insert capture rows into `gexbot_api_capture` via UNNEST.
 * One Postgres round-trip regardless of row count. Empty input is a
 * no-op (skips the DB call). The INSERT retries a transient Neon blip
 * (2 retries, 10 s per attempt) like the snapshot INSERTs in the fast
 * cron; any other error, or an exhausted retry, propagates.
 *
 * Idempotent once migration #192 is applied: `withDbRetry` times an attempt
 * out but does not cancel it, so a slow attempt can commit while its retry
 * (or a duplicate cron delivery) commits the same batch. The INSERT ends in
 * `ON CONFLICT DO NOTHING` (no conflict target), so the second write of a
 * row is a no-op through the partial unique index
 * `gexbot_api_capture_natural_key` on (ticker, endpoint, category,
 * source_timestamp). Rows with a NULL source_timestamp are outside the index
 * and not deduplicated.
 *
 * Deploy order: this code is valid before the index exists, so deploy it
 * first and apply #192 only once this build is live. The pre-#192 plain
 * INSERT raises 23505 (not retryable) on a repeated key once the index exists,
 * and that fails the whole batch.
 *
 * Returns the number of rows actually inserted (`RETURNING 1`), so a caller
 * can report written rows honestly: fetched minus returned is the number of
 * duplicates skipped.
 */
export async function insertCaptureRows(rows: CaptureRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();

  const tickers = rows.map((r) => r.ticker);
  const endpoints = rows.map((r) => r.endpoint);
  const categories = rows.map((r) => r.category);
  const sourceTs = rows.map((r) => r.sourceTimestamp);
  const rawJsons = rows.map((r) => r.rawJson);

  const inserted = await withDbRetry(
    () => sql`
      INSERT INTO gexbot_api_capture (
        ticker, endpoint, category, source_timestamp, raw_response
      )
      SELECT t.ticker, t.endpoint, t.category, t.source_timestamp, t.raw_response::jsonb
      FROM unnest(
        ${tickers}::text[],
        ${endpoints}::text[],
        ${categories}::text[],
        ${sourceTs}::bigint[],
        ${rawJsons}::text[]
      ) AS t(ticker, endpoint, category, source_timestamp, raw_response)
      ON CONFLICT DO NOTHING
      RETURNING 1
    `,
    2,
    10_000,
  );
  return inserted.length;
}
