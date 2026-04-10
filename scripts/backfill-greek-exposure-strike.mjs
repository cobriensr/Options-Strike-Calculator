#!/usr/bin/env node

/**
 * Local backfill script for SPX Greek Exposure by Strike+Expiry.
 * Fetches 0DTE per-strike greek exposure from the UW strike-expiry endpoint.
 *
 * For 0DTE backfill: date=expiry=<trading_date>, so dte=0 for all rows.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-exposure-strike.mjs
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-exposure-strike.mjs 5
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

// ── Fetch strike-expiry rows for one date (0DTE: date=expiry) ──

async function fetchStrikeExpiry(date) {
  const url = `${UW_BASE}/stock/SPX/greek-exposure/strike-expiry?date=${date}&expiry=${date}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW strike-expiry API ${res.status} for ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store strike rows for a date ────────────────────────────

async function storeStrikeRows(rows, date) {
  let stored = 0;

  for (const row of rows) {
    // Filter out zero-GEX rows
    if (row.call_gex === '0.0000' && row.put_gex === '0.0000') continue;

    // Layer 2 computed columns
    const callGex = Number.parseFloat(row.call_gex);
    const putGex = Number.parseFloat(row.put_gex);
    const netGex = callGex + putGex;
    const netDelta =
      Number.parseFloat(row.call_delta) + Number.parseFloat(row.put_delta);
    const netCharm =
      Number.parseFloat(row.call_charm) + Number.parseFloat(row.put_charm);
    const netVanna =
      Number.parseFloat(row.call_vanna) + Number.parseFloat(row.put_vanna);
    const absGex = Math.abs(callGex) + Math.abs(putGex);
    const callGexFraction = absGex > 0 ? callGex / absGex : null;

    try {
      const result = await sql`
        INSERT INTO greek_exposure_strike (
          date, expiry, strike, dte,
          call_gex, put_gex,
          call_delta, put_delta,
          call_charm, put_charm,
          call_vanna, put_vanna,
          net_gex, net_delta, net_charm, net_vanna,
          abs_gex, call_gex_fraction
        )
        VALUES (
          ${date}, ${date}, ${row.strike}, 0,
          ${row.call_gex}, ${row.put_gex},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_vanna}, ${row.put_vanna},
          ${netGex}, ${netDelta}, ${netCharm}, ${netVanna},
          ${absGex}, ${callGexFraction}
        )
        ON CONFLICT (date, expiry, strike) DO UPDATE SET
          dte = EXCLUDED.dte,
          call_gex = EXCLUDED.call_gex,
          put_gex = EXCLUDED.put_gex,
          call_delta = EXCLUDED.call_delta,
          put_delta = EXCLUDED.put_delta,
          call_charm = EXCLUDED.call_charm,
          put_charm = EXCLUDED.put_charm,
          call_vanna = EXCLUDED.call_vanna,
          put_vanna = EXCLUDED.put_vanna,
          net_gex = EXCLUDED.net_gex,
          net_delta = EXCLUDED.net_delta,
          net_charm = EXCLUDED.net_charm,
          net_vanna = EXCLUDED.net_vanna,
          abs_gex = EXCLUDED.abs_gex,
          call_gex_fraction = EXCLUDED.call_gex_fraction
        RETURNING strike
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(
        `  Insert error for ${date} strike ${row.strike}: ${err.message}`,
      );
    }
  }

  return stored;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX Greek Exposure by Strike (0DTE)`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStrikes = 0;
  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const rows = await fetchStrikeExpiry(date);

    // Filter zero-GEX rows before logging count
    const nonZero = rows.filter(
      (r) => !(r.call_gex === '0.0000' && r.put_gex === '0.0000'),
    );

    const stored = await storeStrikeRows(rows, date);

    totalStrikes += nonZero.length;
    totalStored += stored;

    // Find peak magnitude GEX strike for logging
    let peakStrike = null;
    let peakNetGex = null;
    for (const r of nonZero) {
      const ng =
        Number.parseFloat(r.call_gex) + Number.parseFloat(r.put_gex);
      if (peakNetGex === null || Math.abs(ng) > Math.abs(peakNetGex)) {
        peakNetGex = ng;
        peakStrike = r.strike;
      }
    }

    const peakStr =
      peakStrike !== null
        ? `Strike ${peakStrike} net GEX: ${Math.round(peakNetGex).toLocaleString()}`
        : 'N/A';

    console.log(
      `  ${date}: ${nonZero.length} strikes (${stored} stored) | Peak: ${peakStr}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total strikes processed: ${totalStrikes}`);
  console.log(`  Total strikes stored: ${totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
