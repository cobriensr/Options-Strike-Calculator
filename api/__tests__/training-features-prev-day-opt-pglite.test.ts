// @vitest-environment node

/**
 * REAL-SQL test for migration #213: the 15 prev_day_opt_* columns of
 * training_features.
 *
 * db.test.ts only counts the migration's statements, so it cannot see a wrong
 * name or a wrong type. This applies the real #24 (which created the opt_*
 * columns) and the real #213 to a stub of training_features, and reads the
 * columns back from the catalog: each opt_* column must have a prev_day_opt_*
 * twin of the same type, and the twins must be nullable with no default.
 *
 * The stub holds only the primary key. The real table (migration #9) and the
 * ALTERs between #9 and #24 add columns this test does not read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

/** The 15 columns migration #24 created, in its order, with their types. */
const OPT_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ['opt_call_volume', 'integer'],
  ['opt_put_volume', 'integer'],
  ['opt_call_oi', 'integer'],
  ['opt_put_oi', 'integer'],
  ['opt_call_premium', 'numeric(14,2)'],
  ['opt_put_premium', 'numeric(14,2)'],
  ['opt_bullish_premium', 'numeric(14,2)'],
  ['opt_bearish_premium', 'numeric(14,2)'],
  ['opt_call_vol_ask', 'integer'],
  ['opt_put_vol_bid', 'integer'],
  ['opt_vol_pcr', 'numeric(6,4)'],
  ['opt_oi_pcr', 'numeric(6,4)'],
  ['opt_premium_ratio', 'numeric(6,4)'],
  ['opt_call_vol_vs_avg30', 'numeric(6,4)'],
  ['opt_put_vol_vs_avg30', 'numeric(6,4)'],
];

const PREV_COLUMNS = OPT_COLUMNS.map(
  ([name, type]) => [`prev_day_${name}`, type] as const,
);

interface Column {
  name: string;
  type: string;
  not_null: boolean;
  has_default: boolean;
}

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('DROP TABLE IF EXISTS training_features');
  await pg.query('CREATE TABLE training_features (date DATE PRIMARY KEY)');
  await applyMigration(pg, 24);
});

/**
 * Apply #213 the way migrateDb() does: its statements in one transaction.
 * Outside one, its SET LOCAL does nothing but print a warning.
 */
async function apply213(): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, 213);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

/** Columns of training_features whose name starts with `prefix`, in order. */
async function columns(prefix: string): Promise<Column[]> {
  const { rows } = await pg.query<Column>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            a.atthasdef AS has_default
       FROM pg_attribute a
      WHERE a.attrelid = 'training_features'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND starts_with(a.attname, $1)
      ORDER BY a.attnum`,
    [prefix],
  );
  return rows;
}

describe('migration #213: the prev_day_opt_* columns', () => {
  it('starts from the 15 opt_* columns of #24, with the types the spec lists', async () => {
    expect(
      (await columns('opt_')).map((c) => [c.name, c.type] as const),
    ).toEqual(OPT_COLUMNS);
  });

  it('adds exactly one prev_day_opt_ column for each opt_ column, in the same order and of the same type', async () => {
    await apply213();

    const opt = await columns('opt_');
    const prev = await columns('prev_day_opt_');

    expect(prev.map((c) => [c.name, c.type] as const)).toEqual(PREV_COLUMNS);
    // The twin of each opt_X is prev_day_opt_X, and its type is X's.
    expect(prev.map((c) => [c.name.replace('prev_day_', ''), c.type])).toEqual(
      opt.map((c) => [c.name, c.type]),
    );
  });

  it('makes every one nullable with no default', async () => {
    await apply213();

    const prev = await columns('prev_day_opt_');

    expect(prev).toHaveLength(15);
    expect(prev.filter((c) => c.not_null || c.has_default)).toEqual([]);
  });

  it('leaves the existing rows NULL in all 15, and adds nothing else', async () => {
    await pg.query(
      `INSERT INTO training_features (date, opt_call_volume) VALUES ('2026-11-24', 253308)`,
    );
    const before = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_attribute
        WHERE attrelid = 'training_features'::regclass AND attnum > 0 AND NOT attisdropped`,
    );

    await apply213();

    const { rows } = await pg.query<{ j: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS j FROM training_features t`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!.j;
    for (const [name] of PREV_COLUMNS) expect(row[name]).toBeNull();
    // The old row keeps its own value.
    expect(row.opt_call_volume).toBe(253308);
    const after = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_attribute
        WHERE attrelid = 'training_features'::regclass AND attnum > 0 AND NOT attisdropped`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 15);
  });

  it('can be applied twice, as a migration re-run on a database that already has the columns must be', async () => {
    await apply213();
    await apply213();

    expect(await columns('prev_day_opt_')).toHaveLength(15);
  });

  it('bounds the lock wait to 5 s for the transaction, so a queued ALTER fails fast', async () => {
    // SET LOCAL lasts to the end of the transaction, so read it before
    // ROLLBACK.
    await pg.exec('BEGIN');
    try {
      await applyMigration(pg, 213);
      const { rows } = await pg.query<{ lock_timeout: string }>(
        'SHOW lock_timeout',
      );
      expect(rows).toEqual([{ lock_timeout: '5s' }]);
    } finally {
      await pg.exec('ROLLBACK');
    }
    const after = await pg.query<{ lock_timeout: string }>('SHOW lock_timeout');
    expect(after.rows).toEqual([{ lock_timeout: '0' }]);
  });

  it('accepts values at the column limits, and NULL', async () => {
    await apply213();

    // The limits, not values from the UW reply: INTEGER tops out at
    // 2,147,483,647, DECIMAL(14,2) at 12 integer digits and DECIMAL(6,4) at
    // 99.9999. The saved 500-row reply stays well inside them: its largest
    // call open interest is 9,072,169 (2026-06-18), its largest call premium
    // 27,749,047,750 (2025-01-21, 11 integer digits) and its largest vol PCR
    // 3.0301 (2025-02-19).
    await pg.query(
      `INSERT INTO training_features
         (date, prev_day_opt_call_oi, prev_day_opt_call_premium, prev_day_opt_vol_pcr)
       VALUES ('2026-11-25', 2147483647, 999999999999.99, 99.9999),
              ('2026-11-26', NULL, NULL, NULL)`,
    );
    const { rows } = await pg.query<{
      prev_day_opt_call_oi: number | null;
      prev_day_opt_call_premium: string | number | null;
      prev_day_opt_vol_pcr: string | number | null;
    }>(
      `SELECT prev_day_opt_call_oi, prev_day_opt_call_premium::text AS prev_day_opt_call_premium,
              prev_day_opt_vol_pcr::text AS prev_day_opt_vol_pcr
         FROM training_features ORDER BY date`,
    );

    expect(rows).toEqual([
      {
        prev_day_opt_call_oi: 2147483647,
        prev_day_opt_call_premium: '999999999999.99',
        prev_day_opt_vol_pcr: '99.9999',
      },
      {
        prev_day_opt_call_oi: null,
        prev_day_opt_call_premium: null,
        prev_day_opt_vol_pcr: null,
      },
    ]);
  });
});
