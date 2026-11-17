/**
 * GET /api/auth/whoami
 *
 * Server's source-of-truth view of the current session, used by the
 * frontend's fetch interceptor to confirm a 401 storm is real before
 * wiping the JS-visible hint cookies and bouncing the user to public
 * mode. See `src/utils/authInterceptor.ts` for the consumer side.
 *
 * Answers 200 with `{ mode: 'owner' | 'guest' | 'public' }` except for 405
 * (not a GET) and 429 (see below), so the response itself doesn't re-trigger
 * the interceptor's 401 path. The interceptor ignores any non-OK reply and
 * the renewal check (`src/lib/owner-session-renewal.ts`) never reads the
 * status, so neither one clears a cookie or retries on a 429.
 *
 * Owner wins over guest — matches `getAccessMode()` precedence.
 *
 * Also renews the owner sign-in: an answer of 'owner' (the request already
 * passed `isOwner`) re-issues the sc-owner and sc-hint cookies with a fresh
 * 400-day lifetime, so a browser that keeps being used stays signed in. It
 * never creates a session: a guest, public or wrong-cookie request gets no
 * Set-Cookie header.
 *
 * A request that carries a non-empty sc-owner or sc-guest cookie is limited
 * per client (`WHOAMI_PER_MINUTE`) before either cookie is checked. A request
 * with neither cookie is the common public visit and is not counted.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  buildOwnerSessionCookies,
  isLocalDeployment,
  isOwner,
  OWNER_COOKIE,
  parseCookies,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';
import { GUEST_COOKIE, isGuest } from '../_lib/guest-auth.js';

export type WhoamiMode = 'owner' | 'guest' | 'public';

/**
 * Requests per minute, per client, that may carry a credential cookie. An
 * operational knob: a browser asks once a day to renew the owner sign-in, and
 * the 401 interceptor sends at most one probe at a time, so a real client
 * stays far below this while a client that keeps presenting cookies is
 * refused. Exported for the test.
 */
export const WHOAMI_PER_MINUTE = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/auth/whoami');
    const done = metrics.request('/api/auth/whoami');
    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      const cookies = parseCookies(req);
      if (cookies[OWNER_COOKIE] || cookies[GUEST_COOKIE]) {
        // The limiter writes the 429 itself, with Retry-After.
        if (
          await rejectIfRateLimited(req, res, 'auth-whoami', WHOAMI_PER_MINUTE)
        ) {
          done({ status: 429 });
          return;
        }
      }

      let mode: WhoamiMode = 'public';
      if (isOwner(req)) mode = 'owner';
      else if (isGuest(req)) mode = 'guest';

      // Before any Set-Cookie, so no answer that carries a cookie, or fails
      // while building one, is left cacheable.
      res.setHeader('Cache-Control', 'no-store');

      if (mode === 'owner') {
        // Same local-deployment rule as the OAuth callback, so a renewal sets
        // the cookies with the attributes the sign-in did.
        res.setHeader(
          'Set-Cookie',
          buildOwnerSessionCookies(isLocalDeployment()),
        );
      }

      done({ status: 200 });
      return res.status(200).json({ mode });
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
