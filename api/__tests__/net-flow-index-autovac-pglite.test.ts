// @vitest-environment node

/**
 * REAL-SQL tests for two migrations on ws_net_flow_per_ticker:
 *
 * - #199: drop the redundant ws_net_flow_per_ticker_ticker_ts_idx and set
 *   per-table autovacuum options.
 * - #210: swap the plain unique (ticker, ts) index for a covering one and
 *   lower the insert-vacuum scale factor to 0.001.
 *
 * ws_net_flow_per_ticker and its indexes come from the REAL migration #121;
 * the other seven tables are stubs (only the table has to exist for an
 * ALTER ... SET). Each migration runs in one transaction, as migrateDb() runs
 * it, and twice, because on prod it is a no-op over the hand-applied change.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS } from '../_lib/db-migrations.js';
import {
  applyMigration,
  neonOverPglite,
  type PgliteQuery,
} from './pglite-migrations.js';

const INSERT_TUNED = [
  'ws_net_flow_per_ticker',
  'strike_iv_snapshots',
  'strike_exposures',
  'lottery_finder_fires',
  'net_flow_per_ticker_history',
];
// Tuned on prod 2026-05-13 with the four base settings.
const PRE_TUNED = ['ws_gex_strike_expiry', 'ws_option_trades'];
// gex_strike_0dte is insert-only too, so it also gets the insert factor.
const INSERT_TUNED_LATE = 'gex_strike_0dte';

const BASE_OPTIONS = [
  'autovacuum_analyze_scale_factor=0.005',
  'autovacuum_analyze_threshold=1000',
  'autovacuum_vacuum_scale_factor=0.01',
  'autovacuum_vacuum_threshold=1000',
];

/** Migration `id` in one transaction, as migrateDb() runs a `statements` one. */
async function runInTransaction(pg: PGlite, id: number): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, id);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

/** The real #121 table and indexes, plus a stub for every other table #199 alters. */
async function buildNetFlowFixture(pg: PGlite): Promise<void> {
  await applyMigration(pg, 121);
  for (const t of INSERT_TUNED.slice(1).concat(PRE_TUNED, INSERT_TUNED_LATE)) {
    await pg.exec(`CREATE TABLE ${t} (id INT)`);
  }
}

async function reloptions(pg: PGlite, table: string): Promise<string[]> {
  const { rows } = await pg.query<{ reloptions: string[] | null }>(
    'SELECT reloptions FROM pg_class WHERE relname = $1',
    [table],
  );
  return [...(rows[0]?.reloptions ?? [])].sort();
}

