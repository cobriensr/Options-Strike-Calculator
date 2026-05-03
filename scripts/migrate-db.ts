#!/usr/bin/env npx tsx

/**
 * Local migrate-db runner. Calls api/_lib/db.ts `migrateDb()` against
 * whatever Neon DB DATABASE_URL points at and prints the list of
 * newly applied migrations.
 *
 * Vercel runs this same path automatically on every deploy via
 * api/journal/init (init→migrate). This script lets you ship the
 * schema ahead of a deploy — useful when a follow-up local script
 * (e.g. scripts/backfill-lottery-fires.mjs) needs the table to exist
 * before the next deploy lands.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrate-db.ts
 */

import { setGlobalDispatcher, Agent } from 'undici';
import { migrateDb } from '../api/_lib/db.js';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

// Some migrations run heavy DDL or DELETEs that exceed the default
// 30s undici header timeout — bump to 10 minutes so re-runs against
// large tables don't abort mid-statement.
setGlobalDispatcher(
  new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }),
);

const start = Date.now();
console.log('Running migrateDb()...');
const applied = await migrateDb();
const seconds = ((Date.now() - start) / 1000).toFixed(1);

console.log('');
console.log(`Done in ${seconds}s. ${applied.length} migration(s) applied:`);
for (const m of applied) {
  console.log(`  ${m}`);
}
if (applied.length === 0) {
  console.log('  (DB was already up to date)');
}
