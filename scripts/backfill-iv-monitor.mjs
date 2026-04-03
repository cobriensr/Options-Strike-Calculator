#!/usr/bin/env node

/**
 * Backfill IV monitor data for recent trading days.
 *
 * Fetches the UW interpolated-iv endpoint for each historical date,
 * extracts the 0DTE row, and stores one reading per day in iv_monitor.
 * This gives build-features the iv_open value it needs.
 *
 * Usage:
 *   node scripts/backfill-iv-monitor.mjs          # 30 days (default)
 *   node scripts/backfill-iv-monitor.mjs 10       # 10 days
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

const args = process.argv.slice(2);
const days = Number.parseInt(args[0] ?? '30', 10);

// ── Generate last N trading days ────────────────────────────

function getTradingDays(count) {
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

// ── Fetch IV for a single date ──────────────────────────────

async function fetchIvForDate(date) {
  const res = await fetch(`${UW_BASE}/stock/SPX/interpolated-iv?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status}: ${text.slice(0, 100)}`);
    return null;
  }

  const body = await res.json();
  const rows = body.data ?? [];

  // Find the 0DTE row (days <= 1)
  const zeroDte = rows.find((r) => r.days <= 1);
  if (!zeroDte) return null;

  const volatility = Number.parseFloat(zeroDte.volatility);
  if (Number.isNaN(volatility)) return null;

  return {
    volatility,
    impliedMove: Number.parseFloat(zeroDte.implied_move_perc) || 0,
    percentile: Number.parseFloat(zeroDte.percentile) || 0,
  };
}

// ── Store reading ───────────────────────────────────────────

async function storeReading(date, reading) {
  // Use 9:31 AM ET as the timestamp (represents the open reading)
  const timestamp = `${date}T09:31:00-04:00`;

  try {
    await sql`
      INSERT INTO iv_monitor (
        date, timestamp, volatility, implied_move, percentile, spx_price
      ) VALUES (
        ${date}, ${timestamp}, ${reading.volatility},
        ${reading.impliedMove}, ${reading.percentile}, ${null}
      )
      ON CONFLICT (date, timestamp) DO UPDATE SET
        volatility = EXCLUDED.volatility,
        implied_move = EXCLUDED.implied_move,
        percentile = EXCLUDED.percentile
    `;
    return true;
  } catch (err) {
    console.warn(`  Insert error for ${date}: ${err.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log('Backfilling IV monitor (0DTE ATM implied volatility)');
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays.at(-1)})\n`,
  );

  let stored = 0;
  let skipped = 0;
  let errors = 0;

  for (const date of tradingDays) {
    // Rate limit: 600ms between calls
    await new Promise((r) => setTimeout(r, 600));

    const reading = await fetchIvForDate(date);

    if (!reading) {
      console.log(`  ${date}: no 0DTE IV data`);
      skipped++;
      continue;
    }

    const ok = await storeReading(date, reading);
    if (ok) {
      console.log(
        `  ${date}: IV ${(reading.volatility * 100).toFixed(1)}%  ` +
          `implied move ${(reading.impliedMove * 100).toFixed(2)}%  ` +
          `percentile ${reading.percentile.toFixed(0)}`,
      );
      stored++;
    } else {
      errors++;
    }
  }

  console.log('\nDone!');
  console.log(`  Stored: ${stored}`);
  console.log(`  Skipped (no data): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
