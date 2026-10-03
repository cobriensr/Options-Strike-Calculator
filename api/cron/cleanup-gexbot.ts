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
 * A table whose gate or DELETE fails is recorded by name; the other table
 * is still processed, then the run throws so it is never reported success.
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
const WALL_BUDGET_MS = 295_000;

interface PerTableResult {
  table: GexbotArchiveTable;
  /** First un-archived session date, or null when nothing is pending. */
  gate: string | null;
  cutoff: string;
  deleted: number;
  batches: number;
  stopReason: 'drained' | 'wall_budget';
}

async function cleanupOne(
  table: GexbotArchiveTable,
  startedAt: number,
  today: string,
): Promise<PerTableResult> {
  const sql = getDb();

  const pending = await listUnarchivedDates(sql, table, today);

  // Date math in Postgres, returned as text, so no JS Date/timezone
  // conversion is involved. `gate` is NULL when nothing is pending.
  const dateRows = (await withDbRetry(
    () => sql`
      SELECT to_char(${today}::date - 1, 'YYYY-MM-DD') AS yesterday,
             to_char(${pending[0] ?? null}::date - 1, 'YYYY-MM-DD') AS gate
    `,
    2,
    10_000,
  )) as Array<{ yesterday: string; gate: string | null }>;
  const yesterday = dateRows[0]?.yesterday ?? '';
  const gate = dateRows[0]?.gate ?? null;
  const cutoff = gate != null && gate < yesterday ? gate : yesterday;

  let totalDeleted = 0;
  let batches = 0;
  let stopReason: PerTableResult['stopReason'] = 'drained';

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
    totalDeleted += deleted;
    batches += 1;

    if (deleted === 0) break;
    if (Date.now() - startedAt > WALL_BUDGET_MS) {
      stopReason = 'wall_budget';
      break;
    }
  }

  return { table, gate, cutoff, deleted: totalDeleted, batches, stopReason };
}

export default withCronInstrumentation(
  'cleanup-gexbot',
  async (ctx): Promise<CronResult> => {
    const startedAt = Date.now();
    const results: PerTableResult[] = [];
    const failures: Array<{ table: GexbotArchiveTable; error: string }> = [];

    for (const table of GEXBOT_ARCHIVE_TABLES) {
      try {
        results.push(await cleanupOne(table, startedAt, ctx.today));
      } catch (err) {
        failures.push({
          table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (Date.now() - startedAt > WALL_BUDGET_MS) break;
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    ctx.logger.info(
      { today: ctx.today, results, failures, totalDeleted },
      'cleanup-gexbot completed',
    );

    if (failures.length > 0) {
      const named = failures.map((f) => `${f.table} (${f.error})`).join('; ');
      throw new Error(`cleanup-gexbot failed for ${named}`);
    }

    return {
      status: 'success',
      rows: totalDeleted,
      metadata: { today: ctx.today, results },
    };
  },
  { marketHours: false, requireApiKey: false },
);
