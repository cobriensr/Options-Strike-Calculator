/**
 * GET /api/auth/init
 *
 * Sign-in entry point (the SPA's "Sign in" link targets this path).
 *
 * - Schwab configured (`SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET` set):
 *   redirects to Schwab's OAuth login page. After login, Schwab redirects
 *   back to /api/auth/callback with an authorization code. Only needs to be
 *   repeated when the 7-day refresh token expires.
 * - Schwab NOT configured: Schwab is optional (positions + NYSE breadth
 *   internals only — the UW + Theta facade serves everything else), so
 *   this is not an error. Redirects 302 to the Schwab-free owner login form
 *   at /api/auth/login before touching Redis or building an auth URL.
 *
 * Genuine failures (APP_URL missing when Schwab IS configured, getAuthUrl
 * returning null, unhandled throws) still 500.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuthUrl, isSchwabConfigured } from '../_lib/schwab.js';
import { rejectIfRateLimited } from '../_lib/api-helpers.js';

const OWNER_LOGIN_PATH = '/api/auth/login';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/init');
    const done = metrics.request('/api/auth/init');
    try {
      // Unconfigured != broken. Route to the owner login form before the
      // Redis-backed rate limiter or getAuthUrl (which writes an OAuth state
      // nonce to Redis) so the unconfigured path costs no KV round trips.
      if (!isSchwabConfigured()) {
        done({ status: 302 });
        return res.redirect(302, OWNER_LOGIN_PATH);
      }

      const rateLimited = await rejectIfRateLimited(req, res, 'auth-init', 5);
      if (rateLimited) {
        done({ status: 429 });
        return;
      }

      const appUrl = process.env.APP_URL;
      if (!appUrl) {
        done({ status: 500 });
        return res.status(500).json({ error: 'APP_URL not configured' });
      }
      const redirectUri = `${appUrl}/api/auth/callback`;

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
