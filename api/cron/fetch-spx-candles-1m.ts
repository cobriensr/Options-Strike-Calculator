/**
 * GET /api/cron/fetch-spx-candles-1m
 *
 * Fetches 1-minute OHLCV candles from the Unusual Whales API and stores
 * them in the spx_candles_1m table. Runs every minute during market
 * hours (13-21 UTC, Mon-Fri) alongside fetch-gex-0dte so each GEX
 * snapshot has a matching price bar.
 *
 * SPY → SPX translation: Cboe prohibits external distribution of
 * proprietary index OHLC (SPX, VIX, RUT, etc.) via API — only their
 * web platform is allowed. We fetch SPY candles and multiply by the
 * SPX/SPY ratio (10×) to produce approximate SPX bars. This mirrors
 * the existing on-demand path in api/_lib/spx-candles.ts.
 *
 * Role in the GexTarget rebuild:
 *   - Powers the Phase 4 price-chart panel (price vs gamma walls)
 *   - Replaces the analyze endpoint's on-demand UW fetch with a
 *     pre-baked 1-minute series read from Postgres. Subagent 3B
 *     rewrites api/_lib/spx-candles.ts to consume this table.
 *
 * Storage:
 *   - All candles returned by UW are stored, including premarket
 *     (`pr`) and postmarket (`po`). Filtering is done by the reader
 *     so future premarket/postmarket use cases aren't blocked.
 *   - ON CONFLICT (date, timestamp) DO NOTHING keeps the cron
 *     idempotent when UW returns a timestamp we already have.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';

const SPY_TO_SPX_RATIO = 10;

// ── Types ───────────────────────────────────────────────────

/** UW 1-minute candle row from /stock/SPY/ohlc/1m. */
interface UWCandleRow {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  total_volume: number;
  start_time: string; // ISO timestamp: "2026-04-08T23:22:00Z"
  end_time: string;
  market_time: 'pr' | 'r' | 'po';
}

/** Normalized row ready for insert into spx_candles_1m. */
interface SPXCandleRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  market_time: 'pr' | 'r' | 'po';
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchSPYCandles1m(
  apiKey: string,
  date: string,
): Promise<UWCandleRow[]> {
  const params = new URLSearchParams({
    date,
    limit: '500',
  });

  return uwFetch<UWCandleRow>(apiKey, `/stock/SPY/ohlc/1m?${params}`);
}

// ── Transform helper ────────────────────────────────────────

/**
 * Translate UW SPY rows into SPX-equivalent DB rows.
 * Filters out any row with NaN OHLC values (defensive).
 */
function translateRows(rows: UWCandleRow[]): SPXCandleRow[] {
  const translated: SPXCandleRow[] = [];

  for (const row of rows) {
    const open = Number.parseFloat(row.open) * SPY_TO_SPX_RATIO;
    const high = Number.parseFloat(row.high) * SPY_TO_SPX_RATIO;
    const low = Number.parseFloat(row.low) * SPY_TO_SPX_RATIO;
    const close = Number.parseFloat(row.close) * SPY_TO_SPX_RATIO;

    if (
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close)
    ) {
      metrics.increment('fetch_spx_candles_1m.ohlc_invalid');
      continue;
    }

    translated.push({
      timestamp: new Date(row.start_time).toISOString(),
      open,
      high,
      low,
      close,
      volume: row.volume,
      market_time: row.market_time,
    });
  }

  return translated;
}

// ── Store helper ────────────────────────────────────────────

async function storeCandles(
  rows: SPXCandleRow[],
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      rows.map(
        (row) => txn`
          INSERT INTO spx_candles_1m (
            date, timestamp, open, high, low, close, volume, market_time
          )
          VALUES (
            ${today}, ${row.timestamp},
            ${row.open}, ${row.high}, ${row.low}, ${row.close},
            ${row.volume}, ${row.market_time}
          )
          ON CONFLICT (date, timestamp) DO NOTHING
          RETURNING id
        `,
      ),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return { stored, skipped: rows.length - stored };
  } catch (err) {
    logger.warn({ err }, 'Batch spx_candles_1m insert failed');
    return { stored: 0, skipped: rows.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const rawRows = await withRetry(() => fetchSPYCandles1m(apiKey, today));

    if (rawRows.length === 0) {
      return res.status(200).json({ stored: false, reason: 'No 1m candles' });
    }

    const translated = translateRows(rawRows);

    if (translated.length === 0) {
      return res
        .status(200)
        .json({ stored: false, reason: 'No valid 1m candles after filter' });
    }

    const result = await withRetry(() => storeCandles(translated, today));

    logger.info(
      {
        total: rawRows.length,
        valid: translated.length,
        stored: result.stored,
        skipped: result.skipped,
        date: today,
      },
      'fetch-spx-candles-1m completed',
    );

    // Data quality check: premarket/postmarket bars frequently have
    // zero volume, so we gate "nonzero" on volume > 0 rather than
    // OHLC values. If we have enough rows for the day but literally
    // none have volume, UW is returning synthetic/empty data.
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE volume > 0) AS nonzero
        FROM spx_candles_1m
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-spx-candles-1m',
        table: 'spx_candles_1m',
        date: today,
        sourceFilter: '1-minute SPY candles translated to SPX',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    return res.status(200).json({
      job: 'fetch-spx-candles-1m',
      success: true,
      stored: result.stored,
      skipped: result.skipped,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-spx-candles-1m');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-spx-candles-1m error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
