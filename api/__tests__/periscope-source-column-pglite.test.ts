// @vitest-environment node

/**
 * REAL-SQL test for migration #194: periscope_snapshots gets a nullable
 * `source` column with no default, so rows written before it exist read NULL.
 * The table comes from replaying the REAL migration #140 on pglite; #194 then
 * runs on top of existing rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations.js';

async function sourceColumn(db: PGlite) {
  const r = await db.query<{
    is_nullable: string;
    column_default: string | null;
    data_type: string;
  }>(
    `SELECT is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_name = 'periscope_snapshots' AND column_name = 'source'`,
  );
  return r.rows;
}

describe('migration #194: periscope_snapshots.source (pglite)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await applyMigration(db, 140);
    await db.exec(`
      INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value)
      VALUES ('2026-05-01T14:00:00Z', '2026-05-01', 'gamma', 5000, 1.5);
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it('has no source column before the migration', async () => {
    expect(await sourceColumn(db)).toHaveLength(0);
  });

  it('adds a nullable TEXT column with no default', async () => {
    await applyMigration(db, 194);
    expect(await sourceColumn(db)).toEqual([
      { is_nullable: 'YES', column_default: null, data_type: 'text' },
    ]);
  });

  it('leaves existing rows NULL and is a no-op when re-run', async () => {
    await applyMigration(db, 194);
    await applyMigration(db, 194);
    const r = await db.query<{ source: string | null }>(
      'SELECT source FROM periscope_snapshots',
    );
    expect(r.rows).toEqual([{ source: null }]);
  });
});
