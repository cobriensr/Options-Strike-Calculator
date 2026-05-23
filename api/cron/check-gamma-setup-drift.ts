/**
 * GET /api/cron/check-gamma-setup-drift
 *
 * Runs weekly (Friday 21:30 UTC, after the EOD outcome backfill at the
 * same minute the prior crons fire). Aggregates the trailing 28-day
 * window of `ws_gamma_setup_fires`, applies drift rules from
 * `api/_lib/gamma-stats.ts`, and fires a Sentry warning when live stats
 * meaningfully diverge from the validated backtest expectations.
 *
 * Drift rules (see api/_lib/gamma-stats.ts for the constants):
 *   - Composite win rate < 55% with n>=10 outcomes
 *   - Per-signal mean realized edge < 50% of expected backtest edge,
 *     with n>=10 outcomes for that signal
 *
 * When drift fires, the Sentry message carries the full AggregateStats
 * snapshot in `extra` so the alert handler / investigator can see which
 * rule triggered and which signal type is degrading.
 *
 * No UW API call → requireApiKey false. After-hours run → marketHours
 * false (relies on the configured weekly Friday schedule).
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  aggregateFireStats,
  detectDrift,
  loadFireStatsRows,
} from '../_lib/gamma-stats.js';
import { Sentry } from '../_lib/sentry.js';
import { getETDateStr } from '../../src/utils/timezone.js';

const LOOKBACK_DAYS = 28;

function daysAgoEtDateStr(days: number): string {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return getETDateStr(past);
}

export default withCronInstrumentation(
  'check-gamma-setup-drift',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();
    const today = getETDateStr(new Date());
    const from = daysAgoEtDateStr(LOOKBACK_DAYS);

    const rows = await loadFireStatsRows(sql, from, today);
    const stats = aggregateFireStats(rows, from, today);
    const drift = detectDrift(stats);

    if (drift != null) {
      Sentry.setTag('cron.job', 'check-gamma-setup-drift');
      Sentry.captureMessage('gamma-setup drift detected', {
        level: 'warning',
        extra: {
          reasons: drift.reasons,
          stats,
          window_from: from,
          window_to: today,
        },
      });
      ctx.logger.warn(
        { reasons: drift.reasons, n_total: stats.n_total },
        'check-gamma-setup-drift: drift detected',
      );
    } else {
      ctx.logger.info(
        {
          n_total: stats.n_total,
          n_with_outcome: stats.n_with_outcome,
          win_rate: stats.win_rate,
          mean_edge_pts: stats.mean_edge_pts,
        },
        'check-gamma-setup-drift: stats within tolerance',
      );
    }

    return {
      status: drift == null ? 'success' : 'partial',
      rows: stats.n_total,
      message:
        drift == null ? 'no drift' : `drift: ${drift.reasons.join('; ')}`,
      metadata: {
        window_from: from,
        window_to: today,
        n_total: stats.n_total,
        n_with_outcome: stats.n_with_outcome,
        win_rate: stats.win_rate,
        mean_edge_pts: stats.mean_edge_pts,
        drift_fired: drift != null,
      },
    };
  },
  // After-hours weekly run → no market-hours gate, no UW key needed.
  { marketHours: false, requireApiKey: false },
);
