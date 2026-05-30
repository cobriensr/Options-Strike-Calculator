import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const showAll = false;
  const minTakeit = 0.7;
  const r = (await sql`
    WITH ranked AS (
      SELECT underlying_symbol, strike, option_type, expiry, takeit_prob,
        ROW_NUMBER() OVER (PARTITION BY underlying_symbol, strike, option_type, expiry
          ORDER BY trigger_time_ct DESC, id DESC) AS rn,
        COUNT(*) OVER (PARTITION BY underlying_symbol, strike, option_type, expiry)::int AS fc,
        MAX(takeit_prob) OVER (PARTITION BY underlying_symbol, strike, option_type, expiry) AS chain_max_takeit
      FROM lottery_finder_fires
      WHERE date = '2026-05-29'::date AND entry_price >= 0.10
    )
    SELECT
      COUNT(*) FILTER (WHERE ${showAll}::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2)::int AS total,
      COUNT(*) FILTER (WHERE NOT (${showAll}::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2))::int AS suppressed
    FROM ranked
    LEFT JOIN lottery_ticker_stats s ON s.ticker = ranked.underlying_symbol
    WHERE rn = 1
      AND (${minTakeit}::numeric IS NULL OR chain_max_takeit >= ${minTakeit}::numeric)
  `) as Record<string, unknown>[];
  console.log(
    'Phase 2 count (2026-05-29, default 0.70 floor):',
    JSON.stringify(r[0]),
  );
})();
