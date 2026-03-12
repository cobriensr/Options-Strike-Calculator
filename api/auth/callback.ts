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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeInitialTokens } from './schwab';
import { OWNER_COOKIE, OWNER_COOKIE_MAX_AGE } from './api-helpers';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  const ownerSecret = process.env.OWNER_SECRET;
  if (!ownerSecret) {
    return res
      .status(500)
      .json({ error: 'OWNER_SECRET environment variable must be set' });
  }

  const host = req.headers.host || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/callback`;

  const result = await storeInitialTokens(code, redirectUri);

  if ('error' in result) {
    return res.status(500).json({ error: result.error.message });
  }

  // Set the owner session cookie — this is what gates the data endpoints.
  // HttpOnly:    can't be read by JavaScript (XSS safe)
  // Secure:      only sent over HTTPS
  // SameSite=Strict: not sent on cross-site requests (CSRF safe)
  // Path=/:      available to all endpoints
  // Max-Age=7d:  matches Schwab refresh token lifetime
  const isLocal = host.includes('localhost');
  const cookieParts = [
    `${OWNER_COOKIE}=${ownerSecret}`,
    `Path=/`,
    `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (!isLocal) cookieParts.push('Secure');

  res.setHeader('Set-Cookie', cookieParts.join('; '));

  // Return a simple success page
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head><title>Auth Complete</title></head>
    <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
      <div style="text-align: center;">
        <h1 style="color: #22c55e;">&#x2713; Authenticated</h1>
        <p>Schwab tokens stored. Session valid for 7 days.</p>
        <p>Live data will auto-populate in the calculator.</p>
        <p style="color: #888; font-size: 14px;">You can close this tab and return to the calculator.</p>
      </div>
    </body>
    </html>
  `);
}
