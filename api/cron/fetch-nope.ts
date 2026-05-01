/**
 * GET /api/cron/fetch-nope
 *
 * Fetches UW NOPE (Net Options Pricing Effect) per-minute data for SPY and
 * upserts into nope_ticks. Runs every minute during market hours.
 *
 * Why SPY, not SPX: NOPE's denominator is underlying stock_vol. SPX has no
 * tradable shares, so SPX NOPE is not meaningful. SPY acts as the practical
 * proxy for 0DTE SPX hedging pressure since dealers hedge SPX options via
 * SPY (and ES), not the index itself.
 *
 * UW returns the full day each call. We rely on primary-key UPSERT for
 * idempotence — stable (historical) minutes are DO-NOTHING, the trailing
 * minute gets DO-UPDATE as fills accumulate.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cronGuard,
  cronJitter,
  uwFetch,
  withRetry,
} from '../_lib/api-helpers.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export interface UwNopeRow {
  timestamp: string;
  call_vol: number;
  put_vol: number;
  stock_vol: number;
  call_delta: string;
  put_delta: string;
  call_fill_delta: string;
  put_fill_delta: string;
  nope: string;
  nope_fill: string;
}

const NOPE_TICKER = 'SPY';
const NOPE_PATH = `/stock/${NOPE_TICKER}/nope`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey } = guard;

  await cronJitter();

  const startedAt = Date.now();

  try {
    const rows = await withRetry(() => uwFetch<UwNopeRow>(apiKey, NOPE_PATH));

    if (rows.length === 0) {
      return res.status(200).json({
        job: 'fetch-nope',
        fetched: 0,
        upserted: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    const db = getDb();

    // Filter out rows with invalid numerics (UW returns partial rows at
    // session edges occasionally) before building the upsert payload.
    const ingestedAt = new Date().toISOString();
    const validRows: Array<{
      ticker: string;
      timestamp: string;
      call_vol: number;
      put_vol: number;
      stock_vol: number;
      call_delta: string;
      put_delta: string;
      call_fill_delta: string;
      put_fill_delta: string;
      nope: string;
      nope_fill: string;
      ingested_at: string;
    }> = [];
    let skipped = 0;
    for (const r of rows) {
      if (
        !Number.isFinite(Number.parseFloat(r.nope)) ||
        !Number.isFinite(r.stock_vol) ||
        r.stock_vol <= 0
      ) {
        skipped++;
        continue;
      }
      validRows.push({
        ticker: NOPE_TICKER,
        timestamp: r.timestamp,
        call_vol: r.call_vol,
        put_vol: r.put_vol,
        stock_vol: r.stock_vol,
        call_delta: r.call_delta,
        put_delta: r.put_delta,
        call_fill_delta: r.call_fill_delta,
        put_fill_delta: r.put_fill_delta,
        nope: r.nope,
        nope_fill: r.nope_fill,
        // ingested_at is updated on every upsert (matches the legacy
        // `ingested_at = now()` SET clause) by including it in the
        // column list — bulkUpsert defaults to EXCLUDED.col on conflict.
        ingested_at: ingestedAt,
      });
    }

    // ON CONFLICT DO UPDATE always yields a returned row, so the legacy
    // `upserted` count was effectively `validRows.length`. Preserved
    // verbatim by reusing that count after the bulk insert.
    await bulkUpsert({
      sql: db,
      table: 'nope_ticks',
      columns: [
        'ticker',
        'timestamp',
        'call_vol',
        'put_vol',
        'stock_vol',
        'call_delta',
        'put_delta',
        'call_fill_delta',
        'put_fill_delta',
        'nope',
        'nope_fill',
        'ingested_at',
      ],
      rows: validRows,
      conflictTarget: '(ticker, timestamp)',
    });
    const upserted = validRows.length;

    if (skipped > 0) {
      logger.warn(
        { skipped, fetched: rows.length },
        'fetch-nope skipped rows with invalid stock_vol or nope',
      );
    }

    logger.info(
      { fetched: rows.length, upserted, skipped },
      'fetch-nope completed',
    );

    return res.status(200).json({
      job: 'fetch-nope',
      fetched: rows.length,
      upserted,
      skipped,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-nope');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-nope error');
    return res.status(500).json({
      job: 'fetch-nope',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
