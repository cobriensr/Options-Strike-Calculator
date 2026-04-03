/**
 * GET /api/cron/fetch-darkpool
 *
 * 5-minute cron that fetches SPY dark pool block trades from Unusual Whales,
 * aggregates premium by $1 SPX strike level, and stores in dark_pool_levels.
 *
 * Each run replaces the current day's data — the UW endpoint returns all
 * trades for the date, so we're always getting the full picture.
 *
 * Total API calls per invocation: 1 (darkpool/SPY)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, withRetry } from '../_lib/api-helpers.js';
import {
  fetchDarkPoolBlocks,
  aggregateDarkPoolLevels,
} from '../_lib/darkpool.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const trades = await withRetry(() => fetchDarkPoolBlocks(apiKey));

    if (trades.length === 0) {
      logger.info('fetch-darkpool: no trades returned');
      return res.status(200).json({
        job: 'fetch-darkpool',
        skipped: true,
        reason: 'no trades',
      });
    }

    const levels = aggregateDarkPoolLevels(trades);

    if (levels.length === 0) {
      return res.status(200).json({
        job: 'fetch-darkpool',
        skipped: true,
        reason: 'no levels',
      });
    }

    const sql = getDb();

    // Replace today's data — full snapshot each run
    await sql`DELETE FROM dark_pool_levels WHERE date = ${today}`;

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
      `;
    }

    logger.info(
      { levels: levels.length, trades: trades.length },
      'fetch-darkpool: stored levels',
    );

    return res.status(200).json({
      job: 'fetch-darkpool',
      levels: levels.length,
      trades: trades.length,
      topPremium: levels[0]?.totalPremium ?? 0,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-darkpool');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-darkpool error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
