#!/usr/bin/env node

/**
 * One-shot: replay spike detection across the 30-day vega_flow_etf backfill,
 * populating vega_spike_events for historical periods that the live cron
 * missed. Detection algorithm mirrors api/cron/monitor-vega-spike.ts:detectSpike.
 *
 * After this runs, the enrichment cron (enrich-vega-spike-returns) will
 * populate fwd_return_5m/15m/30m on these historical events at its next
 * 5-min tick — assuming etf_candles_1m has the corresponding price data
 * (run scripts/backfill-etf-candles-1m.mjs first if needed).
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/replay-spike-detection.mjs
 *
 * Idempotent: ON CONFLICT (ticker, timestamp) DO NOTHING.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ── Constants — keep in sync with api/_lib/constants.ts ─────

const VEGA_SPIKE_FLOORS = { SPY: 490_000, QQQ: 330_000 };
const VEGA_SPIKE_Z_SCORE_THRESHOLD = 6.0;
const VEGA_SPIKE_VS_PRIOR_MAX_RATIO = 2.0;
const VEGA_SPIKE_MIN_BARS_ELAPSED = 30;
const VEGA_SPIKE_CONFLUENCE_WINDOW_SEC = 60;

const TICKERS = ['SPY', 'QQQ'];

// ── Pure detection helpers ──────────────────────────────────

function median(sorted) {
  if (sorted.length === 0) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

/**
 * Mirrors api/cron/monitor-vega-spike.ts:detectSpike.
 * Returns a spike object if the last bar in `bars` qualifies, else null.
 */
function detectSpike(ticker, bars) {
  if (bars.length < VEGA_SPIKE_MIN_BARS_ELAPSED + 1) return null;
  const candidate = bars.at(-1);
  const baseline = bars.slice(0, -1);
  const candAbs = Math.abs(Number(candidate.dir_vega_flow));
  const floor = VEGA_SPIKE_FLOORS[ticker] ?? 0;
  if (candAbs < floor) return null;
  const priorAbs = baseline.map((b) => Math.abs(Number(b.dir_vega_flow)));
  const priorAbsSorted = [...priorAbs].sort((a, b) => a - b);
  const priorMax = Math.max(...priorAbs);
  if (candAbs < VEGA_SPIKE_VS_PRIOR_MAX_RATIO * priorMax) return null;
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
    barsElapsed: baseline.length,
  };
}

// ── DB helpers ──────────────────────────────────────────────

async function getDistinctDates(ticker) {
  const rows = await sql`
    SELECT DISTINCT date::text AS date
    FROM vega_flow_etf
    WHERE ticker = ${ticker}
    ORDER BY date ASC
  `;
  return rows.map((r) => r.date);
}

async function getBarsForDay(ticker, date) {
  const rows = await sql`
    SELECT timestamp, dir_vega_flow
    FROM vega_flow_etf
    WHERE ticker = ${ticker} AND date = ${date}
    ORDER BY timestamp ASC
  `;
  return rows;
}

async function insertSpike(ticker, date, spike) {
  const result = await sql`
    INSERT INTO vega_spike_events (
      ticker, date, timestamp, dir_vega_flow, z_score, vs_prior_max,
      prior_max, baseline_mad, bars_elapsed, confluence
    ) VALUES (
      ${ticker}, ${date}, ${spike.timestamp}, ${spike.dirVegaFlow},
      ${spike.score}, ${spike.vsPriorMax}, ${spike.priorMax},
      ${spike.baselineMad}, ${spike.barsElapsed}, false
    )
    ON CONFLICT (ticker, timestamp) DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

async function resolveConfluence() {
  // Pair every SPY spike with every QQQ spike that fired within
  // VEGA_SPIKE_CONFLUENCE_WINDOW_SEC seconds, then mark both rows.
  // Idempotent — re-running just reasserts the same flag.
  const result = await sql`
    WITH pairs AS (
      SELECT a.id AS a_id, b.id AS b_id
      FROM vega_spike_events a
      JOIN vega_spike_events b
        ON a.ticker = 'SPY' AND b.ticker = 'QQQ'
       AND ABS(EXTRACT(EPOCH FROM (a.timestamp - b.timestamp))) <= ${VEGA_SPIKE_CONFLUENCE_WINDOW_SEC}
    )
    UPDATE vega_spike_events
    SET confluence = true
    WHERE id IN (SELECT a_id FROM pairs UNION SELECT b_id FROM pairs)
    RETURNING id
  `;
  return result.length;
}

// ── Walk one (ticker, date) ─────────────────────────────────

async function walkDay(ticker, date) {
  const bars = await getBarsForDay(ticker, date);
  if (bars.length < VEGA_SPIKE_MIN_BARS_ELAPSED + 1) {
    return { bars: bars.length, detected: 0, inserted: 0 };
  }

  let detected = 0;
  let inserted = 0;

  // Simulate the live cron's view at each minute: "I just received bar i;
  // here's the prior i bars as baseline." Start at MIN_BARS_ELAPSED so the
  // baseline is always >= MIN_BARS_ELAPSED (gate 4 in detectSpike).
  for (let i = VEGA_SPIKE_MIN_BARS_ELAPSED; i < bars.length; i++) {
    const slice = bars.slice(0, i + 1);
    const spike = detectSpike(ticker, slice);
    if (!spike) continue;
    detected++;
    const wasInserted = await insertSpike(ticker, date, spike);
    if (wasInserted) inserted++;
  }

  return { bars: bars.length, detected, inserted };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const start = Date.now();

  console.log('Replaying spike detection across vega_flow_etf backfill');
  console.log(`Tickers: ${TICKERS.join(', ')}\n`);

  const datesByTicker = {};
  for (const ticker of TICKERS) {
    datesByTicker[ticker] = await getDistinctDates(ticker);
    console.log(`  ${ticker}: ${datesByTicker[ticker].length} distinct dates`);
  }
  console.log('');

  const totals = {};
  for (const ticker of TICKERS) {
    totals[ticker] = { bars: 0, detected: 0, inserted: 0 };
  }

  for (const ticker of TICKERS) {
    for (const date of datesByTicker[ticker]) {
      const { bars, detected, inserted } = await walkDay(ticker, date);
      totals[ticker].bars += bars;
      totals[ticker].detected += detected;
      totals[ticker].inserted += inserted;
      console.log(
        `  ${date} ${ticker}: ${bars} bars → ${detected} spike${detected === 1 ? '' : 's'} detected (${inserted} new)`,
      );
    }
  }

  console.log('\nResolving confluence pairs…');
  const confluenceCount = await resolveConfluence();

  const elapsedMs = Date.now() - start;

  console.log('\nDone!');
  for (const ticker of TICKERS) {
    console.log(
      `  ${ticker}: ${totals[ticker].bars} bars, ${totals[ticker].detected} detected, ${totals[ticker].inserted} newly inserted`,
    );
  }
  console.log(`  Confluence rows marked: ${confluenceCount}`);
  console.log(`  Walk time: ${(elapsedMs / 1000).toFixed(1)}s`);
}

try {
  await main();
} catch (err) {
  console.error('Replay failed:', err);
  process.exit(1);
}
