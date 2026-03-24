#!/usr/bin/env node

/**
 * Local backfill script — run from your terminal.
 * Fetches 30 days of Market Tide data from UW API and inserts directly into Neon.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node backfill-local.mjs
 *
 * Or with your .env.local:
 *   source .env.local && node backfill-local.mjs
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

// ── Fetch Market Tide for one date ──────────────────────────

async function fetchMarketTide(date, otmOnly) {
  const params = new URLSearchParams({ date, interval_5m: 'true' });
  if (otmOnly) params.set('otm_only', 'true');

  const res = await fetch(`${UW_BASE}/market/market-tide?${params}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${date} (${otmOnly ? 'OTM' : 'all-in'}): ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store all candles for one date + source ─────────────────

async function storeCandles(rows, source) {
  let stored = 0;

  for (const row of rows) {
    try {
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${row.date},
          ${row.timestamp},
          ${source},
          ${row.net_call_premium},
          ${row.net_put_premium},
          ${row.net_volume}
        )
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
  const days = Number.parseInt(process.argv[2] ?? '30', 10);
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling ${tradingDays.length} trading days...`);
  console.log(`Range: ${tradingDays[0]} to ${tradingDays.at(-1)}\n`);

  let totalRows = 0;
  let totalStored = 0;

  for (const date of tradingDays) {
    // Small delay to respect rate limits
    await new Promise((r) => setTimeout(r, 200));

    const [allInRows, otmRows] = await Promise.all([
      fetchMarketTide(date, false),
      fetchMarketTide(date, true),
    ]);

    const allInStored = await storeCandles(allInRows, 'market_tide');
    const otmStored = await storeCandles(otmRows, 'market_tide_otm');

    totalRows += allInRows.length + otmRows.length;
    totalStored += allInStored + otmStored;

    console.log(
      `  ${date}: all-in ${allInRows.length} candles (${allInStored} new), OTM ${otmRows.length} candles (${otmStored} new)`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total candles: ${totalRows}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Skipped (duplicates): ${totalRows - totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
