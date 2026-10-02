/**
 * GET /api/cron/schwab-reauth-reminder
 *
 * Hourly at :07, every day: the 7-day refresh-token clock ignores market
 * hours. Pushes a phone reminder to re-authenticate with Schwab before the
 * refresh token lapses, and once a day while it is lapsed. Tapping the
 * notification opens `/api/auth/init` (`notificationclick` in `src/sw.ts`),
 * so the re-login starts from the notification.
 *
 * Reminder kinds use the thresholds the header badge uses
 * (`src/utils/schwab-expiry.ts`). A run sends only the most urgent one due:
 *   - 24h    — 24 h or less left, more than 2 h
 *   - 2h     — 2 h or less left
 *   - lapsed — the record is past its expiry, or gone (logged out)
 *
 * The lapsed nag's "day" is a Central-time day that starts at 07:00 CT
 * (LAPSED_DAY_START_HOUR_CT), not at midnight. The first nag goes out on the
 * run after the lapse; each repeat then lands at 07:07 CT, before the 08:30
 * open, rather than waking the phone at 00:07. On the two DST-change Sundays
 * the rollover moves by an hour.
 *
 * Idempotency (R6) comes from a claim key taken with SET NX BEFORE sending:
 *   - Keys: `schwab:reauth-reminder:{24h|2h}:{refreshExpiresAt}`, derived
 *     from the login itself, so a re-login (new expiry) gets fresh keys;
 *     and `schwab:reauth-reminder:lapsed:{nag day}`, a time bucket.
 *   - Value: a random token per run, so a release is fenced. It deletes
 *     the key only while the key still holds this run's token.
 *   - Renew: none. One SET NX, one send.
 *   - Expire: CLAIM_TTL_SEC = 48 h. A 24h/2h key must outlive its reminder
 *     window, which is at most 24 h (from T-24h to the expiry T). A lapsed
 *     key must outlive its nag day, which is at most 25 h (the DST fall-back
 *     day). 48 h covers both with margin.
 *   - Fail: the claim FAILS CLOSED. If SET NX throws (Redis down), nothing
 *     is sent and the run errors (captured), because sending without a
 *     claim would repeat the push every hour.
 *   - Release: when no device received it (no live subscriptions, or every
 *     send failed), or when the send threw, the claim is released so the
 *     next hourly run retries. A failed release is captured. That reminder
 *     is then not retried until its key expires, but the next kind still
 *     fires.
 *   - Known gaps: a run killed between the claim and the send (a function
 *     timeout) loses that one reminder; the next kind still fires. And
 *     `sendPushToOwner` deletes 410/404 subscriptions AFTER its send loop,
 *     so if that DELETE throws, a push that did reach a device is treated
 *     as a throw: the claim is released and the next run sends a duplicate,
 *     hourly for as long as the DELETE keeps failing.
 *
 * Push TTL is REMINDER_PUSH_TTL_SEC (6 h). The push service drops a message
 * it cannot deliver within its TTL, and the claim would then block a retry,
 * so a phone that is offline or asleep for a few hours must still get it.
 * Bodies give the expiry as an absolute CT time, so a late delivery still
 * reads correctly.
 *
 * Spec: docs/superpowers/specs/schwab-reauth-2026-09-29.md (A3).
 */

import { randomUUID } from 'node:crypto';

import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import logger from '../_lib/logger.js';
import {
  sendPushToOwner,
  type FanOutResult,
  type PushPayload,
} from '../_lib/push.js';
import { redis } from '../_lib/redis.js';
import { getSchwabAuthStatus } from '../_lib/schwab.js';
import { Sentry } from '../_lib/sentry.js';
import {
  classifySchwabExpiry,
  formatSchwabExpiryCt,
  type SchwabAuthStatus,
} from '../../src/utils/schwab-expiry.js';
import { getCTDateStr } from '../../src/utils/timezone.js';

const JOB_NAME = 'schwab-reauth-reminder';
const KEY_PREFIX = 'schwab:reauth-reminder';
const HOUR_MS = 60 * 60 * 1000;
const CLAIM_TTL_SEC = 48 * 60 * 60;
const REMINDER_PUSH_TTL_SEC = 6 * 60 * 60;
/** The lapsed nag's day starts at this CT hour (see the header). */
const LAPSED_DAY_START_HOUR_CT = 7;
const REAUTH_URL = '/api/auth/init';

type ReminderKind = '24h' | '2h' | 'lapsed';

interface Reminder {
  kind: ReminderKind;
  /** The claim key. */
  key: string;
  payload: PushPayload;
}

/**
 * Fenced release, as a STATIC script: delete the claim only if it still
 * holds this run's token.
 *
 * KEYS[1] = claim key; ARGV[1] = this run's claim token
 * Returns: 1 = released, 0 = no longer ours (expired or re-claimed)
 */
const RELEASE_CLAIM_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

