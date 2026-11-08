#!/usr/bin/env node

/**
 * Local backfill script for 0DTE SPX Greek (delta/vega) flow.
 * Fetches from the Greek Flow by Expiry endpoint filtered to each day's date.
 *
 * Stored in flow_data table with source = 'zero_dte_greek_flow'.
 * ncp = total_delta_flow, npp = dir_delta_flow, net_volume = volume.
 *
 * DO NOT RUN THIS for zero_dte_greek_flow, on any day, until it adopts the
 * window-END label (spec P2.1,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). From the deploy of
 * that fix (planned 2026-11-09) api/cron/fetch-greek-flow.ts stamps a closed
 * 5-minute bucket at its END (the 09:30-09:35 bucket at 09:35) and upserts it.
 * This script still stamps the window START (09:30), is DO NOTHING and does not
 * write the OTM columns, so its rows would interleave with the live ones under
 * a second convention, and the unique key would not catch it.
 *
 * Every row it inserts is also appended to flow_data_revisions, in the same
 * statement, under the writer name "backfill-greek-flow" (spec P0.8): a refill
 * keeps the log of what was stored before it.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-flow.mjs
 *
 * Options:
 *   node scripts/backfill-greek-flow.mjs 5    # 5 days instead of 30
 */

import { neon } from '@neondatabase/serverless';

import { storeSampledDay } from './_lib/flow-data-backfill.mjs';
import { getTradingDays } from './_lib/trading-days.mjs';

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';
const SOURCE = 'zero_dte_greek_flow';

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// ── Fetch Greek flow for one date ───────────────────────────

let fetchFailures = 0;
// Insert errors, counted by storeSampledDay: any makes the run exit non-zero.
const totals = { failed: 0 };

async function fetchGreekFlow(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/greek-flow/${date}?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    fetchFailures++;
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Sample to 5-min and store ───────────────────────────────

function storeCandles(ticks, date) {
  // Sampled to 5-min rows and stored with ONE statement for the day. DO NOTHING,
  // and every row it inserts is logged to flow_data_revisions in the same
  // statement (zero_dte_greek_flow is in the revision log, P0.8). An insert
  // error is printed and counted in totals.failed, which sets the exit code.
  return storeSampledDay(sql, ticks, {
    date,
    source: SOURCE,
    writer: 'backfill-greek-flow',
    valueOf: (tick) => ({
      ncp: tick.total_delta_flow,
      npp: tick.dir_delta_flow,
      net_volume: tick.volume,
    }),
    totals,
  });
}

// ── Format for display ──────────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling 0DTE SPX Greek Flow (delta/vega)`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;
  let totalCandles = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const ticks = await fetchGreekFlow(date);
    const result = await storeCandles(ticks, date);

    totalStored += result.stored;
    totalCandles += result.sampled;

    const latest = ticks.at(-1);
    const totalDelta = latest ? fmt(latest.total_delta_flow) : 'N/A';
    const dirDelta = latest ? fmt(latest.dir_delta_flow) : 'N/A';
    const totalVega = latest ? fmt(latest.total_vega_flow) : 'N/A';

    console.log(
      `  ${date}: ${ticks.length} ticks → ${result.sampled} candles (${result.stored} new) | Δ: ${totalDelta} | Dir Δ: ${dirDelta} | Vega: ${totalVega}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total candles: ${totalCandles}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Fetch failures: ${fetchFailures}`);
  console.log(`  Insert failures: ${totals.failed}`);

  if (fetchFailures > 0 || totals.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
