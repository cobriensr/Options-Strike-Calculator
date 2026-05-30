import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  // All SNDK chains today with reignite metrics + chain_max_takeit
  const r = (await sql`
    WITH ordered AS (
      SELECT underlying_symbol, strike, option_type, expiry, trigger_time_ct, entry_price, takeit_prob, peak_ceiling_pct,
        EXTRACT(EPOCH FROM trigger_time_ct - LAG(trigger_time_ct) OVER w)/60.0 AS gap_min,
        ROW_NUMBER() OVER w AS fire_seq,
        COUNT(*) OVER wt AS fire_count
      FROM lottery_finder_fires
      WHERE date='2026-05-29'::date AND underlying_symbol='SNDK' AND entry_price>=0.10
      WINDOW w AS (PARTITION BY underlying_symbol,strike,option_type,expiry ORDER BY trigger_time_ct ASC),
             wt AS (PARTITION BY underlying_symbol,strike,option_type,expiry)
    ),
    mg AS (
      SELECT DISTINCT ON (underlying_symbol,strike,option_type,expiry)
        underlying_symbol,strike,option_type,expiry, gap_min AS max_gap_min, fire_seq AS post_gap_start_seq
      FROM ordered WHERE gap_min IS NOT NULL
      ORDER BY underlying_symbol,strike,option_type,expiry, gap_min DESC
    )
    SELECT o.strike, o.option_type,
      MAX(o.fire_count)::int AS fire_count,
      COALESCE(MAX(mg.max_gap_min),0)::numeric(10,1) AS max_gap_min,
      COALESCE(MAX(o.fire_count)-(MAX(mg.post_gap_start_seq)-1),0)::int AS post_gap_fires,
      round(MAX(o.takeit_prob),3) AS chain_max_takeit,
      round(MIN(o.entry_price),2) AS min_entry,
      round(MAX(o.peak_ceiling_pct),0) AS max_peak_pct
    FROM ordered o LEFT JOIN mg USING (underlying_symbol,strike,option_type,expiry)
    GROUP BY o.strike,o.option_type
    HAVING MAX(o.fire_count) >= 3
    ORDER BY post_gap_fires DESC, fire_count DESC
  `) as Record<string, unknown>[];
  console.log(
    'SNDK chains today (>=3 fires), sorted as reignition would rank them:',
  );
  for (const c of r) {
    const reignitEligible =
      Number(c.fire_count) >= 3 &&
      Number(c.max_gap_min) >= 30 &&
      Number(c.post_gap_fires) >= 2;
    const passesTakeit =
      c.chain_max_takeit != null && Number(c.chain_max_takeit) >= 0.7;
    console.log(
      `SNDK ${c.strike}${c.option_type}: fires=${c.fire_count} gap=${c.max_gap_min}m postgap=${c.post_gap_fires} chainMaxTakeit=${c.chain_max_takeit} minEntry=$${c.min_entry} peak=${c.max_peak_pct}% | reignitEligible=${reignitEligible} passesTakeit0.70=${passesTakeit}`,
    );
  }
})();
