/**
 * flow_data writes and the data-quality count for the closed tide buckets
 * (api/_lib/closed-buckets.ts), shared by fetch-etf-tide and
 * fetch-zero-dte-flow so both use the same SQL.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md
 *
 * The write is an idempotent upsert on the source-derived key (spec R6), not
 * a lock and not DO NOTHING. DO NOTHING kept the first value of a bucket for
 * good, and a minute that has ended is not necessarily final. Each run
 * re-sends every closed bucket of the day, so a value UW revises later is
 * corrected by the next run, through the close. A row is rewritten only when
 * a value really differs, so the settled buckets cost no write, and
 * `created_at` is never touched.
 */

import { getDb } from './db.js';
import { sessionWindowIso, type ClosedBucket } from './closed-buckets.js';

export interface UpsertCounts {
  /** New rows. */
  inserted: number;
  /** Existing rows whose ncp, npp or net_volume UW revised. */
  updated: number;
  /** Existing rows that already hold these values. */
  unchanged: number;
}

/**
 * Upsert `buckets` for `source` on ET day `date` in one transaction. A
 * rejected write throws to the caller, which must fail its run (R4).
 */
export async function upsertClosedBuckets(
  buckets: ClosedBucket[],
  source: string,
  date: string,
): Promise<UpsertCounts> {
  if (buckets.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

  const sql = getDb();
  // Row-wise IS DISTINCT FROM treats two NULLs as equal, so a NULL net_volume
  // that stays NULL is not rewritten. `xmax = 0` marks a tuple this statement
  // inserted; an updated one carries the updater's transaction id. When the
  // WHERE is false no row is returned: unchanged.
  const results = await sql.transaction((txn) =>
    buckets.map(
      (bucket) => txn`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (${date}, ${bucket.timestamp}, ${source}, ${bucket.ncp}, ${bucket.npp}, ${bucket.netVolume})
        ON CONFLICT (date, timestamp, source) DO UPDATE
          SET ncp = EXCLUDED.ncp,
              npp = EXCLUDED.npp,
              net_volume = EXCLUDED.net_volume
          WHERE (flow_data.ncp, flow_data.npp, flow_data.net_volume)
            IS DISTINCT FROM (EXCLUDED.ncp, EXCLUDED.npp, EXCLUDED.net_volume)
        RETURNING (xmax = 0) AS inserted
      `,
    ),
  );

  const wasInserted = results.filter((r) => r[0]?.inserted === true).length;
  const wasUnchanged = results.filter((r) => r[0] === undefined).length;
  return {
    inserted: wasInserted,
    updated: results.length - wasInserted - wasUnchanged,
    unchanged: wasUnchanged,
  };
}

/**
 * Rows stored for `source` on ET day `date` that are stamped inside that
 * day's session (09:30 ET to the close), and how many of them carry a
 * non-zero premium. Rows outside the session, such as a previous session
 * stored under today's `date` before the fix, are not counted (R-quality), so
 * they cannot hide a dead day. NULL premiums count as zero.
 */
export async function sessionRowCounts(
  date: string,
  source: string,
): Promise<{ total: number; nonzero: number }> {
  const { openIso, closeIso } = sessionWindowIso(date);
  const rows = await getDb()`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
    FROM flow_data
    WHERE date = ${date} AND source = ${source}
      AND timestamp >= ${openIso}::timestamptz
      AND timestamp <= ${closeIso}::timestamptz
  `;
  const row = rows[0];
  return { total: Number(row?.total ?? 0), nonzero: Number(row?.nonzero ?? 0) };
}
