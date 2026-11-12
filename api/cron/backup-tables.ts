/**
 * GET /api/cron/backup-tables
 *
 * Weekly logical backup of all database tables to Vercel Blob as JSONL.
 * Keeps a rolling 4-week retention window — deletes older backups automatically,
 * but only after a run that backed up every table (see `pruneSkipped`), and
 * never a folder dated on or before `PRUNE_PROTECTED_THROUGH` (2026-11-15).
 *
 * Each run creates one JSONL file per table under:
 *   backups/{YYYY-MM-DD}/{table_name}.jsonl
 *
 * Designed to run weekly on Sundays at 5 AM UTC via Vercel Cron.
 *
 * A run that does not back up every table in TABLES (a table failed, ran out of
 * time, outgrew the size cap, or pruning failed) answers 500, because
 * `withCronCheckin` sends its `error` check-in off the response status. It
 * also raises one error-level Sentry event that names the missing tables.
 * Every Blob call is aborted at `BLOB_DEADLINE_MS`, so a degraded Blob cannot
 * hold the run until Vercel kills it before that check-in.
 *
 * Environment: CRON_SECRET, BLOB_READ_WRITE_TOKEN (auto-provisioned by Vercel Blob)
 */

import { put, list, del } from '@vercel/blob';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';

export const config = { maxDuration: 300 };

// Priority order, not dependency order (the files are independent JSONL).
// The three revision tables come first: once UW restates a value the
// first-seen number cannot be fetched again, so they are the only copy and
// must land before anything slow can starve them. The rest run smallest to
// largest, so a spent time budget costs the biggest tables first.
const TABLES = [
  // The revision log (spec P0.8): once UW restates a value, the first-seen number
  // cannot be fetched again, so this table is the only copy. `id` is its first
  // column, so ORDER BY 1 pages it stably.
  'flow_data_revisions',
  // The revision logs of the two other series UW restates (spec P0.9): same
  // reason, same `id`-first layout. The seed rows in them are labelled
  // 'seed_restated' and are already restated, so these tables are the only copy
  // of every value stored from the migration on.
  'nope_ticks_revisions',
  'vega_flow_etf_revisions',
  'market_snapshots',
  'analyses',
  'outcomes',
  'positions',
  'lessons',
  'lesson_reports',
  'training_features',
  'day_labels',
  'economic_events',
  'schema_migrations',
  'spot_exposures',
  'flow_data',
  'greek_exposure',
  // strike_exposures is NOT here on purpose. At ~74M rows (12 GB heap, ~48 GB
  // as JSONL, +1M rows per trading day) the OFFSET paging below cannot finish
  // it in 300 s or 4 GB: a page costs 2.4 s at offset 0 and 117 s at offset
  // 20M. It killed the function every Sunday after 2026-05-17 (504 at 300 s,
  // or out of memory), before the closing check-in. Whether and how to back it
  // up is the owner's call (docs/superpowers/specs/live-data-integrity-2026-11-06.md).
] as const;

const RETENTION_WEEKS = 4;

// A backup folder dated on or before this day (YYYY-MM-DD, the ET date in the
// folder name) is never pruned, whatever its age; RETENTION_WEEKS applies only
// to folders dated after it. Owner decision, 2026-11-12. Why: the folders
// through 2026-11-15 are the only copies of these tables as they stood before
// the October-November repairs (the 220 misdated snapshots, the replays, the
// FOMC labels), and 2026-11-15 is the first complete backup since May. The
// owner removes them by hand.
const PRUNE_PROTECTED_THROUGH = '2026-11-15';

// Time budget for the whole table loop, against `maxDuration` 300 s. No table
// or page starts after 210 s. A page query already in flight can still take
// ~33 s (withDbRetry: 3 attempts x 10 s timeout + 1 s and 2 s backoff) and
// the put() after it ~14 s (generous: the whole export plus put of
// greek_exposure, the largest table, took 14 s on 2026-11-08, 05:00:11 to
// 05:00:25), so the last Blob call of a Neon-retrying run starts near 243 s.
// BLOB_DEADLINE_MS below is what keeps that inside maxDuration. A normal run
// needs ~50 s, so this stops a runaway table instead of limiting the run.
const TABLE_LOOP_BUDGET_MS = 210_000;

