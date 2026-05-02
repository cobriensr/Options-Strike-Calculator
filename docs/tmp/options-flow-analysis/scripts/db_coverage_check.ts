/**
 * Coverage check for macro feature tables over the 4/13 - 5/1 backtest window.
 *
 * Verifies the flow_data, spot_exposures, strike_exposures, and
 * greek_exposure tables have adequate data to attach to the 783
 * RE-LOAD fires for re-validation.
 *
 * Run: npx tsx docs/tmp/options-flow-analysis/scripts/db_coverage_check.ts
 *
 * Requires: DATABASE_URL in .env.local
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set; pull .env.local with `vercel env pull .env.local`');
  process.exit(1);
}
const sql = neon(url);

const WINDOW_START = '2026-04-13';
const WINDOW_END = '2026-05-01';

async function main() {
  console.log('=== flow_data coverage by source ===');
  const flow = (await sql`
    SELECT
      source,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      COUNT(DISTINCT date) AS distinct_days,
      COUNT(*) AS rows_total,
      COUNT(*) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS rows_in_window,
      COUNT(DISTINCT date) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS days_in_window
    FROM flow_data
    GROUP BY source
    ORDER BY source
  `) as Array<{
    source: string; first_date: string; last_date: string;
    distinct_days: string; rows_total: string;
    rows_in_window: string; days_in_window: string;
  }>;
  console.table(flow);

  console.log('\n=== spot_exposures coverage by ticker ===');
  const spot = (await sql`
    SELECT
      ticker,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      COUNT(*) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS rows_in_window,
      COUNT(DISTINCT date) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS days_in_window,
      COUNT(DISTINCT timestamp) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS distinct_timestamps
    FROM spot_exposures
    GROUP BY ticker
    ORDER BY ticker
  `) as Array<Record<string, unknown>>;
  console.table(spot);

  console.log('\n=== strike_exposures coverage by ticker ===');
  const strike = (await sql`
    SELECT
      ticker,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      COUNT(*) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS rows_in_window,
      COUNT(DISTINCT date) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS days_in_window,
      COUNT(DISTINCT timestamp) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS distinct_timestamps,
      COUNT(DISTINCT strike) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS distinct_strikes
    FROM strike_exposures
    GROUP BY ticker
    ORDER BY ticker
  `) as Array<Record<string, unknown>>;
  console.table(strike);

  console.log('\n=== greek_exposure (daily EOD) coverage by ticker ===');
  const greek = (await sql`
    SELECT
      ticker,
      COUNT(DISTINCT date) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS days_in_window,
      COUNT(DISTINCT expiry) FILTER (WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date) AS distinct_expiries
    FROM greek_exposure
    GROUP BY ticker
    ORDER BY ticker
    LIMIT 30
  `) as Array<Record<string, unknown>>;
  console.table(greek);

  console.log('\n=== flow_data sample row (most recent in window) ===');
  const sample = await sql`
    SELECT *
    FROM flow_data
    WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  console.log(sample);

  console.log('\n=== spot_exposures sample row ===');
  const ssample = await sql`
    SELECT *
    FROM spot_exposures
    WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  console.log(ssample);

  console.log('\n=== strike_exposures sample row ===');
  const stsample = await sql`
    SELECT *
    FROM strike_exposures
    WHERE date BETWEEN ${WINDOW_START}::date AND ${WINDOW_END}::date
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  console.log(stsample);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
