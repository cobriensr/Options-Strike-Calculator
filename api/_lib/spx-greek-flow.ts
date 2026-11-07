/**
 * SPX 0DTE greek flow (flow_data source `zero_dte_greek_flow`): the one fetch,
 * parse and store path for fetch-greek-flow (live, every 5 minutes) and
 * reconcile-zero-dte-greek-flow (once, after the close).
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.2, F4).
 *
 * One call to UW's `/stock/SPX/greek-flow/{expiry}`, whose path date is the
 * contract EXPIRY: before UW's roll-over (09:28-09:32 ET) an undated call
 * answers with the PREVIOUS session's trades in contracts expiring today (1DTE
 * flow). The rules live in closed-buckets.ts (R-day, R-null, R-closed, the end
 * label, pending/stuck) and the write in flow-bucket-store.ts (an upsert that
 * heals a revised value, OTM wings included); this module wires them to the
 * source and reports what they find:
 *   - no row for today's session: logged, counted, and a Sentry error from
 *     09:40 ET (`feed_stalled`);
 *   - closed buckets stuck without a usable last minute: an
 *     `invalid_candle` metric each and one Sentry warning naming the oldest;
 *   - a snapshot that is all zero or all stuck: dropped, with a Sentry error
 *     (`degenerate_snapshot`);
 *   - a failed write or quality query: thrown to the caller, which must fail
 *     its run (R4).
 *
 * Metric names follow the job: `<job with _>.no_rows_today` and
 * `.invalid_candle` (fetch_greek_flow.*, reconcile_zero_dte_greek_flow.*).
 */

import { Sentry, metrics } from './sentry.js';
import logger from './logger.js';
import { uwFetch, withRetry, checkDataQuality } from './api-helpers.js';
import {
  closedGreekFlowBuckets,
  isDegenerate,
  isFeedStalled,
  type ClosedBucketsResult,
  type GreekFlowMinute,
} from './closed-buckets.js';
import {
  sessionRowCounts,
  upsertClosedBuckets,
  type UpsertCounts,
} from './flow-bucket-store.js';
import type { CronResult } from './cron-instrumentation.js';

export const SPX_GREEK_FLOW_SOURCE = 'zero_dte_greek_flow';

/** What one run found and wrote. */
export interface SpxGreekFlowSync {
  /** Rows UW sent, of any day. */
  ticks: number;
  /** UW sent no row for today's session (the pre-open answer, or nothing). */
  noRowsToday: boolean;
  /** The snapshot was all zero or all stuck: dropped, not written. */
  rejected: boolean;
  /** Rows written: inserted + updated. */
  stored: number;
  inserted: number;
  /** Existing rows whose values UW revised. */
  updated: number;
  /** Existing rows that already held these values (or buckets dropped as rejected). */
  skipped: number;
  /** Closed buckets left out, last minute unusable, ended under 10 min ago. */
  pending: number;
  /** The same, ended 10 min ago or more, or past the day's last attempt. */
  stuck: number;
}

const NOTHING_WRITTEN: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };

/**
 * One UW GET of SPX 0DTE greek flow. `pinDate` adds `?date=<day>`, which a
 * finished session needs (as reconcile-greek-flow-etf and the backfill send
 * it); the live cron sends no date and relies on R-day. A payload without a
 * list in `data` is malformed: it fails the run by name instead of reading as
 * an empty session.
 */
async function fetchSpxGreekFlow(
  job: string,
  apiKey: string,
  day: string,
  pinDate: boolean,
): Promise<GreekFlowMinute[]> {
  const query = pinDate ? `?date=${day}` : '';
  return uwFetch<GreekFlowMinute>(
    apiKey,
    `/stock/SPX/greek-flow/${day}${query}`,
    (body) => {
      if (!Array.isArray(body.data)) {
        throw new Error(`${job}: the UW payload's \`data\` is not a list`);
      }
      return body.data as GreekFlowMinute[];
    },
  );
}

