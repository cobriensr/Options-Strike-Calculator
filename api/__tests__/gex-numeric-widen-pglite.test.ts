// @vitest-environment node

/**
 * REAL-SQL test for migration #191: the greek columns of gex_strike_0dte,
 * strike_exposures and spot_exposures go from NUMERIC(20,4) to NUMERIC(30,4)
 * because 0DTE charm near the close exceeds 1e16, the old cap
 * (docs/superpowers/specs/gex-numeric-overflow-2026-10-25.md).
 *
 * The tables come from replaying the REAL MIGRATIONS entries on pglite (real
 * Postgres in WASM); #191 then runs in one transaction, as migrateDb() runs it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS, type Migration } from '../_lib/db-migrations.js';

type NeonSql = Parameters<NonNullable<Migration['statements']>>[0];

const TABLES = [
  'gex_strike_0dte',
  'strike_exposures',
  'spot_exposures',
] as const;
type Table = (typeof TABLES)[number];

/**
 * Every pre-#191 migration that creates or alters these tables: #7, #8 and #47
 * create them, #17 sets created_at NOT NULL, #148 adds an index. #17 also
 * alters unrelated tables, so the replay keeps only statements naming these.
 */
const SCHEMA_MIGRATION_IDS = [7, 8, 17, 47, 148];
const NAMES_A_TABLE = new RegExp(String.raw`\b(?:${TABLES.join('|')})\b`);

/** Production's NUMERIC(20,4) column count per table (information_schema). */
const GREEK_COLUMN_COUNT: Record<Table, number> = {
  gex_strike_0dte: 18,
  strike_exposures: 16,
  spot_exposures: 9,
};

// spot_exposures has no call/put split, so its pair is charm_oi + charm_vol.
const CHARM: Record<Table, [string, string]> = {
  gex_strike_0dte: ['call_charm_oi', 'put_charm_oi'],
  strike_exposures: ['call_charm_oi', 'put_charm_oi'],
  spot_exposures: ['charm_oi', 'charm_vol'],
};

/** The NOT NULL columns an insert needs. */
const BASE_ROW: Record<Table, Record<string, string>> = {
  gex_strike_0dte: {
    date: '2026-10-22',
    timestamp: '2026-10-22T20:00:00Z',
    strike: '6700.00',
    price: '6712.34',
  },
  strike_exposures: {
    date: '2026-10-22',
    timestamp: '2026-10-22T20:00:00Z',
    strike: '6700.00',
  },
  spot_exposures: { date: '2026-10-22', timestamp: '2026-10-22T20:00:00Z' },
};

const OVER_OLD_CAP = '15000000000000000'; // 1.5e16 > 10^16
const SCALE_28 = '12345.6789567890123456789012345678'; // UW sends 28 dp

interface PgQuery extends PromiseLike<unknown[]> {
  readonly text: string;
  readonly params: unknown[];
}

/**
 * The slice of the neon client the migrations use, backed by pglite. Like
 * neon, a tagged-template query is lazy: it runs when awaited (legacy `run`
 * migrations) or when handed to `transaction` (`statements` migrations).
 */
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
type PgSql = ReturnType<typeof pgSql>;

function statementsOf(sql: PgSql, id: number): PgQuery[] {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (!m?.statements) throw new Error(`migration #${id} has no statements`);
  return m.statements(sql as unknown as NeonSql) as unknown as PgQuery[];
}

async function replaySchema(sql: PgSql): Promise<void> {
  for (const id of SCHEMA_MIGRATION_IDS) {
    const m = MIGRATIONS.find((x) => x.id === id);
    if (m?.run) {
      await m.run(sql as unknown as NeonSql);
    } else {
      const own = statementsOf(sql, id).filter((q) =>
        NAMES_A_TABLE.test(q.text),
      );
      await sql.transaction(own);
    }
  }
}

const widen = (sql: PgSql) => sql.transaction(statementsOf(sql, 191));

async function insert(
  db: PGlite,
  table: Table,
  values: Record<string, string>,
): Promise<void> {
  const row = { ...BASE_ROW[table], ...values };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(row),
  );
}

