#!/usr/bin/env node

/**
 * Local backfill script for dark_pool_prints (SPY + QQQ, last 30
 * trading days).
 *
 * Pulls historical off-lit trades from UW's REST endpoint
 * /darkpool/{TICKER}, applies the same session-hours + extended-hours
 * + contingent-trade filters the live daemon handler does, and INSERTs
 * each print into dark_pool_prints with ON CONFLICT DO NOTHING for
 * idempotency.
 *
 * REST schema has more fields than the WS variant (tracking_id,
 * market_center, canceled) — we do NOT store those because the
 * daemon-side WS payload doesn't carry them and we want a uniform
 * schema across REST-backfilled and WS-ingested rows. Daemon handler
 * is the canonical writer; this script is a one-time history seed.
 *
 * Filters (matching uw-stream/src/handlers/off_lit_trades.py):
 *   - symbol ∈ {SPY, QQQ}
 *   - executed_at inside 08:30–15:00 CT session window
 *   - drop ext_hour_sold_codes == 'extended_hours_trade'
 *   - drop sale_cond_codes containing 'contingent_trade'
 *   - drop canceled trades (REST-only field)
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." \
 *     node scripts/backfill-dark-pool-prints.mjs
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
const TICKERS = ['SPY', 'QQQ'];
const DAYS_TO_BACKFILL = Number(process.env.BACKFILL_DAYS ?? '30');
const PAGE_SIZE = 500;
const MAX_PAGES_PER_DAY = 200; // ~100k prints/day upper bound

// ── ET / CT timezone helpers ────────────────────────────────

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

function getETDateStr(date) {
  return ET_DATE_FORMATTER.format(date);
}

function getETDayOfWeek(date) {
  const name = ET_DAY_OF_WEEK_FORMATTER.format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? 0;
}

/** Get the CT date for a Date instance, as 'YYYY-MM-DD'. */
const CT_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const CT_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function getCTDateStr(date) {
  return CT_DATE_FORMATTER.format(date);
}

/** Returns 'HH:MM:SS' in America/Chicago for a Date. */
function getCTTimeStr(date) {
  return CT_TIME_FORMATTER.format(date);
}

// ── Trading days ────────────────────────────────────────────

