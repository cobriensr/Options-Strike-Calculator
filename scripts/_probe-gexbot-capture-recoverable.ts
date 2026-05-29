/**
 * Probe: the 10 fields missing from the live orderflow payload (zero_gamma,
 * sum_gex_*, major_*, delta_risk_reversal, min_dte/sec_min_dte) are spec'd on
 * `basic_response`, which the /state/{gamma_zero...} per-strike endpoint
 * returns. We already capture those as raw JSONB in gexbot_api_capture.
 * This confirms whether the data is recoverable from what we already store.
 * Read-only. Run: npx tsx scripts/_probe-gexbot-capture-recoverable.ts
 */
import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
type Row = Record<string, unknown>;

const FIELDS = [
  'zero_gamma',
  'min_dte',
  'sec_min_dte',
  'sum_gex_vol',
  'sum_gex_oi',
  'major_pos_vol',
  'major_pos_oi',
  'major_neg_vol',
  'major_neg_oi',
  'delta_risk_reversal',
];

(async () => {
  // Latest SPX gamma_zero (basic_response) capture row — does its JSONB carry
  // the fields the orderflow snapshot is missing?
  const r = (await sql`
    SELECT endpoint, category, captured_at,
           raw_response ? 'zero_gamma'              AS has_zg,
           raw_response->>'zero_gamma'              AS zg,
           raw_response->>'sum_gex_vol'             AS sum_gex_vol,
           raw_response->>'major_pos_vol'           AS major_pos_vol,
           raw_response->>'delta_risk_reversal'     AS drr,
           raw_response->>'min_dte'                 AS min_dte,
           jsonb_array_length(raw_response->'strikes') AS n_strikes
    FROM gexbot_api_capture
    WHERE ticker = 'SPX' AND endpoint = 'state' AND category = 'gamma_zero'
    ORDER BY captured_at DESC
    LIMIT 1
  `) as Row[];
  console.log('latest SPX state/gamma_zero capture:', r[0]);

  // Full key list on that basic_response row
  const k = (await sql`
    SELECT jsonb_object_keys(raw_response) AS k
    FROM (
      SELECT raw_response FROM gexbot_api_capture
      WHERE ticker = 'SPX' AND endpoint = 'state' AND category = 'gamma_zero'
      ORDER BY captured_at DESC LIMIT 1
    ) s
    ORDER BY k
  `) as Row[];
  console.log('\nstate/gamma_zero keys:', k.map((x) => x.k).join(', '));

  // Fill-rate of each missing field across the last 24h of SPX gamma_zero rows
  console.log('\n24h fill-rate on state/gamma_zero (SPX):');
  for (const f of FIELDS) {
    const rr = (await sql.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE raw_response ? '${f}'
                               AND raw_response->>'${f}' IS NOT NULL)::int AS filled
       FROM gexbot_api_capture
       WHERE ticker='SPX' AND endpoint='state' AND category='gamma_zero'
         AND captured_at > NOW() - INTERVAL '24 hours'`,
    )) as Row[];
    const x = rr[0];
    console.log(`   ${f.padEnd(22)} ${x.filled}/${x.n}`);
  }
})();
