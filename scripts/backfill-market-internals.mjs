#!/usr/bin/env node

/**
 * Local backfill script for market internals ($TICK, $ADD, $VOLD, $TRIN).
 *
 * Fetches 1-minute OHLC bars from Schwab pricehistory for the last N
 * calendar days, filters to regular-session hours (9:30-16:00 ET), and
 * inserts into market_internals with ON CONFLICT DO NOTHING.
 *
 * Schwab tokens are read from Upstash Redis (same store the production
 * cron uses). If the access token is expired, the script auto-refreshes
 * it via the stored refresh token (scripts/_lib/schwab-local.mjs, shared
 * with the candle backfill). This script only asks you to keep to the idle
 * window below; the candle backfill enforces it with schwabCronsBusyRefusal.
 *
 * WARNING — this runs against PRODUCTION: `.env.local` points at the
 * production Neon branch AND the production Upstash Redis that holds the
 * live Schwab token record. Run it only while the Schwab crons are idle
 * (outside 13-21 UTC on weekdays) so its token refresh doesn't race theirs.
 * Its token write is a compare-and-set (it never overwrites a re-login or
 * resurrects a cleared record), but it does not take the refresh lock.
 *
 * Usage:
 *   source .env.local && node scripts/backfill-market-internals.mjs
 *   source .env.local && node scripts/backfill-market-internals.mjs 10   # 10 calendar days
 *
 * Environment:
 *   DATABASE_URL              Neon Postgres URL
 *   UPSTASH_REDIS_REST_URL    Upstash Redis URL (for Schwab tokens)
 *   UPSTASH_REDIS_REST_TOKEN  Upstash Redis token
 *   SCHWAB_CLIENT_ID          Schwab app key (for token refresh)
 *   SCHWAB_CLIENT_SECRET      Schwab app secret (for token refresh)
 *
 * Idempotent: safe to run multiple times.
 */

import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

import {
  SCHWAB_BASE,
  SchwabAuthError,
  getSchwabAccessToken,
  readSchwabEnv,
} from './_lib/schwab-local.mjs';

// ── Env check ──────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const schwabEnv = readSchwabEnv();

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (schwabEnv.problem) {
  console.error(schwabEnv.problem);
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const redis = new Redis({
  url: schwabEnv.redisUrl,
  token: schwabEnv.redisToken,
});

// ── Config ─────────────────────────────────────────────────

const SYMBOLS = ['$TICK', '$ADD', '$VOLD', '$TRIN'];
const DEFAULT_LOOKBACK_DAYS = 20;

// ── ET timezone helpers ────────────────────────────────────

const ET_MINUTES_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

function getETTotalMinutes(date) {
  const parts = ET_MINUTES_FMT.formatToParts(date);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value);
    if (p.type === 'minute') m = Number(p.value);
  }
  // Intl hour12:false gives 24 for midnight — normalize
  if (h === 24) h = 0;
  return h * 60 + m;
}

const SESSION_OPEN_MIN = 570; // 9:30 AM ET
const SESSION_CLOSE_MIN = 960; // 4:00 PM ET

// ── Schwab auth ────────────────────────────────────────────

