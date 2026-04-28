/**
 * GET /api/cron/monitor-vega-spike
 *
 * Reads the 1-min ETF vega flow bars ingested by fetch-greek-flow-etf and
 * detects anomalous directional vega spikes for SPY and QQQ. A "spike" is
 * defined by four concurrent gates:
 *
 *   1. Floor gate  — |dir_vega_flow| >= VEGA_SPIKE_FLOORS[ticker]
 *   2. Ratio gate  — |dir_vega_flow| >= VEGA_SPIKE_VS_PRIOR_MAX_RATIO × prior max
 *   3. Z-score gate — robust MAD-based score >= VEGA_SPIKE_Z_SCORE_THRESHOLD
 *   4. Elapsed gate — at least VEGA_SPIKE_MIN_BARS_ELAPSED baseline bars exist
 *
 * Uses median + MAD (not mean/std-dev) for the z-score; std-dev is
 * contaminated by the very spike we are detecting.
 *
 * When BOTH tickers spike in the same invocation and their timestamps are
 * within VEGA_SPIKE_CONFLUENCE_WINDOW_SEC seconds, both rows are updated to
 * confluence = true.
 *
 * Runs after fetch-greek-flow-etf; the monitor reads the previous ingest's
 * bars. ON CONFLICT (ticker, timestamp) DO NOTHING prevents double-fire when
 * ingest is briefly behind.
 *
 * Stored in vega_spike_events table (migration #93).
 *
 * Schedule: vercel.json registers `* 13-21 * * 1-5` (every minute, market hours).
 *
 * Environment: CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, withRetry } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  VEGA_SPIKE_FLOORS,
  VEGA_SPIKE_Z_SCORE_THRESHOLD,
  VEGA_SPIKE_VS_PRIOR_MAX_RATIO,
  VEGA_SPIKE_MIN_BARS_ELAPSED,
  VEGA_SPIKE_CONFLUENCE_WINDOW_SEC,
} from '../_lib/constants.js';

// ── Types ───────────────────────────────────────────────────

interface VegaFlowBar {
  timestamp: string;
  dir_vega_flow: string | number;
}

export interface SpikeResult {
  ticker: string;
  timestamp: string;
  dirVegaFlow: number;
  score: number;
  vsPriorMax: number;
  priorMax: number;
  baselineMad: number;
  barsElapsed: number;
}

interface TickerOutcome {
  fired: boolean;
  score: number | null;
  ratio: number | null;
  newRowId?: number;
  timestamp?: string;
  error?: string;
}

// ── Pure detection helpers ──────────────────────────────────

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Detects whether the last bar in `bars` is a vega spike.
 *
 * @param ticker - 'SPY' or 'QQQ'
 * @param bars   - All of today's 1-min bars for this ticker, ordered ascending.
 *                 Must have at least VEGA_SPIKE_MIN_BARS_ELAPSED + 1 entries.
 * @returns SpikeResult if all 4 gates pass, null otherwise.
 */
export function detectSpike(
  ticker: string,
  bars: VegaFlowBar[],
): SpikeResult | null {
  // Gate 4: need at least MIN_BARS_ELAPSED + 1 bars total (baseline + candidate)
  if (bars.length < VEGA_SPIKE_MIN_BARS_ELAPSED + 1) return null;

  const candidate = bars.at(-1)!;
  const baseline = bars.slice(0, -1);
  const barsElapsed = baseline.length;

  const candAbs = Math.abs(Number(candidate.dir_vega_flow));
  const floor = VEGA_SPIKE_FLOORS[ticker] ?? 0;

  // Gate 1: absolute floor
  if (candAbs < floor) return null;

  const priorAbs = baseline.map((b) => Math.abs(Number(b.dir_vega_flow)));
  const priorAbsSorted = [...priorAbs].sort((a, b) => a - b);
  const priorMax = Math.max(...priorAbs);

  // Gate 2: ratio vs prior max
  if (candAbs < VEGA_SPIKE_VS_PRIOR_MAX_RATIO * priorMax) return null;

  // Gate 3: robust z-score using median + MAD
  const med = median(priorAbsSorted);
  const deviations = priorAbsSorted.map((x) => Math.abs(x - med));
  const mad = median(deviations.sort((a, b) => a - b));
  const safeMad = Math.max(mad, 1);
  const score = candAbs / safeMad;
  if (score < VEGA_SPIKE_Z_SCORE_THRESHOLD) return null;

  return {
    ticker,
    timestamp: candidate.timestamp,
    dirVegaFlow: Number(candidate.dir_vega_flow),
    score,
    vsPriorMax: candAbs / priorMax,
    priorMax,
    baselineMad: safeMad,
    barsElapsed,
  };
}

// ── Per-ticker evaluation ───────────────────────────────────

