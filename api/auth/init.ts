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

export default function handler(req: VercelRequest, res: VercelResponse) {
  Sentry.withIsolationScope((scope) => {
    scope.setTransactionName('GET /api/auth/init');
    const done = metrics.request('/api/auth/init');
    try {
      const host = req.headers.host || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const redirectUri = `${protocol}://${host}/api/auth/callback`;

      const authUrl = getAuthUrl(redirectUri);
      if (!authUrl) {
        done({ status: 500 });
        return res.status(500).json({
          error: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
        });
      }

      done({ status: 302 });
      res.redirect(302, authUrl);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
