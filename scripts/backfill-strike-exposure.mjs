#!/usr/bin/env node

/**
 * Local backfill script for per-strike Greek exposure (SPX 0DTE + 1DTE).
 * Fetches per-strike gamma, charm, delta, vanna for 0DTE and 1DTE expirations.
 * Stores strikes within ±200 pts of ATM.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-strike-exposure.mjs
 *
 * Options:
 *   node scripts/backfill-strike-exposure.mjs 5    # 5 days instead of 30
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
const ATM_RANGE = 200;

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

// ── Get next trading day (skip weekends) ───────────────────

function getNextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// ── Fetch per-strike data for one date ──────────────────────

async function fetchStrikeExposure(date, expiry) {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    date,
    limit: '500',
  });

  const res = await fetch(
    `${UW_BASE}/stock/SPX/spot-exposures/expiry-strike?${params}`,
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

// ── Store strikes ───────────────────────────────────────────

async function storeStrikes(rows, date, expiry) {
  if (rows.length === 0) return { stored: 0, price: null, filtered: 0 };

  const price = Number.parseFloat(rows[0].price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  // Use the timestamp from the data, rounded to 5-min
  const dataTime = new Date(rows[0].time);
  const minutes = dataTime.getMinutes();
  dataTime.setMinutes(minutes - (minutes % 5), 0, 0);
  const timestamp = dataTime.toISOString();

  let stored = 0;

  for (const row of filtered) {
    try {
      const result = await sql`
        INSERT INTO strike_exposures (
          date, timestamp, ticker, expiry, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi
        )
        VALUES (
          ${date}, ${timestamp}, 'SPX', ${expiry}, ${row.strike}, ${row.price},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_ask}, ${row.call_charm_bid},
          ${row.put_charm_ask}, ${row.put_charm_bid},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi}
        )
        ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error at strike ${row.strike}: ${err.message}`);
    }
  }

  return { stored, price, filtered: filtered.length };
}

// ── Format value for display ────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || n === 0) return '0';
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

  console.log(`Backfilling SPX 0DTE + 1DTE Per-Strike Greek Exposure`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 400));

    const nextDay = getNextTradingDay(date);
    const [rows0dte, rows1dte] = await Promise.all([
      fetchStrikeExposure(date, date),
      fetchStrikeExposure(date, nextDay),
    ]);
    const result0dte = await storeStrikes(rows0dte, date, date);
    const result1dte = await storeStrikes(rows1dte, date, nextDay);

    totalStored += result0dte.stored + result1dte.stored;

    // Find peak positive and negative gamma/charm for logging (0DTE)
    let peakGamma = { strike: 0, val: 0 };
    let troughGamma = { strike: 0, val: 0 };
    let peakCharm = { strike: 0, val: 0 };

    const price = result0dte.price ?? 0;
    for (const row of rows0dte) {
      const s = Number.parseFloat(row.strike);
      if (Math.abs(s - price) > ATM_RANGE) continue;
      const netG =
        Number.parseFloat(row.call_gamma_oi) +
        Number.parseFloat(row.put_gamma_oi);
      const netC =
        Number.parseFloat(row.call_charm_oi) +
        Number.parseFloat(row.put_charm_oi);
      if (netG > peakGamma.val) peakGamma = { strike: s, val: netG };
      if (netG < troughGamma.val) troughGamma = { strike: s, val: netG };
      if (netC > peakCharm.val) peakCharm = { strike: s, val: netC };
    }

    console.log(
      `  ${date}: 0DTE ${rows0dte.length} total → ${result0dte.filtered} filtered (${result0dte.stored} new) | 1DTE (${nextDay}) ${rows1dte.length} total → ${result1dte.filtered} filtered (${result1dte.stored} new) | SPX: ${result0dte.price ?? 'N/A'} | Peak γ: ${peakGamma.strike} (${fmt(peakGamma.val)}) | Trough γ: ${troughGamma.strike} (${fmt(troughGamma.val)}) | Peak charm: ${peakCharm.strike} (${fmt(peakCharm.val)})`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total strike rows stored (0DTE + 1DTE): ${totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
