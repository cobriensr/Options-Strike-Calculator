/**
 * GET /api/cron/fetch-zero-dte-flow
 *
 * Fetches 0DTE index-only net flow from Unusual Whales Net Flow Expiry endpoint.
 * Filters: expiration=zero_dte, tide_type=index_only
 *
 * This isolates flow from options expiring TODAY on index products (SPX, NDX, etc.)
 * from weekly/monthly flow. When aggregate SPX Net Flow shows bearish but 0DTE
 * index flow is neutral, the bearishness is from longer-dated hedging, not today's session.
 *
 * Data is already cumulative (same as Market Tide), one tick per minute.
 * Stored in flow_data table with source = 'zero_dte_index'.
 *
 * What is stored, and when (spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md,
 * F3; the rules live in api/_lib/closed-buckets.ts):
 *   - UW answers with the whole session's per-minute grid (390 ticks, 09:30-15:59
 *     ET), null for the minutes that have not happened yet, and before its
 *     roll-over (09:28-09:32 ET) with the PREVIOUS session. Storing the null
 *     grid left one filled slot a day, kept for good by DO NOTHING.
 *   - One row per 5-minute bucket, carrying the value of the bucket's LAST
 *     minute, stored by the first run at least 90 s after the bucket ended
 *     (FINAL_LAG_MS: a minute that has ended is not necessarily final). A
 *     bucket still open, unsettled, or whose last minute has no usable value
 *     waits for a later run. Nothing missing is stored as 0 or NULL.
 *   - The write is an upsert on (date, timestamp, source) (spec R6, not a
 *     lock): every run re-sends the day's closed buckets, a value UW revised
 *     is updated, an unchanged one is not rewritten. See flow-bucket-store.ts.
 *   - Only ticks UW stamps on today's ET date from 09:30 ET until the close. A
 *     payload with none (the pre-open answer) stores nothing; that is a skip,
 *     not an error, unless it is still empty at 09:40 ET (Sentry warning).
 *   - Label rule (spec open question 1, default in force): a closed bucket is
 *     stored under its END time. The 09:30-09:35 bucket is stored at 09:35.
 *   - Runs every 5 minutes from 09:25 ET until 10 minutes after the close, so
 *     the last bucket (15:55-16:00, settled at 16:01:30) has the 16:04 run and
 *     a second attempt at 16:09.
 *   - A write that fails fails the run (HTTP 500, error check-in).
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  withRetry,
  checkDataQuality,
  isMarketHours,
} from '../_lib/api-helpers.js';
import {
  closedBuckets,
  isDegenerate,
  isFeedStalled,
} from '../_lib/closed-buckets.js';
import {
  sessionRowCounts,
  upsertClosedBuckets,
} from '../_lib/flow-bucket-store.js';
import { reportCronRun } from '../_lib/axiom.js';

const SOURCE = 'zero_dte_index';

// ── Types ───────────────────────────────────────────────────

interface FlowTick {
  timestamp: string;
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: string;
  underlying_price: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchZeroDteFlow(apiKey: string): Promise<FlowTick[]> {
  // Omit date param for current-day fetches — the UW API returns
  // null values when ?date= is the current trading day. Without it,
  // the API returns the session's per-minute cumulative grid (future
  // minutes null). The backfill script passes ?date= for historical dates
  // where it works correctly.
  return uwFetch<FlowTick>(
    apiKey,
    '/net-flow/expiry?expiration=zero_dte&tide_type=index_only',
    (body) => {
      // Nested structure: data[0].data[] contains the ticks
      const outer = (body.data as Array<{ data?: FlowTick[] }>) ?? [];
      if (outer.length === 0) return [];
      return outer[0]?.data ?? [];
    },
  );
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-zero-dte-flow', async (req, res) => {
  // Until 10 minutes after the close (the default is 5): the last bucket
  // (15:55-16:00) settles at 16:01:30, so it has the 16:04 run and a second
  // attempt at 16:09 (13:04 and 13:09 on an early-close day).
  const guard = cronGuard(req, res, { timeCheck: () => isMarketHours(10) });
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();
  // One clock read, before the fetch: a bucket counts as closed only if it
  // had already closed when UW answered (R-closed).
  const now = new Date(startTime);
  // Which step failed, for the Sentry tag.
  let stage: 'fetch' | 'batch_insert' | 'quality_check' = 'fetch';

  try {
    const ticks = await withRetry(() => fetchZeroDteFlow(apiKey));
    const closed = closedBuckets(ticks, now);

    // R-day: UW sent nothing for today's session. Normal at the 09:27 run (it
    // still serves the previous session), so a skip, not an error.
    if (closed.sessionRows === 0) {
      logger.warn(
        { payloadRows: ticks.length, today },
        'fetch-zero-dte-flow: no rows for today in the UW payload — nothing stored',
      );
      metrics.increment('fetch_zero_dte_flow.no_rows_today');
      // Still nothing at 09:40 ET or later: the feed has stalled.
      if (isFeedStalled(closed.sessionRows, now)) {
        Sentry.captureMessage(
          "fetch-zero-dte-flow: no rows for today's session in the UW payload (09:40 ET or later)",
          {
            level: 'warning',
            tags: { cron: 'fetch-zero-dte-flow', stage: 'feed_stalled' },
            extra: { payloadRows: ticks.length, date: today },
          },
        );
      }
      const durationMs = Date.now() - startTime;
      await reportCronRun('fetch-zero-dte-flow', {
        status: 'skipped',
        message: 'No rows for today in the UW payload',
        ticks: ticks.length,
        durationMs,
      });
      return res.status(200).json({
        job: 'fetch-zero-dte-flow',
        ticks: ticks.length,
        stored: 0,
        skipped: 0,
        reason: 'no_rows_today',
        durationMs,
      });
    }

    // Only a closed bucket stuck without a usable last minute is a bad
    // candle. Future minutes are expected to be null, and a bucket UW is only
    // a few minutes late with is pending: neither is counted.
    for (let i = 0; i < closed.stuck; i++) {
      metrics.increment('fetch_zero_dte_flow.invalid_candle');
    }
    if (closed.stuck > 0) {
      Sentry.captureMessage(
        'fetch-zero-dte-flow: closed bucket(s) stuck without a usable last minute',
        {
          level: 'warning',
          tags: { cron: 'fetch-zero-dte-flow', stage: 'stuck_bucket' },
          extra: {
            stuck: closed.stuck,
            oldest: closed.oldestStuck,
            date: today,
          },
        },
      );
    }

    let rejected = false;
    let counts = { inserted: 0, updated: 0, unchanged: 0 };
    if (isDegenerate(closed)) {
      rejected = true;
      logger.warn(
        { buckets: closed.buckets.length, stuck: closed.stuck, date: today },
        'fetch-zero-dte-flow: rejecting all-zero/null premium snapshot',
      );
      // Surface the rejection to Sentry so a recurring UW degenerate feed
      // (the 2026-06-03 incident) is observable rather than a silent 0DTE
      // flow gap. The warn log alone produced no alert on recurrence.
      Sentry.captureMessage(
        'fetch-zero-dte-flow: rejected all-zero/null premium snapshot',
        {
          level: 'error',
          tags: { cron: 'fetch-zero-dte-flow', stage: 'degenerate_snapshot' },
          extra: {
            buckets: closed.buckets.length,
            stuck: closed.stuck,
            date: today,
          },
        },
      );
    } else {
      stage = 'batch_insert';
      counts = await withRetry(() =>
        upsertClosedBuckets(closed.buckets, SOURCE, today),
      );
    }
    const stored = counts.inserted + counts.updated;
    // Buckets rejected as degenerate were not written either.
    const skipped = rejected ? closed.buckets.length : counts.unchanged;
    const result = {
      stored,
      inserted: counts.inserted,
      updated: counts.updated,
      skipped,
      pending: closed.pending,
      stuck: closed.stuck,
      ...(rejected ? { rejected } : {}),
    };

    // Log latest values
    const latest = closed.buckets.at(-1);
    logger.info(
      {
        totalTicks: ticks.length,
        ...result,
        latestNcp: latest?.ncp,
        latestNpp: latest?.npp,
      },
      'fetch-zero-dte-flow completed',
    );

    // Data quality check: alert if all of today's session rows are zero. It
    // runs whenever this run wrote a row (inserted or updated) and
    // checkDataQuality decides on the row count. Counts only rows stamped on
    // today's session (R-quality): rows with `date = today` can also hold an
    // earlier session's values, which would hide a dead day.
    if (stored > 0) {
      stage = 'quality_check';
      const { total, nonzero } = await sessionRowCounts(today, SOURCE);
      await checkDataQuality({
        job: 'fetch-zero-dte-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: SOURCE,
        total,
        nonzero,
      });
    }

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-zero-dte-flow', {
      status: 'ok',
      ticks: ticks.length,
      ...result,
      durationMs,
    });
    return res.status(200).json({
      job: 'fetch-zero-dte-flow',
      ticks: ticks.length,
      ...result,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-zero-dte-flow');
    Sentry.captureException(err, {
      tags: { cron: 'fetch-zero-dte-flow', stage },
    });
    logger.error({ err, stage }, 'fetch-zero-dte-flow error');
    // Tell Axiom the run failed (the check-in goes red on the 500 below).
    await reportCronRun('fetch-zero-dte-flow', {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
      stage,
      durationMs: Date.now() - startTime,
    });
    return res.status(500).json({ error: 'Internal error' });
  }
});
