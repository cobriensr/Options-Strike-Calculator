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

// ── ET timezone helpers ─────────────────────────────────────
//
// We MUST compute trading days in ET, not UTC. Using
// `Date.toISOString().slice(0, 10)` gives a UTC date, which is wrong
// for two reasons:
//   1. The walk-backward iteration can land on a UTC day that doesn't
//      match the ET trading day (when run after 19:00 ET = 00:00 UTC)
//   2. UW's `?date=` parameter expects an ET date, and returning rows
//      labeled with the wrong date breaks per-day grouping in queries
//
// These helpers mirror `src/utils/timezone.ts:getETDateStr` which the
// production cron uses via `cronGuard`. Hand-rolled here so the .mjs
// script doesn't need to import TypeScript.

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ET_DAY_OF_WEEK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
});

/** Get the ET calendar date for a Date instance, as 'YYYY-MM-DD'. */
function getETDateStr(date) {
  // en-CA gives ISO-style YYYY-MM-DD ordering directly.
  return ET_DATE_FORMATTER.format(date);
}

/** Get the ET day of week (0=Sun, 6=Sat) for a Date instance. */
function getETDayOfWeek(date) {
  const name = ET_DAY_OF_WEEK_FORMATTER.format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? 0;
}

// ── Generate last N trading days (ending yesterday in ET) ───

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

  // Walk backward in ET, never landing on today's ET date.
  // Start by setting d to "yesterday in ET" — if it's currently
  // before midnight UTC but after midnight ET (rare, only if running
  // exactly at the rollover), the UTC `setDate(-1)` gives the right
  // answer; otherwise we just need to advance one ET day backward.
  let todayET = getETDateStr(new Date());
  // Subtract one calendar day in UTC; this is a one-shot offset that
  // will land us on yesterday in ET in 99% of cases. The while-loop
  // below handles the edge cases by checking the ET date explicitly.
  d.setUTCDate(d.getUTCDate() - 1);
  while (getETDateStr(d) === todayET) {
    d.setUTCDate(d.getUTCDate() - 1);
  }

  while (dates.length < count) {
    const day = getETDayOfWeek(d);
    if (day !== 0 && day !== 6) {
      dates.push(getETDateStr(d));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return dates.reverse();
}

// ── Fetch 1m SPY candles for one date ───────────────────────

async function fetchSPYCandles1m(date) {
  // limit=2500 is UW's documented max; set high enough to cover a full
  // extended-hours session (~960 candles: pr=330 + r=390 + po=240). The
  // original limit=500 silently truncated at minute 500 of the session,
  // which typically dropped all premarket and the first ~1.5 hours of
  // regular session — `previousClose` would come back null for every
  // backfilled day and the chart would start at ~11:15 AM ET.
  const res = await fetch(
    `${UW_BASE}/stock/SPY/ohlc/1m?date=${date}&limit=2500`,
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
//
// IMPORTANT: the row's `date` column is computed PER-ROW from the row's
// own UTC timestamp via getETDateStr(), NOT from the input `date`
// parameter that was used to fetch the batch from UW. This is necessary
// because UW's `?date=YYYY-MM-DD` query returns rows whose UTC
// timestamps span the previous trading day's post-market through the
// requested day's session — using the input date for every row would
// mis-label any post-market candle that fell after midnight UTC the
// previous day.

async function storeCandles(candles) {
  if (candles.length === 0) {
    return { stored: 0, marketTimeCounts: { pr: 0, r: 0, po: 0 } };
  }

  let stored = 0;
  const marketTimeCounts = { pr: 0, r: 0, po: 0 };

  for (const c of candles) {
    // Compute the ET trading date for THIS row from its timestamp.
    const rowDate = getETDateStr(new Date(c.timestamp));
    try {
      const result = await sql`
        INSERT INTO spx_candles_1m (
          date, timestamp, open, high, low, close, volume, market_time
        )
        VALUES (
          ${rowDate}, ${c.timestamp},
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
      result = await storeCandles(translated);
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
