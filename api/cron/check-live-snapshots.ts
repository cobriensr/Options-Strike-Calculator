/**
 * GET /api/cron/check-live-snapshots
 *
 * Every 15 minutes during the session, pushes a phone alert when live
 * `market_snapshots` rows were saving today and none has saved in the last
 * 30 minutes. Live rows save only from the owner's own browser
 * (`useSnapshotSave`), so an asleep, signed-out or stuck trading browser shows
 * up here the same morning instead of days later.
 *
 * A live row is a `market_snapshots` row with `date` = today (ET), `is_backtest
 * = false` and `entry_time <> 'pre-market'` (the pre-market form writes its
 * own row, which is not a calculator snapshot). The latest `created_at` among
 * them is the last live save. With none today the app has not started saving,
 * so there is no stall to report: the check succeeds with "no live snapshot
 * yet today" and sends nothing (owner amendment, 2026-11-12). A whole day with
 * no saves therefore sends nothing, which the owner accepted.
 *
 * Window (`isLiveSnapshotWatchWindow`): a trading day, 10:00 ET (09:00 CT)
 * through the close minus 15 minutes (15:45 ET / 14:45 CT; 12:45 ET / 11:45
 * CT on a half-day). ET-anchored like `isGexbotLiveCt`, so DST-safe: CT is
 * always ET - 1 h. `vercel.json` fires every 15 minutes from 14:00 to 20:45
 * UTC, which covers 10:00-15:45 ET in both EST and EDT; the window skips the
 * rest.
 *
 * Detection time: a save is stale at 30 minutes and a check runs every 15,
 * so the alert lands 30-45 minutes after the last save. Example: saves stop
 * at 11:10 CT. The 11:30 check sees 20 minutes (no push); the 11:45 check
 * sees 35 and pushes "Last live snapshot 11:10 AM CT". Later checks find that
 * stall's claim and skip. If saves resume at 12:00 and stop again at 13:05,
 * the 13:45 check pushes again for the new stall.
 *
 * Deliberate close (owner amendment, 2026-11-12): the app tells the server
 * when the owner closes its page (`POST /api/snapshot-close`), which writes
 * `snapshot-app-closed:{ET date}` = the ISO time of the latest close signal.
 * Only when the last save is stale, before claiming, the cron reads that key:
 *   - A marker at or after the last save means the owner closed the app after
 *     it last saved: success "app closed at {time} CT", no claim, no push.
 *   - A marker before the last save (the app was reopened and saved since) is
 *     ignored, and the stall pushes as usual.
 *   - A Redis read failure propagates (500, an `error` check-in), as a claim
 *     failure does. It must not read as "closed", which would silence a real
 *     stall.
 *   - An unreadable marker value reads as no marker, with a warning. A bad
 *     marker must not silence a real stall either.
 *
 * Idempotency (R6) comes from a claim key taken with SET NX BEFORE sending,
 * by `sendOwnerPushOnce` (`api/_lib/push-once.ts`, which documents the
 * claim, the fenced release and the fail-closed behavior):
 *   - Key: `snapshot-stale-alert:{ET date}:{last save epoch ms}`. The last
 *     save is the event that began the stall, not `NOW()`. During one stall it
 *     does not change, so every later check maps to the same key and skips.
 *     Saves that resume and stop again make a new `MAX(created_at)`, hence a
 *     new key and a new push: one push per stall.
 *   - Expire: CLAIM_TTL_SEC = 24 h. The key must outlive the window in which
 *     the same stall can be derived: the first claim is at 10:00 ET at the
 *     earliest and the last check that day is at 15:45 ET, so 5 h 45 min at
 *     most. 24 h covers it with margin, and the next trading day's date
 *     changes the key.
 *   - Release and known gap: as in `push-once.ts`. A stall's alert lost to
 *     either is lost for that stall: the key outlives the window.
 *
 * The notification tag is per stall too (`snapshot-stale-{date}-{ms}`).
 * `src/sw.ts` shows the notification with the payload's tag and no
 * `renotify`, so a second stall that reused the day's tag would silently
 * replace the first notification without alerting.
 *
 * Push TTL is PUSH_TTL_SEC (1 h): a late delivery is still useful inside the
 * session, and the claim blocks a retry once the push service accepted it.
 * The body gives the last save as an absolute CT time, so a late delivery
 * still reads correctly.
 *
 * Spec: docs/superpowers/specs/live-snapshot-alert-2026-11-11.md.
 */

import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { SNAPSHOT_CLOSED_KEY_PREFIX } from '../_lib/constants.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { neonIso } from '../_lib/db-date.js';
import logger from '../_lib/logger.js';
import { sendOwnerPushOnce, undeliveredReason } from '../_lib/push-once.js';
import { redis } from '../_lib/redis.js';
import { Sentry } from '../_lib/sentry.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import {
  getCTTime,
  getETDateStr,
  getETDayOfWeek,
  getETTime,
} from '../../src/utils/timezone.js';

const JOB_NAME = 'check-live-snapshots';
const KEY_PREFIX = 'snapshot-stale-alert';
const MINUTE_MS = 60_000;
/** Live rows save every 5 min while the page is open: 30 min is six misses. */
const STALE_AFTER_MIN = 30;
/** The first check: 10:00 ET = 09:00 CT, 30 min after the open. */
const WATCH_START_MIN_ET = 10 * 60;
/** The last check is this long before the close, so it can still help. */
const WATCH_END_BEFORE_CLOSE_MIN = 15;
const CLAIM_TTL_SEC = 24 * 60 * 60;
const PUSH_TTL_SEC = 60 * 60;
const OPEN_APP_HINT = 'Open the app signed in as owner.';