// The token read, refresh and compare-and-set live in _lib/schwab-local.mjs,
// shared with the candle backfill. It throws; this script ends the run.
async function getSchwabToken() {
  try {
    return await getSchwabAccessToken(redis, {
      clientId: schwabEnv.clientId,
      clientSecret: schwabEnv.clientSecret,
    });
  } catch (err) {
    if (!(err instanceof SchwabAuthError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

// ── Schwab fetch ───────────────────────────────────────────

async function fetchCandles(symbol, startMs, endMs, token) {
  const params = new URLSearchParams({
    symbol,
    periodType: 'day',
    frequencyType: 'minute',
    frequency: '1',
    startDate: String(startMs),
    endDate: String(endMs),
    needExtendedHoursData: 'false',
    needPreviousClose: 'false',
  });

  const res = await fetch(`${SCHWAB_BASE}/pricehistory?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  Schwab ${res.status} for ${symbol}: ${text.slice(0, 100)}`);
    return null;
  }

  const body = await res.json();
  return body.candles ?? [];
}

// ── Filter + transform ─────────────────────────────────────

function filterToRegularSession(candles) {
  return candles.filter((c) => {
    const etMin = getETTotalMinutes(new Date(c.datetime));
    return etMin >= SESSION_OPEN_MIN && etMin <= SESSION_CLOSE_MIN;
  });
}

function toRows(candles, symbol) {
  return candles
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close),
    )
    .map((c) => ({
      ts: new Date(c.datetime).toISOString(),
      symbol,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
}

// ── Store ──────────────────────────────────────────────────

async function storeRows(rows) {
  if (rows.length === 0) return { stored: 0 };

  let stored = 0;
  for (const row of rows) {
    try {
      const result = await sql`
        INSERT INTO market_internals (ts, symbol, open, high, low, close)
        VALUES (${row.ts}, ${row.symbol}, ${row.open}, ${row.high}, ${row.low}, ${row.close})
        ON CONFLICT (ts, symbol) DO NOTHING
        RETURNING ts
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }
  return { stored };
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const lookbackDays = Number.parseInt(
    process.argv[2] ?? String(DEFAULT_LOOKBACK_DAYS),
    10,
  );

  console.log(`Backfilling market_internals (${lookbackDays} calendar days)`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}\n`);

  const endMs = Date.now();
  const fetchStartMs = endMs - lookbackDays * 24 * 60 * 60 * 1000;

  const totals = {
    fetched: 0,
    filtered: 0,
    stored: 0,
    skipped: 0,
    errors: 0,
  };

  for (const symbol of SYMBOLS) {
    console.log(`\n${symbol}:`);

    // Refresh token before each symbol — row-by-row inserts can take
    // minutes, and Schwab access tokens expire every 30 minutes.
    const token = await getSchwabToken();

    // Polite pacing between symbols
    if (symbol !== SYMBOLS[0]) {
      await new Promise((r) => setTimeout(r, 500));
    }

    let rawCandles;
    try {
      rawCandles = await fetchCandles(symbol, fetchStartMs, endMs, token);
    } catch (err) {
      console.warn(`  Fetch error: ${err.message}`);
      totals.errors++;
      continue;
    }

    if (rawCandles === null) {
      totals.errors++;
      continue;
    }

    const session = filterToRegularSession(rawCandles);
    const filtered = rawCandles.length - session.length;
    const rows = toRows(session, symbol);

    console.log(
      `  Fetched ${rawCandles.length}, filtered ${filtered} ext-hours, ${rows.length} regular-session`,
    );

    if (rows.length === 0) {
      console.log('  No rows to insert');
      continue;
    }

    // Skip rows that already exist in the DB — avoids slow row-by-row
    // inserts for re-runs where most data is already backfilled.
    const existingRows = await sql`
      SELECT ts FROM market_internals
      WHERE symbol = ${symbol}
        AND ts >= ${rows[0].ts}
        AND ts <= ${rows.at(-1).ts}
    `;
    const existingSet = new Set(existingRows.map((r) => r.ts));
    const newRows = rows.filter((r) => !existingSet.has(r.ts));
    const preSkipped = rows.length - newRows.length;

    if (newRows.length === 0) {
      console.log(`  All ${rows.length} rows already exist, skipping`);
      totals.skipped += preSkipped;
      continue;
    }

    console.log(
      `  ${preSkipped} already exist, inserting ${newRows.length} new`,
    );

    const result = await storeRows(newRows);
    const skipped = newRows.length - result.stored + preSkipped;

    console.log(`  Stored ${result.stored}, skipped ${skipped} total`);

    totals.fetched += rawCandles.length;
    totals.filtered += filtered;
    totals.stored += result.stored;
    totals.skipped += skipped;
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log('\n────────────────────────────────');
  console.log('Backfill complete.');
  console.log(`  Total fetched:    ${totals.fetched}`);
  console.log(`  Extended filtered: ${totals.filtered}`);
  console.log(`  Rows stored:      ${totals.stored}`);
  console.log(`  Rows skipped:     ${totals.skipped}`);
  console.log(`  Errors:           ${totals.errors}`);
  console.log(`  Duration:         ${durationSec}s`);

  if (totals.errors > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
