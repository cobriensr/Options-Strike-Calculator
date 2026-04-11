/**
 * GET /api/cron/monitor-iv
 *
 * 1-minute cron that monitors ATM 0DTE implied volatility for spikes.
 * Fetches the UW interpolated-iv endpoint, stores in iv_monitor table,
 * and fires a market alert when IV jumps >= IV_JUMP_MIN (1 vol point)
 * in 5 minutes while SPX moves < IV_PRICE_MAX_MOVE points — the
 * "canary" signal that informed flow is positioning before a
 * directional move. Thresholds live in alert-thresholds.ts.
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
import { reportCronRun } from '../_lib/axiom.js';

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
  today: string,
): Promise<IvReading | null> {
  const rows = await uwFetch<IvTermRow>(
    apiKey,
    `/stock/SPX/interpolated-iv?date=${today}`,
  );

  // Find the 0DTE row (days <= 1)
  const zeroDte = rows.find((r) => r.days <= 1);
  if (!zeroDte) return null;

  const volatility = Number.parseFloat(zeroDte.volatility);
  const impliedMove = Number.parseFloat(zeroDte.implied_move_perc);
  const percentile = Number.parseFloat(zeroDte.percentile);

  if (Number.isNaN(volatility)) return null;

  return {
    volatility,
    impliedMove: Number.isNaN(impliedMove) ? 0 : impliedMove,
    percentile: Number.isNaN(percentile) ? 0 : percentile,
    spxPrice: null, // filled by getLatestSpxPrice
  };
}

/**
 * Read the most recent SPX price from flow_ratio_monitor (preferred)
 * or fall back to market_snapshots when zero_dte_index flow data exists.
 *
 * flow_ratio_monitor is refreshed every minute by the sibling cron and
 * is always the preferred source. When it is missing, we use flow_data
 * (zero_dte_index source) as a liveness check that 0DTE data exists for
 * today, then pull the actual SPX price from market_snapshots.spx — the
 * canonical intraday price feed populated by the calculator. Prior to
 * this fix the fallback unconditionally returned null, which silently
 * disabled the "small price move" half of the IV-spike alert rule.
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

  // Fallback: confirm 0DTE flow data exists via flow_data (liveness check).
  // flow_data has no price column, so we still need market_snapshots for
  // the actual SPX value.
  const flowRows = await sql`
    SELECT 1 FROM flow_data
    WHERE date = ${today} AND source = 'zero_dte_index'
    ORDER BY timestamp DESC LIMIT 1
  `;
  if (flowRows.length === 0) return null;

  // Pull the most recent SPX price from market_snapshots. Ordering by id
  // DESC is the cheapest way to get the latest row for today since id is
  // a SERIAL primary key (entry_time is TEXT like "9:35 AM" and is not
  // chronologically sortable without parsing).
  const snapshotRows = await sql`
    SELECT spx FROM market_snapshots
    WHERE date = ${today} AND spx IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `;
  if (snapshotRows.length > 0 && snapshotRows[0]!.spx != null) {
    return Number(snapshotRows[0]!.spx);
  }

  // No price feed available. detectIvSpike degrades to IV-delta-only
  // gating when spxPrice is null (see lines 178-184).
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

  // Proportional to IV_JUMP_MIN = 0.01. Warning tier is [1, 2) vol pts,
  // critical tier is >= 2 vol pts in the lookback window.
  const severity: AlertPayload['severity'] =
    ivDelta >= 0.02 ? 'critical' : 'warning';

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
      withRetry(() => fetchZeroDteIv(apiKey, today)),
      getLatestSpxPrice(today),
    ]);

    if (!ivResult) {
      logger.warn({ today }, 'monitor-iv: no 0DTE IV row returned');
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

    logger.info(
      {
        iv: ivResult.volatility,
        spxPrice,
        alerted,
        combined,
      },
      'monitor-iv completed',
    );

    const durationMs = Date.now() - startTime;
    await reportCronRun('monitor-iv', {
      status: 'ok',
      iv: ivResult.volatility,
      spxPrice,
      alerted,
      combined,
      durationMs,
    });

    return res.status(200).json({
      job: 'monitor-iv',
      iv: ivResult.volatility,
      spxPrice,
      alerted,
      combined,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'monitor-iv');
    Sentry.captureException(err);
    logger.error({ err }, 'monitor-iv error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
