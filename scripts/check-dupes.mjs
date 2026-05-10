import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

// Parse DATABASE_URL out of .env.local without sourcing the whole file
const env = readFileSync(
  '/Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local',
  'utf8',
);
const m = env.match(/^DATABASE_URL="?([^"\n]+)"?/m);
if (!m) {
  console.error('DATABASE_URL not found');
  process.exit(1);
}
const sql = neon(m[1]);

const days = await sql`
  SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS day,
         COUNT(DISTINCT captured_at) AS slots,
         COUNT(*) AS rows
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date IN ('2026-05-07', '2026-05-08')
  GROUP BY 1 ORDER BY 1 DESC
`;
console.log('Per-day:');
console.table(days);

// Schema first so subsequent queries are correct
const cols = await sql`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'periscope_snapshots'
  ORDER BY ordinal_position
`;
console.log('\nColumns:');
console.table(cols);

const slots = await sql`
  SELECT captured_at,
         COUNT(*) AS rows
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date = '2026-05-08'
  GROUP BY 1 ORDER BY 1
`;
console.log(`\nPer-slot (2026-05-08, ALL ${slots.length} slots):`);
console.table(
  slots.map((r) => ({
    captured_at_ct: new Date(r.captured_at).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
    }),
    rows: r.rows,
  })),
);

// Within-RTH slots only (8:30-15:00 CT). On a clean day this should be 40.
const rthCounts = await sql`
  SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS day,
         COUNT(DISTINCT captured_at) AS rth_slots
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date IN ('2026-05-07', '2026-05-08')
    AND (captured_at AT TIME ZONE 'America/Chicago')::time >= '08:30'
    AND (captured_at AT TIME ZONE 'America/Chicago')::time <= '15:00'
  GROUP BY 1 ORDER BY 1 DESC
`;
console.log('\nRTH-only slot counts (8:30-15:00 CT):');
console.table(rthCounts);

// Count of slots OUTSIDE RTH (the "extras")
const offRth = await sql`
  SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS day,
         COUNT(DISTINCT captured_at) AS off_rth_slots,
         COUNT(*) AS off_rth_rows
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date IN ('2026-05-07', '2026-05-08')
    AND ((captured_at AT TIME ZONE 'America/Chicago')::time < '08:30'
      OR (captured_at AT TIME ZONE 'America/Chicago')::time > '15:00')
  GROUP BY 1 ORDER BY 1 DESC
`;
console.log('\nOff-RTH slot counts (the extras):');
console.table(offRth);

// Check: are off-RTH rows on OTHER days too, or just these two?
const offRthAll = await sql`
  SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS day,
         COUNT(DISTINCT captured_at) AS off_rth_slots
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::time < '08:30'
     OR (captured_at AT TIME ZONE 'America/Chicago')::time > '15:00'
  GROUP BY 1 HAVING COUNT(DISTINCT captured_at) > 0
  ORDER BY 1 DESC
  LIMIT 20
`;
console.log('\nDays with ANY off-RTH slots (top 20 most recent):');
console.table(offRthAll);
