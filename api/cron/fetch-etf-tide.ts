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
 *   - UW answers with the whole session's per-minute grid, null for the
 *     minutes that have not happened yet, and before its roll-over
 *     (09:28-09:32 ET) with the PREVIOUS session. Storing either as data
 *     froze 78 zero rows (or yesterday's session) per day under DO NOTHING.
 *   - One row per 5-minute bucket, stored by the first run after the bucket
 *     closes (the cron runs every 5 minutes through 16:05 ET), carrying the
 *     value of the bucket's LAST minute. A bucket still open, or whose last
 *     minute has no value, waits for a later run. Nothing missing is stored
 *     as 0.
 *   - Only rows UW stamps on today's ET date at or after 09:30 ET. A payload
 *     with none (the pre-open answer) stores nothing; that is a skip, not an
 *     error.
 *   - Label rule (spec open question 1, default in force): a closed bucket is
 *     stored under its END time. The 09:30-09:35 bucket is stored at 09:35.
 *
 * Total API calls per invocation: 2
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { uwFetch, withRetry, checkDataQuality } from '../_lib/api-helpers.js';
import {
  closedBuckets,
  sessionWindowIso,
  type ClosedBucket,
} from '../_lib/closed-buckets.js';
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
  stored: number;
  skipped: number;
  /** Closed buckets this run tried to store. */
  candles: number;
  /** Closed buckets left out because their last minute had no usable value. */
  unusable: number;
  /** Set when UW sent no row for today's session (nothing was attempted). */
  reason?: 'no_rows_today';
}

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

// ── Store helper ────────────────────────────────────────────

async function storeAllCandles(
  candles: ClosedBucket[],
  source: string,
  date: string,
): Promise<{ stored: number; skipped: number }> {
  if (candles.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  // A rejected write throws to the per-ticker catch in the handler, which
  // counts it as a failed leg, logs it and captures it once. Swallowing it
  // here as "skipped" used to leave the run reporting `success` (R4).
  const results = await sql.transaction((txn) =>
    candles.map(
      (candle) => txn`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (${date}, ${candle.timestamp}, ${source}, ${candle.ncp}, ${candle.npp}, ${candle.netVolume})
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `,
    ),
  );

  let stored = 0;
  for (const result of results) {
    if (result.length > 0) stored++;
  }
  return { stored, skipped: candles.length - stored };
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

    // Count per-ticker failures so the handler can demote its status when
    // some (partial) or all (error) tickers fail. Without this the cron
    // returned `success` unconditionally — a full UW outage looked like a
    // healthy zero-row run and the Sentry monitor stayed green (BE-CRON-H4).
    let failureCount = 0;

    await Promise.all(
      TICKERS.map(async ({ ticker, source }) => {
        try {
          const rows = await withRetry(() => fetchEtfTide(apiKey, ticker));
          const { buckets, sessionRows, unusable } = closedBuckets(rows, now);

          // R-day: UW sent nothing for today's session. Normal at the 09:27
          // run (it still serves the previous session), so a skip.
          if (sessionRows === 0) {
            logger.warn(
              { ticker, source, payloadRows: rows.length, today },
              'fetch-etf-tide: no rows for today in the UW payload — nothing stored',
            );
            metrics.increment('fetch_etf_tide.no_rows_today');
            results[source] = {
              stored: 0,
              skipped: 0,
              candles: 0,
              unusable: 0,
              reason: 'no_rows_today',
            };
            return;
          }

          // Only a closed bucket whose last minute has no usable value is a
          // bad candle. Future minutes are expected to be null and are not
          // counted (they were 30,342 hits a day).
          for (let i = 0; i < unusable; i++) {
            metrics.increment('fetch_etf_tide.invalid_candle');
          }

          const result = await storeAllCandles(buckets, source, today);
          results[source] = { ...result, candles: buckets.length, unusable };
        } catch (err) {
          failureCount += 1;
          // Covers the UW fetch AND the flow_data write: either failing
          // leaves the leg without fresh rows.
          logger.warn({ err, ticker, source }, 'Failed to fetch ETF Tide');
          metrics.increment('fetch_etf_tide.fetch_error');
          Sentry.captureException(err);
          results[source] = { stored: 0, skipped: 0, candles: 0, unusable: 0 };
        }
      }),
    );

    // Data quality check: alert if all values are zero. Counts only today's
    // session rows (R-quality): rows with `date = today` can also hold an
    // earlier session's values, which would hide a dead day.
    for (const [source, r] of Object.entries(results)) {
      if (r.candles > 10 && r.stored === r.candles) {
        // All candles were new (no duplicates) — check the raw data
        // for all-zero values which indicate an upstream data issue
        const { openIso, closeIso } = sessionWindowIso(today);
        const rows = await getDb()`
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
          FROM flow_data
          WHERE date = ${today} AND source = ${source}
            AND timestamp >= ${openIso}::timestamptz
            AND timestamp <= ${closeIso}::timestamptz
        `;
        const { total, nonzero } = rows[0]!;
        await checkDataQuality({
          job: 'fetch-etf-tide',
          table: 'flow_data',
          date: today,
          sourceFilter: source,
          total: Number(total),
          nonzero: Number(nonzero),
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
);
