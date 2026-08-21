/**
 * GET /api/cron/monitor-ws-freshness
 *
 * Every-5-min market-hours tripwire for the uw-stream websocket daemon
 * (Railway). Born from the 2026-08-19 incident: the daemon crashed at
 * 16:22Z and sat dead for 24 hours with zero alerting — ws_option_trades /
 * ws_flow_alerts received nothing through a full session while every
 * detector cron kept returning success with 0 fires (0 is a plausible
 * value, so nothing paged). The outage surfaced only via a UI "STALE"
 * chip. This cron is the server-side alert that gap left missing.
 *
 * Check: max(executed_at) from ws_option_trades — the highest-volume WS
 * table (~1M rows/day when healthy across the ~86-ticker Lottery Finder
 * universe), so any daemon stall shows up here first. `executed_at` is
 * used (not `received_at`) because it's the indexed column
 * (ws_option_trades_executed_idx, migration #109); the two track within
 * seconds of each other, which is noise at a 300s threshold. The WHERE
 * clause bounds the scan to the last 30 minutes so the query stays a
 * cheap index range scan and never walks history.
 *
 * Alerting: staleness > WS_STALE_ALERT_S (default 300s) →
 * Sentry.captureMessage at level 'error' + logger.error, once per run —
 * the 5-min cadence provides natural rate limiting, no cross-run latch.
 * The CronResult status stays 'success' either way: the cron RAN fine;
 * the feed is what's broken. Keeping the check-in green means the Sentry
 * cron monitor still distinguishes "monitor stopped running" (missed
 * check-in) from "feed stale" (captureMessage event). The measured
 * staleness rides in the CronResult metadata on every run, so Axiom gets
 * a heartbeat trail even when healthy.
 *
 * Gates:
 *   - cronGuard marketHours (default) — outside RTH the daemon writing
 *     nothing is expected, not an outage.
 *   - isPastCashOpen(5) — before 09:35 ET a quiet tape or a daemon still
 *     booting after the overnight deploy window is a plausible race, so
 *     the run reports 'skipped' instead of alerting (mirrors the
 *     detect-lottery-fires pre-open guard, with a wider grace since a
 *     staleness measure reaches back before the bell).
 */

import { withCronInstrumentation } from '../_lib/cron-instrumentation.js';
import { isPastCashOpen } from '../_lib/cron-helpers.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

/** Default alert threshold in seconds; override via WS_STALE_ALERT_S. */
const DEFAULT_STALE_ALERT_S = 300;

/**
 * Index-range bound for the max(executed_at) scan. Also the staleness
 * floor reported when the window is completely empty — we can't know how
 * much longer than the lookback the feed has been dead, only that it's
 * at least this stale (and 1800s is already 6x the default threshold).
 */
const LOOKBACK_MINUTES = 30;

/** Minutes after the 09:30 ET cash open before an alert is allowed. */
const OPEN_GRACE_MINUTES = 5;

interface FreshnessRow {
  last_executed_at: string | Date | null;
}

function staleThresholdSeconds(): number {
  const raw = Number.parseInt(process.env.WS_STALE_ALERT_S ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_ALERT_S;
}

export default withCronInstrumentation(
  'monitor-ws-freshness',
  async () => {
    if (!isPastCashOpen(OPEN_GRACE_MINUTES)) {
      return {
        status: 'skipped',
        message: `within post-open grace window (first ${OPEN_GRACE_MINUTES} min after cash open)`,
      };
    }

    const sql = getDb();
    const rows = (await withDbRetry(
      () => sql`
        SELECT max(executed_at) AS last_executed_at
        FROM ws_option_trades
        WHERE executed_at > NOW() - make_interval(mins => ${LOOKBACK_MINUTES})
      `,
      2,
      10_000,
    )) as FreshnessRow[];

    const lastRaw = rows[0]?.last_executed_at ?? null;
    const lastExecutedAt =
      lastRaw == null ? null : new Date(lastRaw).toISOString();
    const stalenessSeconds =
      lastExecutedAt == null
        ? LOOKBACK_MINUTES * 60
        : Math.max(
            0,
            Math.round((Date.now() - Date.parse(lastExecutedAt)) / 1000),
          );

    const thresholdSeconds = staleThresholdSeconds();
    const stale = stalenessSeconds > thresholdSeconds;
    const metadata = {
      stale,
      stalenessSeconds,
      thresholdSeconds,
      lastExecutedAt,
      lookbackMinutes: LOOKBACK_MINUTES,
    };

    if (stale) {
      // Once per run — the 5-min cron cadence is the rate limiter.
      Sentry.captureMessage(
        `ws feed stale: no option trades for ${stalenessSeconds}s`,
        {
          level: 'error',
          tags: { 'cron.anomaly': 'ws-freshness' },
          extra: metadata,
        },
      );
      logger.error(
        metadata,
        'monitor-ws-freshness: ws_option_trades feed is stale during market hours',
      );
    }

    return {
      status: 'success',
      message: stale
        ? `stale: no option trades for ${stalenessSeconds}s`
        : 'fresh',
      metadata,
    };
  },
  { marketHours: true, requireApiKey: false },
);
