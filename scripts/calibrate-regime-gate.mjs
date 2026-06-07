/**
 * Calibrate GATE_DEEP_NEG to live gex_strike_0dte units (regime-0dte plan Task 12).
 *
 * The study's -0.15 deep-neg cutoff is in EOD-parquet units. The live gate (api/_lib/regime-0dte.ts
 * gexNear) sums raw (call_gamma_oi - put_gamma_oi) within +/-1% of spot, a DIFFERENT scale. This
 * script computes the live-units open-spot gexNear distribution and the ~12th percentile (matching
 * the study's 13/106 deep-neg share), then cross-checks that deep-neg days are downside-skewed using
 * realized open->close from index_candles_1m.
 *
 * Read-only. Run: node --env-file=<path-to>/.env.local scripts/calibrate-regime-gate.mjs
 * (DATABASE_URL is read from the env file; never printed.)
 */
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set (run with --env-file=.../.env.local)');
  process.exit(1);
}
const sql = neon(DATABASE_URL);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

const span = await sql`
  SELECT min(date) lo, max(date) hi, count(distinct date) days, count(*) rows
  FROM gex_strike_0dte
`;
console.log('gex_strike_0dte span:', span[0]);

// per-day open-spot gexNear in LIVE units (sum call_gamma_oi - put_gamma_oi within +/-1% of the
// first-minute price). One row per trading day.
const gex = await sql`
  WITH fm AS (SELECT date, min(timestamp) AS ts FROM gex_strike_0dte GROUP BY date),
  r AS (
    SELECT g.date, g.price, g.strike, g.call_gamma_oi, g.put_gamma_oi
    FROM gex_strike_0dte g JOIN fm ON g.date = fm.date AND g.timestamp = fm.ts
  )
  SELECT date,
    max(price) AS open_price,
    -- put_gamma_oi is stored SIGNED-NEGATIVE in this table, so net GEX = call + put
    sum(CASE WHEN abs(strike - price) <= 0.01 * price
             THEN call_gamma_oi + put_gamma_oi ELSE 0 END)::float8 AS gex_near,
    count(*) FILTER (WHERE abs(strike - price) <= 0.01 * price) AS n_band
  FROM r GROUP BY date ORDER BY date
`;

// realized open->close % per day from index_candles_1m (SPX regular session)
const oc = await sql`
  WITH c AS (
    SELECT date,
      (array_agg(open  ORDER BY timestamp ASC ))[1] AS o,
      (array_agg(close ORDER BY timestamp DESC))[1] AS c
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND market_time = 'r'
    GROUP BY date
  )
  SELECT date, round(((c - o) / o * 100)::numeric, 3)::float8 AS oc_ret_pct FROM c
`;
const ocByDate = new Map(oc.map((r) => [String(r.date), r.oc_ret_pct]));

const rows = gex
  .filter((r) => r.n_band >= 5 && r.gex_near != null)
  .map((r) => ({
    date: String(r.date),
    gex: r.gex_near,
    oc: ocByDate.get(String(r.date)) ?? null,
  }));

const vals = rows.map((r) => r.gex);
console.log(`\nusable days: ${rows.length}  | n_band>=5`);
console.log('gexNear distribution (live units):');
for (const p of [0, 5, 10, 12, 25, 50, 75, 90, 100]) {
  console.log(`  p${String(p).padStart(3)}: ${pct(vals, p)?.toFixed(4)}`);
}
const nNeg = vals.filter((v) => v < 0).length;
console.log(`  sign: ${nNeg} negative / ${vals.length - nNeg} positive`);

const cut = pct(vals, 12); // ~12th percentile = most-negative ~12% (study: 13/106)
console.log(
  `\n>>> recommended GATE_DEEP_NEG (12th pctile, live units): ${cut?.toFixed(4)}`,
);

// cross-check: among deep-neg (<= cut) vs rest, realized down-day rate (oc <= -0.5%)
const withOc = rows.filter((r) => r.oc != null);
const deep = withOc.filter((r) => r.gex <= cut);
const rest = withOc.filter((r) => r.gex > cut);
const downRate = (a) =>
  a.length ? a.filter((r) => r.oc <= -0.5).length / a.length : NaN;
const upRate = (a) =>
  a.length ? a.filter((r) => r.oc >= 0.5).length / a.length : NaN;
console.log(`\ncross-check vs realized (n with outcome=${withOc.length}):`);
console.log(
  `  deep-neg (<=cut) n=${deep.length}: down<=-0.5% rate=${downRate(deep).toFixed(3)}  up>=0.5% rate=${upRate(deep).toFixed(3)}`,
);
console.log(
  `  rest           n=${rest.length}: down<=-0.5% rate=${downRate(rest).toFixed(3)}  up>=0.5% rate=${upRate(rest).toFixed(3)}`,
);
console.log(
  '\ndeep-neg days:',
  deep.map((r) => `${r.date}(${r.oc}%)`).join(', '),
);
