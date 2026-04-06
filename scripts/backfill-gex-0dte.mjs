#!/usr/bin/env node

/**
 * Backfill script for 0DTE per-strike GEX data (gex_strike_0dte table).
 * Fetches per-strike gamma, charm, delta, vanna for 0DTE expiry only.
 * Stores strikes within ±200 pts of ATM with original timestamp (no rounding).
 *
 * Data is available from UW API since 2025-01-16.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-gex-0dte.mjs
 *
 * Options:
 *   node scripts/backfill-gex-0dte.mjs 5              # 5 days instead of 30
 *   node scripts/backfill-gex-0dte.mjs 2025-01-16     # from specific start date
 *   node scripts/backfill-gex-0dte.mjs 2025-01-16 60  # start date + N days forward
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

// ── Parse CLI args ─────────────────────────────────────────

const arg1 = process.argv[2];
const arg2 = process.argv[3];

let startDate = null;
let dayCount = 30;

if (arg1 && /^\d{4}-\d{2}-\d{2}$/.test(arg1)) {
  // Start date mode: backfill-gex-0dte.mjs 2025-01-16 [days]
  startDate = arg1;
  dayCount = Number.parseInt(arg2 ?? '60', 10);
} else if (arg1) {
  // Count mode: backfill-gex-0dte.mjs 5
  dayCount = Number.parseInt(arg1, 10);
}

// ── Generate trading days ──────────────────────────────────

function getTradingDaysBack(count) {
  const dates = [];
  const d = new Date();

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

function getTradingDaysForward(start, count) {
  const dates = [];
  const d = new Date(start + 'T12:00:00Z');
  const today = new Date().toISOString().slice(0, 10);

  const cursor = new Date(d);
  while (dates.length < count) {
    const dateStr = cursor.toISOString().slice(0, 10);

    // Don't go past today
    if (dateStr > today) break;

    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(dateStr);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

// ── Fetch per-strike 0DTE data for one date ────────────────

async function fetchStrike0dte(date) {
  const params = new URLSearchParams({
    'expirations[]': date, // 0DTE = expiry matches the date
    date,
    limit: '500',
  });

  const res = await fetch(
    `${UW_BASE}/stock/SPX/spot-exposures/expiry-strike?${params}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // Detect historic data access limit and extract earliest date
    if (res.status === 403 && text.includes('historic_data_access_missing')) {
      const match = /available to you is (\d{4}-\d{2}-\d{2})/.exec(text);
      if (match) {
        return { blocked: true, earliestDate: match[1] };
      }
      return { blocked: true, earliestDate: null };
    }

    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store strikes into gex_strike_0dte ─────────────────────

async function storeStrikes(rows, date) {
  if (rows.length === 0) return { stored: 0, price: null, filtered: 0 };

  const price = Number.parseFloat(rows[0].price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  // Use the original timestamp from the API (no rounding — minute precision)
  const timestamp = new Date(rows[0].time).toISOString();

  let stored = 0;

  for (const row of filtered) {
    try {
      const result = await sql`
        INSERT INTO gex_strike_0dte (
          date, timestamp, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_vol, put_gamma_vol,
          call_gamma_ask, call_gamma_bid,
          put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_vol, put_charm_vol,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi,
          call_vanna_vol, put_vanna_vol
        )
        VALUES (
          ${date}, ${timestamp}, ${row.strike}, ${row.price},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_vol}, ${row.put_gamma_vol},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_vol}, ${row.put_charm_vol},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi},
          ${row.call_vanna_vol}, ${row.put_vanna_vol}
        )
        ON CONFLICT (date, timestamp, strike) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error at strike ${row.strike}: ${err.message}`);
    }
  }

  return { stored, price, filtered: filtered.length };
}

// ── Format value for display ───────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Logging helper ─────────────────────────────────────────

function logDay(date, rows, result) {
  let peakGamma = { strike: 0, val: 0 };
  let troughGamma = { strike: 0, val: 0 };
  let peakCharm = { strike: 0, val: 0 };

  const price = result.price ?? 0;
  for (const row of rows) {
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
    if (Math.abs(netC) > Math.abs(peakCharm.val))
      peakCharm = { strike: s, val: netC };
  }

  console.log(
    `  ${date}: ${rows.length} total → ${result.filtered} filtered (${result.stored} new) | SPX: ${result.price ?? 'N/A'} | γ wall: ${peakGamma.strike} (${fmt(peakGamma.val)}) | γ trough: ${troughGamma.strike} (${fmt(troughGamma.val)}) | charm peak: ${peakCharm.strike} (${fmt(peakCharm.val)})`,
  );
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const tradingDays = startDate
    ? getTradingDaysForward(startDate, dayCount)
    : getTradingDaysBack(dayCount);

  console.log(`Backfilling 0DTE Per-Strike GEX → gex_strike_0dte`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;

  let skippedToDate = null;

  for (const date of tradingDays) {
    // Skip dates before the plan's earliest available date
    if (skippedToDate && date < skippedToDate) continue;

    // Rate limit: 120 req/60s → 550ms between requests with margin
    await new Promise((r) => setTimeout(r, 550));

    const rows = await fetchStrike0dte(date);

    // Handle historic data access block — skip ahead automatically
    if (rows && typeof rows === 'object' && !Array.isArray(rows) && rows.blocked) {
      if (rows.earliestDate) {
        console.log(
          `  ${date}: ⚠ Plan limit — skipping ahead to ${rows.earliestDate}`,
        );
        skippedToDate = rows.earliestDate;
      } else {
        console.log(`  ${date}: ⚠ Plan limit — skipping`);
      }
      continue;
    }

    const result = await storeStrikes(rows, date);
    totalStored += result.stored;
    logDay(date, rows, result);
  }

  console.log(`\nDone!`);
  console.log(`  Total rows stored: ${totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
