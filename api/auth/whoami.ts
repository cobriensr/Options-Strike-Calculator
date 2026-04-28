/**
 * GET /api/auth/whoami
 *
 * Server's source-of-truth view of the current session, used by the
 * frontend's fetch interceptor to confirm a 401 storm is real before
 * wiping the JS-visible hint cookies and bouncing the user to public
 * mode. See `src/utils/authInterceptor.ts` for the consumer side.
 *
 * Always returns 200 with `{ mode: 'owner' | 'guest' | 'public' }` so
 * the response itself doesn't re-trigger the interceptor's 401 path.
 *
 * Owner wins over guest — matches `getAccessMode()` precedence.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import { isOwner } from '../_lib/api-helpers.js';
import { isGuest } from '../_lib/guest-auth.js';

export type WhoamiMode = 'owner' | 'guest' | 'public';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/whoami');
    const done = metrics.request('/api/auth/whoami');
    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      let mode: WhoamiMode = 'public';
      if (isOwner(req)) mode = 'owner';
      else if (isGuest(req)) mode = 'guest';

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ mode });
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
