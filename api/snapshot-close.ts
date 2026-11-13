/**
 * POST and DELETE /api/snapshot-close
 *
 * The owner's page tells the server about one marker, so `check-live-snapshots`
 * does not push "Live snapshots stopped saving" for the silence that follows a
 * close, and a reload or a second tab never hides a real stall:
 *   - POST: "the page was closed" (tab or window closed, navigated away or
 *     reloaded, or the live-save switch turned off). The client sends it
 *     best-effort on `pagehide` and when the switch goes off, and never reads
 *     the answer.
 *   - DELETE: "a tab of the app is open". Every live-save tab sends it at load,
 *     30 s later, every 5 minutes in the cash session, and when the page comes
 *     back from the back/forward cache. It removes today's marker (fourth and
 *     fifth amendments in the spec): a reload's close is withdrawn by the new
 *     page, and closing one of several tabs is withdrawn by another tab's next
 *     signal. Only the last tab's close, which nobody withdraws, stands.
 *
 * Owner-only (`guardOwnerEndpoint`), POST or DELETE only, no body, no query:
 * the server picks the key and the time, so a caller can choose neither. Rate
 * limit: 30 a minute per IP, one bucket for both methods (a tab sends about
 * one open signal every 5 minutes, as `/api/snapshot`). Both answer 204.
 *
 * The marker is `snapshot-app-closed:{ET date} = {ISO time}` with a 24 h
 * expiry (R6):
 *   - Key: the ET date at the server clock, never anything the caller sends,
 *     so every close and every open on a day maps to the same key. The prefix
 *     is `SNAPSHOT_CLOSED_KEY_PREFIX`, shared with the cron that reads it.
 *   - POST value: the time of the latest close. The write overwrites (no NX):
 *     the last write wins, which is the intent. The cron compares it with the
 *     last save, so a close at or after the last save hides a stall.
 *   - POST expire: 24 h from the latest write, re-armed by each close. It
 *     outlives the session window in which the cron reads it, and the next
 *     day's date derives a new key.
 *   - DELETE: idempotent, so it needs no claim or fence. Deleting a missing
 *     key is a 204 too. It races only with a close: whichever lands last
 *     wins. A reload's close that reaches the server after the new page's
 *     first open signal is settled by the +30 s signal; the closing tab's own
 *     late open signal deleting its close errs toward an extra alert. So does
 *     a reopened page: its open signal lands seconds before its first save,
 *     and a cron tick in that gap pushes once for the old stall.
 *   - Fail: a Redis error is a 500 with a Sentry capture. A lost close only
 *     lets the cron push a stall alert for a close; it never hides a stall.
 *     A lost delete leaves a close standing until the next open signal or
 *     save, and a close before the last save is ignored by the cron.
 *
 * Spec: docs/superpowers/specs/live-snapshot-alert-2026-11-11.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
} from './_lib/auth-helpers.js';
import { SNAPSHOT_CLOSED_KEY_PREFIX } from './_lib/constants.js';
import logger from './_lib/logger.js';
import { redis } from './_lib/redis.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { getETDateStr } from '../src/utils/timezone.js';

const MARKER_TTL_SEC = 24 * 60 * 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/snapshot-close');

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST or DELETE only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  const rateLimited = await rejectIfRateLimited(req, res, 'snapshot-close', 30);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  const withdrawing = req.method === 'DELETE';
  try {
    // One clock reading, so the key's date and the value agree.
    const now = new Date();
    const key = `${SNAPSHOT_CLOSED_KEY_PREFIX}:${getETDateStr(now)}`;
    if (withdrawing) {
      await redis.del(key);
    } else {
      await redis.set(key, now.toISOString(), { ex: MARKER_TTL_SEC });
    }
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 204 });
    return res.status(204).end();
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err },
      `snapshot-close: marker ${withdrawing ? 'delete' : 'write'} failed`,
    );
    done({ status: 500 });
    return res.status(500).json({ error: 'Internal error' });
  }
}
