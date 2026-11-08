#!/usr/bin/env node

/**
 * Local backfill script for SPY NOPE (Net Options Pricing Effect) ticks.
 * Fetches per-minute data from UW for N trading days and upserts to Neon.
 *
 * Each day is one statement (scripts/_lib/greek-nope-backfill.mjs): a row is
 * rewritten only when a value differs, ingested_at keeps the first-ingest time,
 * and every inserted or changed row is appended to nope_ticks_revisions under
 * the writer 'backfill-nope' (spec P0.9). Exits 1 if a fetch or a write
 * failed.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-nope.mjs
 *
 * Options:
 *   node scripts/backfill-nope.mjs 30     # backfill 30 trading days (default 30)
 *   node scripts/backfill-nope.mjs 90     # backfill 90 days
 */

import { neon } from '@neondatabase/serverless';

import { storeNopeRows } from './_lib/greek-nope-backfill.mjs';
import { getTradingDays } from './_lib/trading-days.mjs';

const WRITER = 'backfill-nope';

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

// ── Fetch NOPE for a date ───────────────────────────────────

let fetchFailures = 0;

async function fetchNopeForDate(date) {
  const res = await fetch(`${UW_BASE}/stock/${TICKER}/nope?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW ${res.status} for ${date}: ${text.slice(0, 100)}`);
    fetchFailures++;
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling ${TICKER} NOPE`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  const totals = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };

  for (const date of tradingDays) {
    // Rate-limit friendliness
    await new Promise((r) => setTimeout(r, 300));

    const rows = await fetchNopeForDate(date);
    const result = await storeNopeRows(sql, rows, WRITER);

    totals.fetched += rows.length;
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.unchanged += result.unchanged;
    totals.skipped += result.skipped;
    totals.failed += result.failed;

    console.log(
      `  ${date}: ${rows.length} fetched, ${result.inserted} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.failed} failed`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total fetched: ${totals.fetched}`);
  console.log(`  Inserted: ${totals.inserted}`);
  console.log(`  Updated: ${totals.updated}`);
  console.log(`  Unchanged: ${totals.unchanged}`);
  console.log(`  Skipped (bad stock_vol): ${totals.skipped}`);
  console.log(`  Store failures (rows): ${totals.failed}`);
  console.log(`  Fetch failures: ${fetchFailures}`);

  if (fetchFailures > 0 || totals.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
