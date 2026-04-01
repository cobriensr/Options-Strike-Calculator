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
import { Sentry } from '../_lib/sentry.js';
import { saveOutcome, getDb } from '../_lib/db.js';
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
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const backfill = req.query.backfill === 'true';

  if (backfill) {
    return handleBackfill(res);
  }

  const force = req.query.force === 'true';
  if (!force && !isAfterClose()) {
    return res.status(200).json({
      skipped: true,
      reason: 'Outside post-close window (4:15-5:30 PM ET)',
    });
  }

  const startTime = Date.now();
  const now = new Date();
  const dateStr = getETDateStr(now);

  try {
    // Fetch SPX intraday candles for today
    const start = now.getTime() - 24 * 60 * 60 * 1000;
    const end = now.getTime();

    const intradayResult = await schwabFetch<PriceHistoryResponse>(
      `/pricehistory?symbol=$SPX&periodType=day&frequencyType=minute&frequency=5` +
        `&startDate=${start}&endDate=${end}&needExtendedHoursData=false`,
    );

    if (!intradayResult.ok) {
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

    if (!quotesResult.ok) {
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

    // Data quality check: alert if settlement is null
    const qcRows = await getDb()`
      SELECT settlement FROM outcomes WHERE date = ${dateStr}
    `;
    if (qcRows.length > 0 && qcRows[0]!.settlement == null) {
      Sentry.setTag('cron.job', 'fetch-outcomes');
      Sentry.captureMessage(
        `Data quality alert: outcomes row for ${dateStr} has NULL settlement — ML pipeline will break`,
        'warning',
      );
      logger.warn(
        { date: dateStr },
        'Outcomes data quality: settlement is null',
      );
    }

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
      job: 'fetch-outcomes',
      date: dateStr,
      settlement,
      dayOpen,
      dayHigh,
      dayLow,
      rangePts: Math.round(dayHigh - dayLow),
      vixClose: vixClose ?? null,
      vix1dClose: vix1dClose ?? null,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-outcomes');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-outcomes error');
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ── Backfill handler ────────────────────────────────────────

interface DailyCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // Unix ms (midnight UTC of trading day)
}

interface DailyHistoryResponse {
  candles: DailyCandle[];
  symbol: string;
  empty: boolean;
}

async function handleBackfill(res: VercelResponse) {
  try {
    // Fetch ~2 months of daily SPX candles
    const now = Date.now();
    const twoMonthsAgo = now - 62 * 24 * 60 * 60 * 1000;

    const spxResult = await schwabFetch<DailyHistoryResponse>(
      `/pricehistory?symbol=$SPX&periodType=month&period=2&frequencyType=daily&frequency=1`,
    );

    if (!spxResult.ok) {
      return res.status(502).json({ error: spxResult.error });
    }

    // Also fetch VIX daily candles for the same period
    const vixResult = await schwabFetch<DailyHistoryResponse>(
      `/pricehistory?symbol=$VIX&periodType=month&period=2&frequencyType=daily&frequency=1`,
    );

    const vixByDate = new Map<string, DailyCandle>();
    if (vixResult.ok) {
      for (const c of vixResult.data.candles) {
        const d = getETDateStr(new Date(c.datetime));
        vixByDate.set(d, c);
      }
    }

    let saved = 0;
    let skipped = 0;

    // Filter to only completed days (exclude today if market still open)
    const todayStr = getETDateStr(new Date());
    const candles = spxResult.data.candles.filter((c) => {
      const d = getETDateStr(new Date(c.datetime));
      return d !== todayStr && c.datetime >= twoMonthsAgo;
    });

    for (const candle of candles) {
      const dateStr = getETDateStr(new Date(candle.datetime));

      try {
        const vixCandle = vixByDate.get(dateStr);

        await saveOutcome({
          date: dateStr,
          settlement: candle.close,
          dayOpen: candle.open,
          dayHigh: candle.high,
          dayLow: candle.low,
          vixClose: vixCandle?.close,
          vix1dClose: undefined, // VIX1D not available in daily history
        });
        saved++;
      } catch {
        skipped++;
      }
    }

    logger.info(
      { saved, skipped, total: candles.length },
      'fetch-outcomes: backfill complete',
    );

    return res.status(200).json({ backfill: true, saved, skipped });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-outcomes');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-outcomes: backfill error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
