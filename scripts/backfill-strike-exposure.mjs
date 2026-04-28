#!/usr/bin/env node

/**
 * Local backfill script for per-strike Greek exposure for the four
 * cross-asset zero-gamma tickers (SPX, NDX, SPY, QQQ).
 *
 * Per-ticker policy:
 *   - SPX: 0DTE + 1DTE (preserves Periscope + build-features-gex 1DTE column)
 *   - SPY/QQQ: 0DTE only (daily expirations available)
 *   - NDX: front Mon/Wed/Fri only (no daily NDX expirations)
 *
 * UW's `/spot-exposures/expiry-strike` endpoint returns the *most recent*
 * snapshot for the given (ticker, expiry, date) — so each backfilled date
 * yields one timestamp's worth of strikes per ticker, not a 5-min time
 * series. Per-day granularity is still actionable for "what was the
 * gamma profile at EOD on date X?" reads.
 *
 * Stores strikes within the per-ticker ATM window (mirroring the live
 * fetch-strike-exposure cron's ATM_RANGE_BY_TICKER constants).
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL="postgresql://..." node scripts/backfill-strike-exposure.mjs
 *
 * Options:
 *   node scripts/backfill-strike-exposure.mjs 5    # 5 days instead of 30
 *
 * Idempotent: ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING.
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

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'];
const ATM_RANGE_BY_TICKER = { SPX: 200, NDX: 500, SPY: 20, QQQ: 20 };

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// ── Trading-day + expiry helpers ────────────────────────────

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

function getNextTradingDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** NDX: today on Mon/Wed/Fri, else +1 (Wed/Fri respectively). */
function getFrontNdxExpiry(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getDay();
  if (dow === 1 || dow === 3 || dow === 5) return dateStr;
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Per-ticker expiry list for a given trading date. */
function getExpiriesToFetch(ticker, date) {
  if (ticker === 'SPX') return [date, getNextTradingDay(date)];
  if (ticker === 'NDX') return [getFrontNdxExpiry(date)];
  return [date]; // SPY, QQQ
}

// ── UW fetch ────────────────────────────────────────────────

async function fetchStrikeExposure(ticker, date, expiry) {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    date,
    limit: '500',
  });

  const res = await fetch(
    `${UW_BASE}/stock/${ticker}/spot-exposures/expiry-strike?${params}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${ticker} ${date} expiry ${expiry}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store ───────────────────────────────────────────────────

async function storeStrikes(rows, date, ticker, expiry) {
  if (rows.length === 0) return { stored: 0, price: null, filtered: 0 };

  const atmRange = ATM_RANGE_BY_TICKER[ticker];
  const price = Number.parseFloat(rows[0].price);
  const minStrike = price - atmRange;
  const maxStrike = price + atmRange;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  // Use the timestamp from the data, rounded to 5-min.
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
          ${date}, ${timestamp}, ${ticker}, ${expiry}, ${row.strike}, ${row.price},
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
      console.warn(
        `  Insert error ${ticker} ${date} strike ${row.strike}: ${err.message}`,
      );
    }
  }

  return { stored, price, filtered: filtered.length };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(
    `Backfilling per-strike Greek exposure for ${TICKERS.join(', ')}`,
  );
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  const totals = Object.fromEntries(TICKERS.map((t) => [t, 0]));

  for (const date of tradingDays) {
    // Build (ticker, expiry) tasks for this date.
    const tasks = [];
    for (const ticker of TICKERS) {
      for (const expiry of getExpiriesToFetch(ticker, date)) {
        tasks.push({ ticker, expiry });
      }
    }

    // Sleep briefly between dates to be polite to UW.
    await new Promise((r) => setTimeout(r, 400));

    // Fetch all (ticker, expiry) for this date in parallel.
    const fetched = await Promise.all(
      tasks.map(async ({ ticker, expiry }) => ({
        ticker,
        expiry,
        rows: await fetchStrikeExposure(ticker, date, expiry),
      })),
    );

    const dailySummary = [];
    for (const { ticker, expiry, rows } of fetched) {
      const result = await storeStrikes(rows, date, ticker, expiry);
      totals[ticker] += result.stored;
      const tag = ticker === 'SPX' && expiry !== date ? '1DTE' : 'primary';
      const priceTag = result.price ? `, ${result.price.toFixed(2)}` : '';
      dailySummary.push(
        `${ticker}/${tag}: ${rows.length}→${result.filtered} (${result.stored} new${priceTag})`,
      );
    }

    console.log(`  ${date}: ${dailySummary.join(' | ')}`);
  }

  console.log(`\nDone!`);
  for (const ticker of TICKERS) {
    console.log(`  ${ticker}: ${totals[ticker]} new rows`);
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
