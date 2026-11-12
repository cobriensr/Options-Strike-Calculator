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
 * (LAPSED_DAY_START_HOUR_CT), not at midnight: its key is the CT date of
 * (now - 7 h). The first nag goes out on the run after the lapse; each
 * repeat then lands at 07:07 CT, before the 08:30 open, rather than waking
 * the phone at 00:07. The shift is 7 elapsed hours, so on the fall-back
 * Sunday the day rolls at 06:00 CST and on the spring-forward Sunday at
 * 08:00 CDT; the Monday after each is back to 07:00.
 *
 * A login that lapses between 00:00 and 07:00 CT is still in the previous
 * nag day, so it gets that day's nag on the next run and another at 07:07,
 * 1–7 h apart. That is rare: the 7-day clock starts at a login, and logins
 * happen during the trading session.
 *
 * Idempotency (R6) comes from a claim key taken with SET NX BEFORE sending,
 * by `sendOwnerPushOnce` (`api/_lib/push-once.ts`, which documents the
 * claim, the fenced release and the fail-closed behavior):
 *   - Keys: `schwab:reauth-reminder:{24h|2h}:{refreshExpiresAt}`, derived
 *     from the login itself, so a re-login (new expiry) gets fresh keys;
 *     and `schwab:reauth-reminder:lapsed:{nag day}`, a time bucket.
 *   - Expire: CLAIM_TTL_SEC = 48 h. A 24h/2h key must outlive its reminder
 *     window, which is at most 24 h (from T-24h to the expiry T). A lapsed
 *     key must outlive its nag day, which is at most 25 h (the DST fall-back
 *     day). 48 h covers both with margin.
 *   - Release: when no device received it, the claim is released so the
 *     next hourly run retries. If that release fails, the reminder is not
 *     retried until its key expires, but the next kind still fires.
 *   - Known gap: a run killed between the claim and the send (a function
 *     timeout) loses that one reminder; the next kind still fires.
 *
 * Push TTL is REMINDER_PUSH_TTL_SEC (6 h). The push service drops a message
 * it cannot deliver within its TTL, and the claim would then block a retry,
 * so a phone that is offline or asleep for a few hours must still get it.
 * Bodies give the expiry as an absolute CT time, so a late delivery still
 * reads correctly.
 *
 * Spec: docs/superpowers/specs/schwab-reauth-2026-09-29.md (A3).
 */

import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import type { PushPayload } from '../_lib/push.js';
import { sendOwnerPushOnce, undeliveredReason } from '../_lib/push-once.js';
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
    // Throws if the claim or the send throws (the wrapper captures it and
    // reports status 'error'); the claim fails closed, see the header.
    const outcome = await sendOwnerPushOnce({
      key,
      claimTtlSec: CLAIM_TTL_SEC,
      payload,
      pushTtlSec: REMINDER_PUSH_TTL_SEC,
      job: JOB_NAME,
    });
    if (!outcome.claimed) {
      return {
        status: 'skipped',
        message: `${kind} reminder already sent`,
        metadata: { state: status.state, kind },
      };
    }

    const { result } = outcome;
    const metadata = { state: status.state, kind, ...result };
    if (result.sent === 0) {
      const reason = undeliveredReason(result);
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