async function indexNames(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'ws_net_flow_per_ticker'`,
  );
  return rows.map((r) => r.indexname).sort();
}

describe('migration #199 (net-flow index drop + autovacuum)', () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await buildNetFlowFixture(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it('starts with the redundant DESC index in place', async () => {
    expect(await indexNames(pg)).toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });

  // #199 alone: the plain unique index is still there. #210 swaps it, below.
  it('drops only the redundant index, keeping the unique key and ts index', async () => {
    await runInTransaction(pg, 199);
    expect(await indexNames(pg)).toEqual([
      'ws_net_flow_per_ticker_pkey',
      'ws_net_flow_per_ticker_ts_idx',
      'ws_net_flow_per_ticker_uq',
    ]);
  });

  it('sets the insert scale factor on the six insert-heavy tables', async () => {
    await runInTransaction(pg, 199);
    for (const t of [...INSERT_TUNED, INSERT_TUNED_LATE]) {
      expect(await reloptions(pg, t), t).toEqual(
        [...BASE_OPTIONS, 'autovacuum_vacuum_insert_scale_factor=0.01'].sort(),
      );
    }
  });

  it('records the two other prod-tuned tables without the insert factor', async () => {
    await runInTransaction(pg, 199);
    for (const t of PRE_TUNED) {
      expect(await reloptions(pg, t), t).toEqual(BASE_OPTIONS);
    }
  });

  it('is idempotent when the index is already gone and options are set', async () => {
    await runInTransaction(pg, 199);
    await expect(runInTransaction(pg, 199)).resolves.toBeUndefined();
    expect(await indexNames(pg)).not.toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });

  it('fails atomically when a target table is missing', async () => {
    await pg.exec('DROP TABLE gex_strike_0dte');
    await expect(runInTransaction(pg, 199)).rejects.toThrow(/gex_strike_0dte/);
    // The earlier ALTERs ran before the failure, so these prove the rollback.
    expect(await reloptions(pg, 'ws_net_flow_per_ticker')).toEqual([]);
    expect(await reloptions(pg, 'strike_iv_snapshots')).toEqual([]);
    expect(await indexNames(pg)).toContain(
      'ws_net_flow_per_ticker_ticker_ts_idx',
    );
  });
});

const COV_INDEX = 'ws_net_flow_per_ticker_cov_uq';
const PLAIN_INDEX = 'ws_net_flow_per_ticker_uq';
const INCLUDED_COLUMNS = [
  'net_call_prem',
  'net_put_prem',
  'net_call_vol',
  'net_put_vol',
];

// What the owner runs by hand on prod first (one autocommit statement each,
// because CONCURRENTLY cannot run inside a transaction). Pglite runs the
// non-concurrent build, which leaves the same index.
const HAND_STEPS = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${COV_INDEX}
     ON ws_net_flow_per_ticker (ticker, ts)
     INCLUDE (net_call_prem, net_put_prem, net_call_vol, net_put_vol)`,
  `DROP INDEX CONCURRENTLY IF EXISTS ${PLAIN_INDEX}`,
  `ALTER TABLE ws_net_flow_per_ticker
     SET (autovacuum_vacuum_insert_scale_factor = 0.001)`,
];

async function applyHandSteps(pg: PGlite): Promise<void> {
  for (const step of HAND_STEPS) await pg.exec(step);
}

interface IndexShape {
  unique: boolean;
  valid: boolean;
  keyColumns: string[];
  includedColumns: string[];
  definition: string;
  relfilenode: string;
}

