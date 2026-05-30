import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const LOOKBACK_HOURS = 12;
(async () => {
  const rows = (await sql`
    SELECT
      count(*)::int AS rows_all,
      count(*) FILTER (WHERE zero_gamma IS NULL)::int AS zg_null_all,
      count(*) FILTER (WHERE sum_gex_oi IS NULL)::int AS sgo_null_all,
      count(*) FILTER (WHERE delta_risk_reversal IS NULL)::int AS drr_null_all,
      count(*) FILTER (WHERE ticker = 'SPX')::int AS rows_spx,
      count(*) FILTER (WHERE ticker = 'SPX' AND zero_gamma IS NULL)::int AS zg_null_spx
    FROM gexbot_snapshots
    WHERE captured_at > NOW() - (${LOOKBACK_HOURS} || ' hours')::interval
  `) as Record<string, unknown>[];
  console.log('query OK — row:', rows[0]);
  console.log('(zero_gamma ~100% NULL expected until Monday first session)');
})();
