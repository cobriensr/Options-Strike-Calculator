#!/usr/bin/env node

/**
 * Local backfill script for Greek Exposure by Expiry (SPX).
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-exposure.mjs
 *
 * Options:
 *   node scripts/backfill-greek-exposure.mjs 5    # 5 days instead of 30
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

// ── Fetch Greek Exposure by Expiry for one date ─────────────

async function fetchGreekExposure(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/greek-exposure/expiry?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for SPX greek exposure ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store all expiry rows ───────────────────────────────────

async function storeRows(rows, date) {
  let stored = 0;

  for (const row of rows) {
    try {
      const result = await sql`
        INSERT INTO greek_exposure (
          date, ticker, expiry, dte,
          call_gamma, put_gamma, call_charm, put_charm,
          call_delta, put_delta, call_vanna, put_vanna
        )
        VALUES (
          ${date}, 'SPX', ${row.expiry}, ${row.dte},
          ${row.call_gamma}, ${row.put_gamma},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_vanna}, ${row.put_vanna}
        )
        ON CONFLICT (date, ticker, expiry) DO NOTHING
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
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX Greek Exposure by Expiry`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalRows = 0;
  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 200));

    const rows = await fetchGreekExposure(date);
    const stored = await storeRows(rows, date);

    // Compute aggregate gamma for logging
    const aggGamma = rows.reduce(
      (sum, r) =>
        sum + Number.parseFloat(r.call_gamma) + Number.parseFloat(r.put_gamma),
      0,
    );
    const zeroDte = rows.find((r) => r.expiry === date || r.dte === 0);
    const zeroDteGamma = zeroDte
      ? Number.parseFloat(zeroDte.call_gamma) +
        Number.parseFloat(zeroDte.put_gamma)
      : null;

    totalRows += rows.length;
    totalStored += stored;

    const zeroDteSuffix =
      zeroDteGamma === null
        ? ''
        : ' | 0DTE GEX: ' + Math.round(zeroDteGamma).toLocaleString();

    console.log(
      `  ${date}: ${rows.length} expiries (${stored} new) | Agg GEX: ${Math.round(aggGamma).toLocaleString()}${zeroDteSuffix}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total rows: ${totalRows}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Skipped (duplicates): ${totalRows - totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
