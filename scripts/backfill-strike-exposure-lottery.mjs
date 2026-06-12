#!/usr/bin/env node

/**
 * One-shot backfill of per-strike Greek exposure for the full Lottery
 * Finder universe (~88 tickers), 0DTE only, over a trailing N-day
 * window. Powers ML training that joins alert fires from
 * `ws_flow_alerts` / `lottery_finder_fires` against the dealer Greek
 * landscape at the time of the fire.
 *
 * Twin script: `backfill-strike-exposure.mjs` covers SPX/NDX/SPY/QQQ
 * on a recurring 5-min cron. This script covers everything else
 * one-shot — the live universe is fed via the websocket
 * (`gex_strike_expiry_lottery` shorthand in uw-stream/src/config.py),
 * NOT a recurring REST cron.
 *
 * Writes to `strike_exposures` with the same shape used by the cron.
 * Idempotent via the (date, timestamp, ticker, strike, expiry) unique
 * key — re-running on the same date is safe.
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL="postgresql://..." \
 *     node scripts/backfill-strike-exposure-lottery.mjs        # 90 days
 *   node scripts/backfill-strike-exposure-lottery.mjs 30       # 30 days
 *   node scripts/backfill-strike-exposure-lottery.mjs 90 TSLA  # one ticker
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md
 * Phase 2.
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

// Lottery Finder universe — mirrors LOTTERY_V3_TICKERS +
// LOTTERY_EXTENDED_TICKERS in api/_lib/lottery-finder.ts (deduped) and
// _LOTTERY_TICKERS in uw-stream/src/config.py. SPX/NDX/SPY/QQQ are
// already handled by the recurring cron (backfill-strike-exposure.mjs)
// — those four are excluded here to avoid double writes on overlap.
//
// SPX is not in the lottery universe (SPXW is); NDX is not (NDXP is).
// SPY and QQQ ARE in the lottery universe but excluded here because
// the recurring cron already covers them at much finer cadence.
const RECURRING_CRON_COVERED = new Set(['SPX', 'NDX', 'SPY', 'QQQ']);

const LOTTERY_TICKERS = [
  'AAOI',
  'AAPL',
  'AMD',
  'AMZN',
  'APLD',
  'APP',
  'ARM',
  'ASTS',
  'AVGO',
  'BA',
  'BABA',
  'BE',
  'CAR',
  'COIN',
  'CRCL',
  'CRWD',
  'CRWV',
  'CSCO',
  'CVNA',
  'DELL',
  'GME',
  'GOOG',
  'GOOGL',
  'HIMS',
  'HOOD',
  'IBIT',
  'IBM',
  'INTC',
  'IONQ',
  'IREN',
  'IWM',
  'LITE',
  'LLY',
  'META',
  'MRVL',
  'MSFT',
  'MSTR',
  'MU',
  'NBIS',
  'NDXP',
  'NFLX',
  'NOW',
  'NVDA',
  'NVTS',
  'OKLO',
  'ORCL',
  'PLTR',
  'POET',
  'QCOM',
  'QQQ',
  'RBLX',
  'RDDT',
  'RGTI',
  'RIOT',
  'RIVN',
  'RKLB',
  'RUTW',
  'SHOP',
  'SLV',
  'SMCI',
  'SMH',
  'SNDK',
  'SNOW',
  'SOFI',
  'SOUN',
  'SOXL',
  'SOXS',
  'SPXW',
  'SPY',
  'SQQQ',
  'STX',
  'TEAM',
  'TLT',
  'TNA',
  'TQQQ',
  'TSLA',
  'TSLL',
  'TSM',
  'UBER',
  'UNH',
  'USAR',
  'USO',
  'WDC',
  'WMT',
  'WULF',
  'XOM',
].filter((t) => !RECURRING_CRON_COVERED.has(t));

const days = Number.parseInt(process.argv[2] ?? '90', 10);
const onlyTicker = process.argv[3]; // optional one-ticker filter for resume

const TICKERS = onlyTicker
  ? LOTTERY_TICKERS.filter((t) => t === onlyTicker)
  : LOTTERY_TICKERS;

if (TICKERS.length === 0) {
  console.error(
    `No tickers to backfill (filter "${onlyTicker ?? ''}" matched nothing)`,
  );
  process.exit(1);
}

// Wider sleep between UW calls than the SPX/NDX/SPY/QQQ script (300ms
// vs 200ms) because lottery-universe tickers can return larger strike
// chains and we don't want to compete with the recurring 5-min cron
// during market hours for the 3-concurrent slot.
const INTER_CALL_SLEEP_MS = 300;

// Batched INSERT page size — Postgres parameter cap is 65k, and each
// row uses 22 columns → safe ceiling around 2,900 rows/INSERT. Pick
// 500 to match the Neon driver's preferred chunk and the project's
// "Always batch multi-row INSERTs" rule (per project memory).
const BATCH_INSERT_SIZE = 500;

// ── UW fetch ────────────────────────────────────────────────

const MAX_RETRIES_429 = 3;

async function fetchStrikeExposure(ticker, date, expiry) {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    date,
    limit: '500',
  });
  const url = `${UW_BASE}/stock/${ticker}/spot-exposures/expiry-strike?${params}`;

  // Bounded retry on 429 — recursing unconditionally on every 429 would
  // sleep-and-retry forever if UW serves persistent 429 (account
  // suspension, plan cap, deep outage). Three attempts matches the
  // pattern in scripts/backfill-dark-pool-prints.mjs; after that we
  // give up on this (ticker, date) pair, surface the give-up in the
  // log, and return [] so the per-ticker summary stays honest about
  // which days didn't land.
  for (let attempt = 0; attempt < MAX_RETRIES_429; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${UW_API_KEY}` },
    });
    if (res.ok) {
      const body = await res.json();
      return body.data ?? [];
    }
    if (res.status === 429) {
      const retryAfter = Number.parseInt(
        res.headers.get('retry-after') ?? '5',
        10,
      );
      console.warn(
        `  429 from UW for ${ticker} ${date} (attempt ${attempt + 1}/${MAX_RETRIES_429}) — sleeping ${retryAfter}s`,
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW ${res.status} for ${ticker} ${date}: ${text.slice(0, 120)}`,
    );
    return [];
  }
  console.warn(
    `  Gave up on ${ticker} ${date} after ${MAX_RETRIES_429} 429 retries`,
  );
  return [];
}

// ── Batched store ───────────────────────────────────────────

/**
 * Build a multi-row INSERT for `strike_exposures` matching the live
 * cron's column order and ON CONFLICT clause. Uses the Neon driver's
 * `sql.query(text, params)` form (arbitrary-arity positional binding)
 * — the tagged-template form can't take a variable-width VALUES list.
 * Pattern mirrors `scripts/backfill-dark-pool-prints.mjs`.
 */
