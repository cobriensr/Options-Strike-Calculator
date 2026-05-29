/**
 * Probe: is gexbot_snapshots.zero_gamma 100% NULL because GEXBot doesn't
 * send the field, or because our extraction drops it? Inspects raw_response.
 * Read-only. Run: npx tsx scripts/_probe-gexbot-zerogamma.ts
 */
import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
type Row = Record<string, unknown>;

(async () => {
  const r = (await sql`
    SELECT ticker,
           raw_response ? 'zero_gamma'              AS has_key,
           raw_response->>'zero_gamma'              AS raw_zg,
           raw_response->>'spot'                    AS raw_spot,
           jsonb_typeof(raw_response->'zero_gamma') AS zg_type
    FROM gexbot_snapshots
    WHERE ticker IN ('SPX', 'SPY', 'ES_SPX')
    ORDER BY captured_at DESC
    LIMIT 6
  `) as Row[];
  for (const x of r) console.log(x);

  const k = (await sql`
    SELECT jsonb_object_keys(raw_response) AS k
    FROM (
      SELECT raw_response FROM gexbot_snapshots
      WHERE ticker = 'SPX' ORDER BY captured_at DESC LIMIT 1
    ) s
    ORDER BY k
  `) as Row[];
  console.log('\nSPX orderflow keys:', k.map((x) => x.k).join(', '));
})();