/** What `name` is on disk: uniqueness, validity, columns, and its file. */
async function indexShape(pg: PGlite, name: string): Promise<IndexShape> {
  const { rows } = await pg.query<{
    unique: boolean;
    valid: boolean;
    nkey: number;
    cols: string[];
    definition: string;
    relfilenode: string;
  }>(
    `SELECT i.indisunique AS unique, i.indisvalid AS valid,
            i.indnkeyatts AS nkey,
            ARRAY(
              SELECT a.attname::text
                FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               ORDER BY k.ord
            ) AS cols,
            pg_get_indexdef(i.indexrelid) AS definition,
            c.relfilenode::text AS relfilenode
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) throw new Error(`index ${name} does not exist`);
  return {
    unique: row.unique,
    valid: row.valid,
    keyColumns: row.cols.slice(0, row.nkey),
    includedColumns: row.cols.slice(row.nkey),
    definition: row.definition,
    relfilenode: row.relfilenode,
  };
}

// uw-stream's write shape (handlers/net_flow.py through db.bulk_insert_...):
// a multi-row INSERT, conflict target (ticker, ts), DO NOTHING.
const UW_STREAM_INSERT = `
  INSERT INTO ws_net_flow_per_ticker
    (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
     raw_payload)
  VALUES ($1, $2::timestamptz, 100.5, 10, -50.25, 5, '{}'::jsonb)
  ON CONFLICT (ticker, ts) DO NOTHING`;

async function writeTick(
  pg: PGlite,
  ticker: string,
  ts: string,
): Promise<number> {
  const result = await pg.query(`${UW_STREAM_INSERT} RETURNING id`, [
    ticker,
    ts,
  ]);
  return result.rows.length;
}

describe('migration #210 (covering unique index on ws_net_flow_per_ticker)', () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await buildNetFlowFixture(pg);
    // Prod's state before M1: #121's indexes after #199.
    await runInTransaction(pg, 199);
  });

  afterEach(async () => {
    await pg.close();
  });

  it('starts from the plain unique index and the 0.01 insert factor', async () => {
    expect(await indexNames(pg)).toEqual([
      'ws_net_flow_per_ticker_pkey',
      'ws_net_flow_per_ticker_ts_idx',
      PLAIN_INDEX,
    ]);
    expect(await reloptions(pg, 'ws_net_flow_per_ticker')).toContain(
      'autovacuum_vacuum_insert_scale_factor=0.01',
    );
  });

  it('builds a valid unique index on (ticker, ts) that carries the four value columns', async () => {
    await runInTransaction(pg, 210);
    expect(await indexShape(pg, COV_INDEX)).toMatchObject({
      unique: true,
      valid: true,
      keyColumns: ['ticker', 'ts'],
      includedColumns: INCLUDED_COLUMNS,
    });
  });

  it('drops the plain unique index, leaving the key, ts and covering indexes', async () => {
    await runInTransaction(pg, 210);
    expect(await indexNames(pg)).toEqual([
      COV_INDEX,
      'ws_net_flow_per_ticker_pkey',
      'ws_net_flow_per_ticker_ts_idx',
    ]);
  });

  it('lowers the insert scale factor to 0.001 and keeps the four base options', async () => {
    await runInTransaction(pg, 210);
    expect(await reloptions(pg, 'ws_net_flow_per_ticker')).toEqual(
      [...BASE_OPTIONS, 'autovacuum_vacuum_insert_scale_factor=0.001'].sort(),
    );
  });

  it("still dedupes uw-stream's INSERT ... ON CONFLICT (ticker, ts) DO NOTHING", async () => {
    await runInTransaction(pg, 210);
    expect(await writeTick(pg, 'NVDA', '2026-11-16T15:00:00.123Z')).toBe(1);
    // The same (ticker, ts) again writes nothing; a new ts or ticker writes.
    expect(await writeTick(pg, 'NVDA', '2026-11-16T15:00:00.123Z')).toBe(0);
    expect(await writeTick(pg, 'NVDA', '2026-11-16T15:00:00.124Z')).toBe(1);
    expect(await writeTick(pg, 'AMD', '2026-11-16T15:00:00.123Z')).toBe(1);
    const { rows } = await pg.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM ws_net_flow_per_ticker',
    );
    expect(rows[0]?.n).toBe('3');
  });

  it('plans that INSERT with the covering index as the conflict arbiter', async () => {
    await runInTransaction(pg, 210);
    const plan = await pg.query<{
      'QUERY PLAN': Array<{ Plan: Record<string, unknown> }>;
    }>(`EXPLAIN (FORMAT JSON) ${UW_STREAM_INSERT}`, [
      'NVDA',
      '2026-11-16T15:00:00.123Z',
    ]);
    const root = plan.rows[0]?.['QUERY PLAN'][0]?.Plan;
    expect(root?.['Node Type']).toBe('ModifyTable');
    expect(root?.['Conflict Resolution']).toBe('NOTHING');
    expect(root?.['Conflict Arbiter Indexes']).toEqual([COV_INDEX]);
  });

  it('bounds the lock wait to 5 s inside its transaction and no further', async () => {
    await pg.exec('BEGIN');
    try {
      await applyMigration(pg, 210);
      const inside = await pg.query<{ lock_timeout: string }>(
        'SHOW lock_timeout',
      );
      expect(inside.rows[0]?.lock_timeout).toBe('5s');
    } finally {
      await pg.exec('COMMIT');
    }
    const after = await pg.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(after.rows[0]?.lock_timeout).toBe('0');
  });

  it('sets the lock bound first and drops the plain index last, after the build', async () => {
    // The queries are lazy: building the array runs nothing.
    const statements =
      MIGRATIONS.find((m) => m.id === 210)?.statements?.(
        neonOverPglite(pg) as never,
      ) ?? [];
    const texts = (statements as unknown as PgliteQuery[]).map((q) =>
      q.text.replace(/\s+/g, ' ').trim(),
    );
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(texts[1]).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS /);
    expect(texts[2]).toMatch(/^ALTER TABLE ws_net_flow_per_ticker SET /);
    // A plain DROP INDEX holds ACCESS EXCLUSIVE to commit, so it follows the
    // other statements and the covering index is already in place.
    expect(texts[3]).toBe(`DROP INDEX IF EXISTS ${PLAIN_INDEX}`);
  });

  it('is a no-op on a database where the hand-applied change is already in place', async () => {
    await applyHandSteps(pg);
    const before = {
      shape: await indexShape(pg, COV_INDEX),
      names: await indexNames(pg),
      options: await reloptions(pg, 'ws_net_flow_per_ticker'),
    };
    expect(before.shape).toMatchObject({ unique: true, valid: true });

    await expect(runInTransaction(pg, 210)).resolves.toBeUndefined();

    // Same index, same file on disk (not rebuilt), same options.
    expect({
      shape: await indexShape(pg, COV_INDEX),
      names: await indexNames(pg),
      options: await reloptions(pg, 'ws_net_flow_per_ticker'),
    }).toEqual(before);
  });

  it('seeds a fresh database to the same shape the hand steps leave', async () => {
    await runInTransaction(pg, 210);
    const seeded = {
      shape: await indexShape(pg, COV_INDEX),
      names: await indexNames(pg),
      options: await reloptions(pg, 'ws_net_flow_per_ticker'),
    };

    const handed = new PGlite();
    try {
      await buildNetFlowFixture(handed);
      await runInTransaction(handed, 199);
      await applyHandSteps(handed);
      const { relfilenode: seededFile, ...seededShape } = seeded.shape;
      const { relfilenode: handedFile, ...handedShape } = await indexShape(
        handed,
        COV_INDEX,
      );
      expect(seededFile).toBeTruthy();
      expect(handedFile).toBeTruthy();
      expect(seededShape).toEqual(handedShape);
      expect(seeded.names).toEqual(await indexNames(handed));
      expect(seeded.options).toEqual(
        await reloptions(handed, 'ws_net_flow_per_ticker'),
      );
    } finally {
      await handed.close();
    }
  });

  it('is idempotent when run twice in a row', async () => {
    await runInTransaction(pg, 210);
    const first = await indexShape(pg, COV_INDEX);
    await expect(runInTransaction(pg, 210)).resolves.toBeUndefined();
    expect(await indexShape(pg, COV_INDEX)).toEqual(first);
    expect(await indexNames(pg)).not.toContain(PLAIN_INDEX);
  });

  it('fails without changing anything when a duplicate (ticker, ts) blocks the build', async () => {
    // Only reachable if the plain unique index is missing; the build is what
    // guards the table, so a failure must leave the table as it was.
    await pg.exec(`DROP INDEX ${PLAIN_INDEX}`);
    for (let i = 0; i < 2; i++) {
      await pg.query(
        `INSERT INTO ws_net_flow_per_ticker
           (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
            raw_payload)
         VALUES ('NVDA', '2026-11-16T15:00:00Z', 1, 1, 1, 1, '{}')`,
      );
    }
    const optionsBefore = await reloptions(pg, 'ws_net_flow_per_ticker');
    const namesBefore = await indexNames(pg);

    await expect(runInTransaction(pg, 210)).rejects.toThrow(
      /could not create unique index|duplicate key/,
    );

    expect(await indexNames(pg)).toEqual(namesBefore);
    expect(await reloptions(pg, 'ws_net_flow_per_ticker')).toEqual(
      optionsBefore,
    );
  });
});
