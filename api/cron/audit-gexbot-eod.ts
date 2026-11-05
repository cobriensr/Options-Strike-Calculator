/**
 * GET /api/cron/audit-gexbot-eod
 *
 * Loss report for a GEXBot EOD day. Runs at 22:30 and 23:30 UTC on weekdays (the
 * second run retries a failed first one and checks the same date), after the
 * download window of the previous trading day's report has closed (17:00 ET
 * today: 21:00 UTC in EDT, 22:00 UTC in EST). The hourly capture cron retries
 * missing reports on its own until then, so a ticker still missing here is
 * lost, and this is information only: nothing manual can do better.
 * Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
 *
 * Which date: `today` in ET. A non-trading day returns `skipped` (no window
 * closed today) and makes no call. Otherwise the date is
 * `priorTradingDay(today)`, the report whose window closed at 17:00 ET today.
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

import { isTradingDay, priorTradingDay } from '../../src/data/marketHours.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { fetchEodTickers, listStoredTickers } from '../_lib/gexbot-eod.js';
import { Sentry } from '../_lib/sentry.js';

export default withCronInstrumentation(
  'audit-gexbot-eod',
  async (ctx): Promise<CronResult> => {
    const today = getETDateStr(new Date());
    if (!isTradingDay(today)) {
      return { status: 'skipped', message: 'no download window closed today' };
    }
    const date = priorTradingDay(today);
    const { tickers, rejected } = await fetchEodTickers();
    const stored = await listStoredTickers(date);
    const missing = tickers.filter((t) => !stored.has(t));
    if (rejected.length > 0) {
      // Information only: rejected tickers can never be stored, so they never
      // count as missing and do not change the audit status.
      Sentry.captureMessage(
        `GEXBot EOD tickers rejected by the charset: ${rejected.join(', ')}`,
        {
          level: 'warning',
          fingerprint: ['gexbot-eod', 'rejected-tickers'],
          extra: { date, rejected },
        },
      );
    }
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

    const message = `GEXBot EOD reports lost for ${date}: ${missing.length} tickers (download window closed; automatic retries could not capture them)`;
    ctx.logger.error({ date, missing }, 'audit-gexbot-eod lost reports');
    Sentry.captureMessage(message, {
      level: 'error',
      fingerprint: ['gexbot-eod', 'missed-window'],
      extra: { date, missing },
    });
    return { status: 'error', rows: 0, message, metadata };
  },
  { marketHours: false, requireApiKey: false },
);