async function bulkInsertStrikes(rows, date, ticker, expiry) {
  if (rows.length === 0) return 0;

  // The data timestamp is the same across all strikes in one UW
  // response — UW emits one snapshot per (ticker, expiry, date) on
  // this endpoint. Round to 5-min for consistency with the cron.
  //
  // Fallback timestamp (UW omits `time`): 21:00 UTC = 4 PM ET / 3 PM
  // CT during DST, 4 PM ET / 3 PM CT during CST as well (ET drifts to
  // UTC-5 in winter; 21:00 UTC is then 4 PM ET, still market close).
  // Anchoring to ET market close keeps the snapshot stable across DST
  // transitions.
  const dataTime = new Date(rows[0].time ?? `${date}T21:00:00Z`);
  const minutes = dataTime.getMinutes();
  dataTime.setMinutes(minutes - (minutes % 5), 0, 0);
  const timestamp = dataTime.toISOString();

  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
    const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
    const placeholders = [];
    const params = [];
    let n = 1;
    for (const row of chunk) {
      placeholders.push(
        `($${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, ` +
          `$${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, ` +
          `$${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, ` +
          `$${n++}, $${n++}, $${n++}, $${n++})`,
      );
      params.push(
        date,
        timestamp,
        ticker,
        expiry,
        row.strike,
        row.price,
        row.call_gamma_oi,
        row.put_gamma_oi,
        row.call_gamma_ask,
        row.call_gamma_bid,
        row.put_gamma_ask,
        row.put_gamma_bid,
        row.call_charm_oi,
        row.put_charm_oi,
        row.call_charm_ask,
        row.call_charm_bid,
        row.put_charm_ask,
        row.put_charm_bid,
        row.call_delta_oi,
        row.put_delta_oi,
        row.call_vanna_oi,
        row.put_vanna_oi,
      );
    }
    const stmt = `
      INSERT INTO strike_exposures (
        date, timestamp, ticker, expiry, strike, price,
        call_gamma_oi, put_gamma_oi,
        call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
        call_charm_oi, put_charm_oi,
        call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
        call_delta_oi, put_delta_oi,
        call_vanna_oi, put_vanna_oi
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
      RETURNING id
    `;
    try {
      const result = await sql.query(stmt, params);
      totalInserted += Array.isArray(result)
        ? result.length
        : (result.rows?.length ?? 0);
    } catch (err) {
      console.warn(
        `  Bulk insert error for ${ticker} ${date} (chunk size ${chunk.length}): ${err.message}`,
      );
    }
  }
  return totalInserted;
}

