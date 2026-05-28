/**
 * GET /api/cron/audit-takeit-health
 *
 * Daily operational health monitor for the TAKE-IT scoring layer. Runs at
 * 23:30 UTC (18:30 CT, after EOD has settled). Computes per-feed metrics
 * against yesterday's fires/alerts, fires Sentry alerts on threshold breach,
 * and writes a row per metric to takeit_health_daily for trend tracking.
 *
 * Metrics persisted per feed:
 *   - null_rate_pct         — fraction of rows with takeit_prob IS NULL
 *   - rows_scored           — total rows in the feed for yesterday
 *   - prob_p10/p50/p90/p99  — score percentiles (distribution health)
 *   - bundle_versions_seen  — distinct takeit_model_version values
 *
 * Alerts (via Sentry captureMessage at 'warning'):
 *   - null_rate_pct > NULL_RATE_ALERT_PCT (5%)
 *   - bundle_versions_seen > BUNDLE_VERSION_MAX_PER_DAY (1)
 *   - rows_scored === 0 on a weekday (possible scoring outage or holiday;
 *     weekends are intentionally skipped — those are normal empty days)
 */

import { cronGuard } from '../_lib/api-helpers.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const NULL_RATE_ALERT_PCT = 5.0;
const BUNDLE_VERSION_MAX_PER_DAY = 1;

interface FeedAgg {
  rows_scored: number;
  null_count: number;
  prob_p10: number | null;
  prob_p50: number | null;
  prob_p90: number | null;
  prob_p99: number | null;
  bundle_versions_seen: number;
}

interface FeedSummary extends FeedAgg {
  null_rate_pct: number;
  alerts: string[];
}

/** Raw DB column value — Neon driver returns numeric columns as strings. */
type DbNumeric = string | number | null;

/**
 * True when `dateStr` (YYYY-MM-DD, UTC) is a Mon–Fri. Used by applyAlerts to
 * suppress empty-day warnings on weekends — Sat/Sun produce zero fires by
 * design, so they should not page. Holidays will produce ~9 false positives
 * a year (manageable; the alert is informational, not paging).
 */
