#!/usr/bin/env node

/**
 * Local backfill script for 0DTE SPX Greek (delta/vega) flow.
 * Fetches from the Greek Flow by Expiry endpoint filtered to each day's date.
 *
 * Stored in flow_data table with source = 'zero_dte_greek_flow'.
 * ncp = total_delta_flow, npp = dir_delta_flow, net_volume = volume.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-flow.mjs
 *
 * Options:
 *   node scripts/backfill-greek-flow.mjs 5    # 5 days instead of 30
 */

import { neon } from '@neondatabase/serverless';

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

// ── Generate last N trading days ────────────────────────────

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

  // Include today if it's a weekday
  const today = d.getDay();
  if (today !== 0 && today !== 6) {
    dates.push(d.toISOString().slice(0, 10));
  }

  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }

  return dates.reverse();
}

// ── Fetch Greek flow for one date ───────────────────────────

async function fetchGreekFlow(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/greek-flow/${date}?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Sample to 5-min and store ───────────────────────────────

async function storeCandles(ticks, date) {
  if (ticks.length === 0) return { stored: 0, sampled: 0 };

  const sampled = new Map();
  for (const tick of ticks) {
    const dt = new Date(tick.timestamp);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    sampled.set(rounded.toISOString(), tick);
  }

  let stored = 0;

  for (const [ts, tick] of sampled) {
    try {
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${date}, ${ts}, ${SOURCE},
          ${tick.total_delta_flow}, ${tick.dir_delta_flow}, ${tick.volume}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return { stored, sampled: sampled.size };
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
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
