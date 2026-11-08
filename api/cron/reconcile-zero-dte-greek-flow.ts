/**
 * GET /api/cron/reconcile-zero-dte-greek-flow
 *
 * Post-close reconciliation of the SPX 0DTE greek flow that fetch-greek-flow
 * stores in flow_data (source `zero_dte_greek_flow`). Re-reads the just-closed
 * session once, with the same fetch, parse and store path as the live cron
 * (api/_lib/spx-greek-flow.ts), and upserts every closed 5-minute bucket of
 * the day: a value UW has restated since the live runs is updated, an
 * unchanged one is not rewritten.
 *
 * Why this exists:
 *   UW restates its per-minute greek-flow figures after first publishing them,
 *   and the window is unknown (docs/tmp/greek-flow-debug/
 *   uw-greek-flow-restatement.md; reconcile-greek-flow-etf is the same job for
 *   SPY and QQQ). A probe on 2026-11-07 found that of the 79 rows the old live
 *   cron stored for 11-06, one matched any of UW's current per-minute values
 *   (the 09:30 row held ncp -2,281; UW then had -14,505 at 09:32). The live
 *   cron's upsert heals revisions only through its 16:08 ET run, so a
 *   revision published later needs this pass.
 *
 * Schedule: vercel.json registers `5 22 * * 1-5` (22:05 UTC, 17:05 ET in EST
 * and 18:05 ET in EDT), on trading days only. At that hour the session is over,
 * so every closed bucket whose last minute is still unusable is reported as
 * stuck, and an empty payload is a failed run (status `error`, plus the Sentry
 * error `feed_stalled`), not a skip.
 *
 * The call pins `?date=<today>`: the finished session, as the backfill and
 * reconcile-greek-flow-etf ask for it. R-day still drops any row stamped on
 * another day.
 *
 * A failed fetch, malformed payload, write or quality query fails the run
 * (HTTP 500, error check-in, Sentry capture), never `success` (R4).
 *
 * Stopgap, with fetch-greek-flow, until the uw-stream `greek_flow_expiry:SPX`
 * writer is live and parity-checked (spec Follow-ups, 2026-11-07); then retire
 * both. Do not extend.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { isTradingDayET } from '../_lib/api-helpers.js';
import {
  REJECTED_SNAPSHOT_MESSAGE,
  spxGreekFlowMetadata,
  syncSpxGreekFlow,
} from '../_lib/spx-greek-flow.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

const JOB = 'reconcile-zero-dte-greek-flow';

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    const sync = await syncSpxGreekFlow({
      job: JOB,
      apiKey,
      today,
      now: new Date(startTimeMs),
      pinDate: true,
    });
    const metadata = { date: today, ...spxGreekFlowMetadata(sync) };

    // After the close on a trading day UW must have the session: nothing for
    // today means the day's whole tape is missing, so the run failed. The
    // Sentry error `feed_stalled` was already raised by the shared path.
    if (sync.noRowsToday) {
      return {
        status: 'error',
        message: "No rows for today's session in the UW payload",
        metadata,
      };
    }

    // A rejected snapshot (all zero or all stuck) is dropped, and the shared
    // path raises the Sentry error `degenerate_snapshot`. At this hour that was
    // the day's last attempt, so the reconcile did not happen: the run is an
    // `error`. ("Rejected is success" is for the live cron, whose next tick
    // retries.) A failed write or quality query throws out of here.
    if (sync.rejected) {
      return { status: 'error', message: REJECTED_SNAPSHOT_MESSAGE, metadata };
    }
    return { status: 'success', metadata };
  },
  // Trading days only: the schedule is Mon-Fri, so a market holiday would
  // otherwise read an empty session as a stalled feed. The time of day is the
  // schedule's.
  { timeCheck: () => isTradingDayET() },
);
