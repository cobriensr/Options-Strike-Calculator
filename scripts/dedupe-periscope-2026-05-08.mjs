/**
 * One-shot cleanup: 2026-05-08 captured 8 redundant near-duplicate
 * slots inside RTH because the live ticker switched cadence from
 * `:00` → `:48` mid-day (9:30 AM → 10:30 AM CT transition window).
 * Each 10-min bucket from 9:30 → 10:30 has both a `:00` capture and
 * a `:XX` capture; from 10:40 onward only the `:48` capture remains.
 *
 * Convention: keep the slot whose seconds component is closest to 0
 * (matches the rest of the historical archive's `:00` cadence). Drop
 * the offset partner.
 *
 * Path C from the diagnostic discussion — does NOT touch off-RTH
 * pre-market slots (those are valid Periscope captures that may feed
 * future overnight analysis).
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

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

// Find the redundant slots via SQL — anything inside RTH whose seconds
// component is NOT 0, AND a partner with seconds=0 exists in the same
// 10-min bucket on the same day. Safer than hand-coding UTC strings.
const targets = await sql`
  WITH rth AS (
    SELECT captured_at,
           date_trunc('minute', captured_at)::timestamptz
             - (EXTRACT(MINUTE FROM captured_at)::int % 10) * INTERVAL '1 minute'
             AS bucket_start,
           EXTRACT(SECOND FROM captured_at)::int AS sec
    FROM periscope_snapshots
    WHERE (captured_at AT TIME ZONE 'America/Chicago')::date = '2026-05-08'
      AND (captured_at AT TIME ZONE 'America/Chicago')::time
          BETWEEN '08:30:00' AND '15:00:00'
    GROUP BY captured_at
  ),
  bucket_has_zero AS (
    SELECT bucket_start
    FROM rth
    WHERE sec = 0
  )
  SELECT r.captured_at
  FROM rth r
  JOIN bucket_has_zero z ON z.bucket_start = r.bucket_start
  WHERE r.sec <> 0
  ORDER BY r.captured_at
`;

console.log('Targets to drop (CT):');
console.table(
  targets.map((r) => ({
    captured_at_ct: new Date(r.captured_at).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour12: false,
    }),
    iso: new Date(r.captured_at).toISOString(),
  })),
);

if (targets.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const targetIsos = targets.map((r) => new Date(r.captured_at).toISOString());

// Pre-flight row counts
const preflight = await sql`
  SELECT COUNT(*) AS rows
  FROM periscope_snapshots
  WHERE captured_at = ANY(${targetIsos}::timestamptz[])
`;
console.log(`\nRows in target slots: ${preflight[0].rows}`);

// DELETE
const deleted = await sql`
  DELETE FROM periscope_snapshots
  WHERE captured_at = ANY(${targetIsos}::timestamptz[])
  RETURNING 1
`;
console.log(`Rows deleted: ${deleted.length}`);

// Post-flight
const after = await sql`
  SELECT COUNT(DISTINCT captured_at) AS rth_slots
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date = '2026-05-08'
    AND (captured_at AT TIME ZONE 'America/Chicago')::time
        BETWEEN '08:30:00' AND '15:00:00'
`;
console.log(`\nRTH slots on 2026-05-08 after cleanup: ${after[0].rth_slots}`);

const allDay = await sql`
  SELECT COUNT(DISTINCT captured_at) AS slots, COUNT(*) AS rows
  FROM periscope_snapshots
  WHERE (captured_at AT TIME ZONE 'America/Chicago')::date = '2026-05-08'
`;
console.log(
  `All slots on 2026-05-08 (incl. pre-market): ${allDay[0].slots} (${allDay[0].rows} rows)`,
);
