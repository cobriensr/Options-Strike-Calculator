#!/usr/bin/env node

/**
 * Local backfill script for SPX Spot GEX Exposures (per-minute panel data).
 * Fetches intraday OI/Volume/Directionalized gamma, charm, vanna + price.
 * Samples to 5-minute intervals before storing.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-spot-gex.mjs
 *
 * Options:
 *   node scripts/backfill-spot-gex.mjs 5    # 5 days instead of 30
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

// ── Fetch spot exposures for one date ───────────────────────

async function fetchSpotExposures(date) {
  const res = await fetch(`${UW_BASE}/stock/SPX/spot-exposures?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
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
    const dt = new Date(row.start_time ?? row.time);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    const key = rounded.toISOString();

    // Keep last tick per 5-min window
    sampled.set(key, {
      timestamp: key,
      price: row.price,
      gamma_oi: row.gamma_per_one_percent_move_oi,
      gamma_vol: row.gamma_per_one_percent_move_vol,
      gamma_dir: row.gamma_per_one_percent_move_dir,
      charm_oi: row.charm_per_one_percent_move_oi,
      charm_vol: row.charm_per_one_percent_move_vol,
      charm_dir: row.charm_per_one_percent_move_dir,
      vanna_oi: row.vanna_per_one_percent_move_oi,
      vanna_vol: row.vanna_per_one_percent_move_vol,
      vanna_dir: row.vanna_per_one_percent_move_dir,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store sampled candles ───────────────────────────────────

async function storeCandles(candles, date) {
  let stored = 0;

  for (const c of candles) {
    try {
      const result = await sql`
        INSERT INTO spot_exposures (
          date, timestamp, ticker, price,
          gamma_oi, gamma_vol, gamma_dir,
          charm_oi, charm_vol, charm_dir,
          vanna_oi, vanna_vol, vanna_dir
        )
        VALUES (
          ${date}, ${c.timestamp}, 'SPX', ${c.price},
          ${c.gamma_oi}, ${c.gamma_vol}, ${c.gamma_dir},
          ${c.charm_oi}, ${c.charm_vol}, ${c.charm_dir},
          ${c.vanna_oi}, ${c.vanna_vol}, ${c.vanna_dir}
        )
        ON CONFLICT (date, timestamp, ticker) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return stored;
}

// ── Format large numbers for display ────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX Spot GEX Exposures (per-minute panel data)`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalCandles = 0;
  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const rawRows = await fetchSpotExposures(date);
    const candles = sampleTo5Min(rawRows);
    const stored = await storeCandles(candles, date);

    totalCandles += candles.length;
    totalStored += stored;

    // Log latest values for sanity check
    const latest = candles.at(-1);
    const gammaOi = latest ? fmt(latest.gamma_oi) : 'N/A';
    const gammaVol = latest ? fmt(latest.gamma_vol) : 'N/A';
    const gammaDir = latest ? fmt(latest.gamma_dir) : 'N/A';
    const price = latest?.price ?? 'N/A';

    console.log(
      `  ${date}: ${rawRows.length} ticks → ${candles.length} candles (${stored} new) | SPX: ${price} | OI: ${gammaOi} | Vol: ${gammaVol} | Dir: ${gammaDir}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total candles: ${totalCandles}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Skipped (duplicates): ${totalCandles - totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
