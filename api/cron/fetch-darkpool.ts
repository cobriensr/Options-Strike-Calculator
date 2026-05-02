/**
 * GET /api/cron/fetch-darkpool
 *
 * 1-minute cron that incrementally fetches SPY dark pool trades from
 * Unusual Whales and UPSERTs aggregated premium by $1 SPX strike level.
 *
 * Incremental strategy:
 *   1. Read the newest trade timestamp from dark_pool_levels for today
 *   2. Fetch only trades newer than that cursor (typically 1 API call)
 *   3. Aggregate new trades by SPX level
 *   4. UPSERT into dark_pool_levels - adds to existing premium totals
 *
 * First run of the day has no cursor -> paginates through the full tape.
 * Subsequent runs pass `newer_than` -> usually 1 page of new trades.
 *
 * Total API calls per invocation: 1 (incremental) or ~50 (first run)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { metrics } from '../_lib/sentry.js';
import { cronJitter, withRetry } from '../_lib/api-helpers.js';
import {
  fetchAllDarkPoolTrades,
  aggregateDarkPoolLevels,
} from '../_lib/darkpool.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// Sentinel: signals "UW returned an error outcome - render 502 with
// the legacy { job, error: 'UW API error', reason } body". Distinct
// from a thrown DB / network error which the wrapper renders as a 500.
class UwApiError extends Error {
  constructor(public readonly reason: string) {
    super('UW API error');
    this.name = 'UwApiError';
  }
}

export default withCronInstrumentation(
  'fetch-darkpool',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger: log } = ctx;

    await cronJitter();

    const sql = getDb();

    // Read the cursor: newest trade timestamp we've already processed
    const cursorRows = await sql`
      SELECT EXTRACT(EPOCH FROM MAX(latest_time))::bigint AS cursor_ts
      FROM dark_pool_levels
      WHERE date = ${today}
    `;
    const cursorTs =
      cursorRows[0]?.cursor_ts != null
        ? Number(cursorRows[0].cursor_ts)
        : undefined;

    const outcome = await withRetry(() =>
      fetchAllDarkPoolTrades(apiKey, today, { newerThan: cursorTs }),
    );

    if (outcome.kind === 'error') {
      // Surface the API error as a failed cron run so we see it in the
      // dashboard - but route through the wrapper's errorPayload so the
      // legacy 502 body shape is preserved verbatim.
      log.error(
        { reason: outcome.reason, cursor: cursorTs },
        'fetch-darkpool: UW API error',
      );
      throw new UwApiError(outcome.reason);
    }

    if (outcome.kind === 'empty') {
      log.info({ cursor: cursorTs }, 'fetch-darkpool: no new trades');
      return {
        status: 'skipped',
        message: 'no new trades',
        metadata: {
          skipped: true,
          reason: 'no new trades',
          cursor: cursorTs,
          incremental: cursorTs != null,
        },
      };
    }

    const trades = outcome.data;
    const levels = aggregateDarkPoolLevels(trades);

    const now = new Date().toISOString();

    try {
      for (const l of levels) {
        await sql`
          INSERT INTO dark_pool_levels (
            date, spx_approx, total_premium, trade_count, total_shares,
            latest_time, updated_at
          ) VALUES (
            ${today}, ${l.spxLevel}, ${l.totalPremium},
            ${l.tradeCount}, ${l.totalShares},
            ${l.latestTime || null}, ${now}
          )
          ON CONFLICT (date, spx_approx) DO UPDATE SET
            total_premium = dark_pool_levels.total_premium + EXCLUDED.total_premium,
            trade_count   = dark_pool_levels.trade_count + EXCLUDED.trade_count,
            total_shares  = dark_pool_levels.total_shares + EXCLUDED.total_shares,
            latest_time   = GREATEST(dark_pool_levels.latest_time, EXCLUDED.latest_time),
            updated_at    = EXCLUDED.updated_at
        `;
      }
    } catch (err) {
      // Preserve the legacy `fetch_darkpool.batch_insert_error` metric
      // so dashboards keyed on DB-write failures (vs UW-API failures)
      // stay distinct. The wrapper will catch + 500 + captureException
      // after this rethrow.
      metrics.increment('fetch_darkpool.batch_insert_error');
      throw err;
    }

    log.info(
      {
        levels: levels.length,
        trades: trades.length,
        incremental: cursorTs != null,
      },
      'fetch-darkpool: upserted levels',
    );

    return {
      status: 'success',
      metadata: {
        levels: levels.length,
        trades: trades.length,
        incremental: cursorTs != null,
      },
    };
  },
  {
    // UW API errors are routed to 502 with the legacy
    // { job, error: 'UW API error', reason } body. Everything else
    // (DB writes, etc.) keeps the default 500 + 'Internal error'.
    errorStatus: (err) => (err instanceof UwApiError ? 502 : 500),
    errorPayload: (err) =>
      err instanceof UwApiError
        ? {
            job: 'fetch-darkpool',
            error: 'UW API error',
            reason: err.reason,
          }
        : {},
  },
);
