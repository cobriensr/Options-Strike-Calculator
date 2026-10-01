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
 * it via the stored refresh token.
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

// ── Env check ──────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SCHWAB_CLIENT_ID = process.env.SCHWAB_CLIENT_ID;
const SCHWAB_CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}
if (!SCHWAB_CLIENT_ID || !SCHWAB_CLIENT_SECRET) {
  console.error('Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

// ── Config ─────────────────────────────────────────────────

const SYMBOLS = ['$TICK', '$ADD', '$VOLD', '$TRIN'];
const DEFAULT_LOOKBACK_DAYS = 20;
const SCHWAB_BASE = 'https://api.schwabapi.com/marketdata/v1';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const KV_KEY = 'schwab:tokens';
const BUFFER_MS = 60_000;

/**
 * Compare-and-set of a refreshed token record — keep in sync with
 * STORE_REFRESHED_LUA in api/_lib/schwab.ts. Writes only if the record still
 * holds the refresh token we refreshed with (plain-find on its
 * `"refreshToken":<JSON>` fragment), so a re-login that lands mid-refresh is
 * never overwritten and a cleared record is never resurrected.
 * Returns: 0 = key absent, 1 = written, 2 = key holds a different token.
 */
const STORE_REFRESHED_LUA = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  if not string.find(raw, ARGV[1], 1, true) then return 2 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
`;

// ── ET timezone helpers (mirrors backfill-spx-candles-1m) ──

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

/**
 * Mask token-like runs, then cap the length — same rule as
 * api/_lib/redact-upstream-body.ts (keep in sync): 24+ chars of
 * `A-Za-z0-9+/=_.-\%` become `[redacted]`, then truncate to 200.
 */
function redactBody(body) {
  const masked = body.replaceAll(/[A-Za-z0-9+/=_.%\\-]{24,}/g, '[redacted]');
  if (masked.length <= 200) return masked;
  return `${masked.slice(0, 200)}… (${body.length} chars)`;
}

async function getSchwabToken() {
  const stored = await redis.get(KV_KEY);
  if (!stored) {
    console.error(
      'No Schwab tokens in Redis. Run /api/auth/init to authenticate first.',
    );
    process.exit(1);
  }

  // Refresh token lapsed? It lives 7 days from the ORIGINAL login; sending a
  // dead one only earns a 400 invalid_grant.
  if (Date.now() > stored.refreshExpiresAt) {
    console.error(
      'Schwab refresh token expired. Run /api/auth/init to re-authenticate.',
    );
    process.exit(1);
  }

  // Token still valid?
  if (Date.now() < stored.expiresAt - BUFFER_MS) {
    return stored.accessToken;
  }

  // Refresh
  console.log('  Schwab access token expired, refreshing...');
  const encoded = Buffer.from(
    `${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`,
  ).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${encoded}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Token refresh failed (${res.status}): ${redactBody(body)}`);
    process.exit(1);
  }

  const data = await res.json();
  if (
    typeof data.access_token !== 'string' ||
    data.access_token === '' ||
    typeof data.expires_in !== 'number'
  ) {
    console.error('Token refresh returned a malformed response; not storing.');
    process.exit(1);
  }
  const now = Date.now();
  const newTokens = {
    accessToken: data.access_token,
    // Schwab may omit refresh_token on a refresh; the stored one stays valid.
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: now + data.expires_in * 1000,
    // Fixed at the original login — a refresh must NOT slide the 7-day
    // window forward (same rule as api/_lib/schwab.ts).
    refreshExpiresAt: stored.refreshExpiresAt,
  };

  const ttlSec = Math.max(
    Math.floor((newTokens.refreshExpiresAt - now + 86_400_000) / 1000),
    3600,
  );
  const written = await redis.eval(
    STORE_REFRESHED_LUA,
    [KV_KEY],
    [
      `"refreshToken":${JSON.stringify(stored.refreshToken)}`,
      JSON.stringify(newTokens),
      String(ttlSec),
    ],
  );
  if (written !== 1) {
    // The record changed under us (a re-login, or a clear). Use what is
    // stored now if it's valid; otherwise stop rather than overwrite it.
    const current = await redis.get(KV_KEY);
    if (current && Date.now() < current.expiresAt - BUFFER_MS) {
      console.log(
        '  Token record changed during refresh (re-login?); using the stored token.',
      );
      return current.accessToken;
    }
    console.error(
      'Token record changed or was cleared during refresh; not overwriting it. Re-run the script.',
    );
    process.exit(1);
  }
  console.log('  Token refreshed and stored.');
  return newTokens.accessToken;
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
