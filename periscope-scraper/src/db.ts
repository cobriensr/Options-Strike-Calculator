/**
 * Neon Postgres helpers for periscope_snapshots inserts.
 *
 * Uses a singleton serverless client and batches inserts (max 500 rows per
 * SQL call) per the parent repo's `feedback_batched_inserts.md` convention.
 * Per-row inserts in a loop are 50–100x slower on Neon serverless.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { DATABASE_URL } from './config.js';
import type { SnapshotRow } from './types.js';

const MAX_ROWS_PER_INSERT = 500;

let client: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (client === null) {
    client = neon(DATABASE_URL);
  }
  return client;
}

/**
 * Insert snapshot rows into `periscope_snapshots` in batches of 500.
 *
 * Uses ON CONFLICT DO NOTHING on the (captured_at, expiry, panel, strike)
 * unique key for idempotency on retry. Returns the count of rows submitted
 * (not necessarily inserted — conflicts are silently skipped).
 */
export async function insertSnapshots(rows: SnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const sql = getDb();
  let submitted = 0;

  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);

    // Build a flat parameter list and a $1,$2,... VALUES list. The Neon
    // serverless driver's tagged-template form doesn't expand arrays into
    // VALUES tuples, so we use the (text, params) call form with explicit
    // positional parameters.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of chunk) {
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
      );
      params.push(
        row.capturedAt,
        row.expiry,
        row.panel,
        row.strike,
        row.value,
        row.timeframe,
      );
    }

    const text =
      `INSERT INTO periscope_snapshots ` +
      `(captured_at, expiry, panel, strike, value, timeframe) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, expiry, panel, strike) DO NOTHING`;

    // Neon v1 routes (text, params) call form through sql.query().
    await sql.query(text, params);
    submitted += chunk.length;
  }

  return submitted;
}
