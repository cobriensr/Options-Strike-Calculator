import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  for (const t of ['lottery_finder_fires', 'silent_boom_alerts']) {
    const cols = (await sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = ${t} ORDER BY ordinal_position
    `) as unknown as { column_name: string; data_type: string }[];
    console.log(`\n=== ${t} (${cols.length} cols) ===`);
    console.log(cols.map((c) => `${c.column_name}:${c.data_type}`).join('\n'));
  }
})();
