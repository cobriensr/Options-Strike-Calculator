import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
(async () => {
  const cols = (await sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'lottery_finder_fires' ORDER BY ordinal_position
  `) as Record<string, unknown>[];
  console.log('=== lottery_finder_fires columns ===');
  console.log(cols.map((c) => `${c.column_name}:${c.data_type}`).join('\n'));
  console.log('\n=== lottery_ticker_stats columns ===');
  const ts = (await sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'lottery_ticker_stats' ORDER BY ordinal_position
  `) as Record<string, unknown>[];
  console.log(ts.map((c) => `${c.column_name}:${c.data_type}`).join('\n'));
})();
