/**
 * GET /api/cron/fetch-day-ohlc
 *
 * Nightly cron that populates the OHLC + excursion columns on the
 * day_embeddings row for the most recent trading day. The sidecar's
 * /archive/day-summary-batch is asked first, but its archive is frozen
 * at 2026-04-17, so in practice the source is `index_candles_1m (SPX)`
 * regular-session bars (Postgres, fed in real time).
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
 * The target is always a trading day, so a day with no bars, or fewer
 * regular-session bars than the session has, means the feed failed:
 * the run skips with a Sentry warning rather than writing a label from
 * it. A DB reject while reading fails the run.
 *
 * Schedule: 0 23 * * 2-6   (6 PM CT Tue-Sat — after ES settles at
 *                           4 PM CT)
 *
 * Environment: CRON_SECRET, SIDECAR_URL, DATABASE_URL
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { readDayOhlcFromPostgres } from '../_lib/postgres-day-summary.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  cashSessionMinutes,
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

interface SummaryRow {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  range?: number;
  up_excursion?: number;
  down_excursion?: number;
}

export default withCronInstrumentation(
  'fetch-day-ohlc',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    // ctx.today is the ET date; a 6 PM CT run is still "today" in ET.
    const targetDate = priorTradingDay(ctx.today);
    const sidecarUrl = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');

    if (!sidecarUrl) {
      logger.warn('fetch-day-ohlc: SIDECAR_URL not configured');
      return {
        status: 'skipped',
        message: 'SIDECAR_URL missing',
        metadata: { skipped: true, reason: 'SIDECAR_URL missing' },
      };
    }

    // Single-date batch call. The archive is frozen at 2026-04-17, so for
    // any newer date it answers `rows: []` or 404 — both mean "not in the
    // archive" and fall through to Postgres. 5xx and other non-ok
    // statuses still escalate.
    const url =
      `${sidecarUrl}/archive/day-summary-batch` +
      `?from=${encodeURIComponent(targetDate)}&to=${encodeURIComponent(targetDate)}`;
    const sidecarRes = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!sidecarRes.ok && sidecarRes.status !== 404) {
      throw new Error(`sidecar ${sidecarRes.status}`);
    }
    const body = sidecarRes.ok
      ? ((await sidecarRes.json()) as { rows?: SummaryRow[] })
      : { rows: [] as SummaryRow[] };
    const sidecarRow = body.rows?.[0];

    interface ResolvedOhlc {
      open: number;
      high: number;
      low: number;
      close: number;
      range: number;
      upExc: number;
      downExc: number;
    }

    let ohlc: ResolvedOhlc;
    let source: 'sidecar' | 'postgres';

    if (
      sidecarRow &&
      typeof sidecarRow.open === 'number' &&
      typeof sidecarRow.high === 'number' &&
      typeof sidecarRow.low === 'number' &&
      typeof sidecarRow.close === 'number'
    ) {
      ohlc = {
        open: sidecarRow.open,
        high: sidecarRow.high,
        low: sidecarRow.low,
        close: sidecarRow.close,
        range: sidecarRow.range ?? sidecarRow.high - sidecarRow.low,
        upExc: sidecarRow.up_excursion ?? sidecarRow.high - sidecarRow.open,
        downExc: sidecarRow.down_excursion ?? sidecarRow.open - sidecarRow.low,
      };
      source = 'sidecar';
    } else {
      // Not in the (frozen) archive: read index_candles_1m (SPX). A DB
      // reject propagates so the run reports an error, not a skip.
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
      ohlc = {
        open: pg.ohlc.open,
        high: pg.ohlc.high,
        low: pg.ohlc.low,
        close: pg.ohlc.close,
        range: pg.ohlc.range,
        upExc: pg.ohlc.up_excursion,
        downExc: pg.ohlc.down_excursion,
      };
      source = 'postgres';
      metrics.increment('fetch_day_ohlc.postgres_fallback');
      logger.info({ targetDate }, 'fetch-day-ohlc: using Postgres fallback');
    }

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
  { marketHours: false, requireApiKey: false },
);
