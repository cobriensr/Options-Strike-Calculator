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
 *     the date's own replay;
 *   - a weekend or NYSE holiday, live or backtest, is skipped: 200 { id:
 *     null, saved: false, skipped: 'non-trading-day' }, with a warning log.
 *     A live save (isBacktest not true) also raises a Sentry warning
 *     (snapshot.save_for_non_trading_day): it is a stale tab or a bad POST.
 *     A backtest save on a closed date is expected and is logged only. The
 *     two skips above are checked first, so a closed date that is also in the
 *     future, or a live save for another closed date, reports the earlier
 *     reason.
 *
 * The server decides the event flag and names. It looks the date up in
 * `getEventsForDate` (FRED, and the FOMC and early-close calendar) and stores
 * `is_event_day` and `event_names` from that, whatever the client sent: the
 * client only knows events from today forward, so a replay or the day's first
 * live save would otherwise store a past event day as a plain one. The flag is
 * macro-only (owner decision 2026-11-12): mega-cap earnings never count, and
 * a client's earnings names are dropped. When the lookup is incomplete or
 * fails, the save still goes ahead with the server's partial names plus the
 * client's non-earnings names, and the gap is reported:
 * snapshot.event_lookup_incomplete counts every such save, while the warning
 * log and the Sentry warning fire once per fetch (or failure), not for each
 * save the cached incomplete entry then serves.
 *
 * A live row's quotes must be fresh (P0.6, F11). When the quote poll stalls
 * or Schwab serves an old print, the inputs still match the quote state, so
 * only the quote's time shows the row is frozen. The client sends it as
 * quotedAt (the older of the SPX and VIX Schwab tradeTime, epoch ms); a live
 * save (isBacktest not true) that none of the three skips above caught is
 * refused with 422 { error: 'quote-not-fresh', reason, saved: false } when:
 *   - no-quote-time: quotedAt is missing;
 *   - bad-entry-time: the entryTime label or the date does not give a slot;
 *   - quote-from-future: quotedAt is over 2 min ahead of this server's clock;
 *   - stale-quote: quotedAt is over 10 min behind the slot (exactly 10:00
 *     passes). The slot is the label's instant, not the clock.
 * The client retries a 422 quietly, so it alerts here: a Sentry error
 * (snapshot.stale_quote: <reason>, one issue per reason) for a slot inside the
 * session, and for a missing time or an unreadable label at any hour. Before
 * the open and after the close the last quote is old by nature, so it is a
 * log and a metric there. A backtest save is not checked. Rule:
 * api/_lib/quote-freshness.ts.
 *
 * A live row saved without yesterday's fields is kept and reported. While the
 * app has no current yesterday (Schwab's daily candle late, or its request
 * failed) it saves a null rvAnnualized and clusterMult. The row is saved as
 * sent, so the slot keeps a row; build-features does not pick it for the day's
 * features (featureSnapshotRejection, `missing-yesterday`), and the save is
 * counted (snapshot.missing_yesterday_fields) and raises a Sentry error
 * tagged snapshot_gap, one issue per date (the owner is emailed by the
 * existing high-priority rule). A backtest save is not alerted: the
 * replay driver checks those. The pre-market row is not written here, and a
 * live post under that label is refused by the quote check above.
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
  isEarningsEventName,
} from './_lib/market-events.js';
import {
  alertsOnRefusal,
  checkQuoteFreshness,
  isoOrNull,
} from './_lib/quote-freshness.js';
import { isTradingDay } from '../src/data/marketHours.js';
import { getETToday } from '../src/utils/timezone.js';

/**
 * The `is_event_day` and `event_names` a snapshot for `date` stores. A
 * complete lookup is the whole answer and the client's values are ignored.
 * An incomplete or failed one keeps the server's names in order, duplicates
 * included, then appends each client name that is not an earnings name and
 * not already listed, and is reported. It never throws: the lookup's failure
 * must not cost the save.
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
  // A live client's list comes from /api/events, which carries earnings.
  for (const name of clientNames ?? []) {
    if (!isEarningsEventName(name) && !eventNames.includes(name)) {
      eventNames.push(name);
    }
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

/**
 * Report a live row that was saved with no RV or no cluster multiplier: the
 * app had no current yesterday. A count for every such save, and a Sentry
 * error event under one fingerprint per date: Sentry groups the events into
 * one issue per date, so a gap that spans several slots is one issue and one
 * email. Nothing here remembers which dates were reported (R1). A row with
 * both present is not reported.
 */
