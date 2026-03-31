/**
 * GET /api/auth/callback?code=...
 *
 * Schwab redirects here after user login.
 * Exchanges the authorization code for access + refresh tokens,
 * stores them in Upstash Redis, and sets the owner session cookie.
 *
 * The owner cookie is what gates the data endpoints — public visitors
 * don't have it and get a 401 (frontend silently falls back to manual input).
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeInitialTokens, redis } from '../_lib/schwab.js';
import { OWNER_COOKIE, OWNER_COOKIE_MAX_AGE } from '../_lib/api-helpers.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/callback');
    const done = metrics.request('/api/auth/callback');
    try {
      const code = req.query.code;
      if (!code || typeof code !== 'string') {
        done({ status: 400 });
        return res.status(400).json({ error: 'Missing authorization code' });
      }

      const ownerSecret = process.env.OWNER_SECRET;
      if (!ownerSecret) {
        done({ status: 500 });
        return res
          .status(500)
          .json({ error: 'OWNER_SECRET environment variable must be set' });
      }

      const state = req.query.state;
      if (!state || typeof state !== 'string') {
        done({ status: 400 });
        return res.status(400).json({ error: 'Missing state parameter' });
      }

      const validState = await redis.get(`oauth:state:${state}`);
      if (!validState) {
        done({ status: 400 });
        return res
          .status(400)
          .json({ error: 'Invalid or expired state parameter' });
      }
      await redis.del(`oauth:state:${state}`);

      const appUrl = process.env.APP_URL;
      if (!appUrl) {
        done({ status: 500 });
        return res.status(500).json({ error: 'APP_URL not configured' });
      }
      const redirectUri = `${appUrl}/api/auth/callback`;

      const result = await storeInitialTokens(code, redirectUri);

      if ('error' in result) {
        done({ status: 500 });
        return res.status(500).json({ error: result.error.message });
      }

      // Set the owner session cookie — this is what gates the data endpoints.
      // HttpOnly:    can't be read by JavaScript (XSS safe)
      // Secure:      only sent over HTTPS
      // SameSite=Strict: not sent on cross-site requests (CSRF safe)
      // Path=/:      available to all endpoints
      // Max-Age=7d:  matches Schwab refresh token lifetime
      const isLocal = appUrl.includes('localhost');
      const cookieParts = [
        `${OWNER_COOKIE}=${ownerSecret}`,
        `Path=/`,
        `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
        'HttpOnly',
        'SameSite=Strict',
      ];
      if (!isLocal) cookieParts.push('Secure');

      // Non-HttpOnly hint cookie so the frontend can detect the owner session
      // on page load (the real sc-owner cookie is HttpOnly and invisible to JS).
      const hintParts = [
        `sc-hint=1`,
        `Path=/`,
        `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
        'SameSite=Strict',
      ];
      if (!isLocal) hintParts.push('Secure');

      res.setHeader('Set-Cookie', [
        cookieParts.join('; '),
        hintParts.join('; '),
      ]);

      // Show success confirmation, then auto-redirect after 3 seconds.
      // The cookie is already set via Set-Cookie header above.
      done({ status: 200 });
      res.setHeader('Content-Type', 'text/html');
      res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Auth Complete</title>
      <meta http-equiv="refresh" content="3;url=${appUrl}" />
    </head>
    <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
      <div style="text-align: center;">
        <h1 style="color: #22c55e;">&#x2713; Authenticated</h1>
        <p>Schwab tokens stored. Session valid for 7 days.</p>
        <p>Redirecting to calculator in 3 seconds&hellip;</p>
        <p style="color: #888; font-size: 14px;"><a href="${appUrl}" style="color: #60a5fa;">Click here</a> if not redirected.</p>
      </div>
    </body>
    </html>
  `);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
