#!/usr/bin/env node

/**
 * Local backfill script for SPY NOPE (Net Options Pricing Effect) ticks.
 * Fetches per-minute data from UW for N trading days and upserts to Neon.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-nope.mjs
 *
 * Options:
 *   node scripts/backfill-nope.mjs 30     # backfill 30 trading days (default 30)
 *   node scripts/backfill-nope.mjs 90     # backfill 90 days
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
const TICKER = 'SPY';

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

// ── Fetch NOPE for a date ───────────────────────────────────

async function fetchNopeForDate(date) {
  const res = await fetch(`${UW_BASE}/stock/${TICKER}/nope?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Upsert rows ─────────────────────────────────────────────

async function storeRows(rows) {
  let stored = 0;
  let skipped = 0;

  for (const r of rows) {
    // Same guard as the cron: reject rows with zero/invalid stock_vol.
    if (
      !Number.isFinite(Number.parseFloat(r.nope)) ||
      !Number.isFinite(r.stock_vol) ||
      r.stock_vol <= 0
    ) {
      skipped++;
      continue;
    }

    try {
      const result = await sql`
        INSERT INTO nope_ticks (
          ticker, timestamp,
          call_vol, put_vol, stock_vol,
          call_delta, put_delta, call_fill_delta, put_fill_delta,
          nope, nope_fill
        ) VALUES (
          ${TICKER}, ${r.timestamp},
          ${r.call_vol}, ${r.put_vol}, ${r.stock_vol},
          ${r.call_delta}, ${r.put_delta}, ${r.call_fill_delta}, ${r.put_fill_delta},
          ${r.nope}, ${r.nope_fill}
        )
        ON CONFLICT (ticker, timestamp) DO UPDATE SET
          call_vol        = EXCLUDED.call_vol,
          put_vol         = EXCLUDED.put_vol,
          stock_vol       = EXCLUDED.stock_vol,
          call_delta      = EXCLUDED.call_delta,
          put_delta       = EXCLUDED.put_delta,
          call_fill_delta = EXCLUDED.call_fill_delta,
          put_fill_delta  = EXCLUDED.put_fill_delta,
          nope            = EXCLUDED.nope,
          nope_fill       = EXCLUDED.nope_fill,
          ingested_at     = now()
        RETURNING ticker
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return { stored, skipped };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling ${TICKER} NOPE`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  const totals = { fetched: 0, stored: 0, skipped: 0 };

  for (const date of tradingDays) {
    // Rate-limit friendliness
    await new Promise((r) => setTimeout(r, 300));

    const rows = await fetchNopeForDate(date);
    const { stored, skipped } = await storeRows(rows);

    totals.fetched += rows.length;
    totals.stored += stored;
    totals.skipped += skipped;

    console.log(
      `  ${date}: ${rows.length} fetched, ${stored} stored, ${skipped} skipped`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total fetched: ${totals.fetched}`);
  console.log(`  Stored (new or updated): ${totals.stored}`);
  console.log(`  Skipped (bad stock_vol): ${totals.skipped}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
