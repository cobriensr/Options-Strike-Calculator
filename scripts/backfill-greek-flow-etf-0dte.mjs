#!/usr/bin/env node

/**
 * Backfill 0DTE per-expiry greek flow for SPY/QQQ on every date already
 * present in `vega_flow_etf` (or a user-specified list of dates).
 *
 * The live cron (api/cron/fetch-greek-flow-etf.ts) writes per-expiry rows
 * going forward starting from the day migration #129 lands. This script
 * fills the historical window: for each date the table already has all-DTE
 * rows for, it determines whether that date was an SPY/QQQ expiry day and,
 * if so, fetches the per-expiry data and upserts it with `expiry = date`.
 *
 * Idempotent — skips (ticker, date) pairs that already have non-null
 * expiry rows. Pass --force to re-upsert anyway.
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL=... node scripts/backfill-greek-flow-etf-0dte.mjs
 *   node scripts/backfill-greek-flow-etf-0dte.mjs --dry-run
 *   node scripts/backfill-greek-flow-etf-0dte.mjs --force
 *   node scripts/backfill-greek-flow-etf-0dte.mjs 2026-04-25 2026-04-28
 *   node scripts/backfill-greek-flow-etf-0dte.mjs 2026-04-25 --force
 *
 * Cost on the typical retention window:
 *   - ~50 dates × 2 tickers × 1 expiry-breakdown call = ~100 calls
 *   - ~50 expiry days × 2 tickers × 1 per-expiry call = ~100 calls
 *   - Total ~200 UW calls; trivial against UW Advanced rate limits.
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
const TICKERS = ['SPY', 'QQQ'];

// ── Parse args ──────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const force = rawArgs.includes('--force');
const explicitDates = rawArgs.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

// ── Date discovery ──────────────────────────────────────────

async function getCandidateDates() {
  if (explicitDates.length > 0) return explicitDates;
  const rows = await sql`
    SELECT DISTINCT date::text AS d
    FROM vega_flow_etf
    WHERE ticker IN ('SPY', 'QQQ')
    ORDER BY d ASC
  `;
  return rows.map((r) => r.d);
}

// ── Idempotency check ───────────────────────────────────────

async function alreadyHasPerExpiry(ticker, date) {
  const rows = await sql`
    SELECT 1
    FROM vega_flow_etf
    WHERE ticker = ${ticker}
      AND date = ${date}::date
      AND expiry IS NOT NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

// ── UW fetch helpers ────────────────────────────────────────

async function uwGet(path) {
  const res = await fetch(`${UW_BASE}${path}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.data ?? [];
}

async function isExpiryDay(ticker, date) {
  const entries = await uwGet(`/stock/${ticker}/expiry-breakdown?date=${date}`);
  // Live API field is `expires` (OpenAPI spec misleadingly says `expiry`).
  return entries.some((e) => e.expires === date);
}

async function fetchPerExpiryTicks(ticker, date) {
  return uwGet(`/stock/${ticker}/greek-flow/${date}?date=${date}`);
}

// ── Upsert (mirrors api/_lib/greek-flow-etf-store.ts) ───────

async function upsertTicks(ticker, ticks, date, expiry) {
  if (ticks.length === 0) return { inserted: 0, updated: 0, failed: 0 };
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const tick of ticks) {
    try {
      const result = await sql`
        INSERT INTO vega_flow_etf (
          ticker, date, timestamp, expiry,
          dir_vega_flow, otm_dir_vega_flow, total_vega_flow, otm_total_vega_flow,
          dir_delta_flow, otm_dir_delta_flow, total_delta_flow, otm_total_delta_flow,
          transactions, volume
        )
        VALUES (
          ${ticker}, ${date}, ${tick.timestamp}, ${expiry},
          ${tick.dir_vega_flow}, ${tick.otm_dir_vega_flow}, ${tick.total_vega_flow}, ${tick.otm_total_vega_flow},
          ${tick.dir_delta_flow}, ${tick.otm_dir_delta_flow}, ${tick.total_delta_flow}, ${tick.otm_total_delta_flow},
          ${tick.transactions}, ${tick.volume}
        )
        ON CONFLICT (ticker, timestamp, expiry) DO UPDATE SET
          dir_vega_flow        = EXCLUDED.dir_vega_flow,
          otm_dir_vega_flow    = EXCLUDED.otm_dir_vega_flow,
          total_vega_flow      = EXCLUDED.total_vega_flow,
          otm_total_vega_flow  = EXCLUDED.otm_total_vega_flow,
          dir_delta_flow       = EXCLUDED.dir_delta_flow,
          otm_dir_delta_flow   = EXCLUDED.otm_dir_delta_flow,
          total_delta_flow     = EXCLUDED.total_delta_flow,
          otm_total_delta_flow = EXCLUDED.otm_total_delta_flow,
          transactions         = EXCLUDED.transactions,
          volume               = EXCLUDED.volume
        RETURNING (xmax = 0) AS was_insert
      `;
      if (result[0]?.was_insert) inserted++;
      else updated++;
    } catch (err) {
      console.warn(
        `    upsert error (${ticker} ${tick.timestamp}): ${err.message}`,
      );
      failed++;
    }
  }
  return { inserted, updated, failed };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const dates = await getCandidateDates();

  console.log(
    `Backfilling 0DTE per-expiry greek flow${dryRun ? ' [DRY RUN]' : ''}${force ? ' [FORCE]' : ''}`,
  );
  if (dates.length === 0) {
    console.log(
      'No candidate dates found. Pass dates explicitly or populate vega_flow_etf first.',
    );
    return;
  }
  console.log(`Dates: ${dates.length} (${dates[0]} → ${dates.at(-1)})\n`);

  const totals = {
    skipped: 0,
    nonExpiry: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    failed: 0,
  };

  for (const date of dates) {
    // Pause between dates so we don't burst the rate limit even if many
    // dates queue up.
    await new Promise((r) => setTimeout(r, 1_500));

    const perTickerSummary = [];

    for (const ticker of TICKERS) {
      // Idempotency
      if (!force && (await alreadyHasPerExpiry(ticker, date))) {
        perTickerSummary.push(`${ticker}: skip (already populated)`);
        totals.skipped++;
        continue;
      }

      let isExpiry;
      try {
        isExpiry = await isExpiryDay(ticker, date);
      } catch (err) {
        perTickerSummary.push(
          `${ticker}: expiry-breakdown failed (${err.message})`,
        );
        totals.failed++;
        continue;
      }

      if (!isExpiry) {
        perTickerSummary.push(`${ticker}: not an expiry`);
        totals.nonExpiry++;
        continue;
      }

      let ticks;
      try {
        ticks = await fetchPerExpiryTicks(ticker, date);
      } catch (err) {
        perTickerSummary.push(
          `${ticker}: per-expiry fetch failed (${err.message})`,
        );
        totals.failed++;
        continue;
      }

      totals.fetched += ticks.length;

      if (dryRun) {
        perTickerSummary.push(`${ticker}: ${ticks.length} ticks (dry run)`);
        continue;
      }

      const result = await upsertTicks(ticker, ticks, date, date);
      totals.inserted += result.inserted;
      totals.updated += result.updated;
      totals.failed += result.failed;
      perTickerSummary.push(
        `${ticker}: ${ticks.length} ticks (${result.inserted}↑ ${result.updated}↻ ${result.failed}✗)`,
      );
    }

    console.log(`  ${date}: ${perTickerSummary.join(' | ')}`);
  }

  console.log(`\nDone!`);
  console.log(`  Skipped (already populated): ${totals.skipped}`);
  console.log(`  Non-expiry days:             ${totals.nonExpiry}`);
  console.log(`  Ticks fetched:               ${totals.fetched}`);
  console.log(`  Inserted:                    ${totals.inserted}`);
  console.log(`  Updated:                     ${totals.updated}`);
  console.log(`  Failed:                      ${totals.failed}`);

  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
