/**
 * GET /api/cron/monitor-iv
 *
 * 1-minute cron that monitors ATM 0DTE implied volatility for spikes.
 * Fetches the UW interpolated-iv endpoint, stores in iv_monitor table,
 * and fires a market alert when IV jumps >= 3 vol points in 5 minutes
 * while SPX moves < 5 points — the "canary" signal that informed flow
 * is positioning before a directional move.
 *
 * SPX price is read from flow_ratio_monitor (populated by the sibling
 * monitor-flow-ratio cron) or falls back to flow_data.
 *
 * Total API calls per invocation: 1 (interpolated-iv)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { writeAlertIfNew, checkForCombinedAlert } from '../_lib/alerts.js';
import type { AlertPayload } from '../_lib/alerts.js';
import { ALERT_THRESHOLDS } from '../_lib/alert-thresholds.js';

// ── Types ───────────────────────────────────────────────────

interface IvTermRow {
  date: string;
  days: number;
  implied_move_perc: string;
  percentile: string;
  volatility: string;
}

interface IvReading {
  volatility: number;
  impliedMove: number;
  percentile: number;
  spxPrice: number | null;
}

// ── Fetch helpers ───────────────────────────────────────────

async function fetchZeroDteIv(
  apiKey: string,
): Promise<IvReading | null> {
  // Omit ?date= for current-day fetches — the UW API returns empty
  // data when the date param is the current trading day (same
  // behavior as the net-flow/expiry endpoint).
  const rows = await uwFetch<IvTermRow>(
    apiKey,
    '/stock/SPX/interpolated-iv',
  );

  // Find the 0DTE row (days <= 1)
  const zeroDte = rows.find((r) => r.days <= 1);
  if (!zeroDte) return null;

  const volatility = Number.parseFloat(zeroDte.volatility);
  const impliedMove = Number.parseFloat(zeroDte.implied_move_perc);
  const percentile = Number.parseFloat(zeroDte.percentile);

  if (isNaN(volatility)) return null;

  return {
    volatility,
    impliedMove: isNaN(impliedMove) ? 0 : impliedMove,
    percentile: isNaN(percentile) ? 0 : percentile,
    spxPrice: null, // filled by getLatestSpxPrice
  };
}

/**
 * Read the most recent SPX price from flow_ratio_monitor (preferred)
 * or fall back to flow_data (zero_dte_index source).
 */
async function getLatestSpxPrice(today: string): Promise<number | null> {
  const sql = getDb();

  // Try flow_ratio_monitor first (updated every 1 min by sibling cron)
  const ratioRows = await sql`
    SELECT spx_price FROM flow_ratio_monitor
    WHERE date = ${today} AND spx_price IS NOT NULL
    ORDER BY timestamp DESC LIMIT 1
  `;
  if (ratioRows.length > 0 && ratioRows[0]!.spx_price != null) {
    return Number(ratioRows[0]!.spx_price);
  }

  // Fallback: flow_data from the 5-min zero-dte cron
  const flowRows = await sql`
    SELECT ncp FROM flow_data
    WHERE date = ${today} AND source = 'zero_dte_index'
    ORDER BY timestamp DESC LIMIT 1
  `;
  // flow_data doesn't store price directly; return null as last resort
  if (flowRows.length > 0) return null;

  return null;
}

// ── Store reading ───────────────────────────────────────────

async function storeIvReading(
  today: string,
  reading: IvReading,
): Promise<void> {
  const sql = getDb();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO iv_monitor (
      date, timestamp, volatility, implied_move, percentile, spx_price
    )
    VALUES (
      ${today}, ${now}, ${reading.volatility},
      ${reading.impliedMove}, ${reading.percentile}, ${reading.spxPrice}
    )
    ON CONFLICT (date, timestamp) DO NOTHING
  `;
}

// ── Spike detection ─────────────────────────────────────────

async function detectIvSpike(
  today: string,
  current: IvReading,
): Promise<AlertPayload | null> {
  const sql = getDb();
  const lookback = ALERT_THRESHOLDS.IV_LOOKBACK_MINUTES;

  const prev = await sql`
    SELECT volatility, spx_price FROM iv_monitor
    WHERE date = ${today}
      AND timestamp <= NOW() - make_interval(mins => ${lookback})
    ORDER BY timestamp DESC LIMIT 1
  `;

  if (prev.length === 0) return null;

  const prevVol = Number(prev[0]!.volatility);
  const prevPrice =
    prev[0]!.spx_price != null ? Number(prev[0]!.spx_price) : null;
  const ivDelta = current.volatility - prevVol;

  if (ivDelta < ALERT_THRESHOLDS.IV_JUMP_MIN) return null;

  // Check SPX price move is small (informed positioning before the move)
  if (
    current.spxPrice != null &&
    prevPrice != null &&
    Math.abs(current.spxPrice - prevPrice) >= ALERT_THRESHOLDS.IV_PRICE_MAX_MOVE
  ) {
    return null;
  }

  const ivPctCurrent = (current.volatility * 100).toFixed(1);
  const ivPctPrev = (prevVol * 100).toFixed(1);
  const ivDeltaPts = (ivDelta * 100).toFixed(1);
  const priceMove =
    current.spxPrice != null && prevPrice != null
      ? (current.spxPrice - prevPrice).toFixed(1)
      : 'N/A';

  const severity: AlertPayload['severity'] =
    ivDelta >= 0.05 ? 'critical' : 'warning';

  return {
    type: 'iv_spike',
    severity,
    direction: 'BEARISH',
    title: `IV Spike: +${ivDeltaPts} vol pts in ${lookback}min`,
    body: [
      `ATM 0DTE IV: ${ivPctPrev}% -> ${ivPctCurrent}% (+${ivDeltaPts} pts)`,
      `SPX moved ${priceMove} pts — someone is bidding for protection`,
      `before price moves. Tighten stops on vulnerable positions.`,
    ].join(' '),
    currentValues: {
      iv: current.volatility,
      spxPrice: current.spxPrice ?? 0,
      percentile: current.percentile,
    },
    deltaValues: {
      ivDelta,
      priceDelta:
        current.spxPrice != null && prevPrice != null
          ? current.spxPrice - prevPrice
          : 0,
    },
  };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    // Fetch IV and SPX price in parallel
    const [ivResult, spxPrice] = await Promise.all([
      withRetry(() => fetchZeroDteIv(apiKey)),
      getLatestSpxPrice(today),
    ]);

    if (!ivResult) {
      logger.info('monitor-iv: no 0DTE IV row returned');
      return res.status(200).json({
        job: 'monitor-iv',
        skipped: true,
        reason: 'no 0DTE IV data',
      });
    }

    ivResult.spxPrice = spxPrice;

    // Store and detect
    await storeIvReading(today, ivResult);
    const alert = await detectIvSpike(today, ivResult);
    const alerted = alert ? await writeAlertIfNew(today, alert) : false;
    const combined = alerted
      ? await checkForCombinedAlert(today, 'iv_spike')
      : false;

    return res.status(200).json({
      job: 'monitor-iv',
      iv: ivResult.volatility,
      spxPrice,
      alerted,
      combined,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'monitor-iv');
    Sentry.captureException(err);
    logger.error({ err }, 'monitor-iv error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
