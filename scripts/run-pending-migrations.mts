#!/usr/bin/env node
/**
 * One-shot pending-migration runner.
 *
 * Production OWNER_SECRET is empty so POST /api/journal/init can't be
 * used; this script calls migrateDb() directly with DATABASE_URL from
 * .env.local. Idempotent (skips already-applied IDs via the
 * schema_migrations table).
 *
 * Usage: node --env-file=.env.local scripts/run-pending-migrations.mts
 *   (npm script: `npm run migrate`)
 */

import { migrateDb } from '../api/_lib/db.ts';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; load .env.local first.');
  process.exit(1);
}

console.log('Running pending migrations against', process.env.DATABASE_URL.split('@')[1]?.split('/')[0] ?? '(unknown host)');

const applied = await migrateDb();

if (applied.length === 0) {
  console.log('No pending migrations — DB is up to date.');
} else {
  console.log(`Applied ${applied.length} migration(s):`);
  for (const desc of applied) {
    // Truncate long descriptions for readability
    const truncated = desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
    console.log('  ✓', truncated);
  }
}
