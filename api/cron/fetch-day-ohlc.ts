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

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import { getETDateStr } from '../../src/utils/timezone.js';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const targetDate = yesterdayEt();
  const sidecarUrl = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');

  if (!sidecarUrl) {
    logger.warn('fetch-day-ohlc: SIDECAR_URL not configured');
    return res.status(200).json({
      job: 'fetch-day-ohlc',
      skipped: true,
      reason: 'SIDECAR_URL missing',
    });
  }

  try {
    // Single-date batch call. The endpoint's from=to semantics return
    // zero rows on non-trading days (weekends, NYSE holidays) — that's
    // a legit "skip this run" signal, not an error.
    const url =
      `${sidecarUrl}/archive/day-summary-batch` +
      `?from=${encodeURIComponent(targetDate)}&to=${encodeURIComponent(targetDate)}`;
    const sidecarRes = await fetch(url);
    if (!sidecarRes.ok) {
      throw new Error(`sidecar ${sidecarRes.status}`);
    }
    const body = (await sidecarRes.json()) as { rows?: SummaryRow[] };
    const rows = body.rows ?? [];

    if (rows.length === 0) {
      logger.info(
        { targetDate },
        'fetch-day-ohlc: no rows from sidecar (holiday/weekend/halt)',
      );
      return res.status(200).json({
        job: 'fetch-day-ohlc',
        targetDate,
        skipped: true,
        reason: 'no rows from sidecar',
      });
    }

    const row = rows[0]!;
    if (
      typeof row.open !== 'number' ||
      typeof row.high !== 'number' ||
      typeof row.low !== 'number' ||
      typeof row.close !== 'number'
    ) {
      throw new Error('sidecar returned row without structured OHLC');
    }

    const sql = getDb();
    const result = await sql`
      UPDATE day_embeddings SET
        day_open  = ${row.open},
        day_high  = ${row.high},
        day_low   = ${row.low},
        day_close = ${row.close},
        range_pt  = ${row.range ?? row.high - row.low},
        up_exc    = ${row.up_excursion ?? row.high - row.open},
        down_exc  = ${row.down_excursion ?? row.open - row.low}
      WHERE date = ${targetDate}::date
      RETURNING date
    `;

    const updated = result.length;
    const durationMs = Date.now() - startTime;

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
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          range: row.range,
          upExc: row.up_excursion,
          downExc: row.down_excursion,
          durationMs,
        },
        'fetch-day-ohlc: updated',
      );
    }

    await reportCronRun('fetch-day-ohlc', {
      status: 'ok',
      targetDate,
      updated,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-day-ohlc',
      targetDate,
      updated,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-day-ohlc');
    Sentry.captureException(err);
    logger.error({ err, targetDate }, 'fetch-day-ohlc failed');
    return res.status(500).json({ error: 'Internal error' });
  }
}
