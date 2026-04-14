/**
 * GET /api/cron/monitor-flow-ratio
 *
 * 1-minute cron that monitors the 0DTE put/call premium ratio for
 * sudden shifts. Fetches the UW 0DTE index flow, computes |NPP|/|NCP|,
 * stores in flow_ratio_monitor, and fires a market alert when the
 * ratio delta and driver-side premium delta both exceed the thresholds
 * in alert-thresholds.ts over a 5-minute window.
 *
 * Uses delta-based detection (not hardcoded levels) so it catches
 * regime shifts regardless of where the ratio started the session.
 *
 * Directional decomposition: determines BEARISH vs BULLISH by which
 * side (NPP or NCP) drove the ratio change.
 *
 * Total API calls per invocation: 1 (net-flow/expiry)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { writeAlertIfNew, checkForCombinedAlert } from '../_lib/alerts.js';
import type { AlertPayload, AlertDirection } from '../_lib/alerts.js';
import { ALERT_THRESHOLDS } from '../_lib/alert-thresholds.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

interface FlowTick {
  timestamp: string;
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: string;
  underlying_price: string;
}

interface RatioReading {
  absNpp: number;
  absNcp: number;
  ratio: number | null;
  spxPrice: number;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchLatestFlowTick(
  apiKey: string,
  today: string,
): Promise<FlowTick | null> {
  const ticks = await uwFetch<FlowTick>(
    apiKey,
    `/net-flow/expiry?date=${today}&expiration=zero_dte&tide_type=index_only`,
    (body) => {
      const outer = (body.data as Array<{ data?: FlowTick[] }>) ?? [];
      if (outer.length === 0) return [];
      return outer[0]?.data ?? [];
    },
  );

  // The UW API pre-fills future minute slots with null values.
  // Find the last tick that actually has data.
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i]!.net_call_premium != null) return ticks[i]!;
  }
  return null;
}

// ── Store reading ───────────────────────────────────────────

async function storeRatioReading(
  today: string,
  reading: RatioReading,
): Promise<void> {
  const sql = getDb();
  const now = new Date().toISOString();

  await sql`
    INSERT INTO flow_ratio_monitor (
      date, timestamp, abs_npp, abs_ncp, ratio, spx_price
    )
    VALUES (
      ${today}, ${now},
      ${reading.absNpp}, ${reading.absNcp}, ${reading.ratio},
      ${reading.spxPrice}
    )
    ON CONFLICT (date, timestamp) DO NOTHING
  `;
}

// ── ROC (1-min rate-of-change) detection ────────────────────

/**
 * Compares the current reading to the most recent prior tick (~1 min ago).
 * Fires an early 'ratio_roc' warning when the 1-minute delta exceeds
 * RATIO_ROC_MIN_DELTA, giving 4-5 minutes of lead time over detectRatioSurge.
 */