function getTradingDays(count) {
  const dates = [];
  const d = new Date();
  let todayET = getETDateStr(new Date());
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

// ── Fetch ────────────────────────────────────────────────────

async function fetchDarkPoolPage(ticker, date, olderThan) {
  const params = new URLSearchParams({
    date,
    limit: String(PAGE_SIZE),
    min_premium: '0',
  });
  if (olderThan != null) params.set('older_than', String(olderThan));

  // Retry-on-429 loop. UW caps at 120 req/min; on rate-limit we sleep
  // 65s (slightly over the per-minute reset) and retry up to 3 times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${UW_BASE}/darkpool/${ticker}?${params}`, {
      headers: {
        Authorization: `Bearer ${UW_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
    });

    if (res.status === 429) {
      console.warn(
        `  Rate-limited on ${ticker} ${date} (attempt ${attempt + 1}/3); sleeping 65s`,
      );
      await new Promise((r) => setTimeout(r, 65_000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const olderThanSuffix = olderThan ? ` older_than=${olderThan}` : '';
      console.warn(
        `  UW API ${res.status} for ${ticker} ${date}${olderThanSuffix}: ${text.slice(0, 100)}`,
      );
      return null;
    }

    const body = await res.json();
    return body.data ?? [];
  }

  console.warn(`  Gave up on ${ticker} ${date} after 3 rate-limit retries`);
  return null;
}

// ── Filters (matching daemon handler) ───────────────────────

function inCtSession(executedAtIso) {
  const dt = new Date(executedAtIso);
  const hhmmss = getCTTimeStr(dt);
  // '08:30:00' <= hhmmss < '15:00:00'
  return hhmmss >= '08:30:00' && hhmmss < '15:00:00';
}

function passesFilter(t) {
  if (t.canceled) return false;
  if (t.ext_hour_sold_codes === 'extended_hours_trade') return false;
  if (
    typeof t.sale_cond_codes === 'string' &&
    t.sale_cond_codes.includes('contingent_trade')
  ) {
    return false;
  }
  if (!inCtSession(t.executed_at)) return false;
  const price = Number.parseFloat(t.price);
  const size = Number.parseInt(t.size, 10);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    price <= 0 ||
    size <= 0
  ) {
    return false;
  }
  return true;
}

// ── Store ────────────────────────────────────────────────────

// Batched multi-row INSERT. One round-trip per ~500 prints instead of
// per-row — typically 50-100x faster than the per-row INSERT loop.
// neon's tagged-template can't directly take an array of rows, so we
// build the (?,?,?...) placeholders manually and pass the values as a
// single flat array via sql.unsafe-style positional binding.
const BATCH_INSERT_SIZE = 500;

async function storeBatch(symbol, trades) {
  if (trades.length === 0) return 0;

  let stored = 0;
  for (let i = 0; i < trades.length; i += BATCH_INSERT_SIZE) {
    const chunk = trades.slice(i, i + BATCH_INSERT_SIZE);
    const placeholders = [];
    const values = [];
    let p = 1;

    for (const t of chunk) {
      const price = Number.parseFloat(t.price);
      const size = Number.parseInt(t.size, 10);
      const premium = price * size;
      const ctDate = getCTDateStr(new Date(t.executed_at));
      // 21 columns: date, symbol, executed_at, price, size, volume, type,
      //   trade_settlement, trade_code, ext_hour_sold_codes,
      //   sale_cond_codes, nbbo_bid, nbbo_ask, nbbo_bid_quantity,
      //   nbbo_ask_quantity, sector, next_earnings_date, avg30_volume,
      //   issue_type, marketcap, premium
      const ph = [];
      for (let k = 0; k < 21; k++) ph.push(`$${p++}`);
      placeholders.push(`(${ph.join(',')})`);
      values.push(
        ctDate,
        symbol,
        t.executed_at,
        price,
        size,
        t.volume ?? null,
        'off_lit',
        t.trade_settlement ?? null,
        t.trade_code ?? null,
        t.ext_hour_sold_codes ?? null,
        t.sale_cond_codes ?? null,
        t.nbbo_bid ?? null,
        t.nbbo_ask ?? null,
        t.nbbo_bid_quantity ?? null,
        t.nbbo_ask_quantity ?? null,
        null,
        null,
        null,
        null,
        null,
        premium,
      );
    }

    const queryText = `
      INSERT INTO dark_pool_prints (
        date, symbol, executed_at, price, size, volume, type,
        trade_settlement, trade_code,
        ext_hour_sold_codes, sale_cond_codes,
        nbbo_bid, nbbo_ask, nbbo_bid_quantity, nbbo_ask_quantity,
        sector, next_earnings_date, avg30_volume, issue_type, marketcap,
        premium
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (symbol, executed_at, price, size) DO NOTHING
      RETURNING id
    `;

    try {
      // neon serverless driver: sql.query(text, params) form for
      // arbitrary-arity batched inserts where the tagged-template form
      // doesn't fit (variable VALUES list).
      const result = await sql.query(queryText, values);
      stored += Array.isArray(result)
        ? result.length
        : (result.rows?.length ?? 0);
    } catch (err) {
      console.warn(`  Batch insert error for ${symbol}: ${err.message}`);
    }
  }
  return stored;
}

// ── Per-(ticker, date) backfill ─────────────────────────────

async function backfillTickerDate(ticker, date) {
  let olderThan;
  let pageNum = 0;
  let totalFetched = 0;
  let totalKept = 0;
  let totalStored = 0;

  while (pageNum < MAX_PAGES_PER_DAY) {
    let batch;
    try {
      batch = await fetchDarkPoolPage(ticker, date, olderThan);
    } catch (err) {
      console.warn(`  ${ticker} ${date} page ${pageNum}: ${err.message}`);
      break;
    }
    if (batch === null || batch.length === 0) break;

    pageNum++;
    totalFetched += batch.length;

    const filtered = batch.filter(passesFilter);
    totalKept += filtered.length;

    if (filtered.length > 0) {
      const stored = await storeBatch(ticker, filtered);
      totalStored += stored;
    }

    // Pagination cursor: oldest trade in this batch
    const oldest = batch.at(-1);
    if (!oldest) break;
    const oldestTs = Math.floor(new Date(oldest.executed_at).getTime() / 1000);
    if (olderThan != null && oldestTs >= olderThan) break;
    olderThan = oldestTs;

    if (batch.length < PAGE_SIZE) break;

    // Polite pacing within a date's pagination — UW caps at 120/min;
    // 500ms between pages = ~120/min steady-state, just under the cap.
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    fetched: totalFetched,
    kept: totalKept,
    stored: totalStored,
    pages: pageNum,
  };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const tradingDays = getTradingDays(DAYS_TO_BACKFILL);

  console.log(
    `Backfilling dark_pool_prints (${TICKERS.join(', ')}) for ${DAYS_TO_BACKFILL} trading days`,
  );
  console.log(
    `Range: ${tradingDays[0]} to ${tradingDays.at(-1)} (skipping weekends)`,
  );
  console.log(
    `Filters: session 08:30-15:00 CT, drop ext-hours / contingent / canceled`,
  );
  console.log();

  const totals = { fetched: 0, kept: 0, stored: 0, errors: 0 };

  for (const date of tradingDays) {
    for (const ticker of TICKERS) {
      // Polite pacing between (ticker, date) pairs
      await new Promise((r) => setTimeout(r, 200));

      try {
        const r = await backfillTickerDate(ticker, date);
        totals.fetched += r.fetched;
        totals.kept += r.kept;
        totals.stored += r.stored;
        console.log(
          `  [${date}] ${ticker}: fetched ${r.fetched}, kept ${r.kept}, stored ${r.stored} (${r.pages} pages)`,
        );
      } catch (err) {
        console.warn(`  [${date}] ${ticker}: error ${err.message}`);
        totals.errors++;
      }
    }
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`\nBackfill complete.`);
  console.log(`  Total fetched:    ${totals.fetched}`);
  console.log(`  Total kept:       ${totals.kept} (after filters)`);
  console.log(
    `  Total stored:     ${totals.stored} (excluding ON CONFLICT skips)`,
  );
  console.log(`  Errors:           ${totals.errors}`);
  console.log(`  Duration:         ${durationSec}s`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
