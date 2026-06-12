#!/usr/bin/env node

/**
 * Backfill flow ratio monitor data for recent trading days.
 *
 * Fetches the UW net-flow/expiry endpoint (0DTE index-only) for each
 * historical date, computes |NPP|/|NCP| ratio per minute tick, and
 * stores in the flow_ratio_monitor table. This gives build-features
 * the pcr_open, pcr_max, pcr_min, pcr_range, pcr_trend, pcr_spike
 * features it needs.
 *
 * Usage:
 *   node scripts/backfill-flow-ratio.mjs          # 30 days (default)
 *   node scripts/backfill-flow-ratio.mjs 10       # 10 days
 */

import { neon } from '@neondatabase/serverless';

import { getTradingDays } from './_lib/trading-days.mjs';

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

// ── Fetch flow ticks for a date ─────────────────────────────

async function fetchFlowTicks(date) {
  const url = `${UW_BASE}/net-flow/expiry?date=${date}&expiration=zero_dte&tide_type=index_only`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  // Double-nested: { data: [{ data: [...ticks...] }] }
  const outer = body.data ?? [];
  if (outer.length === 0) return [];
  return outer[0]?.data ?? [];
}

// ── Store ticks ─────────────────────────────────────────────

async function storeTicks(date, ticks) {
  let stored = 0;
  let errors = 0;

  for (const tick of ticks) {
    const ncp = Number.parseFloat(tick.net_call_premium);
    const npp = Number.parseFloat(tick.net_put_premium);
    const spxPrice = Number.parseFloat(tick.underlying_price);

    if (Number.isNaN(ncp) || Number.isNaN(npp) || Number.isNaN(spxPrice)) {
      continue;
    }

    const absNpp = Math.abs(npp);
    const absNcp = Math.abs(ncp);
    const ratio = absNcp > 0 ? absNpp / absNcp : null;

    try {
      await sql`
        INSERT INTO flow_ratio_monitor (
          date, timestamp, abs_npp, abs_ncp, ratio, spx_price
        ) VALUES (
          ${date}, ${tick.timestamp},
          ${absNpp}, ${absNcp}, ${ratio}, ${spxPrice}
        )
        ON CONFLICT (date, timestamp) DO NOTHING
      `;
      stored++;
    } catch (err) {
      // Don't swallow: an INSERT that throws is a real failure (connection
      // drop, constraint violation, bad value), NOT a duplicate — duplicates
      // are handled by ON CONFLICT DO NOTHING and never reach here. Log it and
      // count it so the run can report and exit non-zero.
      errors++;
      console.warn(
        `  Insert error for ${date} @ ${tick.timestamp}: ${err.message}`,
      );
    }
  }

  return { stored, errors };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log('Backfilling flow ratio monitor (0DTE index P/C ratio)');
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;
  let skipped = 0;
  let totalErrors = 0;

  for (const date of tradingDays) {
    // Rate limit: 600ms between calls
    await new Promise((r) => setTimeout(r, 600));

    const ticks = await fetchFlowTicks(date);

    if (ticks.length === 0) {
      console.log(`  ${date}: no data`);
      skipped++;
      continue;
    }

    const { stored, errors } = await storeTicks(date, ticks);
    totalStored += stored;
    totalErrors += errors;

    // Compute summary stats for logging
    const ratios = ticks
      .map((t) => {
        const ncp = Math.abs(Number.parseFloat(t.net_call_premium));
        const npp = Math.abs(Number.parseFloat(t.net_put_premium));
        return ncp > 0 ? npp / ncp : null;
      })
      .filter((r) => r != null);

    const avgRatio =
      ratios.length > 0
        ? (ratios.reduce((s, r) => s + r, 0) / ratios.length).toFixed(2)
        : 'N/A';

    console.log(
      `  ${date}: ${ticks.length} ticks → ${stored} stored | avg PCR ${avgRatio}`,
    );
  }

  console.log('\nDone!');
  console.log(`  Stored: ${totalStored} readings`);
  console.log(`  Skipped (no data): ${skipped}`);
  console.log(`  Insert errors: ${totalErrors}`);

  // Surface insert errors to CI/cron — the process otherwise exits 0 and hides
  // genuine DB-write failures (previously swallowed by a bare catch {}).
  if (totalErrors > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
