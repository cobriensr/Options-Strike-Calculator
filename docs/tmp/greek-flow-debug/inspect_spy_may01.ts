/**
 * Diagnostic: SPY OTM Dir Delta cumulative on 2026-05-01.
 *
 * Compares our stored values to UW's web display:
 *   - UW tooltip shows OTM Dir Delta = 17,609.44 at 8:33 AM CT, price 722.18
 *   - UW chart shows end-of-day cumulative ≈ -3,570k
 *   - Our panel shows max +348.1k, min -725.2k (5x smaller magnitude, crosses zero)
 *
 * This script prints per-minute raw + cumulative values so we can pinpoint
 * where the divergence starts.
 *
 * Run: npx tsx docs/tmp/greek-flow-debug/inspect_spy_may01.ts
 *
 * Requires: DATABASE_URL in .env.local
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const sql = neon(url);

const TARGET_DATE = '2026-05-01';
const TARGET_TICKER = 'SPY';

async function main() {
  console.log(`\n=== ${TARGET_TICKER} ${TARGET_DATE} — row count + bounds ===`);
  const summary = (await sql`
    SELECT
      COUNT(*) AS minute_rows,
      MIN(timestamp) AS first_ts,
      MAX(timestamp) AS last_ts,
      MIN(otm_dir_delta_flow::numeric) AS raw_min,
      MAX(otm_dir_delta_flow::numeric) AS raw_max,
      SUM(otm_dir_delta_flow::numeric) AS eod_cum
    FROM vega_flow_etf
    WHERE ticker = ${TARGET_TICKER} AND date = ${TARGET_DATE}::date
  `) as Array<{
    minute_rows: string;
    first_ts: string | null;
    last_ts: string | null;
    raw_min: string | null;
    raw_max: string | null;
    eod_cum: string | null;
  }>;
  console.table(summary);

  console.log(`\n=== First 10 minutes (incl. 8:33 AM CT reference) ===`);
  const head = (await sql`
    WITH ordered AS (
      SELECT
        timestamp,
        otm_dir_delta_flow::numeric AS raw,
        SUM(otm_dir_delta_flow::numeric) OVER (ORDER BY timestamp) AS cum
      FROM vega_flow_etf
      WHERE ticker = ${TARGET_TICKER} AND date = ${TARGET_DATE}::date
      ORDER BY timestamp
    )
    SELECT * FROM ordered LIMIT 10
  `) as Array<{ timestamp: string; raw: string; cum: string }>;
  console.table(
    head.map((r) => ({
      ts_utc: r.timestamp,
      ts_ct: new Date(r.timestamp).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        minute: '2-digit',
      }),
      raw: Number.parseFloat(r.raw).toFixed(2),
      cum: Number.parseFloat(r.cum).toFixed(2),
    })),
  );

  console.log(`\n=== Hourly snapshots (cumulative at HH:00 CT) ===`);
  const hourly = (await sql`
    WITH ordered AS (
      SELECT
        timestamp,
        SUM(otm_dir_delta_flow::numeric) OVER (ORDER BY timestamp) AS cum
      FROM vega_flow_etf
      WHERE ticker = ${TARGET_TICKER} AND date = ${TARGET_DATE}::date
    ),
    hourly_marks AS (
      SELECT DISTINCT ON (date_trunc('hour', timestamp AT TIME ZONE 'America/Chicago'))
        timestamp,
        cum,
        date_trunc('hour', timestamp AT TIME ZONE 'America/Chicago') AS hour_ct
      FROM ordered
      ORDER BY date_trunc('hour', timestamp AT TIME ZONE 'America/Chicago'), timestamp
    )
    SELECT * FROM hourly_marks ORDER BY timestamp
  `) as Array<{ timestamp: string; cum: string; hour_ct: string }>;
  console.table(
    hourly.map((r) => ({
      hour_ct: new Date(r.hour_ct).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        minute: '2-digit',
      }),
      first_ts_in_hour: r.timestamp,
      cum: Number.parseFloat(r.cum).toFixed(2),
    })),
  );

  console.log(
    `\n=== Cumulative trajectory: max, min, end (window-function order) ===`,
  );
  const traj = (await sql`
    WITH ordered AS (
      SELECT
        timestamp,
        SUM(otm_dir_delta_flow::numeric) OVER (ORDER BY timestamp) AS cum
      FROM vega_flow_etf
      WHERE ticker = ${TARGET_TICKER} AND date = ${TARGET_DATE}::date
    )
    SELECT
      (SELECT cum FROM ordered ORDER BY timestamp LIMIT 1) AS first_cum,
      (SELECT cum FROM ordered ORDER BY timestamp DESC LIMIT 1) AS last_cum,
      (SELECT MAX(cum) FROM ordered) AS max_cum,
      (SELECT MIN(cum) FROM ordered) AS min_cum,
      (SELECT timestamp FROM ordered ORDER BY cum DESC LIMIT 1) AS ts_at_max,
      (SELECT timestamp FROM ordered ORDER BY cum ASC LIMIT 1) AS ts_at_min
  `) as Array<{
    first_cum: string;
    last_cum: string;
    max_cum: string;
    min_cum: string;
    ts_at_max: string;
    ts_at_min: string;
  }>;
  console.table(traj);

  console.log('\n=== Reference: UW shows ===');
  console.log('  At 8:33 AM CT: OTM Dir Delta cumulative = 17,609.44');
  console.log('  End of session: ≈ -3,570,000');
  console.log('\n=== Our panel shows ===');
  console.log('  Max cumulative: +348,100');
  console.log('  Min cumulative: -725,200');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
