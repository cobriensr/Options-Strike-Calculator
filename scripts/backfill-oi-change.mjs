#!/usr/bin/env node

/**
 * Backfill OI change data for recent trading days.
 *
 * Fetches SPX OI change from Unusual Whales, parses option_symbol to
 * extract strike and is_call (OCC format), and stores in the oi_changes
 * table with ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-oi-change.mjs
 *   node scripts/backfill-oi-change.mjs          # 30 days default
 *   node scripts/backfill-oi-change.mjs 10       # 10 days
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

// ── Parse args ──────────────────────────────────────────────

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

// ── Parse OCC option symbol ─────────────────────────────────

/**
 * OCC format: ROOT + YYMMDD + C/P + strike*1000 (8 digits)
 * e.g. "SPXW  260402C05600000" → { strike: 5600, isCall: true }
 * The char before the last 8 digits is C or P.
 * The last 8 digits / 1000 = strike.
 */
function parseOptionSymbol(symbol) {
  if (!symbol || symbol.length < 9) return null;
  const trimmed = symbol.trim();
  const strikePart = trimmed.slice(-8);
  const cpChar = trimmed.slice(-9, -8).toUpperCase();
  const strike = Number.parseInt(strikePart, 10) / 1000;
  if (Number.isNaN(strike) || strike <= 0) return null;
  const isCall = cpChar === 'C';
  if (cpChar !== 'C' && cpChar !== 'P') return null;
  return { strike, isCall };
}

// ── Fetch OI change for a date ──────────────────────────────

async function fetchOiChange(date) {
  const res = await fetch(`${UW_BASE}/stock/SPX/oi-change?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store OI changes ────────────────────────────────────────

async function storeOiChanges(date, rows) {
  let stored = 0;

  for (const r of rows) {
    const parsed = parseOptionSymbol(r.option_symbol);
    if (!parsed) continue;

    const oiDiff = Number.parseInt(String(r.oi_change ?? '0'), 10);
    const prevAskVol = Number.parseInt(String(r.prev_ask_volume ?? '0'), 10);
    const prevBidVol = Number.parseInt(String(r.prev_bid_volume ?? '0'), 10);
    const prevMultiLeg = Number.parseInt(
      String(r.prev_multi_leg_volume ?? '0'),
      10,
    );
    const prevTotalPremium = Number.parseFloat(
      String(r.prev_total_premium ?? '0'),
    );

    try {
      await sql`
        INSERT INTO oi_changes (
          date, option_symbol, strike, is_call, oi_diff,
          prev_ask_volume, prev_bid_volume,
          prev_multi_leg_volume, prev_total_premium
        ) VALUES (
          ${date}, ${r.option_symbol}, ${parsed.strike}, ${parsed.isCall},
          ${oiDiff}, ${prevAskVol}, ${prevBidVol},
          ${prevMultiLeg}, ${prevTotalPremium}
        )
        ON CONFLICT DO NOTHING
      `;
      stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return stored;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log('Backfilling OI changes for SPX');
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays.at(-1)})\n`,
  );

  const totals = { rows: 0, stored: 0, skipped: 0 };

  for (const date of tradingDays) {
    // Rate limit: 600ms between dates
    await new Promise((r) => setTimeout(r, 600));

    const rows = await fetchOiChange(date);

    if (rows.length === 0) {
      console.log(`  ${date}: no data`);
      totals.skipped++;
      continue;
    }

    const stored = await storeOiChanges(date, rows);

    totals.rows += rows.length;
    totals.stored += stored;

    console.log(`  ${date}: ${rows.length} rows → ${stored} stored`);
  }

  console.log('\nDone!');
  console.log(`  Total rows fetched: ${totals.rows}`);
  console.log(`  Stored: ${totals.stored}`);
  console.log(`  Days skipped (no data): ${totals.skipped}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
