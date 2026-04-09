/**
 * GET /api/cron/compute-es-overnight
 *
 * Runs at 9:35 AM ET on weekdays. Reads overnight ES bars (6:00 PM ET
 * previous trading day → 9:30 AM ET today), computes gap analysis
 * metrics, and writes a summary row for Claude context injection.
 *
 * Schedule: 35 13,14 * * 1-5 (DST-safe: skips if before 9:30 AM ET)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { metrics, Sentry } from '../_lib/sentry.js';
import { schwabFetch, cronGuard } from '../_lib/api-helpers.js';
import { getETTime } from '../../src/utils/timezone.js';

// ── Time helpers ────────────────────────────────────────────

function isAfterCashOpen(): boolean {
  const { hour, minute } = getETTime(new Date());
  const totalMin = hour * 60 + minute;
  return totalMin >= 570; // 9:30 AM
}

/**
 * Get previous trading day's 6:00 PM ET as a UTC ISO string.
 * On Monday → Friday 6:00 PM ET. On Tue-Fri → yesterday 6:00 PM ET.
 */
function getOvernightStart(todayET: string): string {
  const today = new Date(todayET + 'T12:00:00Z'); // noon UTC to avoid date rollover issues
  const dayOfWeek = today.getUTCDay();
  const daysBack = dayOfWeek === 1 ? 3 : 1; // Monday → go back to Friday
  const prevDay = new Date(today);
  prevDay.setUTCDate(prevDay.getUTCDate() - daysBack);
  const dateStr = prevDay.toISOString().slice(0, 10);
  // 6:00 PM ET = 22:00 UTC (EDT) or 23:00 UTC (EST)
  // Use a fixed ET offset approach
  return `${dateStr}T22:00:00Z`; // Approximate: EDT. Close enough for the query window.
}

function getOvernightEnd(todayET: string): string {
  // 9:30 AM ET = 13:30 UTC (EDT) or 14:30 UTC (EST)
  return `${todayET}T13:30:00Z`; // Approximate: EDT
}

// ── Gap classification helpers ──────────────────────────────

function classifyGapSize(absGap: number): string {
  if (absGap < 5) return 'NEGLIGIBLE';
  if (absGap < 15) return 'SMALL';
  if (absGap < 30) return 'MODERATE';
  if (absGap < 50) return 'LARGE';
  return 'EXTREME';
}

function classifyPosition(pctRank: number): string {
  if (pctRank > 90) return 'AT_GLOBEX_HIGH';
  if (pctRank > 70) return 'NEAR_HIGH';
  if (pctRank > 30) return 'MID_RANGE';
  if (pctRank > 10) return 'NEAR_LOW';
  return 'AT_GLOBEX_LOW';
}

function classifyVolume(
  totalVolume: number,
  avg20d: number | null,
): { volRatio: number; volClass: string } {
  if (avg20d && avg20d > 0) {
    const ratio = totalVolume / avg20d;
    let cls: string;
    if (ratio < 0.6) cls = 'LIGHT';
    else if (ratio < 1) cls = 'NORMAL';
    else if (ratio < 1.5) cls = 'ELEVATED';
    else cls = 'HEAVY';
    return { volRatio: ratio, volClass: cls };
  }
  let cls: string;
  if (totalVolume < 300_000) cls = 'LIGHT';
  else if (totalVolume < 500_000) cls = 'NORMAL';
  else if (totalVolume < 700_000) cls = 'ELEVATED';
  else cls = 'HEAVY';
  return { volRatio: 0, volClass: cls };
}

function classifyVwapSignal(gapUp: boolean, gapVsVwapPts: number): string {
  if (gapUp && gapVsVwapPts > 0) return 'SUPPORTED';
  if (gapUp && gapVsVwapPts <= 0) return 'OVERSHOOT_FADE';
  if (!gapUp && gapVsVwapPts < 0) return 'SUPPORTED';
  return 'OVERSHOOT_FADE';
}