// Deadline for every Blob call (put, list, del), measured from startTime. A
// call still running at it is aborted and fails, so the run goes on to answer
// 500 and raise its Sentry error instead of being killed at maxDuration 300 s
// before the closing check-in. The backup-tables monitor is muted, so a silent
// kill would tell no one.
//
// Why a deadline of our own: @vercel/blob 2.4.0 retries a failing call up to
// 10 times (VERCEL_BLOB_RETRIES) with a backoff of 1 s, 2 s, 4 s ... (each x1
// to x2) that never looks at the abort signal, and it stops only when an
// attempt starts and sees an AbortError. So its own rejection can come minutes
// late, and a signal made with AbortSignal.timeout() is worse: that aborts with
// a TimeoutError, which it does not treat as an abort, so it retries on
// regardless (checked against the installed package with a local server that
// answers 503: 9.9 s with 3 retries; the default 10 back off for at least 17
// minutes: 1 s + 2 s + ... + 512 s). blobCallBefore
// therefore aborts an AbortController (AbortError, so the package stops
// sending) and races the call against the deadline (so this run gets its
// rejection on time, backoff or not), and it starts no call after the
// deadline. An abort that lands mid-backoff still leaves the package's
// sleeping setTimeout armed after the response, for up to about 256 s (the
// longest sleep that can still be running at 240 s is the 8th retry's, 128 to
// 256 s). It holds the body Buffer but sends nothing: the next attempt sees
// the aborted signal and bails.
//
// What follows, counted from invocation:
//     5 s  the `in_progress` check-in withCronCheckin sends before startTime
//          (its fetch aborts at 5 s) and that counts against maxDuration
//   243 s  the latest the table loop can end: the 240 s deadline, or a page
//          started at 209.99 s that takes 33 s (withDbRetry), after which the
//          put is refused because the deadline has passed
//     2 s  Sentry.flush
//    42 s  reportCronRun: @axiomhq/js 1.6.1 aborts an ingest at 20 s, and
//          fetch-retry waits 1 s and retries at once on the aborted signal,
//          so 21 s per ingest (fetchClient.js:12-26); the event always carries
//          `meta`, so a rejected first ingest is followed by a second (axiom.ts)
//     5 s  the closing check-in
//   297 s  in all, 3 s to spare. That needs Neon and Axiom to fail at the same
//          time; with a healthy Neon (the loop ends by 240 s) it is 294 s.
// A normal run ends its last Blob call near 60 s. The slowest tail that is not
// a Blob fault (a page in flight at 210 s that takes 33 s, then a 14 s put)
// would end at ~257 s, so the deadline can cut a call off first only while
// Neon is retrying as well. That costs one table reported as failed, loudly.
const BLOB_DEADLINE_MS = 240_000;

// Size cap for one table's JSONL. exportTable holds the whole table in memory:
// one Buffer per row plus a second copy in Buffer.concat, so ~3x the body at
// peak, inside a 4096 MB function (the 2026-11-01 run died at 4096/4096 MB).
// 512 MiB peaks near 1.5 GB and is ~4x the largest table today (greek_exposure,
// 130 MB on 2026-11-08). A table past it is reported, not backed up, until
// the export streams (audit Phase 3.13).
const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

// Neon's serverless HTTP driver caps responses at 64 MiB (67,108,864
// bytes). One unbounded SELECT * on a tape table that has grown past
// ~50 MB overruns the cap and the whole backup row aborts with HTTP
// 507. Chunk via LIMIT/OFFSET; 50k rows × ~1 KB/row = ~50 MB per
// round-trip, comfortably under the limit. See SENTRY-EMERALD-DESERT-6V.
const EXPORT_CHUNK_ROWS = 50_000;

