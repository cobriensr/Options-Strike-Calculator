/**
 * GET /api/auth/init
 *
 * Redirects to Schwab's OAuth login page.
 * After login, Schwab redirects back to /api/auth/callback
 * with an authorization code.
 *
 * Only needs to be called once every 7 days when the refresh token expires.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuthUrl } from './schwab';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const host = req.headers.host || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;

  const authUrl = getAuthUrl(redirectUri);
  if (!authUrl) {
    return res.status(500).json({
      error: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
    });
  }

  res.redirect(302, authUrl);
}
