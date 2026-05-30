import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const CUT = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
async function vis(date: string, cut: string, repGate: boolean) {
  const rows = (await sql`
    WITH filtered AS (
      SELECT underlying_symbol,strike,option_type,expiry,takeit_prob,
        ROW_NUMBER() OVER (PARTITION BY underlying_symbol,strike,option_type,expiry ORDER BY trigger_time_ct DESC, id DESC) AS rn,
        MAX(takeit_prob) OVER (PARTITION BY underlying_symbol,strike,option_type,expiry) AS cmax
      FROM lottery_finder_fires
      WHERE date=${date}::date
        AND (trigger_time_ct AT TIME ZONE 'America/Chicago') < (${`${date} ${cut}`}::timestamp)
        AND entry_price >= 0.10)
    SELECT underlying_symbol,strike,option_type,expiry FROM filtered
    WHERE rn=1 AND (${repGate} AND takeit_prob >= 0.70 OR NOT ${repGate} AND cmax >= 0.70)
  `) as Record<string, unknown>[];
  return new Set(
    rows.map((r) => `${r.underlying_symbol} ${r.strike}${r.option_type}`),
  );
}
(async () => {
  for (const repGate of [true, false]) {
    let prev = new Set<string>();
    let vanishes = 0;
    for (const c of CUT) {
      const v = await vis('2026-05-29', c, repGate);
      for (const x of prev) if (!v.has(x)) vanishes++;
      prev = new Set([...prev, ...v]);
    }
    console.log(
      `${repGate ? 'OLD per-rep gate' : 'NEW chain-max gate'}: ${vanishes} vanish events`,
    );
  }
})();
