#!/usr/bin/env node

/**
 * Local backfill script for per-strike open interest (SPX).
 * Fetches daily OI data from Unusual Whales API and stores in oi_per_strike.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-oi-per-strike.mjs
 *
 * Options:
 *   node scripts/backfill-oi-per-strike.mjs 5    # 5 days instead of 30
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

// ── Fetch OI per strike for one date ────────────────────────

async function fetchOiPerStrike(date) {
  const res = await fetch(`${UW_BASE}/stock/SPX/oi-per-strike?date=${date}`, {
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

// ── Store strikes ───────────────────────────────────────────

async function storeStrikes(rows, date) {
  if (rows.length === 0) return { stored: 0 };

  let stored = 0;

  for (const row of rows) {
    try {
      const callOi = Number.parseInt(String(row.call_oi), 10) || 0;
      const putOi = Number.parseInt(String(row.put_oi), 10) || 0;
      const strike = Number.parseFloat(String(row.strike));

      const result = await sql`
        INSERT INTO oi_per_strike (date, strike, call_oi, put_oi)
        VALUES (${date}, ${strike}, ${callOi}, ${putOi})
        ON CONFLICT (date, strike) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error at strike ${row.strike}: ${err.message}`);
    }
  }

  return { stored };
}

// ── Format number for display ───────────────────────────────

function fmt(val) {
  const n = Number.parseInt(String(val), 10);
  if (Number.isNaN(n) || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX OI Per Strike`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 400));

    const rows = await fetchOiPerStrike(date);
    const result = await storeStrikes(rows, date);

    totalStored += result.stored;

    // Find top 3 strikes by total OI for logging
    const ranked = rows
      .map((r) => ({
        strike: Number.parseFloat(String(r.strike)),
        total:
          (Number.parseInt(String(r.call_oi), 10) || 0) +
          (Number.parseInt(String(r.put_oi), 10) || 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);

    const top3 = ranked.map((r) => `${r.strike} (${fmt(r.total)})`).join(', ');

    console.log(
      `  ${date}: ${rows.length} strikes (${result.stored} new) | Top OI: ${top3 || 'N/A'}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total strike rows stored: ${totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
