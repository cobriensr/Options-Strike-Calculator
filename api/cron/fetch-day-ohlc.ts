/**
 * GET /api/cron/fetch-day-ohlc
 *
 * Nightly cron that populates the OHLC + excursion columns on the
 * day_embeddings row for the most recent trading day. Sources the data
 * from the sidecar's /archive/day-summary-batch endpoint (which emits
 * structured open/high/low/close/range/up_excursion/down_excursion
 * alongside the existing text summary).
 *
 * Kept intentionally simple — no embedding generation, no migration
 * logic, just an UPDATE on the columns added by migration #76. If the
 * row for `date` doesn't exist yet (the embedding backfill runs on its
 * own schedule), the UPDATE silently no-ops; the next run will catch
 * up once the embedding cron lands that row.
 *
 * Schedule: 0 23 * * 1-5   (6 PM CT Mon-Fri — after ES settles at
 *                           4 PM CT and the sidecar's nightly DBN drop
 *                           has been applied)
 *
 * Environment: CRON_SECRET, SIDECAR_URL, DATABASE_URL
 */

import { getDb } from '../_lib/db.js';
import { fetchDayOhlcFromPostgres } from '../_lib/postgres-day-summary.js';
import { metrics } from '../_lib/sentry.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

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

function yesterdayEt(): string {
  // ET-aware "yesterday" — a 6 PM CT cron still resolves to "today" in
  // ET terms, so back up by one calendar day for the trading-date key.
  const today = getETDateStr(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default withCronInstrumentation(
  'fetch-day-ohlc',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    const targetDate = yesterdayEt();
    const sidecarUrl = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');

    if (!sidecarUrl) {
      logger.warn('fetch-day-ohlc: SIDECAR_URL not configured');
      return {
        status: 'skipped',
        message: 'SIDECAR_URL missing',
        metadata: { skipped: true, reason: 'SIDECAR_URL missing' },
      };
    }

    // Single-date batch call. The endpoint's from=to semantics return
    // zero rows on non-trading days (weekends, NYSE holidays) — that's
    // a legit "skip this run" signal, not an error.
    const url =
      `${sidecarUrl}/archive/day-summary-batch` +
      `?from=${encodeURIComponent(targetDate)}&to=${encodeURIComponent(targetDate)}`;
    const sidecarRes = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!sidecarRes.ok) {
      throw new Error(`sidecar ${sidecarRes.status}`);
    }
    const body = (await sidecarRes.json()) as { rows?: SummaryRow[] };
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
      // Sidecar archive doesn't have structured OHLC for this date —
      // most often because the parquet hasn't been refreshed since the
      // last Databento batch. Fall back to spx_candles_1m which the
      // streaming feed populates in real-time. When the parquet catches
      // up, a future cron run will overwrite these values.
      const pg = await fetchDayOhlcFromPostgres(targetDate);
      if (!pg) {
        logger.info(
          { targetDate },
          'fetch-day-ohlc: no rows from sidecar or Postgres (holiday/weekend/halt)',
        );
        return {
          status: 'skipped',
          message: 'no rows from sidecar',
          metadata: {
            targetDate,
            skipped: true,
            reason: 'no rows from sidecar',
          },
        };
      }
      ohlc = {
        open: pg.open,
        high: pg.high,
        low: pg.low,
        close: pg.close,
        range: pg.range,
        upExc: pg.up_excursion,
        downExc: pg.down_excursion,
      };
      source = 'postgres';
      metrics.increment('fetch_day_ohlc.postgres_fallback');
      logger.info({ targetDate }, 'fetch-day-ohlc: using Postgres fallback');
    }

    const sql = getDb();
    const result = await sql`
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
    `;

    const updated = result.length;

    if (updated === 0) {
      // day_embeddings row doesn't exist yet — the embedding cron hasn't
      // landed it. This is a soft warning, not an error: the next run
      // will catch up once that row exists.
      logger.info(
        { targetDate },
        'fetch-day-ohlc: no day_embeddings row yet; will retry next run',
      );
    } else {
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
    }

    return {
      status: 'success',
      metadata: { targetDate, source, updated },
    };
  },
  { marketHours: false, requireApiKey: false },
);
