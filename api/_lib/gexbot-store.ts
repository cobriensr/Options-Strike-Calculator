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
 * the table is 46 columns wide, an UNNEST INSERT would need 46 arrays
 * which is unmaintainable for marginal benefit at that row count.
 */

import { getDb } from './db.js';

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
 * no-op (skips the DB call).
 */
export async function insertCaptureRows(rows: CaptureRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb();

  const tickers = rows.map((r) => r.ticker);
  const endpoints = rows.map((r) => r.endpoint);
  const categories = rows.map((r) => r.category);
  const sourceTs = rows.map((r) => r.sourceTimestamp);
  const rawJsons = rows.map((r) => r.rawJson);

  await sql`
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
  `;
}
