#!/usr/bin/env node
/**
 * One-shot pending-migration runner.
 *
 * Production OWNER_SECRET is empty so POST /api/journal/init can't be
 * used; this script calls migrateDb() directly with DATABASE_URL from
 * .env.local. Idempotent (skips already-applied IDs via the
 * schema_migrations table).
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-pending-migrations.mts
 *   node --env-file=.env.local scripts/run-pending-migrations.mts --yes
 *   (npm script: `npm run migrate`)
 *
 * By default the script prints the target host and waits 5 seconds for
 * Ctrl-C — protects against accidentally pointing at prod when
 * .env.local was meant to load a staging/preview branch. Pass `--yes`
 * (or `-y`) to skip the wait, suitable for CI / automated callers.
 */

import { migrateDb } from '../api/_lib/db.ts';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; load .env.local first.');
  process.exit(1);
}

const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

const host =
  process.env.DATABASE_URL.split('@')[1]?.split('/')[0] ?? '(unknown host)';
console.log('Running pending migrations against', host);

if (!skipConfirm) {
  const waitSec = 5;
  console.log(
    `  → applying in ${waitSec}s; Ctrl-C to abort (use --yes to skip wait)`,
  );
  await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
}

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
