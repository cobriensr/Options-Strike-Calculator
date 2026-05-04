/**
 * Density probe for ws_gex_strike_expiry.
 *
 * Goal: validate that we have enough per-minute rows per (ticker, expiry,
 * strike) to compute server-side Δ% via LAG window functions for 1m / 5m /
 * 10m / 15m / 30m windows. Read-only.
 *
 * Usage:
 *   node docs/tmp/gex-ticker-probe/density_probe.mjs
 *
 * Writes a markdown summary to ./density_results.md alongside this script.
 */

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ENV_PATH = resolve(REPO_ROOT, '.env.local');

dotenvConfig({ path: ENV_PATH });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL not found in ${ENV_PATH}`);
  process.exit(1);
}

const sql = neon(url);

// Trading day window (CT 08:30 -> 15:00 = UTC 13:30 -> 20:00 on 2026-05-01,
// which is in CDT). Note: the spec mentions 13:30->21:00 UTC which is wider
// than 6.5h; we use both. We compute density against 390 RTH minutes
// (09:30->16:00 ET = 13:30->20:00 UTC).
const PROBE_DAY = '2026-05-01';
const RTH_START_UTC = `${PROBE_DAY}T13:30:00Z`;
const RTH_END_UTC = `${PROBE_DAY}T20:00:00Z`;
const TOTAL_RTH_MINUTES = 390;

const out = [];
function log(line = '') {
  console.log(line);
  out.push(line);
}

function fmt(num, digits = 2) {
  if (num == null || Number.isNaN(num)) return 'n/a';
  return Number(num).toFixed(digits);
}

function asNum(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function probe1Span() {
  log('## Probe 1 — Coverage span per ticker');
  log('');
  const rows = await sql`
    SELECT ticker,
           MIN(ts_minute) AS min_ts,
           MAX(ts_minute) AS max_ts,
           COUNT(*) AS row_count,
           COUNT(DISTINCT expiry) AS distinct_expiries,
           COUNT(DISTINCT strike) AS distinct_strikes,
           COUNT(DISTINCT ts_minute) AS distinct_minutes
    FROM ws_gex_strike_expiry
    GROUP BY ticker
    ORDER BY ticker
  `;
  log(
    '| ticker | min_ts | max_ts | rows | expiries | strikes | distinct_minutes |',
  );
  log(
    '|--------|--------|--------|------|----------|---------|------------------|',
  );
  for (const r of rows) {
    log(
      `| ${r.ticker} | ${new Date(r.min_ts).toISOString()} | ${new Date(r.max_ts).toISOString()} | ${r.row_count} | ${r.distinct_expiries} | ${r.distinct_strikes} | ${r.distinct_minutes} |`,
    );
  }
  log('');
  return rows;
}

async function probe2DailyDensity() {
  log(
    `## Probe 2 — Per (ticker, expiry) minute density on ${PROBE_DAY} RTH (390 min)`,
  );
  log('');
  const rows = await sql`
    SELECT ticker,
           expiry::text AS expiry,
           COUNT(DISTINCT ts_minute) AS distinct_minutes,
           COUNT(DISTINCT strike) AS distinct_strikes,
           COUNT(*) AS row_count
    FROM ws_gex_strike_expiry
    WHERE ts_minute >= ${RTH_START_UTC}
      AND ts_minute <  ${RTH_END_UTC}
    GROUP BY ticker, expiry
    ORDER BY ticker, expiry
  `;
  log(
    '| ticker | expiry | distinct_minutes | minute_coverage_pct | strikes | rows |',
  );
  log(
    '|--------|--------|------------------|---------------------|---------|------|',
  );
  for (const r of rows) {
    const pct = (asNum(r.distinct_minutes) / TOTAL_RTH_MINUTES) * 100;
    log(
      `| ${r.ticker} | ${r.expiry} | ${r.distinct_minutes} | ${fmt(pct, 1)}% | ${r.distinct_strikes} | ${r.row_count} |`,
    );
  }
  log('');
  return rows;
}

