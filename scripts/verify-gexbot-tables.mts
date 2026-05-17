#!/usr/bin/env node
/**
 * Sanity check post-migration: confirms gexbot_* tables exist with
 * the expected column counts + indexes. Read-only.
 */

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

const tables = [
  'gexbot_snapshots',
  'gexbot_api_capture',
  'gexbot_archive_audit',
];

for (const table of tables) {
  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = ${table}
    ORDER BY ordinal_position
  `;
  const idx = await sql`
    SELECT indexname FROM pg_indexes WHERE tablename = ${table} ORDER BY indexname
  `;
  console.log(`\n${table}: ${cols.length} columns, ${idx.length} indexes`);
  console.log(
    '  indexes:',
    (idx as { indexname: string }[]).map((r) => r.indexname).join(', '),
  );
}

const audit =
  await sql`SELECT id, description FROM schema_migrations WHERE id = 156`;
console.log(
  '\nschema_migrations row for #156:',
  audit[0] ? '✓ present' : '✗ MISSING',
);
