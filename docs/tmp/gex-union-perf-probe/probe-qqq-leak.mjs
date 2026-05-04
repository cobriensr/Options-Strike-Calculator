import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({
  path: '/Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local',
});

const sql = neon(process.env.DATABASE_URL);

// What's the max ts_minute for QQQ on 2026-05-01?
const wsMax = await sql`
  SELECT MAX(ts_minute) AS ts FROM ws_gex_strike_expiry
  WHERE ticker = 'QQQ' AND expiry = '2026-05-01'::date
`;
console.log('QQQ WS max ts_minute on 2026-05-01:', wsMax[0]?.ts);

// What strikes does QQQ have for 2026-05-01?
const qqqStrikes = await sql`
  SELECT MIN(strike) AS min, MAX(strike) AS max, COUNT(*) AS n
  FROM ws_gex_strike_expiry
  WHERE ticker = 'QQQ' AND expiry = '2026-05-01'::date
`;
console.log('QQQ strike range on 2026-05-01:', qqqStrikes[0]);

// Top 5 by |netGamma| for QQQ 2026-05-01
const qqqTop = await sql`
  SELECT strike, ts_minute,
    (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
  FROM ws_gex_strike_expiry
  WHERE ticker = 'QQQ' AND expiry = '2026-05-01'::date
  ORDER BY ABS(COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) DESC
  LIMIT 5
`;
console.log('QQQ top 5 strikes by |netGamma|:', qqqTop);

// Now let's run the actual UNION query for QQQ and see what comes back
const at = null;
const ticker = 'QQQ';
const expiry = '2026-05-01';
const result = await sql`
  WITH effective_at AS (
    SELECT
      COALESCE(
        ${at}::timestamptz,
        GREATEST(
          (SELECT MAX(ts_minute) FROM ws_gex_strike_expiry
           WHERE ticker = ${ticker} AND expiry = ${expiry}::date),
          CASE WHEN ${ticker} = 'SPX' THEN
            (SELECT MAX(timestamp) FROM gex_strike_0dte WHERE date = ${expiry}::date)
          END
        ),
        NOW()
      ) AS at_ts
  ),
  ws_series AS (
    SELECT ticker, expiry, strike, ts_minute,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker} AND expiry = ${expiry}::date
      AND ts_minute >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
      AND ts_minute <= (SELECT at_ts FROM effective_at)
  ),
  ws_count AS (SELECT COUNT(*) AS n FROM ws_series),
  rest_series AS (
    SELECT 'SPX'::text AS ticker, date AS expiry, strike, timestamp AS ts_minute,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM gex_strike_0dte
    WHERE ${ticker} = 'SPX'
      AND (SELECT n FROM ws_count) = 0
      AND date = ${expiry}::date
      AND timestamp >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
      AND timestamp <= (SELECT at_ts FROM effective_at)
  ),
  combined AS (
    SELECT * FROM ws_series UNION ALL SELECT * FROM rest_series
  )
  SELECT DISTINCT ON (strike) ticker, strike, ts_minute, net_gamma
  FROM combined
  ORDER BY strike, ts_minute DESC
  LIMIT 5
`;
console.log('UNION query for QQQ — first 5 rows:', result);

const resultMax = await sql`
  WITH effective_at AS (
    SELECT
      COALESCE(
        ${at}::timestamptz,
        GREATEST(
          (SELECT MAX(ts_minute) FROM ws_gex_strike_expiry
           WHERE ticker = ${ticker} AND expiry = ${expiry}::date),
          CASE WHEN ${ticker} = 'SPX' THEN
            (SELECT MAX(timestamp) FROM gex_strike_0dte WHERE date = ${expiry}::date)
          END
        ),
        NOW()
      ) AS at_ts
  ),
  ws_series AS (
    SELECT ticker, expiry, strike, ts_minute,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker} AND expiry = ${expiry}::date
      AND ts_minute >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
      AND ts_minute <= (SELECT at_ts FROM effective_at)
  ),
  ws_count AS (SELECT COUNT(*) AS n FROM ws_series),
  rest_series AS (
    SELECT 'SPX'::text AS ticker, date AS expiry, strike, timestamp AS ts_minute,
      (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM gex_strike_0dte
    WHERE ${ticker} = 'SPX'
      AND (SELECT n FROM ws_count) = 0
      AND date = ${expiry}::date
      AND timestamp >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
      AND timestamp <= (SELECT at_ts FROM effective_at)
  ),
  combined AS (
    SELECT * FROM ws_series UNION ALL SELECT * FROM rest_series
  )
  SELECT DISTINCT ON (strike) ticker, strike, ts_minute, net_gamma
  FROM combined
  ORDER BY ABS(net_gamma) DESC, strike
  LIMIT 5
`;
console.log('UNION query for QQQ — top 5 by |netGamma|:', resultMax);