type ExportResult =
  | { complete: true; body: Buffer; rowCount: number }
  | {
      complete: false;
      reason: 'time_budget' | 'size_cap';
      rowCount: number;
      bytes: number;
    };

const INCOMPLETE_REASON = {
  time_budget: 'time budget spent',
  size_cap: 'size cap reached',
} as const;

/**
 * Export a single table as a JSONL `Buffer`.
 * Uses sql.unsafe() for dynamic table names (safe here — names are hardcoded constants).
 *
 * Pages through the table in `EXPORT_CHUNK_ROWS`-sized batches so a
 * single large table doesn't trip Neon's 64 MiB HTTP response cap.
 *
 * Returns a `Buffer` rather than a `string` because V8's `String.maxLength`
 * is ~512 MiB — a large enough table (flow_data, strike_exposures) would
 * throw `RangeError: Invalid string length` on the final `join` even when
 * the per-chunk reads succeed (see SENTRY-EMERALD-DESERT — RangeError
 * d758f914 on 2026-05-17). Buffers cap at ~4 GiB (Buffer.constants.MAX_LENGTH)
 * which gives ~8× more headroom, and `@vercel/blob` `put()` accepts
 * Buffer bodies directly.
 *
 * Byte-format is preserved (rows joined by `\n`, no trailing newline) so
 * any existing restoration script continues to work.
 *
 * ORDER BY a stable surrogate key so successive pages don't overlap or
 * skip rows mid-export — most tables have an `id` PK; for the few that
 * don't (schema_migrations) the row count is small enough that a single
 * chunk covers it.
 *
 * Stops, returning `complete: false`, when `deadline` (epoch ms) has passed
 * before a page starts, or when the body passes `EXPORT_MAX_BYTES`. The partial
 * body is dropped: a truncated file would pass for a complete backup.
 */
async function exportTable(
  tableName: string,
  deadline: number,
): Promise<ExportResult> {
  const sql = getDb();
  const chunks: Buffer[] = [];
  const NEWLINE = Buffer.from('\n');
  let rowCount = 0;
  let bytes = 0;
  let offset = 0;
  while (true) {
    if (Date.now() >= deadline) {
      return { complete: false, reason: 'time_budget', rowCount, bytes };
    }
    const rows = (await withDbRetry(
      () => sql`
        SELECT * FROM ${sql.unsafe(tableName)}
        ORDER BY 1
        LIMIT ${EXPORT_CHUNK_ROWS}
        OFFSET ${offset}
      `,
      2,
      10_000,
    )) as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (chunks.length > 0) {
        chunks.push(NEWLINE);
        bytes += NEWLINE.byteLength;
      }
      const chunk = Buffer.from(JSON.stringify(row));
      chunks.push(chunk);
      bytes += chunk.byteLength;
      rowCount += 1;
      if (bytes > EXPORT_MAX_BYTES) {
        return { complete: false, reason: 'size_cap', rowCount, bytes };
      }
    }
    if (rows.length < EXPORT_CHUNK_ROWS) break;
    offset += EXPORT_CHUNK_ROWS;
  }
  return { complete: true, body: Buffer.concat(chunks), rowCount };
}

/**
 * Run one @vercel/blob call so it cannot outlive `deadline` (epoch ms). At the
 * deadline the call's signal is aborted and this rejects, whatever the package
 * is doing (see BLOB_DEADLINE_MS for why both are needed). `what` names the
 * call in the error. A deadline already past fails at once without starting
 * the call: a table can reach its put after the deadline (a page that took
 * 33 s), and starting it would send an upload of up to ~130 MB that nothing
 * waits for.
 */