async function detectRatioROC(
  today: string,
  current: RatioReading,
): Promise<AlertPayload | null> {
  if (current.ratio == null) return null;

  const sql = getDb();

  // Fetch the most recent prior tick, skipping the one we just inserted
  // (30-second offset prevents self-comparison on the freshly committed row).
  const prev = await sql`
    SELECT ratio, abs_npp, abs_ncp FROM flow_ratio_monitor
    WHERE date = ${today}
      AND ratio IS NOT NULL
      AND timestamp < NOW() - make_interval(secs => 30)
    ORDER BY timestamp DESC LIMIT 1
  `;

  if (prev.length === 0) return null;

  const prevRatio = Number(prev[0]!.ratio);
  const prevNpp = Number(prev[0]!.abs_npp);
  const prevNcp = Number(prev[0]!.abs_ncp);
  const ratioDelta = current.ratio - prevRatio;

  if (Math.abs(ratioDelta) < ALERT_THRESHOLDS.RATIO_ROC_MIN_DELTA) return null;

  const nppChange = current.absNpp - prevNpp;
  const ncpChange = current.absNcp - prevNcp;
  const maxPremiumDelta = Math.max(Math.abs(nppChange), Math.abs(ncpChange));
  if (maxPremiumDelta < ALERT_THRESHOLDS.RATIO_ROC_PREMIUM_MIN) return null;

  const direction = classifyDirection(
    current.absNpp,
    current.absNcp,
    prevNpp,
    prevNcp,
  );
  const driver =
    Math.abs(nppChange) > Math.abs(ncpChange)
      ? `NPP ${nppChange >= 0 ? '+' : ''}$${(nppChange / 1e6).toFixed(1)}M`
      : `NCP ${ncpChange >= 0 ? '+' : ''}$${(ncpChange / 1e6).toFixed(1)}M`;

  return {
    type: 'ratio_roc',
    severity: 'warning',
    direction,
    title: `EARLY ${direction}: Ratio accelerating ${prevRatio.toFixed(2)} -> ${current.ratio.toFixed(2)}`,
    body: [
      `0DTE P/C ratio accelerating ${ratioDelta > 0 ? 'up' : 'down'}`,
      `${prevRatio.toFixed(2)} -> ${current.ratio.toFixed(2)}`,
      `(${ratioDelta > 0 ? '+' : ''}${ratioDelta.toFixed(2)} in ~1min).`,
      `Driver: ${driver}.`,
      direction === 'BEARISH' ? 'Watch PCS stops.' : 'Watch CCS stops.',
    ].join(' '),
    currentValues: {
      ratio: current.ratio,
      absNpp: current.absNpp,
      absNcp: current.absNcp,
      spxPrice: current.spxPrice,
    },
    deltaValues: {
      ratioDelta,
      nppDelta: nppChange,
      ncpDelta: ncpChange,
    },
  };
}

// ── Surge detection ─────────────────────────────────────────

function classifyDirection(
  currentNpp: number,
  currentNcp: number,
  prevNpp: number,
  prevNcp: number,
): AlertDirection {
  const nppDelta = currentNpp - prevNpp;
  const ncpDelta = currentNcp - prevNcp;

  // Which side moved more? Positive delta = that premium grew.
  if (Math.abs(nppDelta) > Math.abs(ncpDelta)) {
    // Put side drove the change
    return nppDelta > 0 ? 'BEARISH' : 'BULLISH';
  }
  // Call side drove the change
  return ncpDelta < 0 ? 'BEARISH' : 'BULLISH';
}

