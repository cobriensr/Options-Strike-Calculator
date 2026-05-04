/**
 * Follow-up probe: Probe 1 revealed that ws_gex_strike_expiry has only
 * 61–72 distinct ts_minute values across 80 days of data (2026-02-09 ->
 * 2026-05-01). Latest ts_minute is 20:14 UTC on the probe day. This
 * strongly suggests the daemon is only writing one (or a few) snapshot(s)
 * per day, NOT a per-minute stream.
 *
 * This probe characterizes WHAT the timestamps look like so we can pick
 * the right approach for Δ% (intraday window functions vs. day-over-day).
 */

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
dotenvConfig({ path: resolve(REPO_ROOT, '.env.local') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const sql = neon(url);

const out = [];
function log(line = '') {
  console.log(line);
  out.push(line);
}

async function main() {
  log('## Follow-up Probe — actual ts_minute layout');
  log('');

  // 1) Per-day distinct ts_minute count (last 14 days available).
  log('### Distinct ts_minute values per (ticker, day) — last 14 days');
  log('');
  const perDay = await sql`
    SELECT ticker,
           DATE(ts_minute) AS day,
           COUNT(DISTINCT ts_minute) AS distinct_minutes,
           MIN(ts_minute) AS first_ts,
           MAX(ts_minute) AS last_ts,
           COUNT(*) AS row_count
    FROM ws_gex_strike_expiry
    WHERE ts_minute >= NOW() - INTERVAL '120 days'
    GROUP BY ticker, DATE(ts_minute)
    ORDER BY day DESC, ticker
    LIMIT 60
  `;
  log('| ticker | day | distinct_minutes | first_ts | last_ts | rows |');
  log('|--------|-----|------------------|----------|---------|------|');
  for (const r of perDay) {
    log(
      `| ${r.ticker} | ${new Date(r.day).toISOString().slice(0, 10)} | ${r.distinct_minutes} | ${new Date(r.first_ts).toISOString().slice(11, 19)} | ${new Date(r.last_ts).toISOString().slice(11, 19)} | ${r.row_count} |`,
    );
  }
  log('');

  // 2) Show all distinct ts_minute values on the most recent day for SPY
  // and the ATM-ish strike's full series on the probe day.
  log('### All distinct ts_minute values on 2026-05-01 (SPY)');
  log('');
  const spyDayMinutes = await sql`
    SELECT DISTINCT ts_minute
    FROM ws_gex_strike_expiry
    WHERE ticker = 'SPY'
      AND ts_minute >= '2026-05-01T00:00:00Z'
      AND ts_minute <  '2026-05-02T00:00:00Z'
    ORDER BY ts_minute
  `;
  log(`Count: ${spyDayMinutes.length}`);
  for (const r of spyDayMinutes) {
    log(`- ${new Date(r.ts_minute).toISOString()}`);
  }
  log('');

  // 3) Histogram of hour-of-day for ts_minute samples (overall).
  log('### Hour-of-day histogram for ts_minute (UTC), all data, both tickers');
  log('');
  const hourHist = await sql`
    SELECT EXTRACT(HOUR FROM ts_minute)::int AS hour_utc,
           COUNT(*) AS row_count,
           COUNT(DISTINCT ts_minute) AS distinct_ts
    FROM ws_gex_strike_expiry
    GROUP BY hour_utc
    ORDER BY hour_utc
  `;
  log('| hour_utc | rows | distinct_ts |');
  log('|----------|------|-------------|');
  for (const r of hourHist) {
    log(`| ${r.hour_utc} | ${r.row_count} | ${r.distinct_ts} |`);
  }
  log('');

  // 4) Latest snapshot — does it have a price column populated and which
  // expiries are covered?
  log(
    '### Latest 5 ts_minute snapshots for SPY: expiry coverage and row count',
  );
  log('');
  const latest = await sql`
    SELECT ts_minute,
           COUNT(DISTINCT expiry) AS expiries,
           COUNT(DISTINCT strike) AS strikes,
           COUNT(*) AS rows,
           COUNT(price) AS rows_with_price
    FROM ws_gex_strike_expiry
    WHERE ticker = 'SPY'
    GROUP BY ts_minute
    ORDER BY ts_minute DESC
    LIMIT 5
  `;
  log('| ts_minute | expiries | strikes | rows | rows_with_price |');
  log('|-----------|----------|---------|------|-----------------|');
  for (const r of latest) {
    log(
      `| ${new Date(r.ts_minute).toISOString()} | ${r.expiries} | ${r.strikes} | ${r.rows} | ${r.rows_with_price} |`,
    );
  }
  log('');

  // 5) For the 0DTE expiry on probe day: how many ts_minute snapshots
  // exist, and does each strike appear in each one?
  log('### 0DTE (expiry=2026-05-01) ts_minute snapshots, per ticker');
  log('');
  const zdteSnaps = await sql`
    SELECT ticker, ts_minute, COUNT(DISTINCT strike) AS strikes
    FROM ws_gex_strike_expiry
    WHERE expiry = '2026-05-01'
    GROUP BY ticker, ts_minute
    ORDER BY ticker, ts_minute
  `;
  log('| ticker | ts_minute | strikes |');
  log('|--------|-----------|---------|');
  for (const r of zdteSnaps) {
    log(
      `| ${r.ticker} | ${new Date(r.ts_minute).toISOString()} | ${r.strikes} |`,
    );
  }
  log('');

  const resultsPath = resolve(__dirname, 'density_results.md');
  const { readFileSync } = await import('node:fs');
  let prior = '';
  try {
    prior = readFileSync(resultsPath, 'utf8');
  } catch {
    /* ok */
  }
  writeFileSync(resultsPath, `${prior}\n\n---\n\n${out.join('\n')}\n`);
  console.log(`\nAppended to ${resultsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
