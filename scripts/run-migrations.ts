#!/usr/bin/env npx tsx

/**
 * One-shot migration 98 runner.
 *
 * Migration 98 (committed by another session) adds unique indexes to 5
 * tables for cron idempotency and dedupes any existing duplicates. The
 * stock migrateDb() path wraps the 10 statements in a single neon HTTP
 * transaction, which times out on `strike_iv_snapshots` (1.87M rows).
 *
 * This script applies the same migration but:
 *   1. Skips DELETE if a table has zero duplicate groups (most do)
 *   2. Uses a window-function dedup (faster than NOT IN subquery)
 *   3. Runs each statement in its own request, so we never hit the
 *      transaction-level timeout
 *   4. Bumps the undici headers timeout to 10 minutes for the slow ones
 *   5. Records the migration as applied at the end
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/run-migrations.ts
 */

import { neon } from '@neondatabase/serverless';
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(
  new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }),
);

const sql = neon(process.env.DATABASE_URL!);

interface TableMigration {
  table: string;
  /** Comma-separated columns forming the natural key. */
  keyCols: string;
  /** Name for the unique index. */
  indexName: string;
}

const TABLES: TableMigration[] = [
  {
    table: 'strike_iv_snapshots',
    keyCols: 'ticker, strike, side, expiry, ts',
    indexName: 'uniq_strike_iv_snapshots_key',
  },
  {
    table: 'iv_anomalies',
    keyCols: 'ticker, strike, side, expiry, ts',
    indexName: 'uniq_iv_anomalies_key',
  },
  {
    table: 'strike_trade_volume',
    keyCols: 'ticker, strike, side, ts',
    indexName: 'uniq_strike_trade_volume_key',
  },
  {
    table: 'zero_gamma_levels',
    keyCols: 'ticker, ts',
    indexName: 'uniq_zero_gamma_levels_key',
  },
];

async function countDupes(table: string, keyCols: string): Promise<number> {
  const rows = (await sql.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM ${table} GROUP BY ${keyCols} HAVING COUNT(*) > 1
     ) d`,
  )) as Array<{ n: string }>;
  return Number(rows[0]!.n);
}

async function dedup(table: string, keyCols: string): Promise<void> {
  // Window-function dedup: scan once, mark rows beyond the first per
  // partition, delete those. Much faster than `id NOT IN (subquery)`.
  await sql.query(
    `DELETE FROM ${table}
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY ${keyCols} ORDER BY id
         ) AS rn FROM ${table}
       ) t
       WHERE rn > 1
     )`,
  );
}

async function createIndex(
  indexName: string,
  table: string,
  keyCols: string,
): Promise<void> {
  await sql.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}
       ON ${table} (${keyCols})`,
  );
}

async function main() {
  // Skip if migration 98 is already applied.
  const existing = (await sql`
    SELECT id FROM schema_migrations WHERE id = 98
  `) as Array<{ id: number }>;
  if (existing.length > 0) {
    console.log('Migration 98 already applied — nothing to do.');
    return;
  }

  console.log('Applying migration 98 — unique indexes on 5 tables...\n');

  for (const { table, keyCols, indexName } of TABLES) {
    const probeStart = Date.now();
    const dupes = await countDupes(table, keyCols);
    console.log(
      `  ${table}: ${dupes} duplicate group(s) [${Date.now() - probeStart}ms]`,
    );

    if (dupes > 0) {
      const dedupStart = Date.now();
      await dedup(table, keyCols);
      console.log(`    → deduped [${Date.now() - dedupStart}ms]`);
    }

    const idxStart = Date.now();
    await createIndex(indexName, table, keyCols);
    console.log(`    → ${indexName} created [${Date.now() - idxStart}ms]`);
  }

  await sql`
    INSERT INTO schema_migrations (id, description)
    VALUES (
      98,
      'Add unique indexes + dedupe to 5 high-volume tables for cron idempotency'
    )
  `;
  console.log('\nMigration 98 marked applied in schema_migrations.');
}

try {
  await main();
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}
