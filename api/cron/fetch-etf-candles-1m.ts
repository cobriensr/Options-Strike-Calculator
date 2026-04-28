/**
 * GET /api/cron/fetch-etf-candles-1m
 *
 * Fetches 1-minute OHLCV candles for SPY and QQQ from the Unusual Whales
 * /stock/{ticker}/ohlc/1m endpoint and stores them as raw prices in the
 * etf_candles_1m table.
 *
 * Why this cron exists instead of reusing fetch-spx-candles-1m:
 *   fetch-spx-candles-1m also fetches SPY from UW, but it multiplies every
 *   bar by the live SPX/SPY ratio to produce SPX-equivalent prices before
 *   storing — the stored values are NOT raw SPY OHLC. This cron stores the
 *   raw ETF prices untouched, which is what the spike-return enrichment
 *   cron needs to compute accurate 5/15/30-min forward returns on each
 *   vega_spike_events row.
 *
 * Phase 5 of the Dir Vega Spike Monitor:
 *   The enrich-vega-spike-returns cron (Phase 5b) reads etf_candles_1m to
 *   look up the close price N minutes after each spike timestamp and writes
 *   fwd_return_5m / fwd_return_15m / fwd_return_30m back onto the spike row.
 *
 * Storage: etf_candles_1m (migration #94).
 * Unique constraint: (ticker, timestamp) — ON CONFLICT DO NOTHING.
 *
 * Total API calls per invocation: 2 (SPY + QQQ in parallel)
 *
 * Schedule: vercel.json registers `* 13-21 * * 1-5` (every minute).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

interface UWCandleRow {
  start_time: string; // ISO timestamp: "2026-04-27T14:32:00Z"
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: number;
}

// ── Store at 1-min resolution ────────────────────────────────

async function storeCandles(
  ticker: string,
  candles: UWCandleRow[],
): Promise<{ stored: number; skipped: number }> {
  if (candles.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const candle of candles) {
    try {
      const result = await sql`
        INSERT INTO etf_candles_1m (ticker, timestamp, open, high, low, close, volume)
        VALUES (
          ${ticker}, ${candle.start_time},
          ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close},
          ${candle.volume ?? null}
        )
        ON CONFLICT (ticker, timestamp) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn(
        { err, ticker, ts: candle.start_time },
        'ETF candle insert failed',
      );
      metrics.increment('fetch_etf_candles_1m.store_error');
      skipped++;
    }
  }

  return { stored, skipped };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const [spyCandles, qqqCandles] = await Promise.all([
      withRetry(() =>
        uwFetch<UWCandleRow>(apiKey, `/stock/SPY/ohlc/1m?date=${today}`),
      ),
      withRetry(() =>
        uwFetch<UWCandleRow>(apiKey, `/stock/QQQ/ohlc/1m?date=${today}`),
      ),
    ]);

    const [spyResult, qqqResult] = await Promise.all([
      storeCandles('SPY', spyCandles),
      storeCandles('QQQ', qqqCandles),
    ]);

    logger.info(
      {
        spy: { candles: spyCandles.length, ...spyResult },
        qqq: { candles: qqqCandles.length, ...qqqResult },
      },
      'fetch-etf-candles-1m completed',
    );

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-etf-candles-1m', {
      status: 'ok',
      spy_candles: spyCandles.length,
      spy_stored: spyResult.stored,
      spy_skipped: spyResult.skipped,
      qqq_candles: qqqCandles.length,
      qqq_stored: qqqResult.stored,
      qqq_skipped: qqqResult.skipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-etf-candles-1m',
      tickers: {
        SPY: { stored: spyResult.stored, skipped: spyResult.skipped },
        QQQ: { stored: qqqResult.stored, skipped: qqqResult.skipped },
      },
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-etf-candles-1m');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-etf-candles-1m error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
