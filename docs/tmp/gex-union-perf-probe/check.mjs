// EXPLAIN ANALYZE probe for the GEX-strike-expiry historical fallback.
//
// Goal: confirm that the new SPX rest_series CTE in
// api/_lib/db-gex-strike-expiry.ts uses the existing
// idx_gex_strike_0dte_date / idx_gex_strike_0dte_ts indexes (per
// migration 47) rather than degenerating into a sequential scan when
// WS is empty for a historical SPX expiry. Echoes the lesson from the
// recent dark-pool fix: a missing composite index can balloon a Vercel
// Function to 12s+; we want sub-second here.
//
// Reads DATABASE_URL from .env.local.
// Usage: node docs/tmp/gex-union-perf-probe/check.mjs [YYYY-MM-DD]
//        (default expiry = pick a recent SPX trading day)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function loadEnvVar(name) {
  const envPath = resolve(REPO_ROOT, '.env.local');
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key !== name) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const DATABASE_URL = loadEnvVar('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('DATABASE_URL missing from .env.local');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const ticker = 'SPX';
const expiry = process.argv[2] ?? '2026-04-30';
// Anchor at session close UTC so the 35-min lookback covers a real
// trading slice rather than NOW() (which is post-session).
const at = `${expiry}T20:00:00Z`;

console.log(`Ticker:  ${ticker}`);
console.log(`Expiry:  ${expiry}`);
console.log(`Anchor:  ${at}`);
console.log('');

// Step 0 — sanity: does the legacy table actually have rows for that
// expiry? If not, the EXPLAIN below shows "0 rows" which is correct
// but uninformative.
const [{ count: restCount }] = await sql`
  SELECT COUNT(*)::int AS count
  FROM gex_strike_0dte
  WHERE date = ${expiry}::date
`;
const [{ count: wsCount }] = await sql`
  SELECT COUNT(*)::int AS count
  FROM ws_gex_strike_expiry
  WHERE ticker = ${ticker} AND expiry = ${expiry}::date
`;
console.log(`gex_strike_0dte rows for ${expiry}:        ${restCount}`);
console.log(`ws_gex_strike_expiry rows for SPX/${expiry}: ${wsCount}`);
console.log('');

// Step 1 — EXPLAIN (ANALYZE, BUFFERS) on the full unified query, exactly
// as it runs in production. Embed params via tagged template so we get
// real prepared-stmt plan, not a literal-substituted one.
console.log('=== EXPLAIN ANALYZE: full UNION query ===');
const t0 = Date.now();
const plan = await sql`
  EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  WITH ws_series AS (
    SELECT
      ticker, expiry, strike, ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask_vol, call_gamma_bid_vol,
      put_gamma_ask_vol, put_gamma_bid_vol,
      call_charm_ask_vol, call_charm_bid_vol,
      put_charm_ask_vol, put_charm_bid_vol,
      call_vanna_ask_vol, call_vanna_bid_vol,
      put_vanna_ask_vol, put_vanna_bid_vol,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker}
      AND expiry = ${expiry}::date
      AND ts_minute >= COALESCE(${at}::timestamptz, NOW()) - INTERVAL '35 minutes'
      AND ts_minute <= COALESCE(${at}::timestamptz, NOW())
  ),
  ws_count AS (
    SELECT COUNT(*) AS n FROM ws_series
  ),
  rest_series AS (
    SELECT
      'SPX'::text AS ticker,
      date AS expiry,
      strike, timestamp AS ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask AS call_gamma_ask_vol,
      call_gamma_bid AS call_gamma_bid_vol,
      put_gamma_ask  AS put_gamma_ask_vol,
      put_gamma_bid  AS put_gamma_bid_vol,
      NULL::numeric AS call_charm_ask_vol,
      NULL::numeric AS call_charm_bid_vol,
      NULL::numeric AS put_charm_ask_vol,
      NULL::numeric AS put_charm_bid_vol,
      NULL::numeric AS call_vanna_ask_vol,
      NULL::numeric AS call_vanna_bid_vol,
      NULL::numeric AS put_vanna_ask_vol,
      NULL::numeric AS put_vanna_bid_vol,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM gex_strike_0dte
    WHERE ${ticker} = 'SPX'
      AND (SELECT n FROM ws_count) = 0
      AND date = ${expiry}::date
      AND timestamp >= COALESCE(${at}::timestamptz, NOW()) - INTERVAL '35 minutes'
      AND timestamp <= COALESCE(${at}::timestamptz, NOW())
  ),
  combined AS (
    SELECT * FROM ws_series
    UNION ALL
    SELECT * FROM rest_series
  ),
  deltas AS (
    SELECT
      ticker, expiry, strike, ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask_vol, call_gamma_bid_vol,
      put_gamma_ask_vol, put_gamma_bid_vol,
      call_charm_ask_vol, call_charm_bid_vol,
      put_charm_ask_vol, put_charm_bid_vol,
      call_vanna_ask_vol, call_vanna_bid_vol,
      put_vanna_ask_vol, put_vanna_bid_vol,
      net_gamma,
      (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 1)  OVER w), 0) - 1) AS gamma_delta_1m,
      (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 5)  OVER w), 0) - 1) AS gamma_delta_5m,
      (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 10) OVER w), 0) - 1) AS gamma_delta_10m,
      (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 15) OVER w), 0) - 1) AS gamma_delta_15m,
      (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 30) OVER w), 0) - 1) AS gamma_delta_30m
    FROM combined
    WINDOW w AS (PARTITION BY ticker, expiry, strike ORDER BY ts_minute)
  )
  SELECT DISTINCT ON (strike)
    ticker, expiry, strike, ts_minute, price,
    call_gamma_oi, put_gamma_oi,
    call_charm_oi, put_charm_oi,
    call_vanna_oi, put_vanna_oi,
    call_gamma_vol, put_gamma_vol,
    call_charm_vol, put_charm_vol,
    call_vanna_vol, put_vanna_vol,
    call_gamma_ask_vol, call_gamma_bid_vol,
    put_gamma_ask_vol, put_gamma_bid_vol,
    call_charm_ask_vol, call_charm_bid_vol,
    put_charm_ask_vol, put_charm_bid_vol,
    call_vanna_ask_vol, call_vanna_bid_vol,
    put_vanna_ask_vol, put_vanna_bid_vol,
    gamma_delta_1m, gamma_delta_5m, gamma_delta_10m,
    gamma_delta_15m, gamma_delta_30m
  FROM deltas
  ORDER BY strike, ts_minute DESC
`;
const elapsedExplain = Date.now() - t0;
for (const row of plan) {
  console.log(row['QUERY PLAN']);
}
console.log('');
console.log(`(EXPLAIN round-trip: ${elapsedExplain} ms)`);
console.log('');

// Step 2 — actual run timing (no EXPLAIN), repeated 3x to absorb cold
// vs warm cache jitter. This is what /api/gex-strike-expiry actually
// pays at request time.
console.log('=== Live timings (3 runs) ===');
for (let i = 1; i <= 3; i++) {
  const start = Date.now();
  const rows = await sql`
    WITH ws_series AS (
      SELECT
        ticker, expiry, strike, ts_minute, price,
        call_gamma_oi, put_gamma_oi,
        call_charm_oi, put_charm_oi,
        call_vanna_oi, put_vanna_oi,
        call_gamma_vol, put_gamma_vol,
        call_charm_vol, put_charm_vol,
        call_vanna_vol, put_vanna_vol,
        call_gamma_ask_vol, call_gamma_bid_vol,
        put_gamma_ask_vol, put_gamma_bid_vol,
        call_charm_ask_vol, call_charm_bid_vol,
        put_charm_ask_vol, put_charm_bid_vol,
        call_vanna_ask_vol, call_vanna_bid_vol,
        put_vanna_ask_vol, put_vanna_bid_vol,
        (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${expiry}::date
        AND ts_minute >= COALESCE(${at}::timestamptz, NOW()) - INTERVAL '35 minutes'
        AND ts_minute <= COALESCE(${at}::timestamptz, NOW())
    ),
    ws_count AS (
      SELECT COUNT(*) AS n FROM ws_series
    ),
    rest_series AS (
      SELECT
        'SPX'::text AS ticker,
        date AS expiry,
        strike, timestamp AS ts_minute, price,
        call_gamma_oi, put_gamma_oi,
        call_charm_oi, put_charm_oi,
        call_vanna_oi, put_vanna_oi,
        call_gamma_vol, put_gamma_vol,
        call_charm_vol, put_charm_vol,
        call_vanna_vol, put_vanna_vol,
        call_gamma_ask AS call_gamma_ask_vol,
        call_gamma_bid AS call_gamma_bid_vol,
        put_gamma_ask  AS put_gamma_ask_vol,
        put_gamma_bid  AS put_gamma_bid_vol,
        NULL::numeric AS call_charm_ask_vol,
        NULL::numeric AS call_charm_bid_vol,
        NULL::numeric AS put_charm_ask_vol,
        NULL::numeric AS put_charm_bid_vol,
        NULL::numeric AS call_vanna_ask_vol,
        NULL::numeric AS call_vanna_bid_vol,
        NULL::numeric AS put_vanna_ask_vol,
        NULL::numeric AS put_vanna_bid_vol,
        (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
      FROM gex_strike_0dte
      WHERE ${ticker} = 'SPX'
        AND (SELECT n FROM ws_count) = 0
        AND date = ${expiry}::date
        AND timestamp >= COALESCE(${at}::timestamptz, NOW()) - INTERVAL '35 minutes'
        AND timestamp <= COALESCE(${at}::timestamptz, NOW())
    ),
    combined AS (
      SELECT * FROM ws_series
      UNION ALL
      SELECT * FROM rest_series
    ),
    deltas AS (
      SELECT
        ticker, expiry, strike, ts_minute, price,
        net_gamma,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 1)  OVER w), 0) - 1) AS gamma_delta_1m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 5)  OVER w), 0) - 1) AS gamma_delta_5m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 10) OVER w), 0) - 1) AS gamma_delta_10m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 15) OVER w), 0) - 1) AS gamma_delta_15m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 30) OVER w), 0) - 1) AS gamma_delta_30m
      FROM combined
      WINDOW w AS (PARTITION BY ticker, expiry, strike ORDER BY ts_minute)
    )
    SELECT DISTINCT ON (strike) strike, ts_minute, gamma_delta_1m
    FROM deltas
    ORDER BY strike, ts_minute DESC
  `;
  const elapsed = Date.now() - start;
  console.log(`Run ${i}: ${elapsed} ms — ${rows.length} rows`);
}

// Step 3 — also probe getTimestampsForDay's UNION query.
console.log('');
console.log('=== getTimestampsForDay timing (3 runs) ===');
for (let i = 1; i <= 3; i++) {
  const start = Date.now();
  const rows = await sql`
    WITH ws_ts AS (
      SELECT DISTINCT ts_minute
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${expiry}::date
    ),
    ws_count AS (
      SELECT COUNT(*) AS n FROM ws_ts
    ),
    rest_ts AS (
      SELECT DISTINCT timestamp AS ts_minute
      FROM gex_strike_0dte
      WHERE ${ticker} = 'SPX'
        AND (SELECT n FROM ws_count) = 0
        AND date = ${expiry}::date
    )
    SELECT ts_minute FROM ws_ts
    UNION
    SELECT ts_minute FROM rest_ts
    ORDER BY ts_minute ASC
  `;
  const elapsed = Date.now() - start;
  console.log(`Run ${i}: ${elapsed} ms — ${rows.length} timestamps`);
}
