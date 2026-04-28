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
 * Owner-or-guest — dark pool data derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/darkpool-levels');
    const done = metrics.request('/api/darkpool-levels');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const sql = getDb();

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/New_York',
            });

      // Optional time filter: "HH:MM" in CT → only show levels with trades by that time
      const timeParam = req.query.time as string | undefined;
      const hasTime = timeParam && /^\d{2}:\d{2}$/.test(timeParam);

      // Include MAX(updated_at) as a window column so the client can
      // show a "last updated" timestamp that reflects the cron's actual
      // last successful write, not the highest-premium row's updated_at.
      // The latter can freeze for hours when a big anchor level gets
      // its only prints early and never receives more, even though the
      // cron is still happily writing lower-ranked levels every minute.
      const rows = hasTime
        ? await sql`
            SELECT spx_approx, total_premium, trade_count, total_shares,
                   latest_time, updated_at,
                   MAX(updated_at) OVER () AS max_updated_at
            FROM dark_pool_levels
            WHERE date = ${date}
              AND latest_time <= (${`${date} ${timeParam}:00`}::timestamp AT TIME ZONE 'America/Chicago')
            ORDER BY total_premium DESC
          `
        : await sql`
            SELECT spx_approx, total_premium, trade_count, total_shares,
                   latest_time, updated_at,
                   MAX(updated_at) OVER () AS max_updated_at
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

      const lastUpdated = rows[0]?.max_updated_at ?? null;

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ levels, date, meta: { lastUpdated } });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'darkpool-levels fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
