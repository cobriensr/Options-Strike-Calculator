/**
 * POST /api/auth/guest-logout
 *
 * Clears the sc-guest + sc-guest-hint cookies. The owner Schwab session
 * (sc-owner cookie) is unaffected — signing out as guest leaves the
 * owner session intact for any user that happens to have both.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import { buildGuestClearCookies } from '../_lib/guest-auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/auth/guest-logout');
    const done = metrics.request('/api/auth/guest-logout');
    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      const appUrl = process.env.APP_URL ?? '';
      const isLocal = appUrl.includes('localhost') || !process.env.VERCEL;
      res.setHeader('Set-Cookie', buildGuestClearCookies(isLocal));
      res.setHeader('Cache-Control', 'no-store');

      done({ status: 200 });
      return res.status(200).json({ ok: true });
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
