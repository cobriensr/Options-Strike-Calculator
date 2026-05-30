import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const r = (await sql`
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL) AS n_peak,
      count(*) FILTER (WHERE realized_trail30_10_pct IS NOT NULL) AS n_trail,
      count(*) FILTER (WHERE realized_tier50_holdeod_pct IS NOT NULL) AS n_tier50,
      count(*) FILTER (WHERE reload_tagged IS TRUE) AS n_reload_true,
      count(*) FILTER (WHERE reload_tagged IS NOT NULL) AS n_reload_nn,
      count(*) FILTER (WHERE spx_spot_gamma_oi IS NOT NULL) AS n_sgamma,
      count(*) FILTER (WHERE spx_spot_gamma_oi < 0) AS n_sgamma_neg,
      count(*) FILTER (WHERE gamma_at_trigger IS NOT NULL) AS n_gat,
      count(*) FILTER (WHERE gamma_at_trigger < 0) AS n_gat_neg,
      count(*) FILTER (WHERE is_isolated_leg IS TRUE) AS n_iso_true,
      count(*) FILTER (WHERE is_isolated_leg IS NOT NULL) AS n_iso_nn,
      count(*) FILTER (WHERE inferred_structure IS NOT NULL) AS n_struct_nn,
      min(date) AS d0, max(date) AS d1,
      count(DISTINCT date) AS ndates
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
  `) as unknown as Record<string, unknown>[];
  console.log('LF (peak NOT NULL):', JSON.stringify(r[0], null, 2));

  const structs = (await sql`
    SELECT inferred_structure AS s, count(*) AS n
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
    GROUP BY inferred_structure ORDER BY n DESC
  `) as unknown as Record<string, unknown>[];
  console.log('\nLF inferred_structure dist:');
  for (const x of structs) console.log(`  ${x.s ?? '(null)'}: ${x.n}`);
})();
