/**
 * POST /api/push/notify
 *
 * Fans out a Web Push payload to every device the owner has subscribed.
 * Internal-only — gated by a shared `INTERNAL_NOTIFY_SECRET` token sent
 * via the `x-internal-notify-secret` header. uw-stream's
 * SPXWIntervalBAHandler calls this post-flush; no other caller should.
 *
 * The secret is compared with the shared `secretEquals` (constant-time over
 * fixed-length digests, so not even the secret's length leaks via timing).
 *
 * NOT in the botid `protect` array on src/main.tsx — that surface is
 * for bot/JS-challenge protection on client-facing routes, and this is
 * server-to-server.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPushToOwner } from '../_lib/push.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
// Direct import: the dependency-free module (see secret-compare.ts).
import { secretEquals } from '../_lib/secret-compare.js';
import { pushNotifySchema } from '../_lib/validation.js';

const SECRET_HEADER = 'x-internal-notify-secret';

function verifySecret(req: VercelRequest): boolean {
  const expected = process.env.INTERNAL_NOTIFY_SECRET;
  if (!expected) return false;
  const headerValue = req.headers[SECRET_HEADER];
  const got = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return secretEquals(got, expected);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/push/notify');
    const done = metrics.request('/api/push/notify');

    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      if (!verifySecret(req)) {
        done({ status: 401 });
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const parsed = pushNotifySchema.safeParse(req.body);
      if (!parsed.success) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Invalid request body',
          issues: parsed.error.issues,
        });
      }

      const result = await sendPushToOwner(parsed.data);

      logger.info({ ...result }, 'push fan-out complete');
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json(result);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'push notify error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
