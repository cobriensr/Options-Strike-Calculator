import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  // Replicate the floor-blind top-N reignition selection (cadence only).
  const r = (await sql`
    WITH ordered AS (
      SELECT underlying_symbol,strike,option_type,expiry,trigger_time_ct,takeit_prob,peak_ceiling_pct,
        EXTRACT(EPOCH FROM trigger_time_ct - LAG(trigger_time_ct) OVER w)/60.0 AS gap_min,
        ROW_NUMBER() OVER w AS fire_seq, COUNT(*) OVER wt AS fire_count
      FROM lottery_finder_fires
      WHERE date='2026-05-29'::date AND entry_price>=0.10
      WINDOW w AS (PARTITION BY underlying_symbol,strike,option_type,expiry ORDER BY trigger_time_ct ASC),
             wt AS (PARTITION BY underlying_symbol,strike,option_type,expiry)
    ),
    mg AS (SELECT DISTINCT ON (underlying_symbol,strike,option_type,expiry)
        underlying_symbol,strike,option_type,expiry, gap_min AS max_gap_min, fire_seq AS pgs
      FROM ordered WHERE gap_min IS NOT NULL
      ORDER BY underlying_symbol,strike,option_type,expiry, gap_min DESC),
    per_chain AS (SELECT o.underlying_symbol,o.strike,o.option_type,o.expiry,
        MAX(o.fire_count)::int AS fire_count, COALESCE(MAX(mg.max_gap_min),0)::numeric AS max_gap_min,
        COALESCE(MAX(o.fire_count)-(MAX(mg.pgs)-1),0)::int AS post_gap_fires,
        round(MAX(o.takeit_prob),3) AS chain_max_takeit, round(MAX(o.peak_ceiling_pct),0) AS peak
      FROM ordered o LEFT JOIN mg USING (underlying_symbol,strike,option_type,expiry)
      GROUP BY o.underlying_symbol,o.strike,o.option_type,o.expiry)
    SELECT underlying_symbol,strike,option_type,fire_count,max_gap_min,post_gap_fires,chain_max_takeit,peak,
      ROW_NUMBER() OVER (ORDER BY post_gap_fires DESC, fire_count DESC) AS rank
    FROM per_chain
    WHERE fire_count>=3 AND max_gap_min>=30 AND post_gap_fires>=2
    ORDER BY post_gap_fires DESC, fire_count DESC LIMIT 5
  `) as Record<string, unknown>[];
  console.log('Floor-blind Hot Right Now top-5 for 2026-05-29:');
  for (const c of r)
    console.log(
      `  #${c.rank} ${c.underlying_symbol} ${c.strike}${c.option_type}: fires=${c.fire_count} postgap=${c.post_gap_fires} chainMaxTakeit=${c.chain_max_takeit} peak=${c.peak}% ${Number(c.chain_max_takeit) < 0.7 ? '← BELOW 0.70 floor (main feed hides; Hot shows)' : ''}`,
    );
})();
