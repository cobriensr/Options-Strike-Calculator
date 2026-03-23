#!/usr/bin/env node

/**
 * Local backfill script for Net Flow ticks (SPX, SPY, QQQ).
 * Fetches per-minute incremental data, cumulates, samples to 5-min, stores to Neon.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-net-flow.mjs
 *
 * Options:
 *   node scripts/backfill-net-flow.mjs 5          # backfill 5 days instead of 30
 *   node scripts/backfill-net-flow.mjs 30 SPX     # backfill only SPX
 *   node scripts/backfill-net-flow.mjs 30 SPY QQQ # backfill only SPY and QQQ
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

const ALL_TICKERS = [
  { ticker: 'SPX', source: 'spx_flow' },
  { ticker: 'SPY', source: 'spy_flow' },
  { ticker: 'QQQ', source: 'qqq_flow' },
];

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const days = Number.parseInt(args[0] ?? '30', 10);
const tickerFilter = args.slice(1).map((t) => t.toUpperCase());
const tickers =
  tickerFilter.length > 0
    ? ALL_TICKERS.filter((t) => tickerFilter.includes(t.ticker))
    : ALL_TICKERS;

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

// ── Fetch + cumulate + sample ───────────────────────────────

async function fetchNetFlowForDate(ticker, date) {
  const res = await fetch(
    `${UW_BASE}/stock/${ticker}/net-prem-ticks?date=${date}`,
    {
      headers: { Authorization: `Bearer ${UW_API_KEY}` },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${ticker} ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  const ticks = body.data ?? [];

  if (ticks.length === 0) return [];

  // Cumulate incremental ticks
  let runningNcp = 0;
  let runningNpp = 0;
  let runningCallVol = 0;
  let runningPutVol = 0;

  const cumulated = ticks.map((tick) => {
    runningNcp += Number.parseFloat(tick.net_call_premium) || 0;
    runningNpp += Number.parseFloat(tick.net_put_premium) || 0;
    runningCallVol += tick.net_call_volume || 0;
    runningPutVol += tick.net_put_volume || 0;

    return {
      date: tick.date,
      timestamp: tick.tape_time,
      ncp: runningNcp,
      npp: runningNpp,
      netVolume: runningCallVol + runningPutVol,
    };
  });

  // Sample at 5-minute intervals (last tick per 5-min window)
  const sampled = new Map();

  for (const tick of cumulated) {
    const dt = new Date(tick.timestamp);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    const key = rounded.toISOString();

    sampled.set(key, {
      date: tick.date,
      timestamp: key,
      ncp: tick.ncp,
      npp: tick.npp,
      netVolume: tick.netVolume,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store all sampled candles ───────────────────────────────

async function storeCandles(candles, source) {
  let stored = 0;

  for (const c of candles) {
    try {
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (${c.date}, ${c.timestamp}, ${source}, ${c.ncp}, ${c.npp}, ${c.netVolume})
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return stored;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(
    `Backfilling net flow for: ${tickers.map((t) => t.ticker).join(', ')}`,
  );
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  const totals = { candles: 0, stored: 0 };

  for (const date of tradingDays) {
    // Delay between dates to respect rate limits
    await new Promise((r) => setTimeout(r, 300));

    const dayResults = [];

    for (const { ticker, source } of tickers) {
      // Small delay between tickers
      await new Promise((r) => setTimeout(r, 100));

      const candles = await fetchNetFlowForDate(ticker, date);
      const stored = await storeCandles(candles, source);

      totals.candles += candles.length;
      totals.stored += stored;

      dayResults.push(`${ticker}: ${candles.length} (${stored} new)`);
    }

    console.log(`  ${date}: ${dayResults.join(', ')}`);
  }

  console.log(`\nDone!`);
  console.log(`  Total candles: ${totals.candles}`);
  console.log(`  Newly stored: ${totals.stored}`);
  console.log(`  Skipped (duplicates): ${totals.candles - totals.stored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
