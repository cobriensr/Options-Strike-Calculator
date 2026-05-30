import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

async function cols(t: string) {
  const r =
    (await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=${t} ORDER BY ordinal_position`) as Record<
      string,
      unknown
    >[];
  console.log(`\n=== ${t} (${r.length} cols) ===`);
  for (const c of r) console.log(`  ${c.column_name} :: ${c.data_type}`);
}
(async () => {
  for (const t of [
    'ws_gex_strike_expiry',
    'periscope_snapshots',
    'gexbot_snapshots',
    'gexbot_api_capture',
    'index_candles_1m',
    'gex_strike_0dte',
  ]) {
    try {
      await cols(t);
    } catch (e) {
      console.log(`\n=== ${t}: ERR ${(e as Error).message}`);
    }
  }
})();
