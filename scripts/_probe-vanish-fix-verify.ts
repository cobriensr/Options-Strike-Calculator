import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

(async () => {
  const minTakeit = 0.7;
  // Mirror the chronological branch's new chain-max gating.
  const rows = (await sql`
    WITH filtered AS (
      SELECT f.*,
        COUNT(*) OVER (PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry)::int AS fire_count,
        ROW_NUMBER() OVER (
          PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
          ORDER BY f.trigger_time_ct DESC, f.id DESC) AS rn,
        MAX(f.takeit_prob) OVER (PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry) AS chain_max_takeit,
        FIRST_VALUE(f.trigger_time_ct) OVER (
          PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
          ORDER BY f.takeit_prob DESC NULLS LAST, f.trigger_time_ct ASC) AS peak_takeit_at
      FROM lottery_finder_fires f
      WHERE f.date = '2026-05-29'::date
        AND f.underlying_symbol = 'TSLA' AND f.strike = 435
        AND f.entry_price >= 0.10
    )
    SELECT option_type,
      to_char(trigger_time_ct AT TIME ZONE 'America/Chicago','HH24:MI') AS latest_ct,
      takeit_prob AS latest_takeit,
      round(chain_max_takeit,4) AS chain_max_takeit,
      to_char(peak_takeit_at AT TIME ZONE 'America/Chicago','HH24:MI') AS peak_at,
      fire_count
    FROM filtered
    WHERE rn = 1
      AND (${minTakeit}::numeric IS NULL OR chain_max_takeit >= ${minTakeit}::numeric)
    ORDER BY option_type
  `) as Record<string, unknown>[];
  console.log(
    '=== TSLA 435 chains returned under default 0.70 floor (NEW gating) ===',
  );
  console.log(JSON.stringify(rows, null, 2));
  console.log(
    rows.length === 2
      ? '\n✅ BOTH 435C and 435P now survive — vanish fixed.'
      : `\n❌ expected 2 chains, got ${rows.length}`,
  );
})();
