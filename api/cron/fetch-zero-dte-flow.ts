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
 *   - UW answers with the whole session's per-minute grid, null for the
 *     minutes that have not happened yet, and before its roll-over
 *     (09:28-09:32 ET) with the PREVIOUS session. Storing the null grid left
 *     one filled slot a day, kept for good by DO NOTHING.
 *   - One row per 5-minute bucket, stored by the first run after the bucket
 *     closes (the cron runs every 5 minutes through 16:05 ET), carrying the
 *     value of the bucket's LAST minute. A bucket still open, or whose last
 *     minute has no value, waits for a later run. Nothing missing is stored
 *     as 0 or NULL.
 *   - Only ticks UW stamps on today's ET date at or after 09:30 ET. A payload
 *     with none (the pre-open answer) stores nothing; that is a skip, not an
 *     error.
 *   - Label rule (spec open question 1, default in force): a closed bucket is
 *     stored under its END time. The 09:30-09:35 bucket is stored at 09:35.
 *   - A write that fails fails the run (HTTP 500, error check-in).
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import {
  closedBuckets,
  sessionWindowIso,
  type ClosedBucket,
} from '../_lib/closed-buckets.js';
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

// ── Store ───────────────────────────────────────────────────

/**
 * True when the closed buckets are a degenerate snapshot: none has a usable
 * value, or every one has zero premium on both sides (the QC "ALL values are
 * zero/null" fingerprint — fired on zero_dte_index for 2026-06-03). Storing it
 * writes a flat 0DTE flow series for the day, so the whole batch is dropped.
 */
function isDegenerate(buckets: ClosedBucket[], unusable: number): boolean {
  if (buckets.length === 0) return unusable > 0;
  return buckets.every((b) => b.ncp === 0 && b.npp === 0);
}

async function storeBuckets(
  buckets: ClosedBucket[],
  date: string,
): Promise<{ stored: number; skipped: number }> {
  if (buckets.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  // Collapse the per-row INSERT loop into a single transaction round-trip
  // (AUD-M7). All rows ship in one network call; a failure aborts the whole
  // batch and throws to the handler, which fails the run (R4). It used to be
  // swallowed here as "skipped", so a dead database reported success.
  const results = await sql.transaction((txn) =>
    buckets.map(
      (bucket) => txn`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${date}, ${bucket.timestamp}, ${SOURCE},
          ${bucket.ncp}, ${bucket.npp}, ${bucket.netVolume}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `,
    ),
  );

  let stored = 0;
  for (const result of results) {
    if (result.length > 0) stored++;
  }
  return { stored, skipped: buckets.length - stored };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-zero-dte-flow', async (req, res) => {
  const guard = cronGuard(req, res);
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
    const { buckets, sessionRows, unusable } = closedBuckets(ticks, now);

    // R-day: UW sent nothing for today's session. Normal at the 09:27 run (it
    // still serves the previous session), so a skip, not an error.
    if (sessionRows === 0) {
      logger.warn(
        { payloadRows: ticks.length, today },
        'fetch-zero-dte-flow: no rows for today in the UW payload — nothing stored',
      );
      metrics.increment('fetch_zero_dte_flow.no_rows_today');
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

    // Only a closed bucket whose last minute has no usable value is a bad
    // candle. Future minutes are expected to be null and are not counted.
    for (let i = 0; i < unusable; i++) {
      metrics.increment('fetch_zero_dte_flow.invalid_candle');
    }

    let result: { stored: number; skipped: number; rejected?: boolean };
    if (isDegenerate(buckets, unusable)) {
      logger.warn(
        { buckets: buckets.length, unusable, date: today },
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
          extra: { buckets: buckets.length, unusable, date: today },
        },
      );
      result = {
        stored: 0,
        skipped: buckets.length + unusable,
        rejected: true,
      };
    } else {
      stage = 'batch_insert';
      result = await withRetry(() => storeBuckets(buckets, today));
    }

    // Log latest values
    const latest = buckets.at(-1);
    logger.info(
      {
        totalTicks: ticks.length,
        ...result,
        unusable,
        latestNcp: latest?.ncp,
        latestNpp: latest?.npp,
      },
      'fetch-zero-dte-flow completed',
    );

    // Data quality check: alert if all values are zero. Counts only today's
    // session rows (R-quality): rows with `date = today` can also hold an
    // earlier session's values, which would hide a dead day.
    if (result.stored > 10) {
      stage = 'quality_check';
      const { openIso, closeIso } = sessionWindowIso(today);
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
        FROM flow_data
        WHERE date = ${today} AND source = ${SOURCE}
          AND timestamp >= ${openIso}::timestamptz
          AND timestamp <= ${closeIso}::timestamptz
      `;
      const { total, nonzero } = rows[0]!;
      await checkDataQuality({
        job: 'fetch-zero-dte-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: SOURCE,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-zero-dte-flow', {
      status: 'ok',
      ticks: ticks.length,
      stored: result.stored,
      skipped: result.skipped,
      unusable,
      durationMs,
    });
    return res.status(200).json({
      job: 'fetch-zero-dte-flow',
      ticks: ticks.length,
      ...result,
      unusable,
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
