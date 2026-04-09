#!/usr/bin/env node

/**
 * Local backfill script for 1-minute SPX candles (SPY×10 translation).
 *
 * Pulls 1-minute SPY OHLCV for the last N trading days from Unusual
 * Whales, translates SPY → SPX via the 10× ratio, and upserts into the
 * spx_candles_1m table via ON CONFLICT (date, timestamp) DO NOTHING.
 *
 * Why SPY? Cboe prohibits external distribution of SPX index prices, so
 * we fetch SPY and multiply by the SPX/SPY ratio. The production cron
 * at api/cron/fetch-spx-candles-1m.ts uses the same translation, so
 * this backfill produces the same rows the cron would produce if it
 * had been running for the last 30 days.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." \
 *     node scripts/backfill-spx-candles-1m.mjs
 *
 * Environment:
 *   DATABASE_URL   Neon Postgres URL
 *   UW_API_KEY     Unusual Whales API key
 *
 * Idempotent: safe to run multiple times.
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
const SPY_TO_SPX_RATIO = 10;
const DAYS_TO_BACKFILL = 30;

// ── Generate last N trading days (ending yesterday) ─────────

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

  // Never include today — the cron handles today and we don't want
  // to race it. Always start from yesterday and walk backward.
  d.setDate(d.getDate() - 1);

  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() - 1);
  }

  return dates.reverse();
}

// ── Fetch 1m SPY candles for one date ───────────────────────

async function fetchSPYCandles1m(date) {
  const res = await fetch(
    `${UW_BASE}/stock/SPY/ohlc/1m?date=${date}&limit=500`,
    {
      headers: {
        Authorization: `Bearer ${UW_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for SPY 1m ${date}: ${text.slice(0, 100)}`,
    );
    return null;
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Translate SPY rows into SPX-equivalent rows ─────────────

function translateRows(rows) {
  const translated = [];

  for (const row of rows) {
    const open = Number.parseFloat(row.open) * SPY_TO_SPX_RATIO;
    const high = Number.parseFloat(row.high) * SPY_TO_SPX_RATIO;
    const low = Number.parseFloat(row.low) * SPY_TO_SPX_RATIO;
    const close = Number.parseFloat(row.close) * SPY_TO_SPX_RATIO;

    if (
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close)
    ) {
      continue;
    }

    translated.push({
      timestamp: new Date(row.start_time).toISOString(),
      open,
      high,
      low,
      close,
      volume: row.volume ?? 0,
      market_time: row.market_time,
    });
  }

  return translated;
}

// ── Store all translated candles for a single date ─────────

async function storeCandles(candles, date) {
  if (candles.length === 0) {
    return { stored: 0, marketTimeCounts: { pr: 0, r: 0, po: 0 } };
  }

  let stored = 0;
  const marketTimeCounts = { pr: 0, r: 0, po: 0 };

  for (const c of candles) {
    try {
      const result = await sql`
        INSERT INTO spx_candles_1m (
          date, timestamp, open, high, low, close, volume, market_time
        )
        VALUES (
          ${date}, ${c.timestamp},
          ${c.open}, ${c.high}, ${c.low}, ${c.close},
          ${c.volume}, ${c.market_time}
        )
        ON CONFLICT (date, timestamp) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) {
        stored++;
        if (c.market_time in marketTimeCounts) {
          marketTimeCounts[c.market_time]++;
        }
      }
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return { stored, marketTimeCounts };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const tradingDays = getTradingDays(DAYS_TO_BACKFILL);

  console.log(`Backfilling spx_candles_1m (${DAYS_TO_BACKFILL} trading days)`);
  console.log(
    `Range: ${tradingDays[0]} to ${tradingDays.at(-1)} (skipping weekends)\n`,
  );

  const totals = {
    daysProcessed: 0,
    daysWithData: 0,
    rowsStored: 0,
    rowsSkipped: 0,
    errors: 0,
  };

  for (const date of tradingDays) {
    totals.daysProcessed++;

    // Polite pacing between days to avoid UW rate limits
    await new Promise((r) => setTimeout(r, 500));

    let rawRows;
    try {
      rawRows = await fetchSPYCandles1m(date);
    } catch (err) {
      console.warn(`  [${date}] fetch error: ${err.message}`);
      totals.errors++;
      continue;
    }

    if (rawRows === null) {
      totals.errors++;
      continue;
    }

    if (rawRows.length === 0) {
      console.log(`  [${date}] no data (holiday or pre-IPO, skipping)`);
      continue;
    }

    const translated = translateRows(rawRows);
    if (translated.length === 0) {
      console.log(`  [${date}] fetched ${rawRows.length}, all filtered as NaN`);
      continue;
    }

    let result;
    try {
      result = await storeCandles(translated, date);
    } catch (err) {
      console.warn(`  [${date}] store error: ${err.message}`);
      totals.errors++;
      continue;
    }

    totals.daysWithData++;
    totals.rowsStored += result.stored;
    totals.rowsSkipped += translated.length - result.stored;

    const { pr, r, po } = result.marketTimeCounts;
    console.log(
      `  [${date}] fetched ${rawRows.length}, stored ${result.stored} ` +
        `(pr=${pr}, r=${r}, po=${po}), skipped ${translated.length - result.stored}`,
    );
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`\nBackfill complete.`);
  console.log(`  Days processed:         ${totals.daysProcessed}`);
  console.log(`  Days with data:         ${totals.daysWithData}`);
  console.log(`  Total rows stored:      ${totals.rowsStored}`);
  console.log(`  Total rows skipped:     ${totals.rowsSkipped}`);
  console.log(`  Errors:                 ${totals.errors}`);
  console.log(`  Duration:               ${durationSec}s`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
