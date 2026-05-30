import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

(async () => {
  const fires = (await sql`
    SELECT id, option_type, strike,
           to_char(trigger_time_ct AT TIME ZONE 'America/Chicago','HH24:MI') AS ct,
           takeit_prob, entry_price, score, combined_score, direction_gated
    FROM lottery_finder_fires
    WHERE underlying_symbol = 'TSLA' AND strike = 435
      AND date = '2026-05-29'
    ORDER BY trigger_time_ct
  `) as Record<string, unknown>[];

  console.log(`=== TSLA 435 fires today: ${fires.length} ===`);
  for (const f of fires) {
    const tp = f.takeit_prob == null ? null : Number(f.takeit_prob);
    console.log(
      `${f.ct} CT  ${f.option_type}  takeit=${tp}  ` +
        `pass0.70=${tp != null && tp >= 0.7}  entry=${f.entry_price}  ` +
        `score=${f.score} combined=${f.combined_score} gated=${f.direction_gated} id=${f.id}`,
    );
  }

  // Representative = latest fire per (strike,type) — what the feed tests
  const byType = new Map<string, Record<string, unknown>[]>();
  for (const f of fires) {
    const k = String(f.option_type);
    (byType.get(k) ?? byType.set(k, []).get(k)!).push(f);
  }
  console.log(
    '\n=== representative (latest) fire the default filter tests ===',
  );
  for (const [t, list] of byType) {
    const latest = list[list.length - 1];
    const tp = latest.takeit_prob == null ? null : Number(latest.takeit_prob);
    const anyAbove = list.some(
      (f) => f.takeit_prob != null && Number(f.takeit_prob) >= 0.7,
    );
    console.log(
      `TSLA 435${t}: latest@${latest.ct} takeit=${tp} ` +
        `=> chain VISIBLE_under_default=${tp != null && tp >= 0.7}; ` +
        `but some-earlier-fire-was-above-0.70=${anyAbove}`,
    );
  }
})();
