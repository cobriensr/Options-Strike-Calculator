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
import {
  schwabFetch,
  withRetry,
  cronGuard,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { saveOutcome, getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';
import { isTradingDay } from '../../src/data/marketHours.js';
import { buildAnalysisSummary, generateEmbedding } from '../_lib/embeddings.js';
import { reportCronRun } from '../_lib/axiom.js';

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
  if (req.query.backfill === 'true') {
    // Backfill bypasses time check but still needs auth — check method + secret only
    const guard = cronGuard(req, res, {
      marketHours: false,
      requireApiKey: false,
    });
    if (!guard) return;
    return handleBackfill(res);
  }

  const force = req.query.force === 'true';
  const guard = cronGuard(req, res, {
    timeCheck: force ? () => true : isAfterClose,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today: dateStr } = guard;

  // Holiday gate: skip NYSE-closed days so we don't silently report success
  // after calling Schwab on Thanksgiving/Christmas/etc. `force=true` bypasses
  // this so a trader can manually re-run on any calendar day.
  const startTime = Date.now();

  if (!force && !isTradingDay(dateStr)) {
    logger.info({ date: dateStr }, 'fetch-outcomes: skipping non-trading day');
    await reportCronRun('fetch-outcomes', {
      status: 'skipped',
      reason: 'not_trading_day',
      durationMs: Date.now() - startTime,
    });
    return res
      .status(200)
      .json({ skipped: true, reason: 'not_trading_day', date: dateStr });
  }
  const now = new Date();

  try {
    // Fetch SPX intraday candles for today
    const start = now.getTime() - 24 * 60 * 60 * 1000;
    const end = now.getTime();

    const intradayResult = await withRetry(() =>
      schwabFetch<PriceHistoryResponse>(
        `/pricehistory?symbol=$SPX&periodType=day&frequencyType=minute&frequency=5` +
          `&startDate=${start}&endDate=${end}&needExtendedHoursData=false`,
      ),
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
      await reportCronRun('fetch-outcomes', {
        status: 'skipped',
        reason: 'No candles',
        durationMs: Date.now() - startTime,
      });
      return res.status(200).json({ skipped: true, reason: 'No candles' });
    }

    const dayOpen = candles[0]!.open;
    const dayHigh = Math.max(...candles.map((c) => c.high));
    const dayLow = Math.min(...candles.map((c) => c.low));
    const settlement = candles.at(-1)!.close;

    // Fetch VIX and VIX1D quotes
    const quotesResult = await withRetry(() =>
      schwabFetch<QuotesResponse>('/quotes?symbols=$VIX,$VIX1D&fields=quote'),
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

    // Re-embed analyses from today with outcome data (fire-and-forget).
    // This upgrades the pre-trade embedding to include settlement + correctness,
    // making future retrieval richer when this day appears as a historical analog.
    void enrichAnalysisEmbeddings(dateStr, settlement);

    // Data quality check: alert if settlement is null
    const qcRows = await getDb()`
      SELECT settlement FROM outcomes WHERE date = ${dateStr}
    `;
    const hasSettlement = qcRows.length > 0 && qcRows[0]!.settlement != null;
    await checkDataQuality({
      job: 'fetch-outcomes',
      table: 'outcomes',
      date: dateStr,
      total: qcRows.length,
      nonzero: hasSettlement ? 1 : 0,
      minRows: 0,
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

    const rangePts = Math.round(dayHigh - dayLow);
    await reportCronRun('fetch-outcomes', {
      status: 'ok',
      date: dateStr,
      settlement,
      dayOpen,
      dayHigh,
      dayLow,
      rangePts,
      vixClose,
      vix1dClose,
      durationMs: Date.now() - startTime,
    });
    return res.status(200).json({
      job: 'fetch-outcomes',
      date: dateStr,
      settlement,
      dayOpen,
      dayHigh,
      dayLow,
      rangePts,
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

// ── Outcome enrichment ─────────────────────────────────────

/**
 * Re-embed analyses from a given date to include settlement + correctness.
 * Fetches the analysis rows with snapshot context, rebuilds the summary
 * with outcome data, generates a new embedding, and overwrites the old one.
 */
async function enrichAnalysisEmbeddings(
  dateStr: string,
  settlement: number,
): Promise<void> {
  const sql = getDb();

  let rows: Record<string, unknown>[];
  try {
    rows = await withRetry(
      () => sql`
        SELECT a.id, a.mode, a.entry_time, a.structure, a.confidence,
               a.suggested_delta, a.spx, a.vix, a.vix1d, a.hedge,
               (a.full_response->'review'->>'wasCorrect')::boolean AS was_correct,
               ms.vix_term_signal, ms.regime_zone, ms.dow_label
        FROM analyses a
        LEFT JOIN market_snapshots ms ON ms.id = a.snapshot_id
        WHERE a.date = ${dateStr}
      `,
    );
  } catch (error_) {
    logger.error(
      { err: error_, date: dateStr },
      'fetch-outcomes: analysis embedding SELECT failed',
    );
    metrics.increment('fetch_outcomes.embedding_enrich_error');
    Sentry.captureException(error_);
    return;
  }

  let updated = 0;
  let rowErrors = 0;
  for (const row of rows) {
    try {
      const summary = buildAnalysisSummary({
        date: dateStr,
        mode: row.mode as string,
        vix: row.vix == null ? null : Number(row.vix),
        vix1d: row.vix1d == null ? null : Number(row.vix1d),
        spx: row.spx == null ? null : Number(row.spx),
        structure: row.structure as string,
        confidence: row.confidence as string,
        suggestedDelta:
          row.suggested_delta == null ? null : Number(row.suggested_delta),
        hedge: (row.hedge as string) ?? null,
        vixTermShape: (row.vix_term_signal as string) ?? null,
        gexRegime: (row.regime_zone as string) ?? null,
        dayOfWeek: (row.dow_label as string) ?? null,
        settlement,
        wasCorrect: row.was_correct == null ? null : Boolean(row.was_correct),
      });

      const embedding = await withRetry(() => generateEmbedding(summary));
      if (!embedding) continue;

      const vectorLiteral = `[${embedding.join(',')}]`;
      await withRetry(
        () => sql`
          UPDATE analyses
          SET analysis_embedding = ${vectorLiteral}::vector
          WHERE id = ${row.id as number}
        `,
      );
      updated++;
    } catch (error_) {
      rowErrors++;
      logger.error(
        { err: error_, date: dateStr, analysisId: row.id },
        'fetch-outcomes: analysis embedding row failed',
      );
      metrics.increment('fetch_outcomes.embedding_enrich_error');
      Sentry.captureException(error_);
    }
  }

  if (rows.length > 0) {
    logger.info(
      { date: dateStr, count: rows.length, updated, rowErrors },
      'fetch-outcomes: enriched analysis embeddings with settlement',
    );
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
      } catch (err) {
        logger.warn(
          { err, dateStr: candle.datetime },
          'Backfill: skipped candle',
        );
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