function isWeekday(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

async function summarizeFeed(
  sql: ReturnType<typeof getDb>,
  table: 'lottery_finder_fires' | 'silent_boom_alerts',
  date: string,
): Promise<FeedAgg> {
  // sql.unsafe(table) is safe here — `table` is a hardcoded TypeScript
  // union ('lottery_finder_fires' | 'silent_boom_alerts'), never user input.
  const rows = (await withDbRetry(
    () =>
      sql`
      SELECT
        count(*) AS rows_scored,
        count(*) FILTER (WHERE takeit_prob IS NULL) AS null_count,
        percentile_cont(0.10) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p10,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p50,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY takeit_prob) AS prob_p99,
        count(DISTINCT takeit_model_version) AS bundle_versions_seen
      FROM ${sql.unsafe(table)}
      WHERE date = ${date}::date
    `,
  )) as Array<{
    rows_scored: DbNumeric;
    null_count: DbNumeric;
    prob_p10: DbNumeric;
    prob_p50: DbNumeric;
    prob_p90: DbNumeric;
    prob_p99: DbNumeric;
    bundle_versions_seen: DbNumeric;
  }>;
  const r = rows[0]!;
  return {
    rows_scored: Number(r.rows_scored),
    null_count: Number(r.null_count),
    prob_p10: r.prob_p10 == null ? null : Number(r.prob_p10),
    prob_p50: r.prob_p50 == null ? null : Number(r.prob_p50),
    prob_p90: r.prob_p90 == null ? null : Number(r.prob_p90),
    prob_p99: r.prob_p99 == null ? null : Number(r.prob_p99),
    bundle_versions_seen: Number(r.bundle_versions_seen),
  };
}

function applyAlerts(
  agg: FeedAgg,
  feed: 'lottery' | 'silent_boom',
  dateStr: string,
): FeedSummary {
  const alerts: string[] = [];
  const null_rate_pct =
    agg.rows_scored > 0 ? (agg.null_count / agg.rows_scored) * 100 : 0;

  if (null_rate_pct > NULL_RATE_ALERT_PCT) {
    alerts.push(
      `null_rate_pct ${null_rate_pct.toFixed(1)}% > ${NULL_RATE_ALERT_PCT}%`,
    );
  }
  if (agg.bundle_versions_seen > BUNDLE_VERSION_MAX_PER_DAY) {
    alerts.push(
      `bundle_versions_seen=${agg.bundle_versions_seen} > ${BUNDLE_VERSION_MAX_PER_DAY}`,
    );
  }
  if (agg.rows_scored === 0 && isWeekday(dateStr)) {
    alerts.push(
      'rows_scored=0 on a weekday (possible scoring outage or holiday)',
    );
  }

  if (alerts.length > 0) {
    Sentry.captureMessage(
      `takeit-health: ${feed} alerts: ${alerts.join('; ')}`,
      {
        level: 'warning',
        tags: { 'takeit.feed': feed, 'cron.anomaly': 'takeit-health' },
        extra: { ...agg, null_rate_pct },
      },
    );
  }

  return { ...agg, null_rate_pct, alerts };
}

async function persistMetrics(
  sql: ReturnType<typeof getDb>,
  date: string,
  feed: 'lottery' | 'silent_boom',
  summary: FeedSummary,
): Promise<void> {
  const rows: Array<[string, number | null, number, boolean]> = [
    [
      'null_rate_pct',
      summary.null_rate_pct,
      NULL_RATE_ALERT_PCT,
      summary.null_rate_pct > NULL_RATE_ALERT_PCT,
    ],
    ['rows_scored', summary.rows_scored, 0, false],
    ['prob_p10', summary.prob_p10, 0, false],
    ['prob_p50', summary.prob_p50, 0, false],
    ['prob_p90', summary.prob_p90, 0, false],
    ['prob_p99', summary.prob_p99, 0, false],
    [
      'bundle_versions_seen',
      summary.bundle_versions_seen,
      BUNDLE_VERSION_MAX_PER_DAY,
      summary.bundle_versions_seen > BUNDLE_VERSION_MAX_PER_DAY,
    ],
  ];

  for (const [metric_name, metric_value, threshold, alert_fired] of rows) {
    await withDbRetry(
      () =>
        sql`
        INSERT INTO takeit_health_daily
          (date, feed, metric_name, metric_value, threshold, alert_fired)
        VALUES
          (${date}::date, ${feed}, ${metric_name}, ${metric_value}, ${threshold}, ${alert_fired})
        ON CONFLICT (date, feed, metric_name)
        DO UPDATE SET
          metric_value = EXCLUDED.metric_value,
          threshold = EXCLUDED.threshold,
          alert_fired = EXCLUDED.alert_fired,
          computed_at = NOW()
      `,
    );
  }
}

export default withCronCheckin('audit-takeit-health', async (req, res) => {
  await Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/cron/audit-takeit-health');
    Sentry.setTag('cron.job', 'audit-takeit-health');
    const done = metrics.request('/api/cron/audit-takeit-health');
    const startedAt = Date.now();

    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;

    const sql = getDb();
    try {
      // Yesterday's date (UTC YYYY-MM-DD — matches how the fires/alerts
      // tables store `date`).
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const lottery = await summarizeFeed(
        sql,
        'lottery_finder_fires',
        yesterday,
      );
      const silentBoom = await summarizeFeed(
        sql,
        'silent_boom_alerts',
        yesterday,
      );

      const lotterySummary = applyAlerts(lottery, 'lottery', yesterday);
      const sbSummary = applyAlerts(silentBoom, 'silent_boom', yesterday);

      await persistMetrics(sql, yesterday, 'lottery', lotterySummary);
      await persistMetrics(sql, yesterday, 'silent_boom', sbSummary);

      const durationMs = Date.now() - startedAt;
      logger.info(
        {
          lottery_null_rate: lotterySummary.null_rate_pct,
          sb_null_rate: sbSummary.null_rate_pct,
          durationMs,
        },
        'audit-takeit-health: complete',
      );

      await reportCronRun('audit-takeit-health', {
        status: 'ok',
        durationMs,
        lottery_null_rate: lotterySummary.null_rate_pct,
        sb_null_rate: sbSummary.null_rate_pct,
      });

      done({ status: 200 });
      res.status(200).json({
        job: 'audit-takeit-health',
        success: true,
        date: yesterday,
        lottery: lotterySummary,
        silent_boom: sbSummary,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      Sentry.captureException(error);
      logger.error({ err: error, durationMs }, 'audit-takeit-health error');

      try {
        await reportCronRun('audit-takeit-health', {
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
