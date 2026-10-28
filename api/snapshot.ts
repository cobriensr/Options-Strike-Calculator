/**
 * POST /api/snapshot
 *
 * Saves the complete calculator state as a market snapshot.
 * Owner-gated: only writes for authenticated sessions.
 * Uniqueness: one snapshot per date + entry_time. A re-save updates it,
 * except that a backtest save never replaces a live row: the response is
 * then 200 { id: null, saved: false }, counted as a successful save and
 * not reported as an error.
 *
 * A row's date must own its data, whatever the client sends:
 *   - a future date (ET) is skipped: 200 { id: null, saved: false,
 *     skipped: 'future-date' };
 *   - a live save (isBacktest not true) for a date other than today (ET)
 *     is skipped: 200 { id: null, saved: false, skipped:
 *     'live-for-other-date' }, with a warning log and a Sentry warning
 *     (snapshot.live_save_for_other_date). A tab still on an older
 *     bundle (the PWA updates on prompt) writes today's live quotes under
 *     the date it shows, and the upsert would then protect that row from
 *     the date's own replay.
 *
 * Called automatically by the frontend whenever results are computed.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfRateLimited,
  guardOwnerEndpoint,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { saveSnapshot } from './_lib/db.js';
import { snapshotBodySchema } from './_lib/validation.js';
import logger from './_lib/logger.js';
import { getETToday } from '../src/utils/timezone.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/snapshot');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  // Rate limit: max 30 snapshots per minute (generous for normal use)
  const rateLimited = await rejectIfRateLimited(req, res, 'snapshot', 30);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const parsed = snapshotBodySchema.safeParse(req.body);
    if (respondIfInvalid(parsed, res, done)) return;

    // Both dates are YYYY-MM-DD (the schema enforces the body's), so they
    // compare as text.
    const { date, entryTime, isBacktest } = parsed.data;
    const today = getETToday();
    if (date > today) {
      done({ status: 200 });
      return res
        .status(200)
        .json({ id: null, saved: false, skipped: 'future-date' });
    }
    if (date !== today && isBacktest !== true) {
      logger.warn(
        { date, today, entryTime },
        'Skipped a live snapshot save for another date (stale client?)',
      );
      Sentry.captureMessage('snapshot.live_save_for_other_date', {
        level: 'warning',
        extra: { date, today, entryTime },
      });
      done({ status: 200 });
      return res
        .status(200)
        .json({ id: null, saved: false, skipped: 'live-for-other-date' });
    }

    const id = await saveSnapshot(parsed.data);

    metrics.dbSave('market_snapshots', true);
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    return res.status(200).json({ id, saved: id != null });
  } catch (err) {
    // Don't fail the user experience or leak DB details
    metrics.dbSave('market_snapshots', false);
    done({ status: 200 });
    Sentry.captureException(err);
    logger.error({ err }, 'Snapshot save error');
    return res.status(200).json({ id: null, saved: false });
  }
}
