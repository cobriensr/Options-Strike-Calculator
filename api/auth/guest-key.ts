/**
 * POST /api/auth/guest-key
 *
 * Body: { key: string }
 *
 * Validates the supplied key against `GUEST_ACCESS_KEYS` (comma-separated
 * env var) using `crypto.timingSafeEqual`. On success, sets the sc-guest
 * (HttpOnly) and sc-guest-hint cookies with a 30-day TTL.
 *
 * Rate-limited to 5 attempts/minute per IP via `rejectIfRateLimited`.
 *
 * Guests get read-only access only — `api/analyze.ts` keeps its
 * `rejectIfNotOwner` check, and the frontend disables the analyze
 * submit button when in guest mode.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import { rejectIfRateLimited, respondIfInvalid } from '../_lib/api-helpers.js';
import { guestKeySchema } from '../_lib/validation.js';
import { buildGuestSetCookies, isValidGuestKey } from '../_lib/guest-auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/auth/guest-key');
    const done = metrics.request('/api/auth/guest-key');
    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      const rateLimited = await rejectIfRateLimited(
        req,
        res,
        'auth-guest-key',
        5,
      );
      if (rateLimited) {
        done({ status: 429 });
        return;
      }

      const parsed = guestKeySchema.safeParse(req.body);
      if (respondIfInvalid(parsed, res, done)) return;

      const { key } = parsed.data;
      if (!isValidGuestKey(key)) {
        done({ status: 401 });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'Invalid access key' });
      }

      const appUrl = process.env.APP_URL ?? '';
      const isLocal = appUrl.includes('localhost') || !process.env.VERCEL;
      res.setHeader('Set-Cookie', buildGuestSetCookies(key, isLocal));
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
