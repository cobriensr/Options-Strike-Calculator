/**
 * GET /api/cron/cleanup-gexbot
 *
 * Daily pre-market retention sweep for `gexbot_snapshots` and
 * `gexbot_api_capture`. Audit-gated: only deletes rows for a (table,
 * date) pair that has a corresponding `gexbot_archive_audit` row,
 * so a missed archive run can never lose data.
 *
 * Cutoff per table: `LEAST(today_et - INTERVAL '1 day', max archived
 * date for table)`. In steady state the cutoff IS yesterday and we
 * trim ~85 k rows daily. After a single missed archive day the
 * cutoff stalls one day older; the next successful archive un-stalls
 * the cleanup the morning after.
 *
 * Mirrors `cleanup-ws-option-trades.ts` for batching + wall-budget
 * semantics. Schedule: 12:15 UTC Mon–Fri (10 min after
 * `cleanup-ws-option-trades` so they don't contend for the same
 * Neon autoscale ceiling).
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 *
 * Environment: CRON_SECRET only — no UW key, no GEXBot key.
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

export const config = { maxDuration: 300 };

const BATCH_SIZE = 50_000;
const WALL_BUDGET_MS = 295_000;

const TARGET_TABLES = ['gexbot_snapshots', 'gexbot_api_capture'] as const;
type TargetTable = (typeof TARGET_TABLES)[number];

interface PerTableResult {
  table: TargetTable;
  cutoff: string | null;
  deleted: number;
  batches: number;
  stopReason: 'drained' | 'wall_budget' | 'no_archive';
}

async function cleanupOne(
  table: TargetTable,
  startedAt: number,
  today: string,
): Promise<PerTableResult> {
  const sql = getDb();

  // Find the latest archive date for this table. If there isn't one,
  // there's nothing safe to delete — skip the table entirely.
  const auditRows = (await sql`
    SELECT MAX(archive_date) AS max_date
    FROM gexbot_archive_audit
    WHERE table_name = ${table}
  `) as Array<{ max_date: string | Date | null }>;
  const maxArchivedRaw = auditRows[0]?.max_date ?? null;
  if (maxArchivedRaw === null) {
    return {
      table,
      cutoff: null,
      deleted: 0,
      batches: 0,
      stopReason: 'no_archive',
    };
  }

  // Normalize to yyyy-mm-dd. The Neon driver returns DATE as Date
  // objects (see memory feedback_neon_date_columns.md), so str-cast
  // assumptions would silently break — convert explicitly.
  const maxArchived =
    maxArchivedRaw instanceof Date
      ? maxArchivedRaw.toISOString().slice(0, 10)
      : String(maxArchivedRaw).slice(0, 10);

  // Compute "yesterday ET" in SQL so date math happens in Postgres
  // with proper timezone handling (matches the cleanup-ws-option-trades
  // pattern). Doing it in JS via `new Date('${today}T00:00:00')` would
  // interpret `today` as local time then mutate UTC, which mis-aligns
  // by a day between 00:00–05:00 ET. Cap at maxArchived so a missed
  // archive day never prematurely deletes its unarchived rows.
  const yesterdayRows = (await sql`
    SELECT (${today}::date - INTERVAL '1 day')::date AS yesterday_et
  `) as Array<{ yesterday_et: string | Date }>;
  const yesterdayRaw = yesterdayRows[0]?.yesterday_et;
  const yesterdayStr =
    yesterdayRaw instanceof Date
      ? yesterdayRaw.toISOString().slice(0, 10)
      : String(yesterdayRaw ?? '').slice(0, 10);
  const cutoff = yesterdayStr < maxArchived ? yesterdayStr : maxArchived;

  let totalDeleted = 0;
  let batches = 0;
  let stopReason: 'drained' | 'wall_budget' = 'drained';

  while (true) {
    // captured_at < (cutoff + 1 day) deletes everything strictly
    // before cutoff+1, i.e. everything on or before cutoff.
    const result =
      table === 'gexbot_snapshots'
        ? ((await sql`
            WITH batch AS (
              SELECT id FROM gexbot_snapshots
              WHERE captured_at < (${cutoff}::date + 1)::timestamptz
              LIMIT ${BATCH_SIZE}
            )
            DELETE FROM gexbot_snapshots
            WHERE id IN (SELECT id FROM batch)
            RETURNING id
          `) as Array<{ id: number }>)
        : ((await sql`
            WITH batch AS (
              SELECT id FROM gexbot_api_capture
              WHERE captured_at < (${cutoff}::date + 1)::timestamptz
              LIMIT ${BATCH_SIZE}
            )
            DELETE FROM gexbot_api_capture
            WHERE id IN (SELECT id FROM batch)
            RETURNING id
          `) as Array<{ id: number }>);

    const deleted = result.length;
    totalDeleted += deleted;
    batches += 1;

    if (deleted === 0) break;
    if (Date.now() - startedAt > WALL_BUDGET_MS) {
      stopReason = 'wall_budget';
      break;
    }
  }

  return { table, cutoff, deleted: totalDeleted, batches, stopReason };
}

export default withCronInstrumentation(
  'cleanup-gexbot',
  async (ctx): Promise<CronResult> => {
    const startedAt = Date.now();
    const results: PerTableResult[] = [];

    for (const table of TARGET_TABLES) {
      results.push(await cleanupOne(table, startedAt, ctx.today));
      if (Date.now() - startedAt > WALL_BUDGET_MS) break;
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    ctx.logger.info(
      { today: ctx.today, results, totalDeleted },
      'cleanup-gexbot completed',
    );

    return {
      status: 'success',
      rows: totalDeleted,
      metadata: { today: ctx.today, results },
    };
  },
  { marketHours: false, requireApiKey: false },
);