async function blobCallBefore<T>(
  deadline: number,
  what: string,
  call: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) {
    throw new Error(`${what} did not finish before the run deadline`);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineHit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${what} did not finish before the run deadline`));
    }, msLeft);
  });
  try {
    return await Promise.race([call(controller.signal), deadlineHit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete backup folders older than the retention window, except any dated on
 * or before `PRUNE_PROTECTED_THROUGH`. Its Blob calls stop at `deadline`.
 */
async function pruneOldBackups(
  currentDate: string,
  deadline: number,
): Promise<string[]> {
  // new Date('YYYY-MM-DD') is UTC midnight, so count the 28 days in UTC too.
  // A local-time setDate is an hour off when a DST change falls inside them.
  const cutoff = new Date(currentDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_WEEKS * 7);

  const { blobs } = await blobCallBefore(deadline, 'list backups/', (signal) =>
    list({ prefix: 'backups/', abortSignal: signal }),
  );
  const toDelete: string[] = [];
  // Folders past the retention window that the floor keeps. At most one entry
  // per weekly folder, and it lives only for this call.
  const keptByFloor = new Set<string>();

  for (const blob of blobs) {
    // Extract date from path: backups/2026-03-21/table.jsonl → 2026-03-21
    const datePattern = /^backups\/(\d{4}-\d{2}-\d{2})\//;
    const match = datePattern.exec(blob.pathname);
    if (!match) continue;

    const folderDate = match[1]!;
    const blobDate = new Date(folderDate);
    if (blobDate < cutoff) {
      // Zero-padded dates order the same as strings and as days, and the
      // string compare does not depend on the time zone.
      if (folderDate <= PRUNE_PROTECTED_THROUGH) {
        keptByFloor.add(folderDate);
      } else {
        toDelete.push(blob.url);
      }
    }
  }

  if (keptByFloor.size > 0) {
    logger.info(
      {
        foldersKept: keptByFloor.size,
        protectedThrough: PRUNE_PROTECTED_THROUGH,
      },
      'Backup folders kept by the protection floor',
    );
  }

  if (toDelete.length > 0) {
    await blobCallBefore(deadline, `del ${toDelete.length} blobs`, (signal) =>
      del(toDelete, { abortSignal: signal }),
    );
  }

  return toDelete;
}

export default withCronCheckin('backup-tables', async (req, res) => {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  const startTime = Date.now();
  const results: Record<string, { rows: number; bytes: number }> = {};
  const errors: string[] = [];
  // Never started: the time budget was spent first.
  const skipped: string[] = [];
  // Started, then stopped by the time budget or the size cap. Nothing uploaded.
  const unfinished: string[] = [];
  const deadline = startTime + TABLE_LOOP_BUDGET_MS;
  const blobDeadline = startTime + BLOB_DEADLINE_MS;

  logger.info({ date: today, tables: TABLES.length }, 'Starting weekly backup');

  for (const [index, table] of TABLES.entries()) {
    if (Date.now() >= deadline) {
      for (const rest of TABLES.slice(index)) {
        skipped.push(rest);
        errors.push(`${rest}: skipped, ${INCOMPLETE_REASON.time_budget}`);
      }
      break;
    }
    try {
      const exported = await exportTable(table, deadline);
      if (!exported.complete) {
        unfinished.push(table);
        const reason = INCOMPLETE_REASON[exported.reason];
        errors.push(
          `${table}: not backed up, ${reason} after ${exported.rowCount} rows (${exported.bytes} bytes)`,
        );
        logger.error(
          {
            table,
            reason: exported.reason,
            rows: exported.rowCount,
            bytes: exported.bytes,
          },
          'Table backup stopped',
        );
        continue;
      }
      const { body, rowCount } = exported;

      // Vercel Blob's put() rejects empty bodies with "body is required"
      // (SENTRY-EMERALD-DESERT-6T). Skip the upload for empty tables but
      // still record them in results so the cron summary lists every
      // intended table — a downstream consumer can tell "table absent
      // from snapshot because empty" vs "table missing because failed."
      if (rowCount === 0) {
        results[table] = { rows: 0, bytes: 0 };
        logger.info({ table }, 'Table empty — skipping blob upload');
        continue;
      }

      const path = `backups/${today}/${table}.jsonl`;
      await blobCallBefore(blobDeadline, `put ${path}`, (signal) =>
        put(path, body, {
          access: 'private',
          allowOverwrite: true,
          contentType: 'application/x-ndjson',
          abortSignal: signal,
        }),
      );

      results[table] = { rows: rowCount, bytes: body.byteLength };
      logger.info(
        { table, rows: rowCount, bytes: body.byteLength },
        'Table backed up',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${table}: ${msg}`);
      Sentry.setTag('cron.job', 'backup-tables');
      Sentry.captureException(err);
      logger.error({ table, err }, 'Table backup failed');
    }
  }

  // A table that was skipped or stopped is not in the backup. Each DB or Blob
  // failure above has its own exception; this one event names the tables the
  // budget and the size cap cost.
  const notBackedUp = [...skipped, ...unfinished];
  if (notBackedUp.length > 0) {
    const elapsedMs = Date.now() - startTime;
    Sentry.setTag('cron.job', 'backup-tables');
    Sentry.captureMessage(
      `backup-tables: ${notBackedUp.length} table(s) not backed up: ${notBackedUp.join(', ')}`,
      {
        level: 'error',
        fingerprint: ['backup-tables', 'incomplete'],
        extra: { date: today, skipped, unfinished, elapsedMs },
      },
    );
    logger.error({ skipped, unfinished, elapsedMs }, 'Tables not backed up');
  }

  // Prune old backups, but only after a run that backed up every table. The
  // prune deletes the oldest weekly folders: after an incomplete run, a table
  // that fails every week would lose its last good copy on the 5th failing
  // run, when the folders still holding it age out. A prune failure adds its
  // own error, so it is judged by the next run, not this one.
  let pruned: string[] = [];
  const pruneSkipped = errors.length > 0;
  if (pruneSkipped) {
    logger.warn(
      { errors: errors.length },
      'Pruning skipped, backup incomplete',
    );
  } else {
    try {
      pruned = await pruneOldBackups(today, blobDeadline);
      if (pruned.length > 0) {
        logger.info({ count: pruned.length }, 'Pruned old backups');
      }
    } catch (err) {
      Sentry.setTag('cron.job', 'backup-tables');
      Sentry.captureException(err);
      logger.error({ err }, 'Backup pruning failed');
      errors.push(`pruning: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  // withCronCheckin never flushes, so every exception captured above (a table,
  // a put, the prune) would sit in the SDK queue when the instance freezes.
  // One flush covers them all; it is after the prune because the prune can add
  // an error of its own.
  if (errors.length > 0) await Sentry.flush(2000);

  const totalRows = Object.values(results).reduce((s, r) => s + r.rows, 0);
  const totalBytes = Object.values(results).reduce((s, r) => s + r.bytes, 0);

  logger.info(
    {
      tables: Object.keys(results).length,
      totalRows,
      totalBytes,
      errors: errors.length,
      skipped: skipped.length,
      unfinished: unfinished.length,
    },
    'Weekly backup complete',
  );

  // 'partial' is any run with an error where at least one table landed. That
  // includes a run where all 16 tables landed and only the prune failed.
  // 'error' is a run where no table landed.
  const backedUp = Object.keys(results).length;
  let status: 'ok' | 'partial' | 'error' = 'ok';
  if (errors.length > 0) status = backedUp > 0 ? 'partial' : 'error';

  await reportCronRun('backup-tables', {
    status,
    date: today,
    tables: backedUp,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    pruneSkipped,
    errors: errors.length,
    skippedTables: skipped,
    unfinishedTables: unfinished,
    durationMs: Date.now() - startTime,
  });

  // withCronCheckin reads the response status, not the status above: a 2xx
  // would send Sentry an `ok` check-in for a run that left tables out.
  res.status(errors.length > 0 ? 500 : 200).json({
    status,
    date: today,
    tables: results,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    pruneSkipped: pruneSkipped ? true : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
    unfinished: unfinished.length > 0 ? unfinished : undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
});
