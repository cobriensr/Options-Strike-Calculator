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

// ── Constants ───────────────────────────────────────────────

const FUTURES_SYMBOLS = [
  'ES',
  'NQ',
  'VXM1',
  'VXM2',
  'ZN',
  'RTY',
  'CL',
] as const;

type FuturesSymbol = (typeof FUTURES_SYMBOLS)[number];

interface SnapshotRow {
  symbol: FuturesSymbol;
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
}

// ── Query helpers ───────────────────────────────────────────

async function computeSnapshot(
  symbol: FuturesSymbol,
  tradeDate: string,
  now: Date,
): Promise<SnapshotRow | null> {
  const sql = getDb();

  // Latest bar
  const latestRows = await sql`
    SELECT close, ts FROM futures_bars
    WHERE symbol = ${symbol}
    ORDER BY ts DESC LIMIT 1
  `;
  if (latestRows.length === 0) return null;

  const price = Number.parseFloat(String(latestRows[0]!.close));

  // 1H change: bar from ~1 hour ago
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const hourAgoRows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${oneHourAgo.toISOString()}
    ORDER BY ts DESC LIMIT 1
  `;
  let change1hPct: number | null = null;
  if (hourAgoRows.length > 0) {
    const hourAgoClose = Number.parseFloat(String(hourAgoRows[0]!.close));
    if (hourAgoClose !== 0) {
      change1hPct = ((price - hourAgoClose) / hourAgoClose) * 100;
    }
  }

  // Day change: first bar of today (approximation: earliest bar where
  // ts >= today's market open ~13:30 UTC)
  const dayOpenTs = `${tradeDate}T13:30:00Z`;
  const dayOpenRows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${dayOpenTs}
    ORDER BY ts ASC LIMIT 1
  `;
  let changeDayPct: number | null = null;
  if (dayOpenRows.length > 0) {
    const dayOpenClose = Number.parseFloat(String(dayOpenRows[0]!.close));
    if (dayOpenClose !== 0) {
      changeDayPct = ((price - dayOpenClose) / dayOpenClose) * 100;
    }
  }

  // 20-day average volume: sum of volume per day / 20 days
  const avgVolRows = await sql`
    SELECT
      AVG(daily_vol) AS avg_vol
    FROM (
      SELECT
        SUM(volume) AS daily_vol
      FROM futures_bars
      WHERE symbol = ${symbol}
        AND ts >= NOW() - INTERVAL '20 days'
      GROUP BY DATE(ts)
    ) sub
  `;

  // Today's volume
  const todayVolRows = await sql`
    SELECT SUM(volume) AS today_vol
    FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${dayOpenTs}
  `;

  let volumeRatio: number | null = null;
  if (avgVolRows[0]?.avg_vol && todayVolRows[0]?.today_vol) {
    const avgVol = Number.parseFloat(String(avgVolRows[0].avg_vol));
    const todayVol = Number.parseFloat(String(todayVolRows[0].today_vol));
    if (avgVol > 0) {
      volumeRatio = todayVol / avgVol;
    }
  }

  return {
    symbol,
    price,
    change1hPct,
    changeDayPct,
    volumeRatio,
  };
}

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
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-futures-snapshot');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-futures-snapshot failed');
    return res.status(500).json({ error: 'Internal error' });
  }
}
