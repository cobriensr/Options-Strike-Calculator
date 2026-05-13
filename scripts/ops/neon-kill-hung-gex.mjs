// Terminate hung getTimestampsForDay backends on Neon. The /api/gex-strike-expiry
// endpoint had no dedup before commit 16a2cca2 — polling fan-out (multiple tabs ×
// 4 tickers × 30s cadence) stacked ~188 concurrent backends, all running the
// same SELECT DISTINCT ts_minute query, all blocked on Neon/FileCache_Write or
// BufferIo. They each hold a connection slot for the full 5-min function timeout.
//
// Killing them unjams Neon immediately; the new endpoint cache prevents
// new backends from joining the queue.
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
);
const sql = neon(env.DATABASE_URL);

const dryRun = process.argv.includes('--dry-run');

// Target: queries whose head matches the ws_gex_strike_expiry DISTINCT
// ts_minute pattern AND have been running > 30 seconds. Only terminate
// (SIGTERM) not cancel — Neon backends ignore pg_cancel_backend()
// on FileCache_Write waits in older versions; pg_terminate_backend() is
// the reliable signal.
const candidates = await sql`
  SELECT pid,
         EXTRACT(EPOCH FROM (NOW() - query_start))::int AS secs,
         wait_event_type, wait_event
  FROM pg_stat_activity
  WHERE state = 'active'
    AND query LIKE '%ws_gex_strike_expiry%'
    AND query LIKE '%DISTINCT ts_minute%'
    AND EXTRACT(EPOCH FROM (NOW() - query_start)) > 30
  ORDER BY query_start ASC
`;

console.log(`found ${candidates.length} hung backends > 30s`);
if (candidates.length === 0) {
  process.exit(0);
}

if (dryRun) {
  for (const c of candidates) console.log(c);
  console.log('dry-run — no terminates issued');
  process.exit(0);
}

let killed = 0;
for (const c of candidates) {
  try {
    const result = await sql`SELECT pg_terminate_backend(${c.pid}) AS ok`;
    if (result[0].ok) killed += 1;
  } catch (e) {
    console.log(`failed pid ${c.pid}: ${e.message}`);
  }
}
console.log(`terminated ${killed} / ${candidates.length}`);
process.exit(0);
