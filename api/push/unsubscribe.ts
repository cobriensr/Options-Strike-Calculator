/**
 * POST /api/push/unsubscribe
 *
 * Removes a browser push subscription by `endpoint`. Idempotent — a
 * missing row returns `{ ok: true }` because the browser's
 * `PushSubscription.unsubscribe()` has already cleared local state and
 * the client can't distinguish "server already dropped it" from "server
 * just dropped it now". Re-erroring would leave the UI stuck.
 *
 * Owner-gated + botid-protected. No cache headers (mutating endpoint).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { PushUnsubscribeBodySchema } from '../_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/push/unsubscribe');
    const done = metrics.request('/api/push/unsubscribe');

    if (req.method !== 'POST') {
      done({ status: 405 });
      return res.status(405).json({ error: 'POST only' });
    }

    if (await guardOwnerEndpoint(req, res, done)) return;

    const parsed = PushUnsubscribeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const { endpoint } = parsed.data;

    try {
      const sql = getDb();
      await sql`
        DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}
      `;

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ ok: true });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'push/unsubscribe error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