function computeFillScore(
  absGap: number,
  volRatio: number,
  pctRank: number,
  vwapSignal: string,
): { score: number; probability: string } {
  let score = 0;

  if (absGap < 10) score += 30;
  else if (absGap < 20) score += 15;
  else if (absGap >= 40) score -= 20;

  if (volRatio < 0.6) score += 25;
  else if (volRatio < 1) score += 10;
  else if (volRatio < 1.5) score -= 10;
  else score -= 25;

  if (pctRank > 90 || pctRank < 10) score += 20;
  else if (pctRank > 70 || pctRank < 30) score += 5;
  else score -= 10;

  if (vwapSignal === 'OVERSHOOT_FADE') score += 20;
  else score -= 15;

  let probability: string;
  if (score > 50) probability = 'HIGH';
  else if (score > 20) probability = 'MODERATE';
  else probability = 'LOW';

  return { score, probability };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    timeCheck: isAfterCashOpen,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today: tradeDate } = guard;

  const startTime = Date.now();
  const sql = getDb();

  try {
    // 1. Query overnight bars
    const overnightStart = getOvernightStart(tradeDate);
    const overnightEnd = getOvernightEnd(tradeDate);

    const bars = await sql`
      SELECT
        (ARRAY_AGG(open ORDER BY ts ASC))[1]        AS globex_open,
        MAX(high)                                     AS globex_high,
        MIN(low)                                      AS globex_low,
        (ARRAY_AGG(close ORDER BY ts DESC))[1]        AS globex_close,
        SUM(((high + low + close) / 3) * volume) / NULLIF(SUM(volume), 0) AS vwap,
        SUM(volume)                                   AS total_volume,
        COUNT(*)                                      AS bar_count
      FROM es_bars
      WHERE symbol = 'ES'
        AND ts >= ${overnightStart}
        AND ts <  ${overnightEnd}
    `;

    if (!bars[0]?.globex_open) {
      logger.info({ tradeDate }, 'No overnight ES bars found');
      return res
        .status(200)
        .json({ skipped: true, reason: 'No overnight bars' });
    }

    const overnight = bars[0];
    const globexHigh = Number.parseFloat(String(overnight.globex_high));
    const globexLow = Number.parseFloat(String(overnight.globex_low));
    const vwap = Number.parseFloat(String(overnight.vwap));
    const totalVolume = Number.parseInt(String(overnight.total_volume), 10);
    const rangePts = globexHigh - globexLow;

    // 2. Get previous SPX settlement
    const prevOutcome = await sql`
      SELECT settlement FROM outcomes
      WHERE date < ${tradeDate}
      ORDER BY date DESC LIMIT 1
    `;
    const prevCashClose = prevOutcome[0]?.settlement
      ? Number.parseFloat(String(prevOutcome[0].settlement))
      : null;

    // 3. Get today's SPX open from Schwab
    let cashOpen: number | null = null;
    try {
      const intradayResult = await schwabFetch<{
        candles?: Array<{ open: number; datetime: number }>;
      }>(
        `/pricehistory?symbol=$SPX&periodType=day&period=1&frequencyType=minute&frequency=5`,
      );
      if (intradayResult.ok && intradayResult.data.candles?.length) {
        cashOpen = intradayResult.data.candles[0]!.open;
      }
    } catch (err) {
      logger.warn({ err }, 'Could not fetch SPX open from Schwab');
      metrics.increment('compute_es_overnight.schwab_fallback');
      Sentry.captureException(err);
    }

    if (!cashOpen) cashOpen = Number.parseFloat(String(overnight.globex_close));

    // 4. Compute all classifications
    const gapPts = prevCashClose ? cashOpen - prevCashClose : 0;
    const gapPct = prevCashClose ? (gapPts / prevCashClose) * 100 : 0;
    const gapDirection = gapPts >= 0 ? 'UP' : 'DOWN';
    const gapSizeClass = classifyGapSize(Math.abs(gapPts));

    const globexRange = globexHigh - globexLow;
    const cashOpenPctRank =
      globexRange > 0 ? ((cashOpen - globexLow) / globexRange) * 100 : 50;
    const positionClass = classifyPosition(cashOpenPctRank);

    const histVol = await sql`
      SELECT total_volume FROM es_overnight_summaries
      WHERE trade_date < ${tradeDate}
      ORDER BY trade_date DESC LIMIT 20
    `;
    const avg20d =
      histVol.length > 0
        ? histVol.reduce(
            (sum: number, r: Record<string, unknown>) =>
              sum +
              (typeof r.total_volume === 'string'
                ? Number.parseInt(r.total_volume, 10)
                : Number(r.total_volume)),
            0,
          ) / histVol.length
        : null;

    const { volRatio, volClass } = classifyVolume(totalVolume, avg20d);

    const gapVsVwapPts = cashOpen - vwap;
    const vwapSignal = classifyVwapSignal(gapPts >= 0, gapVsVwapPts);

    const { score: fillScore, probability: fillProbability } = computeFillScore(
      Math.abs(gapPts),
      volRatio,
      cashOpenPctRank,
      vwapSignal,
    );

    const rangePct = prevCashClose ? rangePts / prevCashClose : 0;

    // 5. Upsert summary
    await sql`
      INSERT INTO es_overnight_summaries (
        trade_date, globex_open, globex_high, globex_low, globex_close,
        vwap, total_volume, bar_count, range_pts, range_pct,
        cash_open, prev_cash_close, gap_pts, gap_pct, gap_direction,
        gap_size_class, cash_open_pct_rank, position_class,
        vol_20d_avg, vol_ratio, vol_class,
        gap_vs_vwap_pts, vwap_signal, fill_score, fill_probability
      ) VALUES (
        ${tradeDate}, ${overnight.globex_open}, ${overnight.globex_high},
        ${overnight.globex_low}, ${overnight.globex_close},
        ${overnight.vwap}, ${totalVolume}, ${overnight.bar_count},
        ${rangePts}, ${rangePct},
        ${cashOpen}, ${prevCashClose}, ${gapPts}, ${gapPct},
        ${gapDirection},
        ${gapSizeClass}, ${cashOpenPctRank}, ${positionClass},
        ${avg20d ? Math.round(avg20d) : null}, ${volRatio}, ${volClass},
        ${gapVsVwapPts}, ${vwapSignal}, ${fillScore}, ${fillProbability}
      )
      ON CONFLICT (trade_date) DO UPDATE SET
        globex_open = EXCLUDED.globex_open,
        globex_high = EXCLUDED.globex_high,
        globex_low = EXCLUDED.globex_low,
        globex_close = EXCLUDED.globex_close,
        vwap = EXCLUDED.vwap,
        total_volume = EXCLUDED.total_volume,
        bar_count = EXCLUDED.bar_count,
        range_pts = EXCLUDED.range_pts,
        range_pct = EXCLUDED.range_pct,
        cash_open = EXCLUDED.cash_open,
        prev_cash_close = EXCLUDED.prev_cash_close,
        gap_pts = EXCLUDED.gap_pts,
        gap_pct = EXCLUDED.gap_pct,
        gap_direction = EXCLUDED.gap_direction,
        gap_size_class = EXCLUDED.gap_size_class,
        cash_open_pct_rank = EXCLUDED.cash_open_pct_rank,
        position_class = EXCLUDED.position_class,
        vol_20d_avg = EXCLUDED.vol_20d_avg,
        vol_ratio = EXCLUDED.vol_ratio,
        vol_class = EXCLUDED.vol_class,
        gap_vs_vwap_pts = EXCLUDED.gap_vs_vwap_pts,
        vwap_signal = EXCLUDED.vwap_signal,
        fill_score = EXCLUDED.fill_score,
        fill_probability = EXCLUDED.fill_probability
    `;

    logger.info(
      {
        tradeDate,
        gapPts,
        gapDirection,
        gapSizeClass,
        fillScore,
        fillProbability,
        volClass,
        positionClass,
      },
      'ES overnight summary computed',
    );

    return res.status(200).json({
      job: 'compute-es-overnight',
      stored: true,
      tradeDate,
      gap: `${gapPts >= 0 ? '+' : ''}${gapPts.toFixed(1)} ${gapDirection}`,
      fillProbability,
      fillScore,
      barCount: Number.parseInt(String(overnight.bar_count), 10),
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'compute-es-overnight');
    Sentry.captureException(err);
    logger.error({ err }, 'compute-es-overnight failed');
    return res.status(500).json({ error: 'Internal error' });
  }
}
