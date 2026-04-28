/**
 * GET /api/cron/fetch-futures-snapshot
 *
 * Runs every 5 minutes during market hours. Queries latest bars from
 * futures_bars for each symbol, computes 1H change / day change /
 * volume ratio, and upserts into futures_snapshots. Also computes
 * derived cross-symbol metrics (VX term spread, ES-SPX basis).
 *
 * Schedule: every 5 min, 13-21 UTC, Mon-Fri
 *
 * Environment: CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { cronGuard, withRetry } from '../_lib/api-helpers.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  FUTURES_SYMBOLS,
  computeSnapshot,
  type SnapshotRow,
} from '../_lib/futures-derive.js';

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Futures trade Sun 5 PM CT – Fri 5 PM CT; skip stock market hours check
  const guard = cronGuard(req, res, {
    requireApiKey: false,
    marketHours: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const tradeDate = getETDateStr(new Date());
  const now = new Date();
  const sql = getDb();

  try {
    // Compute snapshots for each symbol in parallel
    const results = await Promise.allSettled(
      FUTURES_SYMBOLS.map((sym) =>
        withRetry(() => computeSnapshot(sym, tradeDate, now)),
      ),
    );

    const snapshots: SnapshotRow[] = [];
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const symbol = FUTURES_SYMBOLS[i]!;
      if (result.status === 'fulfilled' && result.value) {
        snapshots.push(result.value);
      } else if (result.status === 'rejected') {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : 'Unknown error';
        errors.push(`${symbol}: ${msg}`);
        logger.warn({ symbol, err: result.reason }, 'Snapshot failed');
        Sentry.captureException(result.reason);
      }
    }

    // Upsert each snapshot
    const ts = now.toISOString();
    for (const snap of snapshots) {
      await sql`
        INSERT INTO futures_snapshots (
          trade_date, ts, symbol, price,
          change_1h_pct, change_day_pct, volume_ratio
        ) VALUES (
          ${tradeDate}, ${ts}, ${snap.symbol}, ${snap.price},
          ${snap.change1hPct}, ${snap.changeDayPct}, ${snap.volumeRatio}
        )
        ON CONFLICT (symbol, ts) DO UPDATE SET
          price = EXCLUDED.price,
          change_1h_pct = EXCLUDED.change_1h_pct,
          change_day_pct = EXCLUDED.change_day_pct,
          volume_ratio = EXCLUDED.volume_ratio
      `;
    }

    if (snapshots.length === 0 && errors.length > 0) {
      return res.status(500).json({
        error: 'All symbols failed',
        errors,
      });
    }

    logger.info(
      {
        tradeDate,
        stored: snapshots.length,
        skipped: FUTURES_SYMBOLS.length - snapshots.length,
        errors: errors.length,
        symbols: snapshots.map((s) => s.symbol),
      },
      'fetch-futures-snapshot completed',
    );

    const durationMs = Date.now() - startTime;

    await reportCronRun('fetch-futures-snapshot', {
      status: 'ok',
      stored: snapshots.length,
      skipped: FUTURES_SYMBOLS.length - snapshots.length,
      symbolsCount: FUTURES_SYMBOLS.length,
      errorsCount: errors.length,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-futures-snapshot',
      stored: snapshots.length,
      skipped: FUTURES_SYMBOLS.length - snapshots.length,
      symbols: snapshots.map((s) => ({
        symbol: s.symbol,
        price: s.price,
        change1hPct: s.change1hPct,
        changeDayPct: s.changeDayPct,
      })),
      errors: errors.length > 0 ? errors : undefined,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-futures-snapshot');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-futures-snapshot failed');
    return res.status(500).json({ error: 'Internal error' });
  }
}
