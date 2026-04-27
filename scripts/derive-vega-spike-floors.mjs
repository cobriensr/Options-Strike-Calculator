#!/usr/bin/env node

/**
 * Derive recommended VEGA_SPIKE_FLOORS from the vega_flow_etf table.
 * Computes p99 / p99.5 / p99.9 of |dir_vega_flow| for each ticker
 * and prints a paste-ready snippet for api/_lib/constants.ts.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/derive-vega-spike-floors.mjs
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const TICKERS = ['SPY', 'QQQ'];
const MIN_BARS = 100;

// ── Format for display ──────────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Round UP to nearest 10000, with a 10k minimum ───────────
// Math.round would silently produce a 0 floor when p99.5 < 5_000,
// disabling the FLOOR alert gate downstream. Use ceil + clamp so
// the floor is always at least one 10k bucket and never zero.

function roundTo10k(val) {
  const n = Number.parseFloat(val);
  if (!Number.isFinite(n)) return 10000;
  return Math.max(10000, Math.ceil(n / 10000) * 10000);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(
    `Deriving VEGA_SPIKE_FLOORS from vega_flow_etf (|dir_vega_flow|)\n`,
  );

  const recommendations = {};

  for (const ticker of TICKERS) {
    const rows = await sql`
      SELECT
        percentile_cont(0.99) WITHIN GROUP (ORDER BY abs(dir_vega_flow::numeric)) AS p99,
        percentile_cont(0.995) WITHIN GROUP (ORDER BY abs(dir_vega_flow::numeric)) AS p995,
        percentile_cont(0.999) WITHIN GROUP (ORDER BY abs(dir_vega_flow::numeric)) AS p999,
        max(abs(dir_vega_flow::numeric)) AS max_abs,
        count(*) AS n_bars
      FROM vega_flow_etf
      WHERE ticker = ${ticker}
    `;

    const row = rows.at(-1);
    const nBars = Number.parseInt(row?.n_bars ?? '0', 10);

    console.log(`  ${ticker}: n_bars = ${nBars}`);

    if (nBars < MIN_BARS) {
      console.log(
        `    Sample size too small (< ${MIN_BARS}); skipping floor recommendation\n`,
      );
      continue;
    }

    console.log(`    p99   = ${fmt(row.p99)}`);
    console.log(`    p99.5 = ${fmt(row.p995)}`);
    console.log(`    p99.9 = ${fmt(row.p999)}`);
    console.log(`    max   = ${fmt(row.max_abs)}\n`);

    recommendations[ticker] = { floor: roundTo10k(row.p995), nBars };
  }

  const tickersWithRec = Object.keys(recommendations);
  if (tickersWithRec.length === 0) {
    console.log(
      'No ticker has sufficient sample size for a floor recommendation.',
    );
    return;
  }

  console.log('─'.repeat(60));
  console.log('Paste into api/_lib/constants.ts:\n');
  console.log('// Recommended FLOORS — p99.5 of |dir_vega_flow|, rounded up');
  console.log('// to nearest 10k with a 10k minimum:');
  console.log('export const VEGA_SPIKE_FLOORS: Record<string, number> = {');
  for (const ticker of tickersWithRec) {
    const { floor, nBars } = recommendations[ticker];
    console.log(`  ${ticker}: ${floor}, // n=${nBars} bars`);
  }
  console.log('};');
}

try {
  await main();
} catch (err) {
  console.error('Derive failed:', err);
  process.exit(1);
}
