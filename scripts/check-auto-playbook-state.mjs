/**
 * Audit script: verify the auto-playbook is alive end-to-end.
 *  1. Schema on periscope_analyses (post migration #142)
 *  2. Auto-generated row counts by date
 *  3. Mode + parent-chain integrity
 *  4. Latest playbook row contents (smoke check)
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const env = readFileSync(
  '/Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local',
  'utf8',
);
const m = env.match(/^DATABASE_URL="?([^"\n]+)"?/m);
const sql = neon(m[1]);

const cols = await sql`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'periscope_analyses'
  ORDER BY ordinal_position
`;
console.log('periscope_analyses schema:');
console.table(cols);

const counts = await sql`
  SELECT trading_date,
         COUNT(*) FILTER (WHERE auto_generated) AS auto_rows,
         COUNT(*) FILTER (WHERE NOT auto_generated) AS manual_rows,
         COUNT(DISTINCT slot_captured_at) FILTER (WHERE auto_generated) AS auto_slots
  FROM periscope_analyses
  WHERE created_at > NOW() - INTERVAL '7 days'
  GROUP BY 1
  ORDER BY 1 DESC
`;
console.log('\nLast 7d periscope_analyses (auto vs manual):');
console.table(counts);

const modeMix = await sql`
  SELECT mode, COUNT(*) AS rows
  FROM periscope_analyses
  WHERE auto_generated = TRUE
    AND created_at > NOW() - INTERVAL '7 days'
  GROUP BY 1
  ORDER BY 2 DESC
`;
console.log('\nMode distribution (auto only, last 7d):');
console.table(modeMix);

const latest = await sql`
  SELECT id,
         trading_date,
         slot_captured_at,
         mode,
         parent_id,
         auto_generated,
         length(panel_payload::text) AS payload_chars,
         length(prose_text) AS prose_chars,
         status,
         failure_reason,
         created_at
  FROM periscope_analyses
  ORDER BY created_at DESC
  LIMIT 5
`;
console.log('\nLatest 5 periscope_analyses rows:');
console.table(latest);

const orphans = await sql`
  SELECT a.id, a.trading_date, a.mode, a.parent_id
  FROM periscope_analyses a
  LEFT JOIN periscope_analyses p ON p.id = a.parent_id
  WHERE a.parent_id IS NOT NULL
    AND p.id IS NULL
  LIMIT 5
`;
console.log('\nParent-chain orphans (parent_id refs missing row):');
console.table(orphans);
