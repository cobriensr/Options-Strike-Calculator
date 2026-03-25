/**
 * GET /api/cron/fetch-outcomes
 *
 * End-of-day cron that populates the outcomes table with public market data:
 *   - SPX settlement (close), day OHLC, range
 *   - VIX close, VIX1D close
 *
 * Runs after market close (~4:20-4:30 PM ET). Only executes between
 * 4:15 PM and 5:30 PM ET to avoid stale or unavailable data.
 *
 * Uses the Schwab pricehistory endpoint for SPX OHLC (5-min candles)
 * and the quotes endpoint for VIX/VIX1D close.
 *
 * Idempotent: ON CONFLICT (date) DO UPDATE — safe to run multiple times.
 *
 * Environment: SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { schwabFetch } from '../_lib/api-helpers.js';
import { saveOutcome } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

// ── Time window check ──────────────────────────────────────

function isAfterClose(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  // 4:15 PM = 975 min, 5:30 PM = 1050 min
  return totalMin >= 975 && totalMin <= 1050;
}

// ── Schwab response types ──────────────────────────────────

interface PriceCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // Unix ms
}

interface PriceHistoryResponse {
  candles: PriceCandle[];
  symbol: string;
  empty: boolean;
}

interface QuoteData {
  quote: {
    lastPrice: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
  };
}

interface QuotesResponse {
  [symbol: string]: QuoteData;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isAfterClose()) {
    return res.status(200).json({
      skipped: true,
      reason: 'Outside post-close window (4:15-5:30 PM ET)',
    });
  }

  const now = new Date();
  const dateStr = getETDateStr(now);

  try {
    // Fetch SPX intraday candles for today
    const start = now.getTime() - 24 * 60 * 60 * 1000;
    const end = now.getTime();

    const intradayResult = await schwabFetch<PriceHistoryResponse>(
      `/$SPX/pricehistory?periodType=day&frequencyType=minute&frequency=5` +
        `&startDate=${start}&endDate=${end}&needExtendedHoursData=false`,
    );

    if ('error' in intradayResult) {
      logger.error(
        { error: intradayResult.error },
        'fetch-outcomes: Schwab intraday fetch failed',
      );
      return res.status(502).json({ error: intradayResult.error });
    }

    // Filter to today's candles only (9:30 AM ET = 570 min)
    const candles = intradayResult.data.candles.filter((c) => {
      const cDate = new Date(c.datetime);
      const cDateStr = getETDateStr(cDate);
      if (cDateStr !== dateStr) return false;
      const { hour, minute } = getETTime(cDate);
      return hour * 60 + minute >= 570;
    });

    if (candles.length === 0) {
      logger.warn('fetch-outcomes: No intraday candles found for today');
      return res.status(200).json({ skipped: true, reason: 'No candles' });
    }

    const dayOpen = candles[0]!.open;
    const dayHigh = Math.max(...candles.map((c) => c.high));
    const dayLow = Math.min(...candles.map((c) => c.low));
    const settlement = candles.at(-1)!.close;

    // Fetch VIX and VIX1D quotes
    const quotesResult = await schwabFetch<QuotesResponse>(
      '/quotes?symbols=$VIX,$VIX1D&fields=quote',
    );

    let vixClose: number | undefined;
    let vix1dClose: number | undefined;

    if ('error' in quotesResult) {
      logger.warn(
        { error: quotesResult.error },
        'fetch-outcomes: VIX quotes failed, saving SPX data only',
      );
    } else {
      vixClose = quotesResult.data['$VIX']?.quote?.lastPrice;
      vix1dClose = quotesResult.data['$VIX1D']?.quote?.lastPrice;
    }

    // Save to outcomes table (upserts on date)
    await saveOutcome({
      date: dateStr,
      settlement,
      dayOpen,
      dayHigh,
      dayLow,
      vixClose,
      vix1dClose,
    });

    logger.info(
      {
        date: dateStr,
        settlement,
        range: Math.round(dayHigh - dayLow),
        vixClose,
        vix1dClose,
        candles: candles.length,
      },
      'fetch-outcomes: saved',
    );

    return res.status(200).json({
      date: dateStr,
      settlement,
      dayOpen,
      dayHigh,
      dayLow,
      rangePts: Math.round(dayHigh - dayLow),
      vixClose: vixClose ?? null,
      vix1dClose: vix1dClose ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-outcomes error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Fetch failed',
    });
  }
}
