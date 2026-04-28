#!/usr/bin/env node

/**
 * Local backfill script for raw 1-min OHLC candles on SPY and QQQ.
 *
 * Pulls /stock/{ticker}/ohlc/1m?date={date} from Unusual Whales for the
 * last N trading days (default 30) and stores raw prices in the
 * etf_candles_1m table. Idempotent on (ticker, timestamp).
 *
 * This populates the historical candles needed by
 * api/cron/enrich-vega-spike-returns.ts to backfill forward-return
 * columns on the 30-day spike history already in vega_spike_events.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-etf-candles-1m.mjs
 *
 * Options:
 *   node scripts/backfill-etf-candles-1m.mjs 5    # 5 days instead of 30
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

// ── Fetch 1-min OHLC for one (ticker, date) ─────────────────

async function fetchCandles(ticker, date) {
  const res = await fetch(`${UW_BASE}/stock/${ticker}/ohlc/1m?date=${date}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${ticker} ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store every minute candle ───────────────────────────────

async function storeCandles(candles, ticker) {
  if (candles.length === 0) return { stored: 0, total: 0 };

  let stored = 0;

  for (const candle of candles) {
    try {
      const result = await sql`
        INSERT INTO etf_candles_1m (
          ticker, timestamp, open, high, low, close, volume
        )
        VALUES (
          ${ticker}, ${candle.start_time},
          ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close},
          ${candle.volume ?? null}
        )
        ON CONFLICT (ticker, timestamp) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return { stored, total: candles.length };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling ETF 1-min OHLC candles (SPY, QQQ — raw prices)`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})`,
  );
  console.log(`Tickers: ${TICKERS.join(', ')}\n`);

  let totalStored = 0;
  let totalBars = 0;

  for (const date of tradingDays) {
    for (const ticker of TICKERS) {
      // Pause between (date, ticker) pairs to avoid 429s.
      await new Promise((r) => setTimeout(r, 300));

      const candles = await fetchCandles(ticker, date);
      const result = await storeCandles(candles, ticker);

      totalStored += result.stored;
      totalBars += result.total;

      console.log(
        `  ${date} ${ticker}: ${result.total} bars (${result.stored} new)`,
      );
    }
  }

  console.log(`\nDone!`);
  console.log(`  Days × tickers: ${tradingDays.length} × ${TICKERS.length}`);
  console.log(`  Total bars seen: ${totalBars}`);
  console.log(`  Newly stored: ${totalStored}`);
  console.log(`  Skipped (duplicates): ${totalBars - totalStored}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