async function probe3StrikeCompleteness(spotByTicker) {
  log(`## Probe 3 — 20 strikes nearest spot for ${PROBE_DAY} 0DTE expiry`);
  log('');
  const tickers = Object.keys(spotByTicker);
  for (const ticker of tickers) {
    const spot = spotByTicker[ticker];
    if (spot == null) {
      log(`### ${ticker}: spot unknown, skipped`);
      continue;
    }
    log(`### ${ticker} (spot ≈ ${fmt(spot, 2)})`);
    log('');
    // 20 strikes nearest spot for the 0DTE expiry (PROBE_DAY)
    const rows = await sql`
      WITH ranked AS (
        SELECT strike,
               COUNT(DISTINCT ts_minute) AS distinct_minutes,
               COUNT(*) AS row_count,
               ABS(strike - ${spot}::numeric) AS dist
        FROM ws_gex_strike_expiry
        WHERE ticker = ${ticker}
          AND expiry = ${PROBE_DAY}::date
          AND ts_minute >= ${RTH_START_UTC}
          AND ts_minute <  ${RTH_END_UTC}
        GROUP BY strike
      )
      SELECT strike, distinct_minutes, row_count, dist
      FROM ranked
      ORDER BY dist ASC
      LIMIT 20
    `;
    log('| strike | distinct_minutes | minute_coverage_pct | rows |');
    log('|--------|------------------|---------------------|------|');
    for (const r of rows) {
      const pct = (asNum(r.distinct_minutes) / TOTAL_RTH_MINUTES) * 100;
      log(
        `| ${asNum(r.strike)} | ${r.distinct_minutes} | ${fmt(pct, 1)}% | ${r.row_count} |`,
      );
    }
    log('');
  }
}

async function findAtmStrike(ticker, spot) {
  if (spot == null) return null;
  const rows = await sql`
    SELECT strike,
           COUNT(DISTINCT ts_minute) AS distinct_minutes
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker}
      AND expiry = ${PROBE_DAY}::date
      AND ts_minute >= ${RTH_START_UTC}
      AND ts_minute <  ${RTH_END_UTC}
    GROUP BY strike
    ORDER BY ABS(strike - ${spot}::numeric) ASC
    LIMIT 1
  `;
  return rows[0] ? asNum(rows[0].strike) : null;
}