// ── Resume support ──────────────────────────────────────────

/**
 * Return the set of dates ('YYYY-MM-DD') already present in
 * strike_exposures for a ticker. A multi-hour run that crashes near the
 * end must not re-fetch every (ticker, date) it already wrote — query
 * once per ticker up front, then skip dates we already have.
 *
 * Idempotency (ON CONFLICT DO NOTHING) makes a re-run *correct*, but it
 * still re-pays the UW fetch + insert round-trip for every already-done
 * day. Skipping turns a crash-and-resume into a cheap fast-forward.
 */
async function fetchExistingDates(ticker) {
  const rows = await sql`
    SELECT DISTINCT date FROM strike_exposures WHERE ticker = ${ticker}
  `;
  // Neon returns DATE as a Date object; normalize to 'YYYY-MM-DD'.
  return new Set(
    rows.map((r) =>
      r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
    ),
  );
}

// ── Per-ticker worker ───────────────────────────────────────

/**
 * Process one ticker across all trading days. Returns per-ticker counts
 * so the caller can aggregate without sharing mutable closure state.
 * Resume-aware (skips dates already in strike_exposures) and per-date
 * fault-tolerant (one bad date is counted, not fatal).
 */
async function processTicker(ticker, tradingDays) {
  const counts = { written: 0, fetched: 0, empty: 0, skipped: 0, failed: 0 };

  // Resume: load dates already in strike_exposures for this ticker once,
  // then fast-forward past them. A crash near the end of a multi-hour
  // run resumes cheaply instead of re-fetching the whole window.
  let existingDates;
  try {
    existingDates = await fetchExistingDates(ticker);
  } catch (err) {
    // If the resume probe itself fails, fall back to processing all
    // dates (idempotent inserts keep that correct, just slower) rather
    // than aborting the ticker.
    console.warn(
      `  ${ticker}: resume probe failed (${err.message}) — processing all dates`,
    );
    existingDates = new Set();
  }

  for (const date of tradingDays) {
    if (existingDates.has(date)) {
      counts.skipped++;
      continue;
    }

    // Per-date try/catch: one bad (ticker, date) must not abort the
    // whole multi-hour run. Count the failure and continue.
    try {
      await new Promise((r) => setTimeout(r, INTER_CALL_SLEEP_MS));
      const rows = await fetchStrikeExposure(ticker, date, date); // 0DTE: expiry == date
      counts.fetched++;
      if (rows.length === 0) {
        counts.empty++;
        continue;
      }
      counts.written += await bulkInsertStrikes(rows, date, ticker, date);
    } catch (err) {
      counts.failed++;
      console.warn(`  ✗ ${ticker} ${date} failed: ${err.message}`);
    }
  }

  return counts;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);
  const totalFetches = TICKERS.length * tradingDays.length;
  console.log(
    `Backfilling strike_exposures for ${TICKERS.length} lottery tickers ` +
      `× ${tradingDays.length} trading days × 0DTE = ${totalFetches} fetches`,
  );
  console.log(
    `Window: ${tradingDays[0]} to ${tradingDays.at(-1)} | inter-call sleep ${INTER_CALL_SLEEP_MS}ms\n`,
  );

  const totals = Object.fromEntries(TICKERS.map((t) => [t, 0]));
  let fetchesDone = 0;
  let failedDates = 0;
  let skippedResume = 0;
  const start = Date.now();

  for (const ticker of TICKERS) {
    const counts = await processTicker(ticker, tradingDays);
    totals[ticker] = counts.written;
    fetchesDone += counts.fetched;
    failedDates += counts.failed;
    skippedResume += counts.skipped;

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const pct = ((fetchesDone / totalFetches) * 100).toFixed(1);
    const skippedNote =
      counts.skipped > 0 ? ` · skipped ${counts.skipped} (resume)` : '';
    const daysWithData = tradingDays.length - counts.empty - counts.skipped;
    console.log(
      `  ${ticker}: ${counts.written} rows ` +
        `(${daysWithData}/${tradingDays.length} days fetched with data)` +
        skippedNote +
        ` · ${pct}% complete · ${elapsed}s elapsed`,
    );
  }

  console.log('\nDone.');
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(`  Total rows inserted:   ${grandTotal}`);
  console.log(`  Dates skipped (resume): ${skippedResume}`);
  console.log(`  Failed dates:          ${failedDates}`);
  console.log(`  Wall-clock: ${((Date.now() - start) / 1000).toFixed(0)}s`);

  // Truthful exit code so CI/cron detects partial failures (every other
  // date-loop backfill silently exited 0). Mirrors the pattern in
  // backfill-periscope-playbook.mjs.
  if (failedDates > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