async function detectRatioSurge(
  today: string,
  current: RatioReading,
): Promise<AlertPayload | null> {
  if (current.ratio == null) return null;

  const sql = getDb();
  const lookback = ALERT_THRESHOLDS.RATIO_LOOKBACK_MINUTES;

  const prev = await sql`
    SELECT ratio, abs_npp, abs_ncp FROM flow_ratio_monitor
    WHERE date = ${today}
      AND ratio IS NOT NULL
      AND timestamp <= NOW() - make_interval(mins => ${lookback})
    ORDER BY timestamp DESC LIMIT 1
  `;

  if (prev.length === 0) return null;

  const prevRatio = Number(prev[0]!.ratio);
  const prevNpp = Number(prev[0]!.abs_npp);
  const prevNcp = Number(prev[0]!.abs_ncp);
  const ratioDelta = current.ratio - prevRatio;

  if (Math.abs(ratioDelta) < ALERT_THRESHOLDS.RATIO_DELTA_MIN) return null;

  const nppChange = current.absNpp - prevNpp;
  const ncpChange = current.absNcp - prevNcp;

  // Premium filter: the driving side must have moved at least
  // RATIO_PREMIUM_MIN. Filters low-volume ratio swings that lack
  // institutional conviction.
  const maxPremiumDelta = Math.max(Math.abs(nppChange), Math.abs(ncpChange));
  if (maxPremiumDelta < ALERT_THRESHOLDS.RATIO_PREMIUM_MIN) return null;

  const direction = classifyDirection(
    current.absNpp,
    current.absNcp,
    prevNpp,
    prevNcp,
  );
  const driver =
    Math.abs(nppChange) > Math.abs(ncpChange)
      ? `NPP ${nppChange >= 0 ? '+' : ''}$${(nppChange / 1e6).toFixed(1)}M`
      : `NCP ${ncpChange >= 0 ? '+' : ''}$${(ncpChange / 1e6).toFixed(1)}M`;

  // Critical tier sits above the gate (RATIO_DELTA_MIN = 0.7) so that
  // delta in [0.7, 0.9) is warning and >= 0.9 is critical. The previous
  // critical threshold (0.6) was dead code because it sat below the gate.
  const severity: AlertPayload['severity'] =
    Math.abs(ratioDelta) >= 0.9 ? 'critical' : 'warning';

  return {
    type: 'ratio_surge',
    severity,
    direction,
    title: `${direction} Ratio Surge: ${prevRatio.toFixed(2)} -> ${current.ratio.toFixed(2)}`,
    body: [
      `0DTE P/C ratio ${ratioDelta > 0 ? 'spiked' : 'collapsed'}`,
      `${prevRatio.toFixed(2)} -> ${current.ratio.toFixed(2)}`,
      `(delta ${ratioDelta > 0 ? '+' : ''}${ratioDelta.toFixed(2)})`,
      `in ${lookback}min.`,
      `Driver: ${driver}.`,
      direction === 'BEARISH'
        ? 'Tighten PCS stops, CCS safe.'
        : 'Tighten CCS stops, PCS safe.',
    ].join(' '),
    currentValues: {
      ratio: current.ratio,
      absNpp: current.absNpp,
      absNcp: current.absNcp,
      spxPrice: current.spxPrice,
    },
    deltaValues: {
      ratioDelta,
      nppDelta: nppChange,
      ncpDelta: ncpChange,
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
    const tick = await withRetry(() => fetchLatestFlowTick(apiKey, today));

    if (!tick) {
      logger.info('monitor-flow-ratio: no flow ticks returned');
      return res.status(200).json({
        job: 'monitor-flow-ratio',
        skipped: true,
        reason: 'no flow data',
      });
    }

    const ncp = Number.parseFloat(tick.net_call_premium);
    const npp = Number.parseFloat(tick.net_put_premium);
    const spxPrice = Number.parseFloat(tick.underlying_price);

    if (Number.isNaN(ncp) || Number.isNaN(npp) || Number.isNaN(spxPrice)) {
      logger.warn({ tick }, 'monitor-flow-ratio: invalid tick values');
      return res.status(200).json({
        job: 'monitor-flow-ratio',
        skipped: true,
        reason: 'invalid values',
      });
    }

    const absNpp = Math.abs(npp);
    const absNcp = Math.abs(ncp);
    const ratio = absNcp > 0 ? absNpp / absNcp : null;

    const reading: RatioReading = { absNpp, absNcp, ratio, spxPrice };

    await storeRatioReading(today, reading);

    // ROC check runs first — fires early if 1-min delta is steep enough.
    // Surge check runs second — confirms the move over the full 5-min window.
    // Both have independent cooldowns so both can fire on the same tick.
    const rocAlert = await detectRatioROC(today, reading);
    const rocAlerted = rocAlert
      ? await writeAlertIfNew(today, rocAlert)
      : false;

    const alert = await detectRatioSurge(today, reading);
    const alerted = alert ? await writeAlertIfNew(today, alert) : false;
    const combined = alerted
      ? await checkForCombinedAlert(today, 'ratio_surge')
      : false;

    const durationMs = Date.now() - startTime;

    await reportCronRun('monitor-flow-ratio', {
      status: 'ok',
      ratio,
      absNpp,
      absNcp,
      spxPrice,
      rocAlerted,
      alerted,
      combined,
      durationMs,
    });

    return res.status(200).json({
      job: 'monitor-flow-ratio',
      ratio,
      absNpp,
      absNcp,
      spxPrice,
      rocAlerted,
      alerted,
      combined,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'monitor-flow-ratio');
    Sentry.captureException(err);
    logger.error({ err }, 'monitor-flow-ratio error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