async function probe4GapDistribution(ticker, strike) {
  log(
    `## Probe 4 — Gap distribution for ${ticker} ${PROBE_DAY} strike=${strike}`,
  );
  log('');
  if (strike == null) {
    log('No ATM strike resolved; skipped.');
    log('');
    return;
  }
  const rows = await sql`
    WITH src AS (
      SELECT ts_minute
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${PROBE_DAY}::date
        AND strike = ${strike}::numeric
        AND ts_minute >= ${RTH_START_UTC}
        AND ts_minute <  ${RTH_END_UTC}
      ORDER BY ts_minute
    ),
    gaps AS (
      SELECT EXTRACT(EPOCH FROM (ts_minute - LAG(ts_minute) OVER (ORDER BY ts_minute))) AS gap_seconds
      FROM src
    )
    SELECT
      COUNT(*) FILTER (WHERE gap_seconds IS NOT NULL) AS gap_count,
      MIN(gap_seconds) AS min_gap_s,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap_s,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY gap_seconds) AS p95_gap_s,
      MAX(gap_seconds) AS max_gap_s,
      COUNT(*) FILTER (WHERE gap_seconds > 60) AS gaps_gt_60s,
      COUNT(*) FILTER (WHERE gap_seconds > 120) AS gaps_gt_120s,
      COUNT(*) FILTER (WHERE gap_seconds > 300) AS gaps_gt_300s
    FROM gaps
  `;
  const r = rows[0] || {};
  log('| metric | value |');
  log('|--------|-------|');
  log(`| gap samples | ${r.gap_count ?? 0} |`);
  log(`| min gap (s) | ${fmt(asNum(r.min_gap_s), 1)} |`);
  log(`| median gap (s) | ${fmt(asNum(r.median_gap_s), 1)} |`);
  log(`| p95 gap (s) | ${fmt(asNum(r.p95_gap_s), 1)} |`);
  log(`| max gap (s) | ${fmt(asNum(r.max_gap_s), 1)} |`);
  log(`| gaps > 60s | ${r.gaps_gt_60s ?? 0} |`);
  log(`| gaps > 120s | ${r.gaps_gt_120s ?? 0} |`);
  log(`| gaps > 300s | ${r.gaps_gt_300s ?? 0} |`);
  log('');

  // Also bucket histogram: how many in [<=60, 61-120, 121-300, >300]
  const hist = await sql`
    WITH src AS (
      SELECT ts_minute
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${PROBE_DAY}::date
        AND strike = ${strike}::numeric
        AND ts_minute >= ${RTH_START_UTC}
        AND ts_minute <  ${RTH_END_UTC}
      ORDER BY ts_minute
    ),
    gaps AS (
      SELECT EXTRACT(EPOCH FROM (ts_minute - LAG(ts_minute) OVER (ORDER BY ts_minute))) AS gap_seconds
      FROM src
    )
    SELECT
      COUNT(*) FILTER (WHERE gap_seconds <= 60) AS le60,
      COUNT(*) FILTER (WHERE gap_seconds > 60  AND gap_seconds <= 120) AS b60_120,
      COUNT(*) FILTER (WHERE gap_seconds > 120 AND gap_seconds <= 300) AS b120_300,
      COUNT(*) FILTER (WHERE gap_seconds > 300) AS gt300
    FROM gaps
  `;
  const h = hist[0] || {};
  log('| bucket | count |');
  log('|--------|-------|');
  log(`| ≤ 60s | ${h.le60 ?? 0} |`);
  log(`| 61–120s | ${h.b60_120 ?? 0} |`);
  log(`| 121–300s | ${h.b120_300 ?? 0} |`);
  log(`| > 300s | ${h.gt300 ?? 0} |`);
  log('');
}

async function getApproxSpot(ticker) {
  // Use latest non-null price on the probe day, prefer last RTH minute of
  // the day. Fallback: median of all prices for that day.
  const rows = await sql`
    SELECT price
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker}
      AND expiry = ${PROBE_DAY}::date
      AND ts_minute >= ${RTH_START_UTC}
      AND ts_minute <  ${RTH_END_UTC}
      AND price IS NOT NULL
    ORDER BY ts_minute DESC
    LIMIT 1
  `;
  return rows[0] ? asNum(rows[0].price) : null;
}

async function main() {
  const span = await probe1Span();
  await probe2DailyDensity();

  const tickers = span.map((r) => r.ticker);
  const spotByTicker = {};
  for (const t of tickers) {
    spotByTicker[t] = await getApproxSpot(t);
  }
  log('### Approx closing spot used for ATM strike picks');
  log('');
  log('| ticker | spot |');
  log('|--------|------|');
  for (const t of tickers) {
    log(`| ${t} | ${fmt(spotByTicker[t], 2)} |`);
  }
  log('');

  await probe3StrikeCompleteness(spotByTicker);

  for (const t of tickers) {
    const atm = await findAtmStrike(t, spotByTicker[t]);
    await probe4GapDistribution(t, atm);
  }

  const resultsPath = resolve(__dirname, 'density_results.md');
  const header = [
    `# ws_gex_strike_expiry density probe`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    `Probe day (RTH UTC window): ${RTH_START_UTC} → ${RTH_END_UTC}`,
    `Total RTH minutes assumed: ${TOTAL_RTH_MINUTES}`,
    ``,
  ].join('\n');
  writeFileSync(resultsPath, `${header}\n${out.join('\n')}\n`);
  console.log(`\nWrote ${resultsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
