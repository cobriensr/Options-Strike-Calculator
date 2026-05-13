/**
 * POST /api/interval-ba-alerts-ack
 *
 * Acknowledges an SPXW Interval B/A alert by ID. Stops the repeating
 * chime + clears the in-app banner for that alert.
 *
 * Owner-or-guest — guests with a valid GUEST_ACCESS_KEYS entry can also
 * dismiss alerts. Matches the GET /api/interval-ba-alerts auth tier
 * (both use guardOwnerOrGuestEndpoint) so dismissal isn't blocked by
 * an empty OWNER_SECRET env (which would silently 401 the POST and
 * make dismissed alerts reappear on refresh — verified 2026-05-13).
 *
 * Body: { id: number }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { alertAckSchema } from './_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/interval-ba-alerts-ack');
    const done = metrics.request('/api/interval-ba-alerts-ack');

    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const parsed = alertAckSchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Invalid request body',
          issues: parsed.error.issues,
        });
      }
      const { id } = parsed.data;

      const sql = getDb();
      const result = await sql`
        UPDATE interval_ba_alerts
        SET acknowledged = TRUE
        WHERE id = ${id}
        RETURNING id
      `;

      if (result.length === 0) {
        done({ status: 404 });
        return res.status(404).json({ error: 'Alert not found' });
      }

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ acknowledged: id });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'interval-ba-alerts-ack error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
