/**
 * GET/POST /api/auth/login
 *
 * Schwab-free owner login. Sets the same owner-session cookies the Schwab
 * OAuth callback used to set (`sc-owner` HttpOnly + `sc-hint`), but gated on
 * a single shared secret (`OWNER_SECRET`) instead of a Schwab token exchange.
 *
 * GET  — serves a minimal dark login form (no frontend router exists, so the
 *        form is served inline, mirroring how callback.ts serves its HTML).
 * POST — reads `secret` from the body (JSON or form-encoded; Vercel parses
 *        both into req.body), compares it to OWNER_SECRET with a length-guarded
 *        `timingSafeEqual`, and on a match sets the owner cookies. Returns
 *        200 {ok:true} for JSON callers or a 302 redirect to `/` for browser
 *        form submits so the page lands back in the app already logged in.
 *
 * On mismatch OR unset OWNER_SECRET the response is identical (401
 * {error:'Invalid access key'}, no cookie) so it never leaks whether the
 * secret was wrong versus unconfigured.
 */

import { timingSafeEqual } from 'node:crypto';

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { Sentry, metrics } from '../_lib/sentry.js';
import {
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  checkBot,
  rejectIfRateLimited,
} from '../_lib/auth-helpers.js';

const LOGIN_FORM_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Owner Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
  <form method="POST" action="/api/auth/login" style="display: flex; flex-direction: column; gap: 12px; width: 280px;">
    <h1 style="margin: 0 0 8px; font-size: 20px; font-weight: 600;">Owner Login</h1>
    <label for="secret" style="font-size: 13px; color: #a3a3a3;">Access key</label>
    <input id="secret" name="secret" type="password" autocomplete="current-password" autofocus
      style="padding: 10px 12px; border: 1px solid #333; border-radius: 6px; background: #171717; color: #e5e5e5; font-size: 14px;" />
    <button type="submit"
      style="padding: 10px 12px; border: none; border-radius: 6px; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;">
      Sign in
    </button>
  </form>
</body>
</html>
`;

/**
 * Length-guarded constant-time comparison, mirroring `isOwner` in
 * auth-helpers.ts. The length guard is required because `timingSafeEqual`
 * throws when the two buffers differ in length.
 */
function secretMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A JSON caller (fetch) gets a JSON body; a browser form submit gets a 302
 * back into the app. Content-Type is the primary signal; Accept breaks ties.
 */
function prefersJson(req: VercelRequest): boolean {
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) return true;
  const accept = String(req.headers['accept'] ?? '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName(`${req.method ?? 'GET'} /api/auth/login`);
    const done = metrics.request('/api/auth/login');
    try {
      if (req.method === 'GET') {
        done({ status: 200 });
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(LOGIN_FORM_HTML);
      }

      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'Method not allowed' });
      }

      // Bot protection first (mirrors other POST endpoints). Owner sessions
      // short-circuit checkBot internally; anonymous traffic gets challenged.
      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return res.status(403).json({ error: 'Access denied' });
      }

      // Brute-force guard: 5 attempts/minute per IP, same limiter the Schwab
      // callback + guest-key endpoints use. Fails open if Redis is down.
      const rateLimited = await rejectIfRateLimited(req, res, 'auth-login', 5);
      if (rateLimited) {
        done({ status: 429 });
        return;
      }

      const secret = process.env.OWNER_SECRET;
      const provided =
        typeof req.body?.secret === 'string' ? req.body.secret : '';

      // Identical failure path for wrong-secret and unset-secret so we never
      // leak which one it was. No cookie, no caching.
      if (!secret || !provided || !secretMatches(provided, secret)) {
        done({ status: 401 });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'Invalid access key' });
      }

      // Match — set the owner-session cookies, mirroring api/auth/callback.ts.
      // HttpOnly sc-owner is the real gate; non-HttpOnly sc-hint lets the
      // frontend detect the session on load. Secure only off localhost/dev.
      const appUrl = process.env.APP_URL ?? '';
      const isLocal = appUrl.includes('localhost') || !process.env.VERCEL;

      const cookieParts = [
        `${OWNER_COOKIE}=${secret}`,
        'Path=/',
        `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
        'HttpOnly',
        'SameSite=Strict',
      ];
      if (!isLocal) cookieParts.push('Secure');

      const hintParts = [
        'sc-hint=1',
        'Path=/',
        `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
        'SameSite=Strict',
      ];
      if (!isLocal) hintParts.push('Secure');

      res.setHeader('Set-Cookie', [
        cookieParts.join('; '),
        hintParts.join('; '),
      ]);
      res.setHeader('Cache-Control', 'no-store');

      done({ status: 200 });
      if (prefersJson(req)) {
        return res.status(200).json({ ok: true });
      }
      // Browser form submit → land back in the app, now authenticated.
      return res.redirect(302, '/');
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
