#!/usr/bin/env node

/**
 * Local backfill script for 0DTE Index-Only Net Flow.
 * Fetches from the Net Flow Expiry endpoint with filters:
 *   expiration=zero_dte, tide_type=index_only
 *
 * Data is already cumulative. Sampled to 5-min intervals, stamped at the
 * window START, ON CONFLICT DO NOTHING. Stored in flow_data table with
 * source = 'zero_dte_index'.
 *
 * DO NOT RUN THIS for zero_dte_index on any day until it adopts the
 * window-END label (spec P2.1,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). From the deploy of
 * that fix (planned 2026-11-09)
 * api/cron/fetch-zero-dte-flow.ts stamps a closed bucket at its END (the
 * 09:30-09:35 bucket at 09:35) and upserts it. This script still stamps the
 * window START and is DO NOTHING, so its rows would interleave with the live
 * ones under a second convention. It also stores a null premium as NULL,
 * which the live cron no longer does.
 *
 * Every row it inserts is also appended to flow_data_revisions, in the same
 * statement, under the writer name "backfill-zero-dte-flow" (spec P0.7): a
 * refill keeps the log of what was stored before it.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-zero-dte-flow.mjs
 *
 * Options:
 *   node scripts/backfill-zero-dte-flow.mjs 5    # 5 days instead of 30
 */

import { neon } from '@neondatabase/serverless';

import { storeSampledDay } from './_lib/flow-data-backfill.mjs';
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
const SOURCE = 'zero_dte_index';

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// ── Fetch 0DTE index flow for one date ──────────────────────

async function fetchZeroDteFlow(date, totals) {
  const params = new URLSearchParams({
    expiration: 'zero_dte',
    tide_type: 'index_only',
    date,
  });

  const res = await fetch(`${UW_BASE}/net-flow/expiry?${params}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    totals.failed++;
    return [];
  }

  const body = await res.json();
  const outerData = body.data ?? [];
  if (outerData.length === 0) return [];
  return outerData[0]?.data ?? [];
}

// ── Sample to 5-min and store ───────────────────────────────

function storeCandles(ticks, date, totals) {
  // Sampled to 5-min rows and stored with ONE statement for the day. DO NOTHING,
  // and every row it inserts is logged to flow_data_revisions in the same
  // statement (zero_dte_index is in the revision log, P0.7). An insert error is
  // printed and counted in totals.failed, which sets the exit code.
  return storeSampledDay(sql, ticks, {
    date,
    source: SOURCE,
    writer: 'backfill-zero-dte-flow',
    valueOf: (tick) => ({
      ncp: tick.net_call_premium,
      npp: tick.net_put_premium,
      net_volume: tick.net_volume,
    }),
    totals,
  });
}

// ── Format for display ──────────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling 0DTE Index-Only Net Flow`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;
  let totalCandles = 0;
  const totals = { failed: 0 };

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const ticks = await fetchZeroDteFlow(date, totals);
    const result = await storeCandles(ticks, date, totals);

    totalStored += result.stored;
    totalCandles += result.sampled;

    const latest = ticks.at(-1);
    const ncp = latest ? fmt(latest.net_call_premium) : 'N/A';
    const npp = latest ? fmt(latest.net_put_premium) : 'N/A';

    console.log(
      `  ${date}: ${ticks.length} ticks → ${result.sampled} candles (${result.stored} new) | NCP: ${ncp} | NPP: ${npp}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total candles: ${totalCandles}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Failed (API + insert errors): ${totals.failed}`);

  if (totals.failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
