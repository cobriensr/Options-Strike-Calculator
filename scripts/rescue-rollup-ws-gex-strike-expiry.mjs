#!/usr/bin/env node
/**
 * One-shot rescue: copy a single ET date's `ws_gex_strike_expiry` rows
 * into `strike_exposures` with per-minute `ts_minute` preserved. Used
 * to backfill the persistent archive for dates captured by the WS
 * daemon BEFORE the daily rollup cron started running.
 *
 * Spec: docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md
 *
 * Time pressure: WS data ages out of `ws_gex_strike_expiry` daily at
 * 12:00 UTC (pre-market retention sweep). Run this rescue BEFORE the
 * next retention sweep or the source rows are gone forever — UW REST
 * has no per-minute historical endpoint.
 *
 * Usage:
 *   node --env-file=.env.local \
 *     scripts/rescue-rollup-ws-gex-strike-expiry.mjs 2026-05-15
 *
 * Idempotent: re-runs are no-ops via the `(date, timestamp, ticker,
 * strike, expiry)` UNIQUE constraint on `strike_exposures`.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: rescue-rollup-ws-gex-strike-expiry.mjs YYYY-MM-DD');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const INSERT_SELECT_SQL = `
  INSERT INTO strike_exposures (
    date, timestamp, ticker, expiry, strike, price,
    call_gamma_oi, put_gamma_oi,
    call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
    call_charm_oi, put_charm_oi,
    call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
    call_delta_oi, put_delta_oi,
    call_vanna_oi, put_vanna_oi
  )
  SELECT
    (ts_minute AT TIME ZONE 'America/New_York')::date AS date,
    ts_minute AS timestamp,
    ticker,
    expiry,
    strike,
    price,
    call_gamma_oi,
    put_gamma_oi,
    call_gamma_ask_vol  AS call_gamma_ask,
    call_gamma_bid_vol  AS call_gamma_bid,
    put_gamma_ask_vol   AS put_gamma_ask,
    put_gamma_bid_vol   AS put_gamma_bid,
    call_charm_oi,
    put_charm_oi,
    call_charm_ask_vol  AS call_charm_ask,
    call_charm_bid_vol  AS call_charm_bid,
    put_charm_ask_vol   AS put_charm_ask,
    put_charm_bid_vol   AS put_charm_bid,
    NULL::numeric AS call_delta_oi,
    NULL::numeric AS put_delta_oi,
    call_vanna_oi,
    put_vanna_oi
  FROM ws_gex_strike_expiry
  WHERE expiry = $1::date
    AND (ts_minute AT TIME ZONE 'America/New_York')::date = $1::date
  ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
  RETURNING id
`;

console.log(`Rescuing ws_gex_strike_expiry → strike_exposures for ${date}`);

// Source-side counts for verification.
const [sourceCounts] = await sql`
  SELECT
    COUNT(*) AS source_rows,
    COUNT(DISTINCT ticker) AS source_tickers,
    COUNT(DISTINCT ts_minute) AS source_minutes
  FROM ws_gex_strike_expiry
  WHERE expiry = ${date}::date
    AND (ts_minute AT TIME ZONE 'America/New_York')::date = ${date}::date
`;
console.log('Source slice in ws_gex_strike_expiry:');
console.log(`  rows:    ${sourceCounts.source_rows}`);
console.log(`  tickers: ${sourceCounts.source_tickers}`);
console.log(`  minutes: ${sourceCounts.source_minutes}`);

if (Number(sourceCounts.source_rows) === 0) {
  console.log('\nNo source rows. Exiting.');
  process.exit(0);
}

const startedAt = Date.now();
const result = await sql.query(INSERT_SELECT_SQL, [date]);
const durationMs = Date.now() - startedAt;
const inserted = Array.isArray(result)
  ? result.length
  : (result.rows?.length ?? 0);

console.log(`\nInserted ${inserted} rows in ${durationMs}ms`);

// Post-rescue verification.
const [destCounts] = await sql`
  SELECT
    COUNT(*) AS dest_rows,
    COUNT(DISTINCT ticker) AS dest_tickers,
    COUNT(DISTINCT timestamp) AS dest_timestamps
  FROM strike_exposures
  WHERE date = ${date}::date
`;
console.log('\nstrike_exposures after rescue:');
console.log(`  rows:       ${destCounts.dest_rows}`);
console.log(`  tickers:    ${destCounts.dest_tickers}`);
console.log(`  timestamps: ${destCounts.dest_timestamps}`);
console.log('\nDone.');