function lapsedReminder(now: number, detail: string): Reminder {
  // The CT date of `now` shifted back by the start hour, so the day rolls
  // over at 07:00 CT instead of midnight.
  const nagDay = getCTDateStr(
    new Date(now - LAPSED_DAY_START_HOUR_CT * HOUR_MS),
  );
  return {
    kind: 'lapsed',
    key: `${KEY_PREFIX}:lapsed:${nagDay}`,
    payload: {
      title: 'Schwab login expired',
      body: `${detail} Tap to re-authenticate.`,
      // Dated, so each day's nag alerts afresh instead of silently
      // replacing yesterday's notification if it is still open.
      tag: `schwab-reauth-lapsed-${nagDay}`,
      requireInteraction: true,
      url: REAUTH_URL,
    },
  };
}

/** The reminder due for `status` at `now`, or null when none is. */
function reminderFor(
  status: Exclude<SchwabAuthStatus, { state: 'unknown' }>,
  now: number,
): Reminder | null {
  if (status.state === 'logged_out') {
    return lapsedReminder(now, 'Live Schwab data is off.');
  }
  const { refreshExpiresAt } = status;
  const tier = classifySchwabExpiry(refreshExpiresAt, now);
  const at = formatSchwabExpiryCt(refreshExpiresAt);
  if (tier === 'ok') return null;
  if (tier === 'expired') {
    return lapsedReminder(now, `Expired ${at}; live Schwab data is off.`);
  }
  const kind: ReminderKind = tier === 'urgent' ? '2h' : '24h';
  return {
    kind,
    key: `${KEY_PREFIX}:${kind}:${refreshExpiresAt}`,
    payload: {
      title:
        kind === '2h'
          ? 'Schwab login expires in under 2 hours'
          : 'Schwab login expires within 24 hours',
      body: `Expires ${at}. Tap to re-authenticate.`,
      // Per login, so next week's reminder alerts afresh instead of
      // silently replacing this one if it is still open.
      tag: `schwab-reauth-${kind}-${refreshExpiresAt}`,
      requireInteraction: true,
      url: REAUTH_URL,
    },
  };
}

/** Release a claim so the next hourly run retries the reminder. */
async function releaseClaim(key: string, token: string): Promise<void> {
  try {
    await redis.eval(RELEASE_CLAIM_LUA, [key], [token]);
  } catch (err) {
    // The claim now holds until its TTL, so this reminder is not retried.
    logger.error(
      { err, key },
      `${JOB_NAME}: claim release failed; the reminder will not be retried`,
    );
    Sentry.captureException(err);
  }
}

export default withCronInstrumentation(
  JOB_NAME,
  async (): Promise<CronResult> => {
    const status = await getSchwabAuthStatus();
    if (status.state === 'unknown') {
      // The token store is unreachable or the record is malformed (the
      // status read logged which). No reminder can be judged, so page.
      Sentry.captureMessage('schwab.reauth_reminder.status_unknown', {
        level: 'warning',
        fingerprint: ['schwab.reauth_reminder.status_unknown'],
      });
      return {
        status: 'error',
        message: 'Schwab login status unreadable; no reminder sent',
      };
    }

    const reminder = reminderFor(status, Date.now());
    if (reminder === null) {
      return {
        status: 'success',
        message: 'no reminder due',
        metadata: { state: status.state },
      };
    }

    const { kind, key, payload } = reminder;
    const claimToken = randomUUID();
    // Throws on a Redis error: fail closed (see the header).
    const claimed = await redis.set(key, claimToken, {
      nx: true,
      ex: CLAIM_TTL_SEC,
    });
    if (claimed !== 'OK') {
      return {
        status: 'skipped',
        message: `${kind} reminder already sent`,
        metadata: { state: status.state, kind },
      };
    }

    let result: FanOutResult;
    try {
      result = await sendPushToOwner(payload, {
        ttlSec: REMINDER_PUSH_TTL_SEC,
      });
    } catch (err) {
      await releaseClaim(key, claimToken);
      throw err; // the wrapper captures it and reports status 'error'
    }

    const metadata = { state: status.state, kind, ...result };
    if (result.sent === 0) {
      await releaseClaim(key, claimToken);
      const reason =
        result.failed > 0
          ? 'every send failed'
          : result.expired > 0
            ? 'every subscription expired'
            : 'no push subscriptions';
      Sentry.captureMessage('schwab.reauth_reminder.undelivered', {
        level: 'warning',
        fingerprint: ['schwab.reauth_reminder.undelivered'],
        extra: { kind, reason, ...result },
      });
      return {
        status: 'error',
        message: `${kind} reminder not delivered: ${reason}`,
        metadata,
      };
    }

    return {
      status: result.failed > 0 ? 'partial' : 'success',
      message: `${kind} reminder sent`,
      metadata,
    };
  },
  // Runs around the clock and calls no UW API.
  { marketHours: false, requireApiKey: false },
);
