/**
 * GET /api/cron/fetch-day-ohlc[?date=YYYY-MM-DD]
 *
 * Nightly cron that populates the OHLC + excursion columns on the
 * day_embeddings row for the most recent trading day. The source is the
 * `index_candles_1m (SPX)` regular-session bars (Postgres, fed in real
 * time). The sidecar archive is frozen at 2026-04-17 and the target is
 * always a later date, so this cron makes no sidecar call.
 *
 * Kept intentionally simple — no embedding generation, no migration
 * logic, just an UPDATE on the columns added by migration #76. If the
 * row for the target date doesn't exist (embed-yesterday skipped or
 * failed it), the UPDATE matches nothing and the run reports a skip.
 *
 * Target: the trading day before today (ET), holiday-aware. The row is
 * written by embed-yesterday at 07:00 UTC the morning after, so the
 * target must be a day whose row already exists: Tue's run labels Mon,
 * Sat's run labels Fri. (The old Mon–Fri "yesterday" schedule labelled
 * Sunday on Mondays and never reached a Friday.)
 *
 * Manual rebuild: `GET ...?date=2026-09-21` with the CRON_SECRET bearer
 * labels that ET date instead of the prior trading day. It exists for a
 * day whose bars were repaired after the nightly run labelled it (or
 * after embed-yesterday wrote its row): nothing else ever targets a past
 * day again. Triggered by hand; Vercel's scheduler sends no query. The
 * date is validated like embed-yesterday's (`api/_lib/cron-target-date.ts`):
 * a real YYYY-MM-DD calendar date strictly BEFORE today (ET). Anything
 * else (a bad format, today, a later day, a repeated param) throws before
 * any source is read, and the wrapper answers 500 `{ error }` naming the
 * cause. The override runs the same path as the nightly target: the
 * same skips below, the same Postgres read and UPDATE. It cannot force a
 * partial day through. Re-running a day is safe: the UPDATE is idempotent.
 * A weekend or market holiday skips as `not_trading_day`, with no
 * warning, because it has no session rather than a failed feed.
 *
 * The scheduled target is always a trading day, so a day with no bars, or
 * fewer regular-session bars than the session has, means the feed failed:
 * the run skips with a Sentry warning rather than writing a label from
 * it. A DB reject while reading fails the run.
 *
 * Schedule: 0 23 * * 2-6   (6 PM CT Tue-Sat — after ES settles at
 *                           4 PM CT)
 *
 * Environment: CRON_SECRET, DATABASE_URL
 */

import {
  InvalidDateParamError,
  resolveTargetDate,
} from '../_lib/cron-target-date.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { readDayOhlcFromPostgres } from '../_lib/postgres-day-summary.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  cashSessionMinutes,
  isTradingDay,
  priorTradingDay,
} from '../../src/data/marketHours.js';
import {
  withCronInstrumentation,
  type CronResult,
  type CronContext,
} from '../_lib/cron-instrumentation.js';

/**
 * Skip a trading day the feed failed on, loudly: warn log, metric and a
 * Sentry warning (the 07-23 → 09-07 SPX hole went unseen for six weeks
 * behind an info-level skip).
 */
function feedFailureSkip(
  logger: CronContext['logger'],
  reason: 'no_bars' | 'incomplete_day',
  detail: { targetDate: string; barCount: number; expectedBars: number },
): CronResult {
  logger.warn(detail, `fetch-day-ohlc: ${reason}, not labelling`);
  metrics.increment(`fetch_day_ohlc.${reason}`);
  Sentry.captureMessage(`fetch-day-ohlc: ${reason}, day not labelled`, {
    level: 'warning',
    extra: detail,
  });
  return {
    status: 'skipped',
    message: reason,
    metadata: { ...detail, skipped: true, reason },
  };
}

export default withCronInstrumentation(
  'fetch-day-ohlc',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    // ctx.today is the ET date; a 6 PM CT run is still "today" in ET.
    const targetDate = resolveTargetDate(
      ctx.req?.query.date,
      ctx.today,
      priorTradingDay,
      'fetch-day-ohlc',
    );
    // The schedule only ever targets a trading day. A `?date=` can name a
    // weekend or a holiday, which has no bars because it has no session:
    // not a feed failure, so no warning.
    if (!isTradingDay(targetDate)) {
      logger.info(
        { targetDate },
        'fetch-day-ohlc: target is not a trading day',
      );
      metrics.increment('fetch_day_ohlc.not_trading_day');
      return {
        status: 'skipped',
        message: 'not_trading_day',
        metadata: { targetDate, skipped: true, reason: 'not_trading_day' },
      };
    }
    // The one source of the OHLC; kept in the run result and the log so
    // the key stays continuous with earlier runs.
    const source = 'postgres';

    // Read index_candles_1m (SPX). A DB reject propagates so the run
    // reports an error, not a skip.
    const pg = await readDayOhlcFromPostgres(targetDate);
    const expectedBars = cashSessionMinutes(targetDate);
    if (!pg) {
      return feedFailureSkip(logger, 'no_bars', {
        targetDate,
        barCount: 0,
        expectedBars,
      });
    }
    if (pg.barCount < expectedBars) {
      return feedFailureSkip(logger, 'incomplete_day', {
        targetDate,
        barCount: pg.barCount,
        expectedBars,
      });
    }
    const ohlc = {
      open: pg.ohlc.open,
      high: pg.ohlc.high,
      low: pg.ohlc.low,
      close: pg.ohlc.close,
      range: pg.ohlc.range,
      upExc: pg.ohlc.up_excursion,
      downExc: pg.ohlc.down_excursion,
    };

    const sql = getDb();
    const result = await withDbRetry(
      () => sql`
        UPDATE day_embeddings SET
          day_open  = ${ohlc.open},
          day_high  = ${ohlc.high},
          day_low   = ${ohlc.low},
          day_close = ${ohlc.close},
          range_pt  = ${ohlc.range},
          up_exc    = ${ohlc.upExc},
          down_exc  = ${ohlc.downExc}
        WHERE date = ${targetDate}::date
        RETURNING date
      `,
      2,
      10_000,
    );

    const updated = result.length;

    if (updated === 0) {
      // No day_embeddings row: embed-yesterday (07:00 UTC, same day)
      // skipped or failed this date. Nothing was written, so this run
      // is a skip, not a success; embed-yesterday's own skip/error is
      // the alert. A later run targets a later day and won't revisit.
      logger.info(
        { targetDate },
        'fetch-day-ohlc: no day_embeddings row for target date',
      );
      return {
        status: 'skipped',
        message: 'no_day_embeddings_row',
        metadata: {
          targetDate,
          source,
          updated,
          skipped: true,
          reason: 'no_day_embeddings_row',
        },
      };
    }

    logger.info(
      {
        targetDate,
        source,
        open: ohlc.open,
        high: ohlc.high,
        low: ohlc.low,
        close: ohlc.close,
        range: ohlc.range,
        upExc: ohlc.upExc,
        downExc: ohlc.downExc,
      },
      'fetch-day-ohlc: updated',
    );

    return {
      status: 'success',
      metadata: { targetDate, source, updated },
    };
  },
  {
    marketHours: false,
    requireApiKey: false,
    // `?date=` is read from the request.
    passReq: true,
    // A rejected `?date=` says why and names no date: no day was targeted.
    // Any other error returns {}, which keeps the wrapper's own
    // `{ job, error: 'Internal error' }` body.
    errorPayload: (err) =>
      err instanceof InvalidDateParamError ? { error: err.message } : {},
  },
);