async function evaluateTicker(
  ticker: string,
  today: string,
): Promise<{ outcome: TickerOutcome; spike: SpikeResult | null }> {
  const sql = getDb();

  const rawBars = await withRetry(
    () =>
      sql`
      SELECT timestamp, dir_vega_flow
      FROM vega_flow_etf
      WHERE ticker = ${ticker}
        AND date = ${today}
      ORDER BY timestamp ASC
    `,
  );
  const bars = rawBars as VegaFlowBar[];

  const spike = detectSpike(ticker, bars);

  if (!spike) {
    return {
      outcome: { fired: false, score: null, ratio: null },
      spike: null,
    };
  }

  const result = await withRetry(
    () => sql`
    INSERT INTO vega_spike_events (
      ticker, date, timestamp, dir_vega_flow, z_score, vs_prior_max,
      prior_max, baseline_mad, bars_elapsed, confluence
    ) VALUES (
      ${ticker}, ${today}, ${spike.timestamp}, ${spike.dirVegaFlow},
      ${spike.score}, ${spike.vsPriorMax}, ${spike.priorMax},
      ${spike.baselineMad}, ${spike.barsElapsed}, false
    )
    ON CONFLICT (ticker, timestamp) DO NOTHING
    RETURNING id
  `,
  );

  if (result.length === 0) {
    // Duplicate — already in DB from a prior run
    return {
      outcome: { fired: false, score: spike.score, ratio: spike.vsPriorMax },
      spike: null,
    };
  }

  const newRowId = Number((result[0] as { id: number }).id);

  logger.info(
    {
      ticker,
      timestamp: spike.timestamp,
      score: spike.score,
      vsPriorMax: spike.vsPriorMax,
      dirVegaFlow: spike.dirVegaFlow,
    },
    'vega spike fired',
  );
  Sentry.metrics.count('vega_spike.fired', 1, {
    attributes: { ticker, confluence: 'false' },
  });

  return {
    outcome: {
      fired: true,
      score: spike.score,
      ratio: spike.vsPriorMax,
      newRowId,
      timestamp: spike.timestamp,
    },
    spike,
  };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();

  try {
    const tickers: Record<string, TickerOutcome | null> = {
      SPY: null,
      QQQ: null,
    };
    const newSpikes: Record<string, { timestamp: string; rowId: number }> = {};

    for (const ticker of ['SPY', 'QQQ']) {
      try {
        const { outcome, spike } = await evaluateTicker(ticker, today);
        tickers[ticker] = outcome;
        if (outcome.fired && outcome.newRowId != null && spike) {
          newSpikes[ticker] = {
            timestamp: spike.timestamp,
            rowId: outcome.newRowId,
          };
        }
      } catch (err) {
        logger.error({ err, ticker }, 'monitor-vega-spike per-ticker error');
        tickers[ticker] = {
          fired: false,
          score: null,
          ratio: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // ── Confluence check ──────────────────────────────────
    let confluence = false;
    const spySpikeInfo = newSpikes['SPY'];
    const qqqSpikeInfo = newSpikes['QQQ'];

    if (spySpikeInfo && qqqSpikeInfo) {
      const diffSec =
        Math.abs(
          new Date(spySpikeInfo.timestamp).getTime() -
            new Date(qqqSpikeInfo.timestamp).getTime(),
        ) / 1000;

      if (diffSec <= VEGA_SPIKE_CONFLUENCE_WINDOW_SEC) {
        const sql = getDb();
        await withRetry(
          () => sql`
          UPDATE vega_spike_events
          SET confluence = true
          WHERE (ticker, timestamp) IN (
            ('SPY', ${spySpikeInfo.timestamp}),
            ('QQQ', ${qqqSpikeInfo.timestamp})
          )
        `,
        );
        confluence = true;
        // Intentional: this is a SECOND emit on top of the per-ticker emits at
        // ~line 197. Confluent days will show 3x vega_spike.fired counts (one
        // per ticker as confluence=false, plus this BOTH/confluence=true). Sum
        // by `confluence:true` to get confluent-event count; sum by ticker to
        // get raw event count. Do NOT collapse — Sentry tag-based filtering
        // depends on the per-ticker rows being present.
        Sentry.metrics.count('vega_spike.fired', 1, {
          attributes: { ticker: 'BOTH', confluence: 'true' },
        });
        logger.info(
          {
            spy: spySpikeInfo.timestamp,
            qqq: qqqSpikeInfo.timestamp,
            diffSec,
          },
          'vega spike confluence detected',
        );
      }
    }

    const durationMs = Date.now() - startTime;
    await reportCronRun('monitor-vega-spike', {
      status: 'ok',
      spy_fired: tickers['SPY']?.fired ?? false,
      qqq_fired: tickers['QQQ']?.fired ?? false,
      confluence,
      durationMs,
    });

    return res.status(200).json({
      job: 'monitor-vega-spike',
      tickers,
      confluence,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'monitor-vega-spike');
    Sentry.captureException(err);
    logger.error({ err }, 'monitor-vega-spike error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
