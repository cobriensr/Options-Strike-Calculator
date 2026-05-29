/**
 * GET /api/cron/audit-migration-drift
 *
 * Daily safety net for migration drift. Runs at 12:00 UTC (07:00 CT), ahead of
 * the 13:00 UTC market-data crons. Compares the migration ids defined in code
 * (`MIGRATIONS` in db-migrations.ts) against the ids actually applied to the
 * live DB (`schema_migrations`). Any code migration missing from the DB means a
 * migration was authored + deployed but never applied via psql — the exact gap
 * that broke takeit_health_daily on 2026-05-28 (migration #182). Alerts via
 * Sentry at 'warning' so it surfaces before a table-dependent consumer crashes.
 *
 * Spec: docs/superpowers/specs/migration-drift-audit-cron-2026-05-29.md
 *
 * Alerts (via Sentry captureMessage at 'warning'):
 *   - one or more code migrations are not present in schema_migrations
 *
 * Does NOT flag applied ids that are absent from code (DB ahead of code, e.g.
 * after a revert) — that is not a drift error.
 */

import { cronGuard } from '../_lib/api-helpers.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { MIGRATIONS } from '../_lib/db-migrations.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

export default withCronCheckin('audit-migration-drift', async (req, res) => {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/cron/audit-migration-drift');
    Sentry.setTag('cron.job', 'audit-migration-drift');
    const done = metrics.request('/api/cron/audit-migration-drift');
    const startedAt = Date.now();

    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;

    const sql = getDb();
    try {
      const rows = (await withDbRetry(
        () => sql`SELECT id FROM schema_migrations`,
      )) as Array<{ id: number | string }>;
      const appliedIds = new Set(rows.map((r) => Number(r.id)));

      const codeIds = MIGRATIONS.map((m) => m.id);
      const missing = codeIds
        .filter((id) => !appliedIds.has(id))
        .sort((a, b) => a - b);

      const codeMax = codeIds.length > 0 ? Math.max(...codeIds) : 0;
      const appliedMax = appliedIds.size > 0 ? Math.max(...appliedIds) : 0;

      if (missing.length > 0) {
        Sentry.captureMessage(
          `migration-drift: ${missing.length} code migration(s) not applied to DB: ${missing.join(', ')}`,
          {
            level: 'warning',
            tags: { 'cron.anomaly': 'migration-drift' },
            extra: { missing, appliedMax, codeMax },
          },
        );
      }

      const durationMs = Date.now() - startedAt;
      logger.info(
        { missing, appliedMax, codeMax, durationMs },
        'audit-migration-drift: complete',
      );

      await reportCronRun('audit-migration-drift', {
        status: 'ok',
        durationMs,
        missing_count: missing.length,
        appliedMax,
        codeMax,
      });

      done({ status: 200 });
      res.status(200).json({
        job: 'audit-migration-drift',
        success: true,
        applied_max: appliedMax,
        code_max: codeMax,
        missing,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      Sentry.captureException(error);
      logger.error({ err: error, durationMs }, 'audit-migration-drift error');

      try {
        await reportCronRun('audit-migration-drift', {
          status: 'error',
          error: String(error),
          durationMs,
        });
      } catch {
        /* swallowed: observability path must never crash the response */
      }

      done({ status: 500, error: 'unhandled' });
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});
