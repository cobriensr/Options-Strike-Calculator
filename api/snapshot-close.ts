/**
 * POST /api/snapshot-close
 *
 * The owner's page calls this when it is closed (tab or window closed, or
 * navigated away), so `check-live-snapshots` does not push "Live snapshots
 * stopped saving" for the silence that follows. The client sends it
 * best-effort on `pagehide` and never reads the answer.
 *
 * Owner-only (`guardOwnerEndpoint`), POST only, no body: the server picks both
 * the key and the time, so a caller can choose neither. Rate limit: 30 a
 * minute per IP, as `/api/snapshot`.
 *
 * Writes one marker, `SET snapshot-app-closed:{ET date} {ISO time} EX 24 h`
 * (R6):
 *   - Key: the ET date at the server clock, never anything the caller sends,
 *     so every close on a day maps to the same key.
 *   - Value: the time of the latest close. The write overwrites (no NX): the
 *     last write wins, which is the intent. The cron compares it with the last
 *     save, so only a close after the last save hides a stall.
 *   - Expire: 24 h from the latest write, re-armed by each close. It outlives
 *     the session window in which the cron reads it, and the next day's date
 *     derives a new key.
 *   - Fail: a Redis error is a 500 with a Sentry capture. A lost marker only
 *     lets the cron push a stall alert for a close; it never hides a stall.
 *
 * Spec: docs/superpowers/specs/live-snapshot-alert-2026-11-11.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
} from './_lib/auth-helpers.js';
import logger from './_lib/logger.js';
import { redis } from './_lib/redis.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { getETDateStr } from '../src/utils/timezone.js';

/** Read by `api/cron/check-live-snapshots.ts`: `{prefix}:{ET date}`. */
const KEY_PREFIX = 'snapshot-app-closed';
const MARKER_TTL_SEC = 24 * 60 * 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/snapshot-close');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  const rateLimited = await rejectIfRateLimited(req, res, 'snapshot-close', 30);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    // One clock reading, so the key's date and the value agree.
    const now = new Date();
    await redis.set(`${KEY_PREFIX}:${getETDateStr(now)}`, now.toISOString(), {
      ex: MARKER_TTL_SEC,
    });
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 204 });
    return res.status(204).end();
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'snapshot-close: marker write failed');
    done({ status: 500 });
    return res.status(500).json({ error: 'Internal error' });
  }
}
