#!/usr/bin/env node

/**
 * Local backfill script for SPX Greek Exposure.
 * Fetches BOTH aggregate (has gamma) and by-expiry (has charm/delta/vanna breakdown).
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

// ── Fetch aggregate for one date ────────────────────────────

async function fetchAggregate(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/greek-exposure?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW aggregate API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return null;
  }

  const body = await res.json();
  const data = body.data ?? [];
  // Find the row matching this date (array may contain multiple days)
  return data.find((r) => r.date === date) ?? data[data.length - 1] ?? null;
}

// ── Fetch by-expiry for one date ────────────────────────────

async function fetchByExpiry(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/greek-exposure/expiry?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW expiry API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store aggregate row ─────────────────────────────────────

async function storeAggregate(row, date) {
  try {
    const result = await sql`
      INSERT INTO greek_exposure (
        date, ticker, expiry, dte,
        call_gamma, put_gamma, call_charm, put_charm,
        call_delta, put_delta, call_vanna, put_vanna
      )
      VALUES (
        ${date}, 'SPX', 'aggregate', -1,
        ${row.call_gamma}, ${row.put_gamma},
        ${row.call_charm}, ${row.put_charm},
        ${row.call_delta}, ${row.put_delta},
        ${row.call_vanna}, ${row.put_vanna}
      )
      ON CONFLICT (date, ticker, expiry) DO NOTHING
      RETURNING id
    `;
    return result.length > 0;
  } catch (err) {
    console.warn(`  Aggregate insert error: ${err.message}`);
    return false;
  }
}

// ── Store expiry rows ───────────────────────────────────────

async function storeExpiryRows(rows, date) {
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
        ON CONFLICT (date, ticker, expiry) DO UPDATE SET
          call_gamma = EXCLUDED.call_gamma,
          put_gamma = EXCLUDED.put_gamma
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

  console.log(`Backfilling SPX Greek Exposure (aggregate + by-expiry)`);
  console.log(`Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`);

  let totalExpiries = 0;
  let totalStored = 0;
  let aggCount = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    // Fetch both in parallel
    const [aggRow, expiryRows] = await Promise.all([
      fetchAggregate(date),
      fetchByExpiry(date),
    ]);

    // Store aggregate
    let aggResult = false;
    let netGamma = 'N/A';
    if (aggRow) {
      aggResult = await storeAggregate(aggRow, date);
      if (aggResult) aggCount++;
      const ng = Number.parseFloat(aggRow.call_gamma) + Number.parseFloat(aggRow.put_gamma);
      netGamma = Number.isNaN(ng) ? 'N/A' : Math.round(ng).toLocaleString();
    }

    // Store expiry rows
    const expiryStored = await storeExpiryRows(expiryRows, date);

    totalExpiries += expiryRows.length;
    totalStored += expiryStored;

    // 0DTE charm for logging
    const zeroDte = expiryRows.find((r) => r.expiry === date || r.dte === 0);
    const zeroDteCharm = zeroDte
      ? Math.round(Number.parseFloat(zeroDte.call_charm) + Number.parseFloat(zeroDte.put_charm)).toLocaleString()
      : 'N/A';

    console.log(
      `  ${date}: Agg GEX: ${netGamma} | ${expiryRows.length} expiries (${expiryStored} stored) | 0DTE Charm: ${zeroDteCharm}${aggResult ? ' | [agg NEW]' : ''}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Aggregate rows stored: ${aggCount}`);
  console.log(`  Expiry rows stored: ${totalStored}`);
  console.log(`  Total expiry rows processed: ${totalExpiries}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}