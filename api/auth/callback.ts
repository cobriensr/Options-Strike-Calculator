/**
 * GET /api/auth/callback?code=...
 *
 * Schwab redirects here after user login.
 * Exchanges the authorization code for access + refresh tokens,
 * stores them in Upstash Redis, and sets the owner session cookie —
 * only for the owner's Schwab login (`storeInitialTokens` checks the
 * login's accounts against OWNER_SCHWAB_ACCOUNT_SHA256). Any other login
 * gets a 403 with nothing stored and no cookie.
 *
 * A refused login (403 or 500) has spent its OAuth state, so retry from
 * /api/auth/init. Runbook: the OWNER_SCHWAB_ACCOUNT_SHA256 entry in
 * .env.example.
 *
 * The owner cookie is what gates the data endpoints — public visitors
 * don't have it and get a 401 (frontend silently falls back to manual input).
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeInitialTokens, type SchwabLoginError } from '../_lib/schwab.js';
import { redis } from '../_lib/redis.js';
import {
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';

/**
 * How the callback answers a login the owner check refused (see
 * `storeInitialTokens`); null for every other failure kind. The client gets
 * an opaque body; the detail, which names no account, goes to Sentry and
 * the log.
 */
function ownerCheckRefusal(type: SchwabLoginError['type']): {
  status: 403 | 500;
  level: 'warning' | 'error';
  error: string;
} | null {
  switch (type) {
    case 'not_owner':
      return {
        status: 403,
        level: 'warning',
        error: 'This Schwab login is not authorized for this app',
      };
    case 'owner_hash_missing':
      return {
        status: 500,
        level: 'error',
        error: 'Owner account check is not configured',
      };
    case 'owner_check_failed':
      return {
        status: 500,
        level: 'error',
        error: 'Owner account check failed',
      };
    default:
      return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/callback');
    const done = metrics.request('/api/auth/callback');
    try {
      const rateLimited = await rejectIfRateLimited(
        req,
        res,
        'auth-callback',
        5,
      );
      if (rateLimited) {
        done({ status: 429 });
        return;
      }

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

      // One atomic GETDEL: the nonce is returned at most once, so two
      // callbacks carrying the same state cannot both get past here.
      const validState = await redis.getdel(`oauth:state:${state}`);
      if (!validState) {
        done({ status: 400 });
        return res
          .status(400)
          .json({ error: 'Invalid or expired state parameter' });
      }

      const appUrl = process.env.APP_URL;
      if (!appUrl) {
        done({ status: 500 });
        return res.status(500).json({ error: 'APP_URL not configured' });
      }
      const redirectUri = `${appUrl}/api/auth/callback`;

      const result = await storeInitialTokens(code, redirectUri);

      if ('error' in result) {
        const refusal = ownerCheckRefusal(result.error.type);
        if (refusal) {
          // Nothing was stored and no cookie is set.
          const event = `schwab.auth.${result.error.type}`;
          Sentry.captureMessage(event, {
            level: refusal.level,
            fingerprint: [event],
            extra: { detail: result.error.message },
          });
          logger[refusal.level === 'warning' ? 'warn' : 'error'](
            { kind: result.error.type, detail: result.error.message },
            'Schwab login refused by the owner check',
          );
          done({ status: refusal.status });
          return res.status(refusal.status).json({ error: refusal.error });
        }

        // Don't leak the raw Schwab error body to the client — it can
        // include OAuth diagnostic metadata that narrows an attacker's
        // probe surface. Capture details server-side; return opaque text.
        Sentry.captureMessage(
          `Schwab token exchange failed: ${result.error.message}`,
          'error',
        );
        logger.error(
          { err: result.error.message },
          'Schwab token exchange failed',
        );
        done({ status: 500 });
        return res.status(500).json({ error: 'Token exchange failed' });
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
      const safeUrl = encodeURI(appUrl);
      res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Auth Complete</title>
      <meta http-equiv="refresh" content="3;url=${safeUrl}" />
    </head>
    <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
      <div style="text-align: center;">
        <h1 style="color: #22c55e;">&#x2713; Authenticated</h1>
        <p>Schwab tokens stored. Session valid for 7 days.</p>
        <p>Redirecting to calculator in 3 seconds&hellip;</p>
        <p style="color: #888; font-size: 14px;"><a href="${safeUrl}" style="color: #60a5fa;">Click here</a> if not redirected.</p>
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
