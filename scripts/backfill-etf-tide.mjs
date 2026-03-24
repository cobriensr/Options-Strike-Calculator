#!/usr/bin/env node

/**
 * Local backfill script for ETF Tide (SPY and QQQ underlying holdings flow).
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-etf-tide.mjs
 *
 * Options:
 *   node scripts/backfill-etf-tide.mjs 5          # 5 days instead of 30
 *   node scripts/backfill-etf-tide.mjs 30 SPY     # SPY only
 *   node scripts/backfill-etf-tide.mjs 30 QQQ     # QQQ only
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
  { ticker: 'SPY', source: 'spy_etf_tide' },
  { ticker: 'QQQ', source: 'qqq_etf_tide' },
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

// ── Fetch ETF Tide for one date ─────────────────────────────

async function fetchEtfTide(ticker, date) {
  const res = await fetch(`${UW_BASE}/market/${ticker}/etf-tide?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${ticker} ETF Tide ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Sample to 5-min intervals ───────────────────────────────

function sampleTo5Min(rows) {
  if (rows.length === 0) return [];

  const sampled = new Map();

  for (const row of rows) {
    const dt = new Date(row.timestamp);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    const key = rounded.toISOString();

    sampled.set(key, {
      date: row.date ?? dt.toISOString().slice(0, 10),
      timestamp: key,
      ncp: Number.parseFloat(row.net_call_premium) || 0,
      npp: Number.parseFloat(row.net_put_premium) || 0,
      netVolume: row.net_volume || 0,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store all sampled candles ───────────────────────────────

async function storeCandles(candles, source, date) {
  let stored = 0;

  for (const c of candles) {
    try {
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (${date}, ${c.timestamp}, ${source}, ${c.ncp}, ${c.npp}, ${c.netVolume})
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
    `Backfilling ETF Tide for: ${tickers.map((t) => t.ticker).join(', ')}`,
  );
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  const totals = { candles: 0, stored: 0 };

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const dayResults = [];

    for (const { ticker, source } of tickers) {
      await new Promise((r) => setTimeout(r, 100));

      const rows = await fetchEtfTide(ticker, date);
      const candles = sampleTo5Min(rows);
      const stored = await storeCandles(candles, source, date);

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
