import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

// Replicate the endpoint's chain-max gate at each chip setting.
async function visibleSNDK1670C(floor: number | null) {
  const r = (await sql`
    WITH filtered AS (
      SELECT underlying_symbol, strike, option_type,
        ROW_NUMBER() OVER (PARTITION BY underlying_symbol,strike,option_type,expiry
          ORDER BY trigger_time_ct DESC, id DESC) AS rn,
        MAX(takeit_prob) OVER (PARTITION BY underlying_symbol,strike,option_type,expiry) AS cmax
      FROM lottery_finder_fires
      WHERE date='2026-05-29'::date AND entry_price >= 0.10)
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE underlying_symbol='SNDK' AND strike=1670 AND option_type='C')::int AS has_sndk_1670c
    FROM filtered
    WHERE rn=1 AND (${floor}::numeric IS NULL OR cmax >= ${floor}::numeric)
  `) as Record<string, unknown>[];
  return r[0];
}

(async () => {
  // Mirror useLotteryFinder: chip "off" (0) sends NO param → server floor null.
  for (const [label, floor] of [
    ['off (chip=0 → no param)', null],
    ['0.60', 0.6],
    ['0.70 (default)', 0.7],
  ] as const) {
    const r = await visibleSNDK1670C(floor as number | null);
    console.log(
      `chip=${label}: ${r.total} chains visible | SNDK 1670C present: ${Number(r.has_sndk_1670c) > 0 ? 'YES ✅' : 'no'}`,
    );
  }
})();
