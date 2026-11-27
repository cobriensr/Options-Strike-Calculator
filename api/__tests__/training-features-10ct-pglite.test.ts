// @vitest-environment node

/**
 * REAL-SQL test for migration #214: the 23 morning-safe columns of
 * training_features (spec: docs/superpowers/specs/2026-11-26-ml-morning-
 * features-design.md, phase 1).
 *
 * db.test.ts only counts the migration's statements, so it cannot see a wrong
 * name or a wrong type. This builds training_features from the real
 * migrations that build it up to #61 (#9, #11, #21, #22, #24, #26, #29, #31,
 * #33 and #61; #9, #11, #21, #26, #29 and #33 create the twins), applies the
 * real #214, and reads the columns back from the catalog: each new column must
 * have the type its twin has, and be nullable with no default.
 *
 * The types are pinned twice: written out below, from the migrations that
 * created the twins, and compared with the twin's type in the catalog. A type
 * that matched the plan's table but not its twin (or the reverse) fails.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

/**
 * The migrations that build training_features up to #61, in the order they
 * ran. #9, #11, #21, #26, #29 and #33 create the twins; #22, #24, #31 and #61
 * add other columns.
 */
const TWIN_MIGRATIONS = [9, 11, 21, 22, 24, 26, 29, 31, 33, 61] as const;

/**
 * The 23 new columns, in the order #214 adds them: the name, the twin it
 * copies its type from, and that type as the catalog prints it.
 */
const NEW_COLUMNS: ReadonlyArray<
  readonly [name: string, twin: string, type: string]
> = [
  // PCR, from flow_ratio_monitor rows up to 10:00 CT (twins: #26).
  ['pcr_max_10ct', 'pcr_max', 'numeric(8,4)'],
  ['pcr_min_10ct', 'pcr_min', 'numeric(8,4)'],
  ['pcr_range_10ct', 'pcr_range', 'numeric(8,4)'],
  ['pcr_spike_count_10ct', 'pcr_spike_count', 'integer'],
  // The 0DTE strike ladder at 10:00 CT (twins: #9).
  ['charm_slope_10ct', 'charm_slope', 'numeric(20,4)'],
  ['gamma_wall_above_dist_10ct', 'gamma_wall_above_dist', 'numeric(10,2)'],
  ['gamma_wall_below_dist_10ct', 'gamma_wall_below_dist', 'numeric(10,2)'],
  ['neg_gamma_nearest_dist_10ct', 'neg_gamma_nearest_dist', 'numeric(10,2)'],
  ['gamma_asymmetry_10ct', 'gamma_asymmetry', 'numeric(10,4)'],
  ['charm_max_pos_dist_10ct', 'charm_max_pos_dist', 'numeric(10,2)'],
  ['charm_max_neg_dist_10ct', 'charm_max_neg_dist', 'numeric(10,2)'],
  ['charm_pattern_10ct', 'charm_pattern', 'text'],
  // Realized vol from settlements before the date (twins: #11).
  ['prev_day_realized_vol_5d', 'realized_vol_5d', 'numeric(10,6)'],
  ['prev_day_realized_vol_10d', 'realized_vol_10d', 'numeric(10,6)'],
  ['rv_iv_ratio_10ct', 'rv_iv_ratio', 'numeric(6,4)'],
  // Dark pool up to 10:00 CT (twins: #21, and #29 for the last two).
  ['dp_total_premium_10ct', 'dp_total_premium', 'numeric(14,2)'],
  ['dp_cluster_count_10ct', 'dp_cluster_count', 'integer'],
  ['dp_top_cluster_dist_10ct', 'dp_top_cluster_dist', 'numeric(10,2)'],
  ['dp_support_premium_10ct', 'dp_support_premium', 'numeric(14,2)'],
  ['dp_resistance_premium_10ct', 'dp_resistance_premium', 'numeric(14,2)'],
  [
    'dp_support_resistance_ratio_10ct',
    'dp_support_resistance_ratio',
    'numeric(8,4)',
  ],
  ['dp_concentration_10ct', 'dp_concentration', 'numeric(8,4)'],
  // The previous trading day's IV rank (twin: #33).
  ['prev_day_iv_rank', 'iv_rank', 'numeric(6,2)'],
];

