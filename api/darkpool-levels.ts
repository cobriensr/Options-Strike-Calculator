/**
 * GET /api/darkpool-levels
 *
 * Returns today's dark pool cluster levels sorted by aggregate premium.
 * Data is stored by the fetch-darkpool cron every 5 minutes.
 * The frontend polls this every 60 seconds — no Claude involved.
 *
 * Owner-gated — dark pool data derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/darkpool-levels');

    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
      }

      if (rejectIfNotOwner(req, res)) return;

      const sql = getDb();

      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });

      const rows = await sql`
        SELECT spx_approx, spy_price_low, spy_price_high,
               total_premium, trade_count, total_shares,
               buyer_initiated, seller_initiated, neutral,
               latest_time, updated_at
        FROM dark_pool_levels
        WHERE date = ${today}
        ORDER BY total_premium DESC
      `;

      const levels = rows.map((r) => ({
        spxApprox: Number(r.spx_approx),
        spyPriceLow: Number(r.spy_price_low),
        spyPriceHigh: Number(r.spy_price_high),
        totalPremium: Number(r.total_premium),
        tradeCount: Number(r.trade_count),
        totalShares: Number(r.total_shares),
        buyerInitiated: Number(r.buyer_initiated),
        sellerInitiated: Number(r.seller_initiated),
        neutral: Number(r.neutral),
        latestTime: r.latest_time,
        updatedAt: r.updated_at,
        direction:
          Number(r.buyer_initiated) > Number(r.seller_initiated)
            ? 'BUY'
            : Number(r.seller_initiated) > Number(r.buyer_initiated)
              ? 'SELL'
              : 'MIXED',
      }));

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ levels, date: today });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'darkpool-levels fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
