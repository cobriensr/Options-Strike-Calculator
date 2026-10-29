/**
 * GET /api/cron/audit-gexbot-eod
 *
 * Alarm for a lost GEXBot EOD day. Runs at 19:45 UTC on weekdays, when
 * `latestEligibleReportDate` is the previous trading day, whose download
 * window closes at 17:00 ET (75 minutes later in EDT), enough for a manual
 * rescue run of archive-gexbot-eod.
 * Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
 *
 * Reads only the `/tickers` list and the `gexbot_eod_reports` index. It
 * makes no report request and no R2 call. Only charset-valid tickers can
 * ever be stored, so `missing` is computed from `tickers` and never from
 * `rejected`; rejected tickers are reported as information only.
 *
 * Missing tickers return `status: 'error'` (the wrapper turns that into an
 * error check-in and Axiom event) plus one Sentry message. A `/tickers` or
 * DB failure throws through the wrapper.
 *
 * Environment: CRON_SECRET, DATABASE_URL
 */

import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  fetchEodTickers,
  latestEligibleReportDate,
  listStoredTickers,
} from '../_lib/gexbot-eod.js';
import { Sentry } from '../_lib/sentry.js';

export default withCronInstrumentation(
  'audit-gexbot-eod',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    const { tickers, rejected } = await fetchEodTickers();
    const date = latestEligibleReportDate(now);
    const stored = await listStoredTickers(date);
    const missing = tickers.filter((t) => !stored.has(t));
    const metadata = {
      date,
      tickers: tickers.length,
      missing,
      rejectedTickers: rejected,
    };

    if (missing.length === 0) {
      ctx.logger.info({ date, tickers: tickers.length }, 'audit-gexbot-eod ok');
      return { status: 'success', rows: 0, metadata };
    }

    const message = `GEXBot EOD reports missing for ${date}: ${missing.length} tickers`;
    ctx.logger.error({ date, missing }, 'audit-gexbot-eod missing reports');
    Sentry.captureMessage(message, {
      level: 'error',
      fingerprint: ['gexbot-eod', 'missed-window'],
      extra: { date, missing },
    });
    return { status: 'error', rows: 0, message, metadata };
  },
  { marketHours: false, requireApiKey: false },
);
