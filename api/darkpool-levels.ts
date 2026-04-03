/**
 * GET /api/darkpool-levels
 *
 * Returns dark pool strike levels sorted by aggregate premium.
 * Data is stored by the fetch-darkpool cron every 5 minutes.
 * The frontend polls this every 60 seconds — no Claude involved.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  — return levels for a specific date
 *   (default: today in ET)
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

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/New_York',
            });

      const rows = await sql`
        SELECT spx_approx, total_premium, trade_count, total_shares,
               latest_time, updated_at
        FROM dark_pool_levels
        WHERE date = ${date}
        ORDER BY total_premium DESC
      `;

      const levels = rows.map((r) => ({
        spxLevel: Number(r.spx_approx),
        totalPremium: Number(r.total_premium),
        tradeCount: Number(r.trade_count),
        totalShares: Number(r.total_shares),
        latestTime: r.latest_time,
        updatedAt: r.updated_at,
      }));

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ levels, date });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'darkpool-levels fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
