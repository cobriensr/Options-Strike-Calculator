import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const r = (await sql`
    SELECT min(date) AS d0, max(date) AS d1, count(*) AS n,
           count(DISTINCT date) AS ndates
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL AND is_isolated_leg IS NOT NULL
  `) as unknown as Record<string, unknown>[];
  console.log('is_isolated_leg NOT NULL date range:', JSON.stringify(r[0]));

  const r2 = (await sql`
    SELECT min(date) AS d0, max(date) AS d1, count(*) AS n
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL AND reload_tagged IS TRUE
  `) as unknown as Record<string, unknown>[];
  console.log('reload_tagged=true date range:', JSON.stringify(r2[0]));

  const r3 = (await sql`
    SELECT min(date) AS d0, max(date) AS d1, count(*) AS n
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL AND spx_spot_gamma_oi IS NOT NULL
  `) as unknown as Record<string, unknown>[];
  console.log('spx_spot_gamma_oi NOT NULL date range:', JSON.stringify(r3[0]));

  // gamma<0 by date — is the sign coverage time-clustered?
  const r4 = (await sql`
    SELECT min(date) AS d0, max(date) AS d1, count(*) AS n,
           count(DISTINCT date) AS ndates
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL AND spx_spot_gamma_oi < 0
  `) as unknown as Record<string, unknown>[];
  console.log('spx_spot_gamma_oi < 0 date range:', JSON.stringify(r4[0]));
})();
