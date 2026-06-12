#!/usr/bin/env node

/**
 * Local backfill script for per-strike Greek exposure across ALL expirations.
 * Stores with expiry = '1970-01-01' sentinel to distinguish from 0DTE rows.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-strike-all.mjs
 *
 * Options:
 *   node scripts/backfill-strike-all.mjs 5    # 5 days instead of 30
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
const ATM_RANGE = 200;
const ALL_EXPIRY_SENTINEL = '1970-01-01';

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// UW's /spot-exposures/strike endpoint caps a page at `limit` rows and
// exposes no offset/cursor/next-page parameter (verified against every
// caller in this repo — all use a bare `limit`). So if a page returns
// exactly the limit, more strikes likely exist beyond it and were
// silently dropped. We can't paginate; the best we can do is warn loudly
// and flag the run as a failure so the truncation isn't silent.
const STRIKE_LIMIT = 500;

// Set true if any date's page hit the limit (likely truncated). Forces a
// non-zero exit code at the end so the run reports failure.
let overflowDetected = false;

// ── Fetch per-strike data for one date ──────────────────────

async function fetchStrikeAll(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/spot-exposures/strike?date=${date}&limit=${STRIKE_LIMIT}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  const data = body.data ?? [];

  if (data.length >= STRIKE_LIMIT) {
    console.warn(
      `  ⚠️  OVERFLOW: ${date} returned ${data.length} rows (== limit ${STRIKE_LIMIT}). ` +
        `The endpoint has no offset/cursor pagination, so additional strikes were ` +
        `likely truncated. Data for this date may be incomplete.`,
    );
    overflowDetected = true;
  }

  return data;
}

// ── Store strikes ───────────────────────────────────────────

async function storeStrikes(rows, date) {
  if (rows.length === 0) return { stored: 0, price: null, filtered: 0 };

  const price = Number.parseFloat(rows[0].price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  const dataTime = new Date(rows[0].time);
  const minutes = dataTime.getMinutes();
  dataTime.setMinutes(minutes - (minutes % 5), 0, 0);
  const timestamp = dataTime.toISOString();

  let stored = 0;

  for (const row of filtered) {
    try {
      const result = await sql`
        INSERT INTO strike_exposures (
          date, timestamp, ticker, expiry, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi
        )
        VALUES (
          ${date}, ${timestamp}, 'SPX', ${ALL_EXPIRY_SENTINEL}, ${row.strike}, ${row.price},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_ask}, ${row.call_charm_bid},
          ${row.put_charm_ask}, ${row.put_charm_bid},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi}
        )
        ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error at strike ${row.strike}: ${err.message}`);
    }
  }

  return { stored, price, filtered: filtered.length };
}

// ── Format value for display ────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n) || n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX All-Expiry Per-Strike Greek Exposure`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStored = 0;

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 400));

    const rows = await fetchStrikeAll(date);
    const result = await storeStrikes(rows, date);

    totalStored += result.stored;

    // Find peak positive and negative gamma for logging
    let peakGamma = { strike: 0, val: 0 };
    let troughGamma = { strike: 0, val: 0 };

    const price = result.price ?? 0;
    for (const row of rows) {
      const s = Number.parseFloat(row.strike);
      if (Math.abs(s - price) > ATM_RANGE) continue;
      const netG =
        Number.parseFloat(row.call_gamma_oi) +
        Number.parseFloat(row.put_gamma_oi);
      if (netG > peakGamma.val) peakGamma = { strike: s, val: netG };
      if (netG < troughGamma.val) troughGamma = { strike: s, val: netG };
    }

    console.log(
      `  ${date}: ${rows.length} total → ${result.filtered} filtered (${result.stored} new) | SPX: ${result.price ?? 'N/A'} | Peak γ: ${peakGamma.strike} (${fmt(peakGamma.val)}) | Trough γ: ${troughGamma.strike} (${fmt(troughGamma.val)})`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total strike rows stored: ${totalStored}`);

  if (overflowDetected) {
    console.error(
      `\n⚠️  One or more dates hit the ${STRIKE_LIMIT}-row page limit — data may be ` +
        `truncated (endpoint has no pagination). Exiting non-zero.`,
    );
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
