import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  for (const [label, q] of [
    [
      'direction_gated=true',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND direction_gated`,
    ],
    [
      'reload_tagged=true',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND reload_tagged`,
    ],
    [
      'cluster_bonus>=1',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND cluster_bonus >= 1`,
    ],
    [
      'takeit_prob not null',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND takeit_prob IS NOT NULL`,
    ],
    [
      'gamma_at_trigger not null',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND gamma_at_trigger IS NOT NULL`,
    ],
    [
      'spx_spot_gamma_oi not null',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND spx_spot_gamma_oi IS NOT NULL`,
    ],
    [
      'score not null',
      sql`SELECT min(date)::text a, max(date)::text b, count(*)::int n FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL AND score IS NOT NULL`,
    ],
  ] as const) {
    const r = (await q) as Record<string, unknown>[];
    console.log(label.padEnd(28), JSON.stringify(r[0]));
  }
})();
