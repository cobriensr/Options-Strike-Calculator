/**
 * POST /api/auth/guest-key
 *
 * Body: { key: string }
 *
 * Validates the supplied key against `GUEST_ACCESS_KEYS` (comma-separated
 * env var) using `crypto.timingSafeEqual`. On success, sets the sc-guest
 * (HttpOnly) and sc-guest-hint cookies with a 30-day TTL.
 *
 * Checks, in order: POST only, the bot check (403), the per-client limiter of
 * 5 attempts a minute (429), the hourly failure budget, the body, then the
 * key. A wrong key (401) is counted against the budget: once
 * `GUEST_KEY_FAILS_PER_HOUR` wrong keys have been seen in an epoch hour, every
 * attempt gets a 429 until the next hour. When the budget can't be read the
 * attempt is refused with a 503 rather than let through unchecked.
 *
 * Guests get read-only access only — `api/analyze.ts` keeps its
 * `rejectIfNotOwner` check, and the frontend disables the analyze
 * submit button when in guest mode.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  checkBot,
  guestKeyBudgetSpent,
  hourWindow,
  isLocalDeployment,
  recordGuestKeyFailure,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { guestKeySchema } from '../_lib/validation.js';
import { buildGuestSetCookies, isValidGuestKey } from '../_lib/guest-auth.js';

/**
 * The epoch hour for which this instance last sent the "budget spent"
 * message. One number, so it holds no more than one entry however many
 * requests arrive. Once the budget is spent every attempt is refused, so
 * without it the owner would get a Sentry message per attempt.
 */
let lastBudgetReportHour = -1;

function reportBudgetSpentOncePerHour(epochHour: number): void {
  if (epochHour === lastBudgetReportHour) return;
  lastBudgetReportHour = epochHour;
  // The Sentry alert rule "Auth: wrong secret, short secret or guest-key limit"
  // matches this whole text exactly (not a prefix); reword it and update the
  // rule.
  Sentry.captureMessage(
    'Guest-key login refused: hourly failure budget spent',
    {
      level: 'warning',
      fingerprint: ['guest-key-failure-budget'],
    },
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/auth/guest-key');
    const done = metrics.request('/api/auth/guest-key');
    try {
      if (req.method !== 'POST') {
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ error: 'Access denied' });
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

      let budgetSpent: boolean;
      try {
        budgetSpent = await guestKeyBudgetSpent();
      } catch (err) {
        // Fail closed: with no count, the attempt can't be allowed.
        Sentry.captureException(err, {
          level: 'warning',
          fingerprint: ['guest-key-budget-unavailable'],
        });
        done({ status: 503 });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'Try again later' });
      }
      if (budgetSpent) {
        const { epochHour, secondsLeft } = hourWindow(Date.now());
        reportBudgetSpentOncePerHour(epochHour);
        done({ status: 429 });
        res.setHeader('Retry-After', String(secondsLeft));
        res.setHeader('Cache-Control', 'no-store');
        return res
          .status(429)
          .json({ error: 'Too many attempts. Try again later.' });
      }

      const parsed = guestKeySchema.safeParse(req.body);
      if (respondIfInvalid(parsed, res, done)) return;

      const { key } = parsed.data;
      if (!isValidGuestKey(key)) {
        // Awaited: a function instance may be frozen once the response is
        // sent. `recordGuestKeyFailure` never throws.
        await recordGuestKeyFailure();
        done({ status: 401 });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'Invalid access key' });
      }

      res.setHeader(
        'Set-Cookie',
        buildGuestSetCookies(key, isLocalDeployment()),
      );
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
