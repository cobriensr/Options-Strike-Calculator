/**
 * GET /api/cron/audit-gexbot-health
 *
 * Daily data-quality monitor for the GEXBot classic-basic merge. Runs at
 * 22:30 UTC (17:30 CT, after the 21:55 UTC capture window closes) on
 * weekdays. Confirms the 10 aggregate columns revived by the 2026-05-29
 * `/classic/gex_zero` capture (see spec) are actually populating — a
 * recurrence of the orderflow spec-drift would return HTTP 200 with the
 * fields silently absent, which the per-tick `enriched` metric can't catch.
 *
 * `zero_gamma` is the canary: it's the field wired into silent_boom_alerts /
 * lottery_finder_fires (#180/#181) and the target of the whole fix. We check
 * it both overall (whole-pipeline break) and SPX-specifically (the primary
 * trading ticker — a 1/16 single-ticker break stays under the overall rate).
 *
 * Alerts (via Sentry captureMessage at 'warning'):
 *   - zero_gamma NULL rate > ZG_NULL_ALERT_PCT (50%) overall, OR
 *   - zero_gamma NULL rate > ZG_NULL_ALERT_PCT for SPX, OR
 *   - zero snapshots in the last 12h (capture outage).
 *
 * 50% cleanly separates "working" (~0% post-fix) from "broken again" (~100%
 * if the endpoint regresses) without paging on transient per-ticker misses.
 *
 * No persistence table — this is a notification tripwire, not a trend store.
 * Re-run scripts/_probe-gexbot-capture-2026-05-29.ts for the full readout.
 */

import { cronGuard, isTradingDayET } from '../_lib/api-helpers.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const ZG_NULL_ALERT_PCT = 50.0;
const LOOKBACK_HOURS = 12;

/** Raw DB column value — Neon driver returns integer counts as strings. */
type DbNumeric = string | number | null;

interface HealthRow {
  rows_all: DbNumeric;
  zg_null_all: DbNumeric;
  sgo_null_all: DbNumeric;
  drr_null_all: DbNumeric;
  rows_spx: DbNumeric;
  zg_null_spx: DbNumeric;
}

function pct(nullCount: number, total: number): number {
  return total > 0 ? (nullCount / total) * 100 : 0;
}

export default withCronCheckin('audit-gexbot-health', async (req, res) => {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/cron/audit-gexbot-health');
    Sentry.setTag('cron.job', 'audit-gexbot-health');
    const done = metrics.request('/api/cron/audit-gexbot-health');
    const startedAt = Date.now();

    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;

    const sql = getDb();
    try {
      const rows = (await withDbRetry(
        () => sql`
        SELECT
          count(*)::int AS rows_all,
          count(*) FILTER (WHERE zero_gamma IS NULL)::int AS zg_null_all,
          count(*) FILTER (WHERE sum_gex_oi IS NULL)::int AS sgo_null_all,
          count(*) FILTER (WHERE delta_risk_reversal IS NULL)::int AS drr_null_all,
          count(*) FILTER (WHERE ticker = 'SPX')::int AS rows_spx,
          count(*) FILTER (WHERE ticker = 'SPX' AND zero_gamma IS NULL)::int AS zg_null_spx
        FROM gexbot_snapshots
        WHERE captured_at > NOW() - make_interval(hours => ${LOOKBACK_HOURS})
      `,
      )) as HealthRow[];

      const r = rows[0]!;
      const rowsAll = Number(r.rows_all);
      const rowsSpx = Number(r.rows_spx);
      const zgNullAllPct = pct(Number(r.zg_null_all), rowsAll);
      const zgNullSpxPct = pct(Number(r.zg_null_spx), rowsSpx);
      const sgoNullAllPct = pct(Number(r.sgo_null_all), rowsAll);
      const drrNullAllPct = pct(Number(r.drr_null_all), rowsAll);

      const alerts: string[] = [];
      if (rowsAll === 0) {
        // GexBot is gated to futures RTH, so weekends/holidays legitimately
        // produce zero snapshots — not an outage. Only a real trading day with
        // no rows is a capture failure worth paging on. (This cron runs Mon–Fri
        // UTC, but a weekday market holiday would otherwise false-alarm.)
        if (isTradingDayET()) {
          alerts.push(
            `no gexbot_snapshots in last ${LOOKBACK_HOURS}h (capture outage?)`,
          );
        }
      } else {
        if (zgNullAllPct > ZG_NULL_ALERT_PCT) {
          alerts.push(
            `zero_gamma NULL ${zgNullAllPct.toFixed(1)}% overall > ${ZG_NULL_ALERT_PCT}% (classic-basic merge regressed?)`,
          );
        }
        if (rowsSpx > 0 && zgNullSpxPct > ZG_NULL_ALERT_PCT) {
          alerts.push(
            `zero_gamma NULL ${zgNullSpxPct.toFixed(1)}% for SPX > ${ZG_NULL_ALERT_PCT}%`,
          );
        }
      }

      const summary = {
        rowsAll,
        rowsSpx,
        zgNullAllPct,
        zgNullSpxPct,
        sgoNullAllPct,
        drrNullAllPct,
        alerts,
      };

      if (alerts.length > 0) {
        Sentry.captureMessage(`gexbot-health: ${alerts.join('; ')}`, {
          level: 'warning',
          tags: { 'cron.anomaly': 'gexbot-health' },
          extra: summary,
        });
      }

      const durationMs = Date.now() - startedAt;
      logger.info({ ...summary, durationMs }, 'audit-gexbot-health: complete');

      try {
        await reportCronRun('audit-gexbot-health', {
          status: 'ok',
          durationMs,
          zgNullAllPct,
          zgNullSpxPct,
          alerts: alerts.length,
        });
      } catch {
        /* swallowed: observability path must never crash the response */
      }

      done({ status: 200 });
      res.status(200).json({
        job: 'audit-gexbot-health',
        success: true,
        ...summary,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      Sentry.captureException(error);
      logger.error({ err: error, durationMs }, 'audit-gexbot-health error');

      try {
        await reportCronRun('audit-gexbot-health', {
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
