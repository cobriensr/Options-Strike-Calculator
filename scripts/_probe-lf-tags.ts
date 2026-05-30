import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

(async () => {
  // Null / fill rates and distributions for candidate tag columns, peak-non-null universe.
  const stats = await sql`
    SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE direction_gated) ::int AS gated_true,
      count(direction_gated)::int AS gated_nn,
      count(*) FILTER (WHERE reload_tagged)::int AS reload_true,
      count(reload_tagged)::int AS reload_nn,
      count(*) FILTER (WHERE cheap_call_pm_tagged)::int AS ccpm_true,
      count(cheap_call_pm_tagged)::int AS ccpm_nn,
      count(score)::int AS score_nn,
      count(takeit_prob)::int AS takeit_nn,
      count(range_pos_at_trigger)::int AS rangepos_nn,
      count(fire_count_score_adjustment)::int AS fcsa_nn,
      count(gamma_at_trigger)::int AS gamma_nn,
      count(spx_spot_gamma_oi)::int AS spxgamma_nn,
      count(mkt_tide_diff)::int AS tide_nn,
      count(cum_ncp_at_fire)::int AS ncp_nn,
      count(cum_npp_at_fire)::int AS npp_nn,
      count(inferred_structure)::int AS struct_nn,
      count(is_isolated_leg)::int AS isoleg_nn,
      count(*) FILTER (WHERE is_isolated_leg)::int AS isoleg_true,
      count(tod)::int AS tod_nn,
      count(combined_score)::int AS combined_nn,
      count(cluster_bonus)::int AS cbonus_nn,
      count(*) FILTER (WHERE dte = 0)::int AS dte0,
      count(dte)::int AS dte_nn
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL`;
  console.log(
    'STATS',
    JSON.stringify((stats as Record<string, unknown>[])[0], null, 2),
  );

  // tod distribution
  const tod = await sql`
    SELECT tod, count(*)::int AS n FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL GROUP BY tod ORDER BY n DESC`;
  console.log('TOD', JSON.stringify(tod));

  // inferred_structure distribution + date range where populated
  const struct = await sql`
    SELECT inferred_structure, count(*)::int AS n, min(date)::text AS mind, max(date)::text AS maxd
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL AND inferred_structure IS NOT NULL
    GROUP BY inferred_structure ORDER BY n DESC`;
  console.log('STRUCT', JSON.stringify(struct));

  // fire_count_score_adjustment distribution (proxy for fireCount bucket)
  const fcsa = await sql`
    SELECT fire_count_score_adjustment AS adj, count(*)::int AS n
    FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL
    GROUP BY fire_count_score_adjustment ORDER BY adj`;
  console.log('FCSA', JSON.stringify(fcsa));

  // cluster_bonus distribution
  const cb = await sql`
    SELECT cluster_bonus AS cb, count(*)::int AS n
    FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL
    GROUP BY cluster_bonus ORDER BY cb`;
  console.log('CLUSTERBONUS', JSON.stringify(cb));

  // score distribution buckets
  const sc = await sql`
    SELECT width_bucket(score, 0, 26, 13) AS b, min(score)::int AS lo, max(score)::int AS hi, count(*)::int AS n
    FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND score IS NOT NULL
    GROUP BY b ORDER BY b`;
  console.log('SCORE', JSON.stringify(sc));

  // range_pos quintile-ish (inversion quintile is NOT stored per-row; range_pos is the Range Kill col)
  const rp = await sql`
    SELECT round(range_pos_at_trigger::numeric, 1) AS bin, count(*)::int AS n
    FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND range_pos_at_trigger IS NOT NULL
    GROUP BY bin ORDER BY bin`;
  console.log('RANGEPOS', JSON.stringify(rp));
})();
