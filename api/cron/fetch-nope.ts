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
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
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
    let upserted = 0;
    let skipped = 0;
    for (const r of rows) {
      // Skip rows where any required numeric failed to parse — UW has
      // historically returned partial rows at session edges.
      if (
        !Number.isFinite(Number.parseFloat(r.nope)) ||
        !Number.isFinite(r.stock_vol) ||
        r.stock_vol <= 0
      ) {
        skipped++;
        continue;
      }

      const result = await db`
        INSERT INTO nope_ticks (
          ticker, timestamp,
          call_vol, put_vol, stock_vol,
          call_delta, put_delta, call_fill_delta, put_fill_delta,
          nope, nope_fill
        ) VALUES (
          ${NOPE_TICKER}, ${r.timestamp},
          ${r.call_vol}, ${r.put_vol}, ${r.stock_vol},
          ${r.call_delta}, ${r.put_delta}, ${r.call_fill_delta}, ${r.put_fill_delta},
          ${r.nope}, ${r.nope_fill}
        )
        ON CONFLICT (ticker, timestamp) DO UPDATE SET
          call_vol        = EXCLUDED.call_vol,
          put_vol         = EXCLUDED.put_vol,
          stock_vol       = EXCLUDED.stock_vol,
          call_delta      = EXCLUDED.call_delta,
          put_delta       = EXCLUDED.put_delta,
          call_fill_delta = EXCLUDED.call_fill_delta,
          put_fill_delta  = EXCLUDED.put_fill_delta,
          nope            = EXCLUDED.nope,
          nope_fill       = EXCLUDED.nope_fill,
          ingested_at     = now()
        RETURNING ticker
      `;
      if (result.length > 0) upserted++;
    }

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
