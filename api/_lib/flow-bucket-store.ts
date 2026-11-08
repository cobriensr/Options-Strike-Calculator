/**
 * flow_data writes and the data-quality count for the closed buckets
 * (api/_lib/closed-buckets.ts), shared by fetch-etf-tide,
 * fetch-zero-dte-flow and fetch-greek-flow so all three use the same counting
 * and the same session count. A bucket that carries the OTM wings (greek flow:
 * otm_ncp, otm_npp) also writes and compares them; one without leaves those
 * two columns unnamed, so they stay NULL and are never rewritten.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md
 *
 * The write is an idempotent upsert on the source-derived key (spec R6), not
 * a lock and not DO NOTHING. DO NOTHING kept the first value of a bucket for
 * good, and a minute that has ended is not necessarily final. Each run
 * re-sends every closed bucket of the day, so a value UW revises later is
 * corrected by the next run, through the close. A row is rewritten only when
 * a value really differs, so a settled bucket gets no new tuple version (the
 * row is still locked by the conflicting INSERT), and `created_at` is never
 * touched.
 *
 * Every row a write inserts or changes is also appended to flow_data_revisions
 * (migration #206, spec P0.7), the log of every value a row ever had with the
 * time it was stored and the writer's name. flow_data keeps the latest value,
 * and UW restates these series, so without the log the first-seen value, and
 * what the system showed at time T, are gone. The log insert is part of the
 * same statement as the upsert, so a rejected log insert rejects the write:
 * flow_data does not change and the run fails (R4). A row whose values did not
 * change writes no revision.
 */

import { getDb } from './db.js';
import { sessionWindowIso, type ClosedBucket } from './closed-buckets.js';

export interface UpsertCounts {
  /** New rows. */
  inserted: number;
  /** Existing rows whose ncp, npp, net_volume or OTM wing UW revised. */
  updated: number;
  /** Existing rows that already hold these values. */
  unchanged: number;
}

/**
 * Upsert `buckets` for `source` on ET day `date` in one transaction, logging
 * each inserted or changed row to flow_data_revisions under `writer` (the job
 * name). A rejected write, or a rejected log insert, throws to the caller,
 * which must fail its run (R4).
 */
export async function upsertClosedBuckets(
  buckets: ClosedBucket[],
  source: string,
  date: string,
  writer: string,
): Promise<UpsertCounts> {
  if (buckets.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

  const sql = getDb();
  // One statement per bucket: a data-modifying CTE. `up` is the upsert, and it
  // returns the row it inserted or changed (when the WHERE is false no row is
  // returned: unchanged); the INSERT after it appends that row, as stored, to
  // flow_data_revisions. Row-wise IS DISTINCT FROM treats two NULLs as equal,
  // so a NULL net_volume that stays NULL is not rewritten. `xmax = 0` marks a
  // tuple this statement inserted; an updated one carries the updater's
  // transaction id, and is_first records which it was. The outer RETURNING
  // gives the same one-row-or-none answer the counting below reads.
  //
  // Two statements, one per shape of bucket, because a tagged template cannot
  // splice a column list. They differ only in the two OTM columns, and both
  // return the same row, so the counting below is shared.
  const results = await sql.transaction((txn) =>
    buckets.map((bucket) =>
      bucket.otm === undefined
        ? txn`
        WITH up AS (
          INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
          VALUES (${date}, ${bucket.timestamp}, ${source}, ${bucket.ncp}, ${bucket.npp}, ${bucket.netVolume})
          ON CONFLICT (date, timestamp, source) DO UPDATE
            SET ncp = EXCLUDED.ncp,
                npp = EXCLUDED.npp,
                net_volume = EXCLUDED.net_volume
            WHERE (flow_data.ncp, flow_data.npp, flow_data.net_volume)
              IS DISTINCT FROM (EXCLUDED.ncp, EXCLUDED.npp, EXCLUDED.net_volume)
          RETURNING date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
                    (xmax = 0) AS is_first
        )
        INSERT INTO flow_data_revisions (
          date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
          writer, is_first
        )
        SELECT date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
               ${writer}::text, is_first
        FROM up
        RETURNING is_first AS inserted
      `
        : txn`
        WITH up AS (
          INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp)
          VALUES (${date}, ${bucket.timestamp}, ${source}, ${bucket.ncp}, ${bucket.npp}, ${bucket.netVolume}, ${bucket.otm.ncp}, ${bucket.otm.npp})
          ON CONFLICT (date, timestamp, source) DO UPDATE
            SET ncp = EXCLUDED.ncp,
                npp = EXCLUDED.npp,
                net_volume = EXCLUDED.net_volume,
                otm_ncp = EXCLUDED.otm_ncp,
                otm_npp = EXCLUDED.otm_npp
            WHERE (flow_data.ncp, flow_data.npp, flow_data.net_volume, flow_data.otm_ncp, flow_data.otm_npp)
              IS DISTINCT FROM (EXCLUDED.ncp, EXCLUDED.npp, EXCLUDED.net_volume, EXCLUDED.otm_ncp, EXCLUDED.otm_npp)
          RETURNING date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
                    (xmax = 0) AS is_first
        )
        INSERT INTO flow_data_revisions (
          date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
          writer, is_first
        )
        SELECT date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp,
               ${writer}::text, is_first
        FROM up
        RETURNING is_first AS inserted
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