interface LastLiveRow {
  last_live_at: string | Date | null;
}

/**
 * True on a trading day (weekday, not a market holiday) from 10:00 ET
 * through the close minus 15 minutes, inclusive.
 */
export function isLiveSnapshotWatchWindow(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  const closeHour = getMarketCloseHourET(getETDateStr(now));
  if (closeHour == null) return false; // holiday

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  return (
    totalMin >= WATCH_START_MIN_ET &&
    totalMin <= closeHour * 60 - WATCH_END_BEFORE_CLOSE_MIN
  );
}

/** The time as the owner reads it in Central time: "10:25 AM CT". */
function formatCtClock(ms: number): string {
  const { hour, minute } = getCTTime(new Date(ms));
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const minutes = String(minute).padStart(2, '0');
  return `${hour % 12 || 12}:${minutes} ${meridiem} CT`;
}

/**
 * When the owner last closed the app today, in epoch ms, or null when there is
 * no marker or its value is unreadable.
 *
 * A Redis error propagates: a failed read must not read as "closed", which
 * would silence a real stall. An unreadable value is warned about and reads as
 * no marker, for the same reason. Upstash returns a digits-only value as a
 * number, hence the string check.
 */
async function readCloseMarkerMs(today: string): Promise<number | null> {
  const marker = await redis.get<unknown>(
    `${SNAPSHOT_CLOSED_KEY_PREFIX}:${today}`,
  );
  if (marker == null) return null;
  const closedAtMs =
    typeof marker === 'string' ? Date.parse(marker) : Number.NaN;
  if (!Number.isFinite(closedAtMs)) {
    logger.warn(
      { today, marker },
      `${JOB_NAME}: close marker unreadable; treating as not closed`,
    );
    return null;
  }
  return closedAtMs;
}

export default withCronInstrumentation(
  JOB_NAME,
  async ({ today }): Promise<CronResult> => {
    const sql = getDb();
    const rows = (await withDbRetry(
      () => sql`
        SELECT MAX(created_at) AS last_live_at
        FROM market_snapshots
        WHERE date = ${today}
          AND is_backtest = false
          AND entry_time <> 'pre-market'
      `,
      2,
      10_000,
    )) as LastLiveRow[];
    const lastLive = rows[0]?.last_live_at;
    // No live row today: saves have not started, so nothing has stalled.
    if (lastLive == null) {
      return {
        status: 'success',
        message: 'no live snapshot yet today',
        metadata: { lastLiveAt: null },
      };
    }

    const lastLiveAt = neonIso(lastLive);
    // An unreadable save time must fail loud: NaN compares false, which would
    // read as "current" and silence the alert.
    const lastSaveMs = Date.parse(lastLiveAt);
    if (!Number.isFinite(lastSaveMs)) {
      throw new Error(`live snapshot reference time unreadable for ${today}`);
    }

    const sinceMs = Date.now() - lastSaveMs;
    const minutesSince = Math.floor(sinceMs / MINUTE_MS);
    if (sinceMs < STALE_AFTER_MIN * MINUTE_MS) {
      return {
        status: 'success',
        message: 'live snapshots current',
        metadata: { lastLiveAt, minutesSince },
      };
    }

    // Stale. A close at or after the last save is the owner leaving, not a
    // stall. Read before claiming, so a close never takes the claim.
    const closedAtMs = await readCloseMarkerMs(today);
    if (closedAtMs !== null && closedAtMs >= lastSaveMs) {
      return {
        status: 'success',
        message: `app closed at ${formatCtClock(closedAtMs)}`,
        metadata: { lastLiveAt, closedAt: new Date(closedAtMs).toISOString() },
      };
    }

    // Throws if the claim or the send throws (the wrapper captures it and
    // reports status 'error'); the claim fails closed, see the header.
    const outcome = await sendOwnerPushOnce({
      key: `${KEY_PREFIX}:${today}:${lastSaveMs}`,
      claimTtlSec: CLAIM_TTL_SEC,
      payload: {
        title: 'Live snapshots stopped saving',
        body: `Last live snapshot ${formatCtClock(lastSaveMs)}. ${OPEN_APP_HINT}`,
        // Per stall, so a second stall shows a second notification instead of
        // silently replacing the first (see the header).
        tag: `snapshot-stale-${today}-${lastSaveMs}`,
        requireInteraction: true,
        url: '/',
      },
      pushTtlSec: PUSH_TTL_SEC,
      job: JOB_NAME,
    });
    const metadata = { today, lastLiveAt, minutesSince };
    if (!outcome.claimed) {
      return {
        status: 'skipped',
        message: 'alert already sent for this stall',
        metadata,
      };
    }

    const { result } = outcome;
    if (result.sent === 0) {
      const reason = undeliveredReason(result);
      // Level 'error': the phone alert itself was lost. A warning gets
      // medium priority, and the only Issue Stream rule mails high priority.
      Sentry.captureMessage('snapshot.stale_alert.undelivered', {
        level: 'error',
        fingerprint: ['snapshot.stale_alert.undelivered'],
        extra: { reason, ...metadata, ...result },
      });
      return {
        status: 'error',
        message: `alert not delivered: ${reason}`,
        metadata: { ...metadata, ...result },
      };
    }

    return {
      status: result.failed > 0 ? 'partial' : 'success',
      message: 'stale alert sent',
      metadata: { ...metadata, ...result },
    };
  },
  // The window is the gate, and no UW API is called.
  { timeCheck: isLiveSnapshotWatchWindow, requireApiKey: false },
);
