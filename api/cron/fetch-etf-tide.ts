/**
 * GET /api/cron/fetch-etf-tide
 *
 * Fetches ETF Tide data from Unusual Whales API for SPY and QQQ.
 * ETF Tide measures options flow on the individual holdings of an ETF,
 * not on the ETF itself — a more granular view of directional conviction.
 *
 * Same response format as Market Tide (cumulative NCP/NPP/volume).
 * Stores in flow_data table with sources: 'spy_etf_tide', 'qqq_etf_tide'
 *
 * What is stored, and when (spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md,
 * F1/F2; the rules live in api/_lib/closed-buckets.ts):
 *   - UW answers with the whole session's per-minute grid (390 rows, 09:30-15:59
 *     ET), null for the minutes that have not happened yet, and before its
 *     roll-over (09:28-09:32 ET) with the PREVIOUS session. Storing either as
 *     data froze 78 zero rows (or yesterday's session) per day under DO NOTHING.
 *   - One row per 5-minute bucket, carrying the value of the bucket's LAST
 *     minute, stored by the first run at least 90 s after the bucket ended
 *     (FINAL_LAG_MS: a minute that has ended is not necessarily final). A
 *     bucket still open, unsettled, or whose last minute has no usable value
 *     waits for a later run. Nothing missing is stored as 0.
 *   - The write is an upsert on (date, timestamp, source) (spec R6, not a
 *     lock): every run re-sends the day's closed buckets, a value UW revised
 *     is updated, an unchanged one is not rewritten. See flow-bucket-store.ts.
 *   - Only rows UW stamps on today's ET date from 09:30 ET until the close. A
 *     payload with none (the pre-open answer) stores nothing; that is a skip,
 *     not an error, unless it is still empty at 09:40 ET (Sentry warning).
 *   - Label rule (spec open question 1, default in force): a closed bucket is
 *     stored under its END time. The 09:30-09:35 bucket is stored at 09:35.
 *   - Runs every 5 minutes from 09:25 ET until 10 minutes after the close, so
 *     the last bucket (15:55-16:00, settled at 16:01:30) has the 16:02 run and
 *     a second attempt at 16:07.
 *
 * Total API calls per invocation: 2
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
  closedBuckets,
  isDegenerate,
  isFeedStalled,
} from '../_lib/closed-buckets.js';
import {
  sessionRowCounts,
  upsertClosedBuckets,
} from '../_lib/flow-bucket-store.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

const TICKERS: Array<{ ticker: string; source: string }> = [
  { ticker: 'SPY', source: 'spy_etf_tide' },
  { ticker: 'QQQ', source: 'qqq_etf_tide' },
];

// ── Types ───────────────────────────────────────────────────

interface EtfTideRow {
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
  timestamp: string;
}

interface LegResult {
  /** Rows written: inserted + updated. */
  stored: number;
  inserted: number;
  /** Existing rows whose values UW revised. */
  updated: number;
  /** Existing rows that already held these values. */
  skipped: number;
  /** Closed buckets this run tried to store. */
  candles: number;
  /** Closed buckets left out, last minute unusable, ended under 10 min ago. */
  pending: number;
  /** The same, ended 10 min ago or more. */
  stuck: number;
  /** Set when nothing was attempted. */
  reason?: 'no_rows_today' | 'degenerate';
}

const NOTHING_STORED = {
  stored: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  candles: 0,
  pending: 0,
  stuck: 0,
} satisfies LegResult;

// ── Fetch helper ────────────────────────────────────────────

