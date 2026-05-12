/**
 * POST /api/push/unsubscribe
 *
 * Removes a Web Push subscription by endpoint. Owner-only. Idempotent —
 * returns 200 even if the endpoint wasn't on file (matches the browser's
 * own `pushManager.getSubscription().unsubscribe()` semantics).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { pushUnsubscribeSchema } from '../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/push/unsubscribe');
    const done = metrics.request('/api/push/unsubscribe');

    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      if (await guardOwnerEndpoint(req, res, done)) return;

      const parsed = pushUnsubscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Invalid request body',
          issues: parsed.error.issues,
        });
      }
      const { endpoint } = parsed.data;

      const sql = getDb();
      await sql`
        DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}
      `;

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ unsubscribed: true });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'push unsubscribe error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
