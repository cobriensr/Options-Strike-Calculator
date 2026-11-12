/**
 * POST /api/snapshot
 *
 * Saves the complete calculator state as a market snapshot.
 * Owner-gated: only writes for authenticated sessions.
 * Uniqueness: one snapshot per date + entry_time. A re-save updates it,
 * except that a backtest save never replaces a live row: the response is
 * then 200 { id: null, saved: false, skipped: 'live-row' }, counted as a
 * successful save and not reported as an error. A DB error answers 200
 * { id: null, saved: false } with no skipped marker, and is reported.
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
 * The server decides the event flag and names. It looks the date up in
 * `getEventsForDate` (FRED, the FOMC and early-close calendar, Finnhub) and
 * stores `is_event_day` and `event_names` from that, whatever the client sent:
 * the client only knows events from today forward, so a replay or the day's
 * first live save would otherwise store a past event day as a plain one. When
 * the lookup is incomplete or fails, the save still goes ahead with the
 * server's partial names plus any the client sent, and the gap is reported:
 * snapshot.event_lookup_incomplete counts every such save, while the warning
 * log and the Sentry warning fire once per fetch (or failure), not for each
 * save the cached incomplete entry then serves.
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
import {
  eventNamesForSnapshot,
  getEventsForDate,
} from './_lib/market-events.js';
import { getETToday } from '../src/utils/timezone.js';

/**
 * The `is_event_day` and `event_names` a snapshot for `date` stores. A
 * complete lookup is the whole answer and the client's values are ignored.
 * An incomplete or failed one keeps the server's names in order, duplicates
 * included, then appends each client name not already listed, and is
 * reported. It never throws: the lookup's failure must not cost the save.
 */
async function resolveEventFlags(
  date: string,
  clientNames: readonly string[] | null | undefined,
): Promise<{ isEventDay: boolean; eventNames: string[] }> {
  let serverNames: string[] = [];
  let complete = false;
  let fromCache = false;
  let threw = false;
  let lookupErr: unknown;
  try {
    const lookup = await getEventsForDate(date);
    fromCache = lookup.fromCache;
    // `complete` is read last: if naming the events throws, the lookup counts
    // as failed and `serverNames` is still empty.
    serverNames = eventNamesForSnapshot(lookup.events);
    complete = lookup.complete;
  } catch (err) {
    threw = true;
    lookupErr = err;
  }

  if (complete) {
    return { isEventDay: serverNames.length > 0, eventNames: serverNames };
  }

  const eventNames = [...serverNames];
  for (const name of clientNames ?? []) {
    if (!eventNames.includes(name)) eventNames.push(name);
  }
  // Count every incomplete save. Warn once per fetch: the cache serves an
  // incomplete entry for 5 minutes and a replay saves about 24 times a
  // minute, so reporting each save would send about 120 events per failure.
  metrics.increment('snapshot.event_lookup_incomplete');
  if (threw || !fromCache) {
    logger.warn({ date, err: lookupErr }, 'snapshot: event lookup incomplete');
    Sentry.captureMessage('snapshot: event lookup incomplete', {
      level: 'warning',
      extra: { date },
    });
  }
  return { isEventDay: eventNames.length > 0, eventNames };
}

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

    const { isEventDay, eventNames } = await resolveEventFlags(
      date,
      parsed.data.eventNames,
    );
    const id = await saveSnapshot({ ...parsed.data, isEventDay, eventNames });

    metrics.dbSave('market_snapshots', true);
    res.setHeader('Cache-Control', 'no-store');
    done({ status: 200 });
    // A null id is a backtest save that left the live row in place.
    return res
      .status(200)
      .json(
        id == null
          ? { id: null, saved: false, skipped: 'live-row' }
          : { id, saved: true },
      );
  } catch (err) {
    // Don't fail the user experience or leak DB details
    metrics.dbSave('market_snapshots', false);
    done({ status: 200 });
    Sentry.captureException(err);
    logger.error({ err }, 'Snapshot save error');
    return res.status(200).json({ id: null, saved: false });
  }
}