async function fetchEtfTide(
  apiKey: string,
  ticker: string,
): Promise<EtfTideRow[]> {
  // Omit ?date= for current-day fetches — the UW API returns zeros
  // when ?date= is the current trading day. Without the param, it
  // returns the session's per-minute cumulative grid (future minutes null).
  // The backfill script passes ?date= for historical dates where it works
  // correctly.
  return uwFetch<EtfTideRow>(apiKey, `/market/${ticker}/etf-tide`);
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-etf-tide',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    // One clock read, before any fetch: a bucket counts as closed only if it
    // had already closed when UW answered (R-closed).
    const now = new Date(startTimeMs);
    const results: Record<string, LegResult> = {};
    /** Legs where UW sent no row for today at or after 09:40 ET. */
    const stalled: string[] = [];
    /** Legs with a closed bucket stuck without a usable last minute. */
    const stuckBySource: Record<
      string,
      { stuck: number; oldest: string | null }
    > = {};

    // Count per-ticker failures so the handler can demote its status when
    // some (partial) or all (error) tickers fail. Without this the cron
    // returned `success` unconditionally — a full UW outage looked like a
    // healthy zero-row run and the Sentry monitor stayed green (BE-CRON-H4).
    let failureCount = 0;

    await Promise.all(
      TICKERS.map(async ({ ticker, source }) => {
        try {
          const rows = await withRetry(() => fetchEtfTide(apiKey, ticker));
          const result = closedBuckets(rows, now);

          // R-day: UW sent nothing for today's session. Normal at the 09:27
          // run (it still serves the previous session), so a skip.
          if (result.sessionRows === 0) {
            logger.warn(
              { ticker, source, payloadRows: rows.length, today },
              'fetch-etf-tide: no rows for today in the UW payload — nothing stored',
            );
            metrics.increment('fetch_etf_tide.no_rows_today');
            if (isFeedStalled(result.sessionRows, now)) stalled.push(source);
            results[source] = { ...NOTHING_STORED, reason: 'no_rows_today' };
            return;
          }

          // Only a closed bucket stuck without a usable last minute is a bad
          // candle. Future minutes are expected to be null, and a bucket UW
          // is only a few minutes late with is pending: neither is counted.
          for (let i = 0; i < result.stuck; i++) {
            metrics.increment('fetch_etf_tide.invalid_candle');
          }
          if (result.stuck > 0) {
            stuckBySource[source] = {
              stuck: result.stuck,
              oldest: result.oldestStuck,
            };
          }

          if (isDegenerate(result)) {
            logger.warn(
              {
                source,
                buckets: result.buckets.length,
                stuck: result.stuck,
                date: today,
              },
              'fetch-etf-tide: rejecting all-zero/unusable snapshot',
            );
            Sentry.captureMessage(
              'fetch-etf-tide: rejected all-zero/unusable ETF tide snapshot',
              {
                level: 'error',
                tags: { cron: 'fetch-etf-tide', stage: 'degenerate_snapshot' },
                extra: {
                  source,
                  buckets: result.buckets.length,
                  stuck: result.stuck,
                  date: today,
                },
              },
            );
            results[source] = {
              ...NOTHING_STORED,
              candles: result.buckets.length,
              pending: result.pending,
              stuck: result.stuck,
              reason: 'degenerate',
            };
            return;
          }

          const counts = await upsertClosedBuckets(
            result.buckets,
            source,
            today,
          );
          results[source] = {
            stored: counts.inserted + counts.updated,
            inserted: counts.inserted,
            updated: counts.updated,
            skipped: counts.unchanged,
            candles: result.buckets.length,
            pending: result.pending,
            stuck: result.stuck,
          };
        } catch (err) {
          failureCount += 1;
          // Covers the UW fetch AND the flow_data write: either failing
          // leaves the leg without fresh rows.
          logger.warn({ err, ticker, source }, 'Failed to fetch ETF Tide');
          metrics.increment('fetch_etf_tide.fetch_error');
          Sentry.captureException(err);
          results[source] = { ...NOTHING_STORED };
        }
      }),
    );

    // A feed with nothing for today at 09:40 ET or later has stalled: say so
    // once per run, naming the legs.
    if (stalled.length > 0) {
      Sentry.captureMessage(
        "fetch-etf-tide: no rows for today's session in the UW payload (09:40 ET or later)",
        {
          level: 'warning',
          tags: { cron: 'fetch-etf-tide', stage: 'feed_stalled' },
          extra: { sources: stalled, date: today },
        },
      );
    }
    // Closed buckets stuck without a usable last minute: once per run, naming
    // the oldest of each leg.
    if (Object.keys(stuckBySource).length > 0) {
      Sentry.captureMessage(
        'fetch-etf-tide: closed bucket(s) stuck without a usable last minute',
        {
          level: 'warning',
          tags: { cron: 'fetch-etf-tide', stage: 'stuck_bucket' },
          extra: { bySource: stuckBySource, date: today },
        },
      );
    }

    // Data quality check: alert if all of today's session rows are zero. It
    // runs whenever this run wrote a row (inserted or updated) and
    // checkDataQuality decides on the row count. Counts only rows stamped on
    // today's session (R-quality): rows with `date = today` can also hold an
    // earlier session's values, which would hide a dead day.
    for (const [source, r] of Object.entries(results)) {
      if (r.stored > 0) {
        const { total, nonzero } = await sessionRowCounts(today, source);
        await checkDataQuality({
          job: 'fetch-etf-tide',
          table: 'flow_data',
          date: today,
          sourceFilter: source,
          total,
          nonzero,
        });
      }
    }

    // Status demotion via the shared helper: all tickers failed → 'error',
    // some failed → 'partial', none → 'success'. totalLegs is derived from
    // the ticker list so adding a ticker can never make 'error' unreachable.
    const derived = deriveCronStatus(failureCount, TICKERS.length);
    const allWithoutRows = Object.values(results).every(
      (r) => r.reason === 'no_rows_today',
    );
    // A clean run that had no rows for today is a skip, not a success.
    const status =
      derived === 'success' && allWithoutRows ? 'skipped' : derived;

    logger.info({ results, failureCount, status }, 'fetch-etf-tide completed');

    return {
      status,
      ...(status === 'skipped'
        ? { message: 'No rows for today in the UW payload' }
        : {}),
      metadata: { results, failureCount },
    };
  },
  // Until 10 minutes after the close (the default is 5): the last bucket
  // (15:55-16:00) settles at 16:01:30, so it has the 16:02 run and a second
  // attempt at 16:07 (13:02 and 13:07 on an early-close day).
  { timeCheck: () => isMarketHours(10) },
);
