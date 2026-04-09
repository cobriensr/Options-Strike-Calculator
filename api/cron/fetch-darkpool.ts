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
 *   4. UPSERT into dark_pool_levels — adds to existing premium totals
 *
 * First run of the day has no cursor → paginates through the full tape.
 * Subsequent runs pass `newer_than` → usually 1 page of new trades.
 *
 * Total API calls per invocation: 1 (incremental) or ~50 (first run)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { metrics, Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, withRetry } from '../_lib/api-helpers.js';
import {
  fetchAllDarkPoolTrades,
  aggregateDarkPoolLevels,
} from '../_lib/darkpool.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
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

    const trades = await withRetry(() =>
      fetchAllDarkPoolTrades(apiKey, today, { newerThan: cursorTs }),
    );

    if (trades.length === 0) {
      logger.info({ cursor: cursorTs }, 'fetch-darkpool: no new trades');
      return res.status(200).json({
        job: 'fetch-darkpool',
        skipped: true,
        reason: 'no new trades',
        cursor: cursorTs,
      });
    }

    const levels = aggregateDarkPoolLevels(trades);

    const now = new Date().toISOString();

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

    logger.info(
      {
        levels: levels.length,
        trades: trades.length,
        incremental: cursorTs != null,
      },
      'fetch-darkpool: upserted levels',
    );

    return res.status(200).json({
      job: 'fetch-darkpool',
      levels: levels.length,
      trades: trades.length,
      incremental: cursorTs != null,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-darkpool');
    Sentry.captureException(err);
    metrics.increment('fetch_darkpool.batch_insert_error');
    logger.error({ err }, 'fetch-darkpool error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
