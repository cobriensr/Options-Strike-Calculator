// @vitest-environment node

/**
 * REAL-SQL test for migration #200: drop es_overnight_summaries and
 * es_bars.
 *
 * The tables come from the REAL migrations #12 and #13, and futures_bars
 * from #42, which copied es_bars into it. #200 runs in one transaction, as
 * migrateDb() runs it, and must leave futures_bars and its rows intact:
 * the #42 copy is data only, not a dependency. The drops carry no CASCADE,
 * so an object that depends on either table fails the migration and rolls
 * it back with both tables in place. Each test gets a fresh PGlite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations.js';

async function runInTransaction(pg: PGlite): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, 200);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

async function tableExists(pg: PGlite, table: string): Promise<boolean> {
  const { rows } = await pg.query<{ oid: string | null }>(
    'SELECT to_regclass($1)::text AS oid',
    [table],
  );
  return rows[0]?.oid != null;
}

describe('migration #200 (drop es_overnight_summaries and es_bars)', () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigration(pg, 12);
    await applyMigration(pg, 13);
    await pg.exec(
      `INSERT INTO es_bars (ts, open, high, low, close, volume)
       VALUES ('2026-09-28 13:30:00+00', 5700, 5701, 5699, 5700.5, 10)`,
    );
    await applyMigration(pg, 42);
  });

  afterEach(async () => {
    await pg.close();
  });

  it('starts with both tables and the copied ES bar in futures_bars', async () => {
    expect(await tableExists(pg, 'es_bars')).toBe(true);
    expect(await tableExists(pg, 'es_overnight_summaries')).toBe(true);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM futures_bars WHERE symbol = 'ES'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('drops both tables and keeps futures_bars, its rows and its index', async () => {
    await runInTransaction(pg);

    expect(await tableExists(pg, 'es_bars')).toBe(false);
    expect(await tableExists(pg, 'es_overnight_summaries')).toBe(false);
    expect(await tableExists(pg, 'futures_bars')).toBe(true);

    const { rows } = await pg.query<{ close: string }>(
      `SELECT close::text AS close FROM futures_bars WHERE symbol = 'ES'`,
    );
    expect(rows).toEqual([{ close: '5700.5000' }]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'futures_bars'`,
    );
    expect(idx.rows.map((r) => r.indexname)).toContain(
      'idx_futures_bars_symbol_ts',
    );
  });

  it('is a no-op when the tables are already gone', async () => {
    await runInTransaction(pg);
    await expect(runInTransaction(pg)).resolves.toBeUndefined();
    expect(await tableExists(pg, 'futures_bars')).toBe(true);
  });

  it('fails closed and keeps both tables when another object depends on one', async () => {
    await pg.exec('CREATE VIEW es_bars_dep AS SELECT ts FROM es_bars');
    await expect(runInTransaction(pg)).rejects.toThrow(
      /other objects depend on it/,
    );
    // es_overnight_summaries drops first, so it proves the rollback.
    expect(await tableExists(pg, 'es_overnight_summaries')).toBe(true);
    expect(await tableExists(pg, 'es_bars')).toBe(true);
  });
});
