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
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  withRetry,
  checkDataQuality,
  isMarketHours,
} from '../_lib/api-helpers.js';
import {
  closedGreekFlowBuckets,
  isDegenerate,
  isFeedStalled,
  type ClosedBucketsResult,
  type GreekFlowMinute,
} from '../_lib/closed-buckets.js';
import {
  sessionRowCounts,
  upsertClosedBuckets,
} from '../_lib/flow-bucket-store.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

const JOB = 'fetch-greek-flow';
const SOURCE = 'zero_dte_greek_flow';

// ── Fetch helper ────────────────────────────────────────────

async function fetchGreekFlow(
  apiKey: string,
  today: string,
): Promise<GreekFlowMinute[]> {
  return uwFetch<GreekFlowMinute>(
    apiKey,
    `/stock/SPX/greek-flow/${today}`,
    (body) => {
      // A payload without a list is malformed: fail the run by name instead
      // of treating it as an empty session.
      if (!Array.isArray(body.data)) {
        throw new Error(`${JOB}: the UW payload's \`data\` is not a list`);
      }
      return body.data as GreekFlowMinute[];
    },
  );
}

// ── Reporting ───────────────────────────────────────────────

/** UW sent no row for today's session: a skip, and an error from 09:40 ET. */
function reportNoRowsToday(ticks: number, now: Date, today: string): void {
  logger.warn(
    { payloadRows: ticks, today },
    `${JOB}: no rows for today in the UW payload — nothing stored`,
  );
  metrics.increment('fetch_greek_flow.no_rows_today');
  // Still nothing at 09:40 ET or later: the feed has stalled. An error, not a
  // warning: a warning reaches nobody, and the whole tape for the day is
  // missing.
  if (isFeedStalled(0, now)) {
    Sentry.captureMessage(
      `${JOB}: no rows for today's session in the UW payload (09:40 ET or later)`,
      {
        level: 'error',
        tags: { cron: JOB, stage: 'feed_stalled' },
        extra: { payloadRows: ticks, date: today },
      },
    );
  }
}

/**
 * Only a closed bucket stuck without a usable last minute is a bad candle.
 * Future minutes are expected to be null, and a bucket UW is only a few
 * minutes late with is pending: neither is counted.
 */
function reportStuck(closed: ClosedBucketsResult, today: string): void {
  for (let i = 0; i < closed.stuck; i++) {
    metrics.increment('fetch_greek_flow.invalid_candle');
  }
  if (closed.stuck > 0) {
    Sentry.captureMessage(
      `${JOB}: closed bucket(s) stuck without a usable last minute`,
      {
        level: 'warning',
        tags: { cron: JOB, stage: 'stuck_bucket' },
        extra: { stuck: closed.stuck, oldest: closed.oldestStuck, date: today },
      },
    );
  }
}

/** A snapshot that is all zero, or all stuck, is dropped and raised as an error. */
function reportRejected(closed: ClosedBucketsResult, today: string): void {
  logger.warn(
    { buckets: closed.buckets.length, stuck: closed.stuck, date: today },
    `${JOB}: rejecting all-zero/unusable greek flow snapshot`,
  );
  Sentry.captureMessage(
    `${JOB}: rejected all-zero/unusable greek flow snapshot`,
    {
      level: 'error',
      tags: { cron: JOB, stage: 'degenerate_snapshot' },
      extra: {
        buckets: closed.buckets.length,
        stuck: closed.stuck,
        date: today,
      },
    },
  );
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    // One clock read, before the fetch: a bucket counts as closed only if it
    // had already closed when UW answered (R-closed).
    const now = new Date(startTimeMs);

    const ticks = await withRetry(() => fetchGreekFlow(apiKey, today));
    const closed = closedGreekFlowBuckets(ticks, now);

    // R-day: UW sent nothing for today's session. Normal at the 09:28 run (it
    // still serves the previous session), so a skip, not an error.
    if (closed.sessionRows === 0) {
      reportNoRowsToday(ticks.length, now, today);
      return {
        status: 'skipped',
        message: 'No rows for today in the UW payload',
        metadata: {
          ticks: ticks.length,
          stored: 0,
          skipped: 0,
          reason: 'no_rows_today',
        },
      };
    }

    reportStuck(closed, today);

    // A rejected write throws out of here: the wrapper answers 500, captures
    // the error and reports the run as `error`, never `success` (R4).
    const rejected = isDegenerate(closed);
    if (rejected) reportRejected(closed, today);
    const counts = rejected
      ? { inserted: 0, updated: 0, unchanged: 0 }
      : await withRetry(() =>
          upsertClosedBuckets(closed.buckets, SOURCE, today),
        );
    const stored = counts.inserted + counts.updated;
    // Buckets rejected as degenerate were not written either.
    const skipped = rejected ? closed.buckets.length : counts.unchanged;

    const latest = closed.buckets.at(-1);
    ctx.logger.info(
      {
        totalTicks: ticks.length,
        stored,
        inserted: counts.inserted,
        updated: counts.updated,
        skipped,
        pending: closed.pending,
        stuck: closed.stuck,
        rejected,
        latestNcp: latest?.ncp,
        latestNpp: latest?.npp,
        latestOtmNcp: latest?.otm?.ncp,
        latestOtmNpp: latest?.otm?.npp,
      },
      `${JOB} completed`,
    );

    // Data quality check: alert if all of today's session rows are zero. It
    // runs whenever this run wrote a row (inserted or updated) and
    // checkDataQuality decides on the row count. Counts only rows stamped on
    // today's session (R-quality): rows with `date = today` can also hold an
    // earlier session's values, which would hide a dead day.
    if (stored > 0) {
      const { total, nonzero } = await sessionRowCounts(today, SOURCE);
      await checkDataQuality({
        job: JOB,
        table: 'flow_data',
        date: today,
        sourceFilter: SOURCE,
        total,
        nonzero,
      });
    }

    return {
      // A rejected snapshot wrote nothing although buckets had closed.
      status: rejected ? 'partial' : 'success',
      ...(rejected
        ? { message: 'Rejected an all-zero/unusable greek flow snapshot' }
        : {}),
      metadata: {
        ticks: ticks.length,
        stored,
        inserted: counts.inserted,
        updated: counts.updated,
        skipped,
        pending: closed.pending,
        stuck: closed.stuck,
        ...(rejected ? { rejected } : {}),
      },
    };
  },
  // Until 10 minutes after the close (the default is 5): the last bucket
  // (15:55-16:00) settles at 16:01:30, so it has the 16:03 run and a second
  // attempt at 16:08 (13:03 and 13:08 on an early-close day).
  { timeCheck: () => isMarketHours(10) },
);