function reportMissingYesterdayFields(
  date: string,
  entryTime: string,
  rvAnnualized: number | null | undefined,
  clusterMult: number | null | undefined,
): void {
  const rvMissing = rvAnnualized == null;
  const clusterMissing = clusterMult == null;
  if (!rvMissing && !clusterMissing) return;
  const context = { date, entryTime, rvMissing, clusterMissing };
  logger.warn(
    context,
    'Saved a live snapshot without yesterday’s fields (RV or the cluster multiplier)',
  );
  metrics.increment('snapshot.missing_yesterday_fields');
  Sentry.captureMessage('snapshot.missing_yesterday_fields', {
    // `error`, not `warning`: the project's high-priority issue rule emails the
    // owner on a new error issue and skips warnings, so each date's first
    // event is the email and no Sentry rule is needed.
    level: 'error',
    tags: { snapshot_gap: 'missing_yesterday_fields' },
    fingerprint: ['snapshot-missing-yesterday-fields', date],
    extra: context,
  });
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
    const { date, entryTime, isBacktest, quotedAt } = parsed.data;
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
    // A weekend or NYSE holiday owns no snapshot rows, live or replayed. The
    // client guards only its live path, so a stale tab, a direct POST or a
    // backtest save can still get here. Every skip is logged; only a live
    // save reaches Sentry, because it means a stale tab or a bad POST. A
    // backtest save on a closed date is expected.
    if (!isTradingDay(date)) {
      logger.warn(
        { date, entryTime, isBacktest },
        'Skipped a snapshot save for a non-trading day',
      );
      if (isBacktest !== true) {
        Sentry.captureMessage('snapshot.save_for_non_trading_day', {
          level: 'warning',
          extra: { date, entryTime, isBacktest },
        });
      }
      done({ status: 200 });
      return res
        .status(200)
        .json({ id: null, saved: false, skipped: 'non-trading-day' });
    }
    if (isBacktest !== true) {
      const verdict = checkQuoteFreshness({
        date,
        entryTime,
        quotedAt,
        nowMs: Date.now(),
      });
      if (!verdict.ok) {
        const { reason, slotMs, behindMs } = verdict;
        const context = {
          date,
          entryTime,
          quotedAtIso: isoOrNull(quotedAt),
          slotIso: isoOrNull(slotMs),
          behindMs,
        };
        logger.warn(
          { ...context, reason },
          'Refused a live snapshot save: the quote is not fresh',
        );
        metrics.increment('snapshot.quote_refused');
        if (alertsOnRefusal(date, verdict)) {
          // The title names the reason, so an alert email says why; the
          // fingerprint keeps one issue per reason.
          Sentry.captureMessage(`snapshot.stale_quote: ${reason}`, {
            level: 'error',
            tags: { reason },
            fingerprint: ['snapshot.stale_quote', reason],
            extra: context,
          });
        }
        res.setHeader('Cache-Control', 'no-store');
        done({ status: 422, error: reason });
        return res
          .status(422)
          .json({ error: 'quote-not-fresh', reason, saved: false });
      }
    }

    const { isEventDay, eventNames } = await resolveEventFlags(
      date,
      parsed.data.eventNames,
    );
    const id = await saveSnapshot({ ...parsed.data, isEventDay, eventNames });

    // Saved as sent: no refusal, so the slot keeps a row. Reported only once
    // the row is in (a failed save throws past this), and never for a replay.
    if (isBacktest !== true) {
      reportMissingYesterdayFields(
        date,
        entryTime,
        parsed.data.rvAnnualized,
        parsed.data.clusterMult,
      );
    }

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
