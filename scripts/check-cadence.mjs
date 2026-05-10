import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const env = readFileSync(
  '/Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local',
  'utf8',
);
const m = env.match(/^DATABASE_URL="?([^"\n]+)"?/m);
const sql = neon(m[1]);

// Distribution of seconds-component for RTH slots, recent days
const cadence = await sql`
  SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS day,
         CASE WHEN EXTRACT(SECOND FROM captured_at)::int = 0 THEN ':00 cadence (backfill)'
              WHEN EXTRACT(SECOND FROM captured_at)::int BETWEEN 45 AND 50 THEN ':48 cadence (live)'
              ELSE 'other'
         END AS cadence_kind,
         COUNT(DISTINCT captured_at) AS slots
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date BETWEEN '2026-04-20' AND '2026-05-08'
    AND (captured_at AT TIME ZONE 'America/Chicago')::time BETWEEN '08:30' AND '15:00'
  GROUP BY 1, 2
  ORDER BY 1 DESC, 3 DESC
`;
console.table(cadence);
