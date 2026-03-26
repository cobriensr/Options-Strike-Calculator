/**
 * GET /api/auth/init
 *
 * Redirects to Schwab's OAuth login page.
 * After login, Schwab redirects back to /api/auth/callback
 * with an authorization code.
 *
 * Only needs to be called once every 7 days when the refresh token expires.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuthUrl } from '../_lib/schwab.js';
import { rejectIfRateLimited } from '../_lib/api-helpers.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/init');
    const done = metrics.request('/api/auth/init');
    try {
      const rateLimited = await rejectIfRateLimited(req, res, 'auth-init', 5);
      if (rateLimited) {
        done({ status: 429 });
        return;
      }

      const host = req.headers.host || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const redirectUri = `${protocol}://${host}/api/auth/callback`;

      const authResult = await getAuthUrl(redirectUri);
      if (!authResult) {
        done({ status: 500 });
        return res.status(500).json({
          error: 'Schwab OAuth credentials not configured',
        });
      }

      done({ status: 302 });
      res.redirect(302, authResult.url);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
