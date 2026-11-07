/**
 * GET /api/cron/fetch-greek-flow
 *
 * Fetches 0DTE-specific delta and vega flow for SPX from Unusual Whales API.
 * Uses the Greek Flow by Expiry endpoint filtered to today's expiration.
 *
 * Delta flow = how much directional exposure is being added per minute.
 * Vega flow = how much volatility exposure is being added per minute.
 *
 * When delta flow surges negative while premium flow (NCP) is flat,
 * institutions are adding directional delta without paying premium — likely
 * through complex structures (spreads, combos) rather than outright buys.
 * This is a higher-conviction directional signal than premium alone.
 *
 * Stored in flow_data table with source = 'zero_dte_greek_flow'.
 * ncp column = total_delta_flow, npp column = dir_delta_flow,
 * net_volume column = volume,
 * otm_ncp column = otm_total_delta_flow, otm_npp column = otm_dir_delta_flow.
 *
 * The OTM variants capture directional conviction in the wings (informed
 * positioning), while the total/non-OTM columns include ATM activity that
 * is dominated by dealer hedging and gamma scalping. See migration #48.
 *
 * What is stored, and when (spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md,
 * F4; the rules live in api/_lib/closed-buckets.ts, shared with fetch-etf-tide
 * and fetch-zero-dte-flow):
 *   - The path's date is the contract EXPIRY, and the call carries no `date=`
 *     query, so before UW's roll-over (09:28-09:32 ET) the answer holds the
 *     PREVIOUS session's trades in contracts expiring today (1DTE flow). The
 *     09:28 run stored it under today's date. Only rows UW stamps on today's
 *     ET date from 09:30 ET until the close are used (R-day); a payload with
 *     none stores nothing, a skip and not an error unless it is still empty at
 *     09:40 ET (Sentry error). SPX options print until 16:15 ET, so the
 *     minutes after the cash close are left out too.
 *   - One row per 5-minute bucket, carrying the value of the bucket's LAST
 *     minute (a per-minute flow, not a sum of the five: what this cron and
 *     scripts/backfill-greek-flow.mjs have always stored), stored by the first
 *     run at least 90 s after the bucket ended (FINAL_LAG_MS: a minute that has
 *     ended is not necessarily final). A bucket still open, unsettled, or whose
 *     last minute has no usable value waits for a later run. Nothing missing is
 *     stored as 0.
 *   - The write is an upsert on (date, timestamp, source) (spec R6, not a
 *     lock): every run re-sends the day's closed buckets, a value UW revised is
 *     updated, an unchanged one is not rewritten. UW restates these per-minute
 *     figures after the fact (docs/tmp/greek-flow-debug), which DO NOTHING kept
 *     at its first, preliminary value. See flow-bucket-store.ts.
 *   - Label rule (spec open question 1, default in force): a closed bucket is
 *     stored under its END time. The 09:30-09:35 bucket is stored at 09:35.
 *   - Runs every 5 minutes from 09:25 ET until 10 minutes after the close, so
 *     the last bucket (15:55-16:00, settled at 16:01:30) has the 16:03 run and
 *     a second attempt at 16:08.
 *   - A write that fails fails the run (HTTP 500, error check-in).
 *
 * The fetch, parse and store path is shared with
 * reconcile-zero-dte-greek-flow (api/_lib/spx-greek-flow.ts), which re-reads
 * the closed session once after the close.
 *
 * Stopgap until the uw-stream `greek_flow_expiry:SPX` writer is live and
 * parity-checked (spec Follow-ups, 2026-11-07); then retire this cron. Do not
 * extend.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { isMarketHours } from '../_lib/api-helpers.js';
import {
  spxGreekFlowMetadata,
  syncSpxGreekFlow,
} from '../_lib/spx-greek-flow.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

const JOB = 'fetch-greek-flow';

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    // One clock read, before the fetch: a bucket counts as closed only if it
    // had already closed when UW answered (R-closed).
    const sync = await syncSpxGreekFlow({
      job: JOB,
      apiKey,
      today,
      now: new Date(startTimeMs),
      pinDate: false,
    });
    const metadata = spxGreekFlowMetadata(sync);

    // R-day: UW sent nothing for today's session. Normal at the 09:28 run (it
    // still serves the previous session), so a skip, not an error.
    if (sync.noRowsToday) {
      return {
        status: 'skipped',
        message: 'No rows for today in the UW payload',
        metadata,
      };
    }

    // A failed write (upsert or quality query) throws out of here: the wrapper
    // answers 500, captures the error and reports the run as `error`, never
    // `success` (R4). A rejected snapshot is dropped and raised as the Sentry
    // error `degenerate_snapshot`; that error is the alert, so the run itself
    // stays `success`, as for fetch-etf-tide and fetch-zero-dte-flow.
    return {
      status: 'success',
      ...(sync.rejected
        ? { message: 'Rejected an all-zero/unusable greek flow snapshot' }
        : {}),
      metadata,
    };
  },
  // Until 10 minutes after the close (the default is 5): the last bucket
  // (15:55-16:00) settles at 16:01:30, so it has the 16:03 run and a second
  // attempt at 16:08 (13:03 and 13:08 on an early-close day).
  { timeCheck: () => isMarketHours(10) },
);
