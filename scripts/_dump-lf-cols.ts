import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'lottery_finder_fires'
    ORDER BY ordinal_position`;
  for (const c of cols as Record<string, unknown>[])
    console.log(`${c.column_name}\t${c.data_type}`);
  console.log('--- ROW COUNT ---');
  const cnt =
    await sql`SELECT count(*)::int AS n, count(peak_ceiling_pct)::int AS n_peak,
    min(date)::text AS mind, max(date)::text AS maxd FROM lottery_finder_fires`;
  console.log(JSON.stringify((cnt as Record<string, unknown>[])[0]));
})();
