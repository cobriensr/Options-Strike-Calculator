// @vitest-environment node

/**
 * REAL-SQL test for migration #192: gexbot_api_capture gets its duplicate
 * rows deleted (lowest id kept per (ticker, endpoint, category,
 * source_timestamp)) and a partial unique index on that key, so
 * insertCaptureRows can use a bare ON CONFLICT DO NOTHING.
 *
 * The table comes from replaying the REAL migration #156 on pglite (real
 * Postgres in WASM); #192 then runs in one transaction, as migrateDb() runs
 * it. The mocked-DB tests can only see the SQL text; this one runs it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS, type Migration } from '../_lib/db-migrations.js';
import { applyMigration } from './pglite-migrations.js';

type NeonSql = Parameters<NonNullable<Migration['statements']>>[0];

interface PgQuery extends PromiseLike<unknown[]> {
  readonly text: string;
  readonly params: unknown[];
}

/** The slice of the neon client a `statements` migration uses, on pglite. */
function pgSql(db: PGlite) {
  const tag = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
    const query: PgQuery = {
      text,
      params,
      then: (onFulfilled, onRejected) =>
        db
          .query(text, params)
          .then((r) => r.rows)
          .then(onFulfilled, onRejected),
    };
    return query;
  };
  return Object.assign(tag, {
    transaction: (queries: PgQuery[]) =>
      db.transaction(async (tx) => {
        for (const q of queries) await tx.query(q.text, q.params);
      }),
  });
}

function statements192(sql: ReturnType<typeof pgSql>): PgQuery[] {
  const m = MIGRATIONS.find((x) => x.id === 192);
  if (!m?.statements) throw new Error('migration #192 has no statements');
  return m.statements(sql as unknown as NeonSql) as unknown as PgQuery[];
}

const CAPTURE_COLS =
  'ticker, endpoint, category, source_timestamp, raw_response';

async function ids(db: PGlite): Promise<number[]> {
  const r = await db.query<{ id: number }>(
    'SELECT id FROM gexbot_api_capture ORDER BY id',
  );
  return r.rows.map((x) => Number(x.id));
}

/** The UNNEST form insertCaptureRows uses, minus withDbRetry. */
async function unnestInsert(
  db: PGlite,
  rows: Array<[string, string, string, number | null]>,
): Promise<number> {
  const r = await db.query(
    `INSERT INTO gexbot_api_capture (${CAPTURE_COLS})
     SELECT t.ticker, t.endpoint, t.category, t.source_timestamp,
            t.raw_response::jsonb
     FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[])
       AS t(ticker, endpoint, category, source_timestamp, raw_response)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [
      rows.map((x) => x[0]),
      rows.map((x) => x[1]),
      rows.map((x) => x[2]),
      rows.map((x) => x[3]),
      rows.map(() => '{}'),
    ],
  );
  return r.rows.length;
}

describe('migration #192: gexbot_api_capture natural key (pglite)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await applyMigration(db, 156);
    // ids 1-3: a 3-row duplicate group; 4-6: same timestamp under another
    // category / endpoint / ticker (distinct keys); 7-8: a NULL pair;
    // 9: singleton.
    await db.exec(`
      INSERT INTO gexbot_api_capture (${CAPTURE_COLS}) VALUES
        ('SPX','state','gamma_zero',100,'{}'),
        ('SPX','state','gamma_zero',100,'{}'),
        ('SPX','state','gamma_zero',100,'{}'),
        ('SPX','state','charm_zero',100,'{}'),
        ('SPX','classic','gamma_zero',100,'{}'),
        ('VIX','state','gamma_zero',100,'{}'),
        ('SPX','state','gamma_zero',NULL,'{}'),
        ('SPX','state','gamma_zero',NULL,'{}'),
        ('SPX','state','gamma_zero',200,'{}');
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  const migrate = (sql = pgSql(db)) => sql.transaction(statements192(sql));

  it('keeps the lowest id per key and leaves the NULL pair and distinct keys alone', async () => {
    await migrate();
    expect(await ids(db)).toEqual([1, 4, 5, 6, 7, 8, 9]);
  });

  it('creates the partial unique index and is a no-op when re-run', async () => {
    await migrate();
    await migrate();
    const idx = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'gexbot_api_capture_natural_key'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(idx.rows[0]?.indexdef).toMatch(/source_timestamp IS NOT NULL/);
    expect(await ids(db)).toEqual([1, 4, 5, 6, 7, 8, 9]);
  });

  it('does not touch gexbot_snapshots (no natural key there)', async () => {
    await migrate();
    const idx = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'gexbot_snapshots_natural_key'`,
    );
    expect(idx.rows).toHaveLength(0);
  });

  it('skips a duplicate, collapses an intra-batch duplicate, and still inserts NULL-timestamp rows', async () => {
    await migrate();
    // existing dup (100), a fresh row (300) sent twice, and a NULL row
    const inserted = await unnestInsert(db, [
      ['SPX', 'state', 'gamma_zero', 100],
      ['SPX', 'state', 'gamma_zero', 300],
      ['SPX', 'state', 'gamma_zero', 300],
      ['SPX', 'state', 'gamma_zero', null],
    ]);
    expect(inserted).toBe(2);
    expect(await ids(db)).toHaveLength(7 + 2);
  });

  it('rolls the whole transaction back when a duplicate lands before the index build', async () => {
    const sql = pgSql(db);
    const [setLock, lock, del, createIndex] = statements192(sql);
    if (!setLock || !lock || !del || !createIndex) {
      throw new Error('expected 4 statements');
    }
    await expect(
      db.transaction(async (tx) => {
        for (const q of [setLock, lock, del]) await tx.query(q.text, q.params);
        // A writer that slipped in a duplicate (the LOCK TABLE prevents this
        // in production; here the same transaction stands in for it).
        await tx.query(
          `INSERT INTO gexbot_api_capture (${CAPTURE_COLS})
           VALUES ('SPX','state','gamma_zero',100,'{}')`,
        );
        await tx.query(createIndex.text, createIndex.params);
      }),
    ).rejects.toMatchObject({ code: '23505' });

    // DELETE undone (all 9 original rows), no index left behind.
    expect(await ids(db)).toHaveLength(9);
    const idx = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'gexbot_api_capture_natural_key'`,
    );
    expect(idx.rows).toHaveLength(0);
    // And the migration is re-runnable afterwards.
    await migrate();
    expect(await ids(db)).toEqual([1, 4, 5, 6, 7, 8, 9]);
  });

  it('the pre-#192 plain INSERT fails the whole batch with 23505 once the index exists', async () => {
    await migrate();
    await expect(
      db.query(
        `INSERT INTO gexbot_api_capture (${CAPTURE_COLS})
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[],
                              $4::bigint[], $5::jsonb[])`,
        [
          ['SPX', 'QQQ'],
          ['state', 'state'],
          ['gamma_zero', 'gamma_zero'],
          [100, 999],
          ['{}', '{}'],
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // The fresh QQQ row was lost with the batch: the deploy-order hazard.
    const fresh = await db.query(
      `SELECT 1 FROM gexbot_api_capture WHERE ticker = 'QQQ'`,
    );
    expect(fresh.rows).toHaveLength(0);
  });
});
