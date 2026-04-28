/**
 * GET /api/alerts
 *
 * Returns unacknowledged market alerts for today, or alerts since a
 * given timestamp. Polled by the frontend every 10 seconds during
 * market hours to drive browser push notifications.
 *
 * Owner-or-guest — alert data derives from UW flow data (OPRA compliance).
 *
 * Query params:
 *   ?since=ISO8601  — return alerts created after this timestamp
 *   (default: all unacknowledged alerts for today)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { getETDateStr } from '../src/utils/timezone.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/alerts');
    const done = metrics.request('/api/alerts');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const sql = getDb();
      const since = req.query.since as string | undefined;

      const today = getETDateStr(new Date());

      const alerts = since
        ? await sql`
            SELECT id, date, timestamp, type, severity, direction,
                   title, body, current_values, delta_values,
                   acknowledged, created_at
            FROM market_alerts
            WHERE created_at > ${since}
            ORDER BY created_at DESC
            LIMIT 20
          `
        : await sql`
            SELECT id, date, timestamp, type, severity, direction,
                   title, body, current_values, delta_values,
                   acknowledged, created_at
            FROM market_alerts
            WHERE date = ${today} AND NOT acknowledged
            ORDER BY created_at DESC
            LIMIT 20
          `;

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ alerts });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'alerts fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
