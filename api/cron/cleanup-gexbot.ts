/**
 * GET /api/cron/cleanup-gexbot
 *
 * Daily pre-market retention sweep for `gexbot_snapshots` and
 * `gexbot_api_capture`. Audit-gated: only deletes rows on days that have
 * a `gexbot_archive_audit` row, so a missed archive run can never lose data.
 *
 * Cutoff per table: `LEAST(yesterday_et, first_unarchived_session - 1)`,
 * where the first un-archived session comes from `listUnarchivedDates`
 * (api/_lib/gexbot-archive-dates.ts, which also documents the UTC-day ==
 * ET-session-date boundary). A missed archive day stalls deletion at that
 * day until it is archived, no matter how many later days succeed. With no
 * audit rows at all every live day is pending, so nothing is deleted.
 *
 * A table whose gate or DELETE fails is recorded by name (with the rows it
 * removed before failing); the other table is still processed, then the run
 * throws so it is never reported success. A table skipped because the wall
 * budget ran out is reported in `skippedTables` and makes the run 'partial'.
 *
 * Mirrors `cleanup-ws-option-trades.ts` for batching + wall-budget
 * semantics. Schedule: 12:15 UTC Mon–Fri (10 min after
 * `cleanup-ws-option-trades` so they don't contend for the same
 * Neon autoscale ceiling).
 *
 * See: docs/superpowers/specs/gexbot-trial-capture-2026-05-16.md
 * and docs/superpowers/specs/gexbot-archive-repair-2026-10-02.md
 *
 * Environment: CRON_SECRET only — no UW key, no GEXBot key.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  GEXBOT_ARCHIVE_TABLES,
  listUnarchivedDates,
  type GexbotArchiveTable,
} from '../_lib/gexbot-archive-dates.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

export const config = { maxDuration: 300 };

const BATCH_SIZE = 50_000;
/**
 * Checked before each table and after each batch, measured from wrapper
 * entry (`ctx.startTimeMs`, which precedes the in-progress Sentry check-in).
 * One batch under `withDbRetry(..., 2, 10_000)` can take ~33 s in the worst
 * case (3 attempts x 10 s + 1 s + 2 s backoff), so the last batch may start
 * just under this budget and still has to finish inside maxDuration:
 * 300 s - 33 s worst-case batch - 12 s slack (completion check-in, Axiom
 * report, response) = 255 s.
 */
const WALL_BUDGET_MS = 255_000;

interface PerTableResult {
  table: GexbotArchiveTable;
  /** First un-archived session date, or null when nothing is pending. */
  gate: string | null;
  /** Delete-through date; null only if the table failed before it was known. */
  cutoff: string | null;
  deleted: number;
  batches: number;
  stopReason: 'drained' | 'wall_budget';
  /** Set when the table failed; deleted/batches hold partial progress. */
  error?: string;
}

async function cleanupOne(
  table: GexbotArchiveTable,
  startedAt: number,
  today: string,
): Promise<PerTableResult> {
  const progress: PerTableResult = {
    table,
    gate: null,
    cutoff: null,
    deleted: 0,
    batches: 0,
    stopReason: 'drained',
  };
  try {
    await runCleanup(table, startedAt, today, progress);
  } catch (err) {
    progress.error = err instanceof Error ? err.message : String(err);
  }
  return progress;
}

async function runCleanup(
  table: GexbotArchiveTable,
  startedAt: number,
  today: string,
  progress: PerTableResult,
): Promise<void> {
  const sql = getDb();

  const pending = await listUnarchivedDates(sql, table, today);
  // Recorded before the dates SELECT so a failure there still reports the
  // stalled session.
  progress.gate = pending[0] ?? null;

  // Date math in Postgres, returned as text, so no JS Date/timezone
  // conversion is involved. `gate_cutoff` is NULL when nothing is pending.
  const dateRows = (await withDbRetry(
    () => sql`
      SELECT to_char(${today}::date - 1, 'YYYY-MM-DD') AS yesterday,
             to_char(${pending[0] ?? null}::date - 1, 'YYYY-MM-DD') AS gate_cutoff
    `,
    2,
    10_000,
  )) as Array<{ yesterday: string; gate_cutoff: string | null }>;
  const dateRow = dateRows[0];
  if (!dateRow) {
    throw new Error(`cleanup-gexbot: no date row returned for ${table}`);
  }
  const { yesterday, gate_cutoff: gateCutoff } = dateRow;
  const cutoff =
    gateCutoff != null && gateCutoff < yesterday ? gateCutoff : yesterday;
  progress.cutoff = cutoff;

  while (true) {
    // captured_at < (cutoff + 1 day) deletes everything strictly
    // before cutoff+1, i.e. everything on or before cutoff.
    const result =
      table === 'gexbot_snapshots'
        ? ((await withDbRetry(
            () => sql`
              WITH batch AS (
                SELECT id FROM gexbot_snapshots
                WHERE captured_at < (${cutoff}::date + 1)::timestamptz
                LIMIT ${BATCH_SIZE}
              )
              DELETE FROM gexbot_snapshots
              WHERE id IN (SELECT id FROM batch)
              RETURNING id
            `,
            2,
            10_000,
          )) as Array<{ id: number }>)
        : ((await withDbRetry(
            () => sql`
              WITH batch AS (
                SELECT id FROM gexbot_api_capture
                WHERE captured_at < (${cutoff}::date + 1)::timestamptz
                LIMIT ${BATCH_SIZE}
              )
              DELETE FROM gexbot_api_capture
              WHERE id IN (SELECT id FROM batch)
              RETURNING id
            `,
            2,
            10_000,
          )) as Array<{ id: number }>);

    const deleted = result.length;
    progress.deleted += deleted;
    progress.batches += 1;

    if (deleted === 0) break;
    if (Date.now() - startedAt > WALL_BUDGET_MS) {
      progress.stopReason = 'wall_budget';
      break;
    }
  }
}

export default withCronInstrumentation(
  'cleanup-gexbot',
  async (ctx): Promise<CronResult> => {
    const results: PerTableResult[] = [];
    const skippedTables: Array<{
      table: GexbotArchiveTable;
      reason: 'wall_budget';
    }> = [];

    for (const table of GEXBOT_ARCHIVE_TABLES) {
      if (Date.now() - ctx.startTimeMs > WALL_BUDGET_MS) {
        skippedTables.push({ table, reason: 'wall_budget' });
        continue;
      }
      results.push(await cleanupOne(table, ctx.startTimeMs, ctx.today));
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
    const failures = results.filter((r) => r.error !== undefined);

    if (failures.length > 0) {
      ctx.logger.error(
        { today: ctx.today, results, skippedTables, totalDeleted },
        'cleanup-gexbot finished with failures',
      );
      const named = failures
        .map(
          (f) => `${f.table} (${f.error}; deleted ${f.deleted} before failing)`,
        )
        .join('; ');
      throw new Error(`cleanup-gexbot failed for ${named}`);
    }

    if (skippedTables.length > 0) {
      ctx.logger.warn(
        { today: ctx.today, results, skippedTables, totalDeleted },
        'cleanup-gexbot skipped tables: wall budget exhausted',
      );
    } else {
      ctx.logger.info(
        { today: ctx.today, results, totalDeleted },
        'cleanup-gexbot completed',
      );
    }

    return {
      status: skippedTables.length > 0 ? 'partial' : 'success',
      rows: totalDeleted,
      metadata: { today: ctx.today, results, skippedTables },
    };
  },
  { marketHours: false, requireApiKey: false },
);