const NEW_NAMES = NEW_COLUMNS.map(([name]) => name);

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
  for (const id of TWIN_MIGRATIONS) await applyMigration(pg, id);
});

/**
 * Apply #214 the way migrateDb() does: its statements in one transaction.
 * Outside one, its SET LOCAL does nothing but print a warning.
 */
async function apply214(): Promise<void> {
  await pg.exec('BEGIN');
  try {
    await applyMigration(pg, 214);
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK');
    throw err;
  }
}

/** The named columns of training_features that exist, in table order. */
async function columns(names: readonly string[]): Promise<Column[]> {
  const { rows } = await pg.query<Column>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            a.atthasdef AS has_default
       FROM pg_attribute a
      WHERE a.attrelid = 'training_features'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attname = ANY($1)
      ORDER BY a.attnum`,
    [names],
  );
  return rows;
}

/** Every live column name of training_features. */
async function allColumnNames(): Promise<string[]> {
  const { rows } = await pg.query<{ name: string }>(
    `SELECT attname AS name FROM pg_attribute
      WHERE attrelid = 'training_features'::regclass
        AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`,
  );
  return rows.map((r) => r.name);
}

describe('migration #214: the 23 morning-safe columns', () => {
  it('starts from the 23 twins, with the types the migrations that created them gave', async () => {
    const twins = NEW_COLUMNS.map(([, twin]) => twin);

    const found = await columns(twins);

    // Table order is the twins' own, so compare as a map.
    expect(Object.fromEntries(found.map((c) => [c.name, c.type]))).toEqual(
      Object.fromEntries(NEW_COLUMNS.map(([, twin, type]) => [twin, type])),
    );
    expect(await columns(NEW_NAMES)).toEqual([]);
  });

  it('adds exactly the 23 columns, each of its twin’s type', async () => {
    const before = await allColumnNames();

    await apply214();

    const added = (await allColumnNames()).filter((n) => !before.includes(n));
    expect(added).toEqual(NEW_NAMES);
    expect(added).toHaveLength(23);
    const byName = new Map(
      (await columns([...NEW_NAMES, ...NEW_COLUMNS.map(([, t]) => t)])).map(
        (c) => [c.name, c.type] as const,
      ),
    );
    for (const [name, twin, type] of NEW_COLUMNS) {
      expect(byName.get(name), name).toBe(type);
      expect(byName.get(name), `${name} against ${twin}`).toBe(
        byName.get(twin),
      );
    }
  });

  it('makes every one nullable with no default', async () => {
    await apply214();

    const added = await columns(NEW_NAMES);

    expect(added).toHaveLength(23);
    expect(added.filter((c) => c.not_null || c.has_default)).toEqual([]);
  });

  it('leaves the existing rows NULL in all 23, keeps their own values, and adds nothing else', async () => {
    await pg.query(
      `INSERT INTO training_features (date, pcr_max, charm_slope, charm_pattern, dp_total_premium, iv_rank)
       VALUES ('2026-11-24', 1.2345, -123.4567, 'all_negative', 31500000.5, 63.25)`,
    );
    const before = await allColumnNames();

    await apply214();

    const { rows } = await pg.query<{ j: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS j FROM training_features t`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!.j;
    for (const name of NEW_NAMES) expect(row[name], name).toBeNull();
    // The old row keeps its own values, the twins included.
    expect(row.pcr_max).toBe(1.2345);
    expect(row.charm_slope).toBe(-123.4567);
    expect(row.charm_pattern).toBe('all_negative');
    expect(row.dp_total_premium).toBe(31500000.5);
    expect(row.iv_rank).toBe(63.25);
    expect((await allColumnNames()).length).toBe(before.length + 23);
  });

  it('can be applied twice, as a migration re-run on a database that already has the columns must be', async () => {
    await apply214();
    const once = await allColumnNames();

    await apply214();

    expect(await allColumnNames()).toEqual(once);
    expect(await columns(NEW_NAMES)).toHaveLength(23);
  });

  it('bounds the lock wait to 5 s for the transaction, so a queued ALTER fails fast', async () => {
    // SET LOCAL lasts to the end of the transaction, so read it before
    // ROLLBACK.
    await pg.exec('BEGIN');
    try {
      await applyMigration(pg, 214);
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

  // One column for each numeric shape the 23 use (the other columns of a shape
  // share its limits): the largest value it holds, and the first value past
  // it. The values are SQL literals, so a bound parameter's type cannot change
  // the message. charm_slope_10ct is DECIMAL(20,4), 16 integer digits, so
  // -9999999999999999.9999 fits and 1e16 does not.
  const LIMITS: ReadonlyArray<
    readonly [column: string, atLimit: string, pastLimit: string, error: RegExp]
  > = [
    ['pcr_max_10ct', '9999.9999', '10000', /numeric field overflow/],
    ['prev_day_iv_rank', '9999.99', '10000', /numeric field overflow/],
    [
      'dp_total_premium_10ct',
      '999999999999.99',
      '1000000000000',
      /numeric field overflow/,
    ],
    [
      'charm_slope_10ct',
      '-9999999999999999.9999',
      '10000000000000000',
      /numeric field overflow/,
    ],
    [
      'gamma_wall_above_dist_10ct',
      '99999999.99',
      '100000000',
      /numeric field overflow/,
    ],
    [
      'gamma_asymmetry_10ct',
      '999999.9999',
      '1000000',
      /numeric field overflow/,
    ],
    [
      'prev_day_realized_vol_5d',
      '9999.999999',
      '10000',
      /numeric field overflow/,
    ],
    ['rv_iv_ratio_10ct', '99.9999', '100', /numeric field overflow/],
    [
      'dp_cluster_count_10ct',
      '2147483647',
      '2147483648',
      /integer out of range/,
    ],
  ];

  it.each(LIMITS)(
    '%s holds %s and refuses %s',
    async (column, atLimit, pastLimit, error) => {
      await apply214();

      await pg.query(
        `INSERT INTO training_features (date, ${column}) VALUES ('2026-11-25', ${atLimit})`,
      );
      const { rows } = await pg.query<{ v: string }>(
        `SELECT ${column}::text AS v FROM training_features WHERE date = '2026-11-25'`,
      );
      expect(rows).toEqual([{ v: atLimit }]);
      await expect(
        pg.query(
          `INSERT INTO training_features (date, ${column}) VALUES ('2026-11-26', ${pastLimit})`,
        ),
      ).rejects.toThrow(error);
    },
  );

  it('refuses 10000 in dp_support_resistance_ratio_10ct, the overflow the spec names', async () => {
    await apply214();

    // 03-26 computed 35,853 into the (8,4) twin, which overflowed.
    await pg.query(
      `INSERT INTO training_features (date, dp_support_resistance_ratio_10ct)
       VALUES ('2026-11-25', 9999.9999)`,
    );
    await expect(
      pg.query(
        `INSERT INTO training_features (date, dp_support_resistance_ratio_10ct)
         VALUES ('2026-11-26', 10000)`,
      ),
    ).rejects.toThrow(/numeric field overflow/);
    await expect(
      pg.query(
        `INSERT INTO training_features (date, dp_support_resistance_ratio_10ct)
         VALUES ('2026-11-27', 35853)`,
      ),
    ).rejects.toThrow(/numeric field overflow/);
  });

  it('takes NULL in every one of the 23', async () => {
    await apply214();
    const nulls = NEW_NAMES.map(() => 'NULL').join(', ');

    await pg.query(
      `INSERT INTO training_features (date, ${NEW_NAMES.join(', ')})
       VALUES ('2026-11-25', ${nulls})`,
    );

    const { rows } = await pg.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM training_features',
    );
    expect(rows[0]!.n).toBe(1);
  });
});