async function readText(
  db: PGlite,
  table: Table,
  columns: string[],
): Promise<string[]> {
  const select = columns.map((c) => `${c}::text AS ${c}`).join(', ');
  const res = await db.query<Record<string, string>>(
    `SELECT ${select} FROM ${table}`,
  );
  expect(res.rows).toHaveLength(1);
  return columns.map((c) => res.rows[0]![c]!);
}

/** Storage file of each table and each of its indexes. */
async function relfilenodes(db: PGlite): Promise<Record<string, string>> {
  const res = await db.query<{ relname: string; node: string }>(
    `SELECT c.relname, c.relfilenode::text AS node
     FROM pg_class c
     LEFT JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = ANY($1::text[])
        OR i.indrelid IN (SELECT oid FROM pg_class WHERE relname = ANY($1::text[]))`,
    [TABLES],
  );
  return Object.fromEntries(res.rows.map((r) => [r.relname, r.node]));
}

let db: PGlite;
let sql: PgSql;

beforeEach(async () => {
  db = await PGlite.create();
  sql = pgSql(db);
  await replaySchema(sql);
});

afterEach(async () => {
  await db.close();
});

describe('migration #191: widen GEX greek columns to NUMERIC(30,4)', () => {
  it.each(TABLES)(
    'before #191, 1.5e16 in %s charm fails with 22003 numeric field overflow',
    async (table) => {
      await expect(
        insert(db, table, { [CHARM[table][0]]: OVER_OLD_CAP }),
      ).rejects.toMatchObject({
        code: '22003',
        message: expect.stringContaining('numeric field overflow'),
      });
    },
  );

  it('rewrites nothing (same relfilenode for every table and index) and keeps rows', async () => {
    // The NUMERIC(20,4) maximum and October's stored max charm.
    const seeded = ['9999999999999999.9999', '-9560000000000000.1234'];
    for (const table of TABLES) {
      const [a, b] = CHARM[table];
      await insert(db, table, { [a]: seeded[0]!, [b]: seeded[1]! });
    }
    const before = await relfilenodes(db);
    expect(Object.keys(before).length).toBeGreaterThan(TABLES.length);

    await widen(sql);

    // SET LOCAL, not SET: the 5s timeout must not outlive the migration's
    // transaction on a pooled backend.
    const timeout = await db.query('SHOW lock_timeout');
    expect(timeout.rows).toEqual([{ lock_timeout: '0' }]);
    expect(await relfilenodes(db)).toEqual(before);
    for (const table of TABLES) {
      expect(await readText(db, table, CHARM[table])).toEqual(seeded);
    }
  });

  it.each(TABLES)(
    'after #191, %s stores 1.5e16 and rounds a 28-dp value to 4 decimals',
    async (table) => {
      await widen(sql);
      const [big, fine] = CHARM[table];

      await insert(db, table, { [big]: OVER_OLD_CAP, [fine]: SCALE_28 });

      expect(await readText(db, table, [big, fine])).toEqual([
        '15000000000000000.0000',
        '12345.6790',
      ]);
    },
  );

  it('leaves no precision-20 column: greeks are (30,4), strike/price stay (10,2)', async () => {
    await widen(sql);

    const res = await db.query<{
      table: Table;
      column: string;
      type: string;
    }>(
      `SELECT table_name AS table, column_name AS column,
              numeric_precision || ',' || numeric_scale AS type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
         AND data_type = 'numeric'`,
      [TABLES],
    );
    const isPrice = (c: string) => c === 'strike' || c === 'price';
    const greeks = res.rows.filter((r) => !isPrice(r.column));

    // A column #191 missed would show up here at '20,4'.
    expect(greeks.filter((r) => r.type !== '30,4')).toEqual([]);
    expect(
      res.rows.filter((r) => isPrice(r.column) && r.type !== '10,2'),
    ).toEqual([]);
    // The replay produced production's column set.
    const counts = Object.fromEntries(
      TABLES.map((t) => [t, greeks.filter((r) => r.table === t).length]),
    );
    expect(counts).toEqual(GREEK_COLUMN_COUNT);
  });
});