/** UW sent no row for today's session: a skip, and an error from 09:40 ET. */
function reportNoRowsToday(
  job: string,
  ticks: number,
  now: Date,
  today: string,
): void {
  logger.warn(
    { payloadRows: ticks, today },
    `${job}: no rows for today in the UW payload — nothing stored`,
  );
  metrics.increment(`${job.replaceAll('-', '_')}.no_rows_today`);
  // Still nothing at 09:40 ET or later: the feed has stalled. An error, not a
  // warning: a warning reaches nobody, and the whole tape for the day is
  // missing.
  if (isFeedStalled(0, now)) {
    Sentry.captureMessage(
      `${job}: no rows for today's session in the UW payload (09:40 ET or later)`,
      {
        level: 'error',
        tags: { cron: job, stage: 'feed_stalled' },
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
function reportStuck(
  job: string,
  closed: ClosedBucketsResult,
  today: string,
): void {
  const metric = `${job.replaceAll('-', '_')}.invalid_candle`;
  for (let i = 0; i < closed.stuck; i++) metrics.increment(metric);
  if (closed.stuck > 0) {
    Sentry.captureMessage(
      `${job}: closed bucket(s) stuck without a usable last minute`,
      {
        level: 'warning',
        tags: { cron: job, stage: 'stuck_bucket' },
        extra: { stuck: closed.stuck, oldest: closed.oldestStuck, date: today },
      },
    );
  }
}

/** A snapshot that is all zero, or all stuck, is dropped and raised as an error. */
function reportRejected(
  job: string,
  closed: ClosedBucketsResult,
  today: string,
): void {
  logger.warn(
    { buckets: closed.buckets.length, stuck: closed.stuck, date: today },
    `${job}: rejecting all-zero/unusable greek flow snapshot`,
  );
  Sentry.captureMessage(
    `${job}: rejected all-zero/unusable greek flow snapshot`,
    {
      level: 'error',
      tags: { cron: job, stage: 'degenerate_snapshot' },
      extra: {
        buckets: closed.buckets.length,
        stuck: closed.stuck,
        date: today,
      },
    },
  );
}

/**
 * Fetch today's SPX 0DTE greek flow, keep the closed buckets and upsert them.
 * `now` is read once by the caller before the call, so every bucket called
 * closed was already closed when UW answered (R-closed). A rejected write or
 * quality query throws.
 */
export async function syncSpxGreekFlow(opts: {
  job: string;
  apiKey: string;
  today: string;
  now: Date;
  pinDate: boolean;
}): Promise<SpxGreekFlowSync> {
  const { job, apiKey, today, now, pinDate } = opts;

  const ticks = await withRetry(() =>
    fetchSpxGreekFlow(job, apiKey, today, pinDate),
  );
  const closed = closedGreekFlowBuckets(ticks, now);

  // R-day: UW sent nothing for today's session. Normal at the 09:28 run (it
  // still serves the previous session), so a skip, not an error.
  if (closed.sessionRows === 0) {
    reportNoRowsToday(job, ticks.length, now, today);
    return {
      ticks: ticks.length,
      noRowsToday: true,
      rejected: false,
      stored: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      pending: 0,
      stuck: 0,
    };
  }

  reportStuck(job, closed, today);

  const rejected = isDegenerate(closed);
  if (rejected) reportRejected(job, closed, today);
  const counts = rejected
    ? NOTHING_WRITTEN
    : await withRetry(() =>
        upsertClosedBuckets(closed.buckets, SPX_GREEK_FLOW_SOURCE, today),
      );
  const stored = counts.inserted + counts.updated;
  // Buckets rejected as degenerate were not written either.
  const skipped = rejected ? closed.buckets.length : counts.unchanged;

  const latest = closed.buckets.at(-1);
  logger.info(
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
    `${job} completed`,
  );

  // Data quality check: alert if all of today's session rows are zero. It
  // runs whenever this run wrote a row (inserted or updated) and
  // checkDataQuality decides on the row count. Counts only rows stamped on
  // today's session (R-quality): rows with `date = today` can also hold an
  // earlier session's values, which would hide a dead day.
  if (stored > 0) {
    const { total, nonzero } = await sessionRowCounts(
      today,
      SPX_GREEK_FLOW_SOURCE,
    );
    await checkDataQuality({
      job,
      table: 'flow_data',
      date: today,
      sourceFilter: SPX_GREEK_FLOW_SOURCE,
      total,
      nonzero,
    });
  }

  return {
    ticks: ticks.length,
    noRowsToday: false,
    rejected,
    stored,
    inserted: counts.inserted,
    updated: counts.updated,
    skipped,
    pending: closed.pending,
    stuck: closed.stuck,
  };
}

/**
 * The run's counts for the cron response and the Axiom event. A payload with
 * no rows for today reports `reason: 'no_rows_today'` and no pending or stuck
 * counts; a rejected snapshot reports `rejected: true`.
 */
export function spxGreekFlowMetadata(
  sync: SpxGreekFlowSync,
): NonNullable<CronResult['metadata']> {
  if (sync.noRowsToday) {
    return {
      ticks: sync.ticks,
      stored: 0,
      skipped: 0,
      reason: 'no_rows_today',
    };
  }
  return {
    ticks: sync.ticks,
    stored: sync.stored,
    inserted: sync.inserted,
    updated: sync.updated,
    skipped: sync.skipped,
    pending: sync.pending,
    stuck: sync.stuck,
    ...(sync.rejected ? { rejected: true } : {}),
  };
}
