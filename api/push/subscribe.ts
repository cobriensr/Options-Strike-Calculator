/**
 * POST /api/push/subscribe
 *
 * Records (or refreshes) a Web Push subscription. Owner-only — guests
 * can't receive pushes. The browser-supplied `endpoint` is the dedupe
 * key: re-subscribing from the same device UPSERTs over the existing
 * row, preserving `created_at`.
 *
 * Body shape mirrors `PushSubscription.toJSON()` so the client can pass
 * the object straight through.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { pushSubscribeSchema } from '../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/push/subscribe');
    const done = metrics.request('/api/push/subscribe');

    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      if (await guardOwnerEndpoint(req, res, done)) return;

      const parsed = pushSubscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Invalid request body',
          issues: parsed.error.issues,
        });
      }
      const { endpoint, keys, user_agent } = parsed.data;

      const sql = getDb();
      await sql`
        INSERT INTO push_subscriptions
          (endpoint, p256dh_key, auth_key, user_agent)
        VALUES
          (${endpoint}, ${keys.p256dh}, ${keys.auth}, ${user_agent ?? null})
        ON CONFLICT (endpoint) DO UPDATE
          SET p256dh_key = EXCLUDED.p256dh_key,
              auth_key = EXCLUDED.auth_key,
              user_agent = EXCLUDED.user_agent
      `;

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ subscribed: true });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'push subscribe error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
