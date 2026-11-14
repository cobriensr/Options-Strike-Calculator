// @vitest-environment node

/**
 * REAL-SQL test for migration #208: the versioned lottery weights store
 * (docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md, D5). Three
 * tables (lottery_score_versions, lottery_score_pointers,
 * lottery_fire_value_snapshots) and lottery_finder_fires.score_version,
 * seeded with the frozen 06-17 weights and both pointers on it.
 *
 * Nothing reads the store yet, so this checks the schema and the seed on
 * the real migration entries applied to pglite (real Postgres in WASM):
 * #110 creates lottery_finder_fires, #208 builds the store on top of it.
 * Every rule D5 puts in a CHECK, a key or a foreign key is hit from both
 * sides, and each rejection is asserted by its constraint name, so a
 * different constraint failing first does not pass for the right one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { LotteryWeightsSchema } from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';
import { applyMigration } from './pglite-migrations';

const FIRES_MIGRATION = 110;
const STORE_MIGRATION = 208;

const SEED = SEED_LOTTERY_WEIGHTS_VERSION;
const REFIT = 'refit-2026-11-04';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyMigration(db, FIRES_MIGRATION);
  await applyMigration(db, STORE_MIGRATION);
});

// Back to the state a first apply leaves: the seed row and both pointers,
// nothing else. Deleting in foreign-key order and applying again also means
// every test starts from the migration's own seeding.
beforeEach(async () => {
  await db.exec(`
    DELETE FROM lottery_fire_value_snapshots;
    DELETE FROM lottery_score_pointers;
    DELETE FROM lottery_score_versions;
  `);
  await applyMigration(db, STORE_MIGRATION);
});

afterAll(async () => {
  await db.close();
});

function insertVersion(
  version: string,
  status = 'rejected',
  weights: unknown = SEED_LOTTERY_WEIGHTS,
) {
  return db.query(
    `INSERT INTO lottery_score_versions (version, weights, status)
     VALUES ($1, $2::jsonb, $3)`,
    [version, JSON.stringify(weights), status],
  );
}

/** A Postgres array literal, so a test names its elements plainly. */
function arr(...items: (number | string | null)[]): string {
  return `{${items.map((i) => (i === null ? 'NULL' : String(i))).join(',')}}`;
}

function insertSnapshot(
  over: Partial<{
    reason: string;
    columnName: string;
    toVersion: string | null;
    fireIds: string;
    oldValues: string;
    oldTags: string;
  }> = {},
) {
  const v = {
    reason: 'promote-refit-2026-11-04',
    columnName: 'score',
    toVersion: REFIT as string | null,
    fireIds: arr(101, 102),
    oldValues: arr(7.5, 8),
    oldTags: arr(SEED, null),
    ...over,
  };
  return db.query(
    `INSERT INTO lottery_fire_value_snapshots
       (reason, column_name, to_version, fire_ids, old_values, old_tags)
     VALUES ($1, $2, $3, $4::bigint[], $5::float8[], $6::text[])`,
    [v.reason, v.columnName, v.toVersion, v.fireIds, v.oldValues, v.oldTags],
  );
}

describe('migration #208: the seed', () => {
  it('creates the store and points active and takeit at the seed', async () => {
    const versions = await db.query<{ version: string; status: string }>(
      `SELECT version, status FROM lottery_score_versions`,
    );
    const pointers = await db.query<{ name: string; version: string }>(
      `SELECT name, version FROM lottery_score_pointers ORDER BY name`,
    );

    expect(versions.rows).toEqual([{ version: SEED, status: 'seed' }]);
    expect(pointers.rows).toEqual([
      { name: 'active', version: SEED },
      { name: 'takeit', version: SEED },
    ]);
  });

  it('the seed row parses and equals SEED_LOTTERY_WEIGHTS', async () => {
    const { rows } = await db.query<{
      weights: unknown;
      trained_through: string;
    }>(
      `SELECT weights, trained_through::text AS trained_through
         FROM lottery_score_versions WHERE version = $1`,
      [SEED],
    );

    expect(rows).toHaveLength(1);
    expect(LotteryWeightsSchema.parse(rows[0]?.weights)).toEqual(
      SEED_LOTTERY_WEIGHTS,
    );
    // The row's own trained_through is the weights' trained_through.
    expect(rows[0]?.trained_through).toBe(SEED_LOTTERY_WEIGHTS.trained_through);
  });

  it('stamps the seed row in the database and starts its gate report empty', async () => {
    const { rows } = await db.query<{
      created_at_set: boolean;
      decided_at: unknown;
      gate_report: unknown;
    }>(
      `SELECT created_at IS NOT NULL AS created_at_set, decided_at, gate_report
         FROM lottery_score_versions WHERE version = $1`,
      [SEED],
    );
    expect(rows).toEqual([
      { created_at_set: true, decided_at: null, gate_report: {} },
    ]);
  });

  it('re-running keeps a moved pointer', async () => {
    await insertVersion(REFIT, 'promoted');
    await db.query(
      `UPDATE lottery_score_pointers SET version = $1 WHERE name = 'active'`,
      [REFIT],
    );

    await applyMigration(db, STORE_MIGRATION);

    const pointers = await db.query<{ name: string; version: string }>(
      `SELECT name, version FROM lottery_score_pointers ORDER BY name`,
    );
    expect(pointers.rows).toEqual([
      { name: 'active', version: REFIT },
      { name: 'takeit', version: SEED },
    ]);
  });

  it('re-running leaves the stored seed row as it is', async () => {
    // A later writer fills decided_at and gate_report on a version; a re-run
    // of the seed insert must not reset them (ON CONFLICT DO NOTHING).
    await db.query(
      `UPDATE lottery_score_versions
          SET decided_at = '2026-11-05T12:00:00Z',
              gate_report = '{"verdict":"kept"}'::jsonb,
              status = 'promoted'
        WHERE version = $1`,
      [SEED],
    );

    await applyMigration(db, STORE_MIGRATION);

    // Compared inside the database: the text form of a timestamptz follows
    // the session time zone.
    const { rows } = await db.query<{
      status: string;
      decided_at_kept: boolean;
      gate_report: unknown;
    }>(
      `SELECT status,
              decided_at = '2026-11-05T12:00:00Z'::timestamptz
                AS decided_at_kept,
              gate_report
         FROM lottery_score_versions WHERE version = $1`,
      [SEED],
    );
    expect(rows).toEqual([
      {
        status: 'promoted',
        decided_at_kept: true,
        gate_report: { verdict: 'kept' },
      },
    ]);
  });

  it('re-running adds no second seed row and leaves a row stored since', async () => {
    await insertVersion(REFIT, 'shadow');

    await applyMigration(db, STORE_MIGRATION);

    const { rows } = await db.query<{ version: string }>(
      `SELECT version FROM lottery_score_versions ORDER BY version`,
    );
    expect(rows.map((r) => r.version)).toEqual([REFIT, SEED]);
  });
});

describe('migration #208: the schema', () => {
  it('creates the three tables with the columns, types and nullability D5 lists', async () => {
    const { rows } = await db.query<{
      table_name: string;
      column_name: string;
      type: string;
      not_null: boolean;
    }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname IN ('lottery_score_versions',
                            'lottery_score_pointers',
                            'lottery_fire_value_snapshots')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
    );

    expect(
      rows.map((r) => [r.table_name, r.column_name, r.type, r.not_null]),
    ).toEqual([
      ['lottery_fire_value_snapshots', 'id', 'bigint', true],
      [
        'lottery_fire_value_snapshots',
        'taken_at',
        'timestamp with time zone',
        true,
      ],
      ['lottery_fire_value_snapshots', 'reason', 'text', true],
      ['lottery_fire_value_snapshots', 'column_name', 'text', true],
      ['lottery_fire_value_snapshots', 'to_version', 'text', false],
      ['lottery_fire_value_snapshots', 'fire_ids', 'bigint[]', true],
      [
        'lottery_fire_value_snapshots',
        'old_values',
        'double precision[]',
        true,
      ],
      ['lottery_fire_value_snapshots', 'old_tags', 'text[]', true],
      ['lottery_score_pointers', 'name', 'text', true],
      ['lottery_score_pointers', 'version', 'text', true],
      [
        'lottery_score_pointers',
        'updated_at',
        'timestamp with time zone',
        true,
      ],
      ['lottery_score_versions', 'version', 'text', true],
      ['lottery_score_versions', 'weights', 'jsonb', true],
      ['lottery_score_versions', 'status', 'text', true],
      ['lottery_score_versions', 'trained_through', 'date', false],
      [
        'lottery_score_versions',
        'created_at',
        'timestamp with time zone',
        true,
      ],
      [
        'lottery_score_versions',
        'decided_at',
        'timestamp with time zone',
        false,
      ],
      ['lottery_score_versions', 'gate_report', 'jsonb', true],
    ]);
  });

  it('adds a nullable score_version with no default', async () => {
    const { rows } = await db.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'lottery_finder_fires'
          AND column_name = 'score_version'`,
    );

    expect(rows).toEqual([
      { data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });
});

describe('lottery_score_versions', () => {
  it.each([
    ['seed', 'seed-2026-06-18'],
    ['shadow', 'refit-2026-11-01'],
    ['passed', 'refit-2026-11-02'],
    ['promoted', 'refit-2026-11-03'],
    ['rejected', 'refit-2026-11-05'],
  ])('accepts the status %s', async (status, version) => {
    await expect(insertVersion(version, status)).resolves.toBeDefined();
  });

  it.each(['SEED', 'candidate', 'shadow ', ''])(
    'rejects the status %j',
    async (status) => {
      await expect(insertVersion(REFIT, status)).rejects.toThrow(
        /lottery_score_versions_status_chk/,
      );
    },
  );

  it.each(['refit-2026-11-04', 'seed-2026-06-18', 'refit-2030-12-31'])(
    'accepts the version id %s',
    async (version) => {
      await expect(insertVersion(version)).resolves.toBeDefined();
    },
  );

  it.each([
    'refit-2026-1-04',
    'refit-2026-11-4',
    'refit-26-11-04',
    'REFIT-2026-11-04',
    'refit-2026-11-04x',
    'xrefit-2026-11-04',
    'refit-2026-11-04\n',
    'refit_2026-11-04',
    'promoted-2026-11-04',
    'refit-2026-11-04-2',
    'refit-20261104',
    'seed2026-06-17',
    '',
  ])('rejects the malformed version id %j', async (version) => {
    await expect(insertVersion(version)).rejects.toThrow(
      /lottery_score_versions_version_chk/,
    );
  });

  it('allows at most one shadow version', async () => {
    await insertVersion('refit-2026-11-04', 'shadow');

    await expect(insertVersion('refit-2026-11-05', 'shadow')).rejects.toThrow(
      /lottery_score_versions_one_shadow/,
    );
  });

  it('allows any number of rejected versions next to the shadow', async () => {
    await insertVersion('refit-2026-11-04', 'shadow');

    await insertVersion('refit-2026-11-05', 'rejected');
    await insertVersion('refit-2026-11-06', 'rejected');

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM lottery_score_versions
        WHERE status IN ('shadow', 'rejected')`,
    );
    expect(rows.map((r) => r.status).sort()).toEqual([
      'rejected',
      'rejected',
      'shadow',
    ]);
  });

  it('frees the shadow slot once the shadow is decided', async () => {
    await insertVersion('refit-2026-11-04', 'shadow');
    await db.query(
      `UPDATE lottery_score_versions SET status = 'passed'
        WHERE version = 'refit-2026-11-04'`,
    );

    await expect(
      insertVersion('refit-2026-11-05', 'shadow'),
    ).resolves.toBeDefined();
  });

  it('keeps one row per version id', async () => {
    await insertVersion(REFIT);

    await expect(insertVersion(REFIT)).rejects.toThrow(
      /lottery_score_versions_pkey/,
    );
  });

  it('rejects a NULL weights object: a CHECK passes on NULL, so NOT NULL is the only guard', async () => {
    await expect(
      db.query(
        `INSERT INTO lottery_score_versions (version, weights, status)
         VALUES ($1, NULL, 'rejected')`,
        [REFIT],
      ),
    ).rejects.toThrow(/null value in column "weights"/);
  });
});

describe('lottery_score_pointers', () => {
  it('rejects a pointer to an unknown version', async () => {
    await expect(
      db.query(
        `UPDATE lottery_score_pointers SET version = 'refit-2030-01-01'
          WHERE name = 'active'`,
      ),
    ).rejects.toThrow(/lottery_score_pointers_version_fkey/);
  });

  it.each(['shadow', 'ACTIVE', 'Takeit', 'candidate', ''])(
    'rejects the unknown pointer name %j',
    async (name) => {
      await expect(
        db.query(
          `INSERT INTO lottery_score_pointers (name, version)
           VALUES ($1, $2)`,
          [name, SEED],
        ),
      ).rejects.toThrow(/lottery_score_pointers_name_chk/);
    },
  );

  it('keeps one row per pointer name', async () => {
    await expect(
      db.query(
        `INSERT INTO lottery_score_pointers (name, version)
         VALUES ('active', $1)`,
        [SEED],
      ),
    ).rejects.toThrow(/lottery_score_pointers_pkey/);
  });

  it('refuses to delete a version a pointer still names', async () => {
    await expect(
      db.query(`DELETE FROM lottery_score_versions WHERE version = $1`, [SEED]),
    ).rejects.toThrow(/lottery_score_pointers_version_fkey/);
  });

  it('moves a pointer to a stored version', async () => {
    await insertVersion(REFIT, 'promoted');

    await db.query(
      `UPDATE lottery_score_pointers SET version = $1 WHERE name = 'active'`,
      [REFIT],
    );

    const { rows } = await db.query<{ version: string }>(
      `SELECT version FROM lottery_score_pointers WHERE name = 'active'`,
    );
    expect(rows).toEqual([{ version: REFIT }]);
  });
});

describe('lottery_fire_value_snapshots', () => {
  beforeEach(async () => {
    // The default snapshot is a score snapshot that names REFIT.
    await insertVersion(REFIT, 'promoted');
  });

  it('stores a score snapshot with its target version and stamps it in the database', async () => {
    await insertSnapshot();

    const { rows } = await db.query<{
      reason: string;
      column_name: string;
      to_version: string;
      fire_ids: string[];
      old_values: number[];
      old_tags: (string | null)[];
      taken_at_set: boolean;
    }>(
      `SELECT reason, column_name, to_version, fire_ids::text[] AS fire_ids,
              old_values, old_tags, taken_at IS NOT NULL AS taken_at_set
         FROM lottery_fire_value_snapshots`,
    );
    expect(rows).toEqual([
      {
        reason: 'promote-refit-2026-11-04',
        column_name: 'score',
        to_version: REFIT,
        fire_ids: ['101', '102'],
        old_values: [7.5, 8],
        old_tags: [SEED, null],
        taken_at_set: true,
      },
    ]);
  });

  it('stores a realized_flow_inversion_pct snapshot with no version', async () => {
    await expect(
      insertSnapshot({
        columnName: 'realized_flow_inversion_pct',
        toVersion: null,
      }),
    ).resolves.toBeDefined();
  });

  it('stores a NULL old value: a fire that had none yet', async () => {
    await expect(
      insertSnapshot({ oldValues: arr(null, 8) }),
    ).resolves.toBeDefined();
  });

  it('snapshot rows need a version exactly for scores', async () => {
    // A score snapshot with no version.
    await expect(insertSnapshot({ toVersion: null })).rejects.toThrow(
      /lottery_fire_value_snapshots_to_version_chk/,
    );
    // An inversion snapshot that names one.
    await expect(
      insertSnapshot({ columnName: 'realized_flow_inversion_pct' }),
    ).rejects.toThrow(/lottery_fire_value_snapshots_to_version_chk/);
  });

  it('rejects a version the store does not hold', async () => {
    await expect(
      insertSnapshot({ toVersion: 'refit-2030-01-01' }),
    ).rejects.toThrow(/lottery_fire_value_snapshots_to_version_fkey/);
  });

  it('refuses to delete a version a snapshot names', async () => {
    await insertSnapshot();

    await expect(
      db.query(`DELETE FROM lottery_score_versions WHERE version = $1`, [
        REFIT,
      ]),
    ).rejects.toThrow(/lottery_fire_value_snapshots_to_version_fkey/);
  });

  it.each(['price', 'SCORE', 'score_version', ''])(
    'rejects the column name %j',
    async (columnName) => {
      await expect(insertSnapshot({ columnName })).rejects.toThrow(
        /lottery_fire_value_snapshots_column_chk/,
      );
    },
  );

  it.each([
    ['old_values one short', { oldValues: arr(7.5) }],
    ['old_tags one short', { oldTags: arr(SEED) }],
    ['old_values one long', { oldValues: arr(7.5, 8, 9) }],
    ['old_tags one long', { oldTags: arr(SEED, SEED, SEED) }],
    ['fire_ids one long', { fireIds: arr(101, 102, 103) }],
    ['all three empty', { fireIds: '{}', oldValues: '{}', oldTags: '{}' }],
  ])('rejects arrays of unequal or zero length: %s', async (_name, over) => {
    await expect(insertSnapshot(over)).rejects.toThrow(
      /lottery_fire_value_snapshots_lengths_chk/,
    );
  });

  it('allows 50,000 ids and rejects 50,001', async () => {
    const bulk = (n: number) =>
      db.query(
        `INSERT INTO lottery_fire_value_snapshots
           (reason, column_name, to_version, fire_ids, old_values, old_tags)
         SELECT 'bulk-test', 'score', $2,
                ARRAY(SELECT g FROM generate_series(1, $1::int) g)::bigint[],
                ARRAY(SELECT g::float8 FROM generate_series(1, $1::int) g),
                array_fill(NULL::text, ARRAY[$1::int])`,
        [n, REFIT],
      );

    await expect(bulk(50_000)).resolves.toBeDefined();
    await expect(bulk(50_001)).rejects.toThrow(
      /lottery_fire_value_snapshots_lengths_chk/,
    );
  });

  it.each(['promote-refit-2026-11-04', 'a1', 'x-y', `a${'b'.repeat(40)}`])(
    'accepts the reason %j',
    async (reason) => {
      await expect(insertSnapshot({ reason })).resolves.toBeDefined();
    },
  );

  it.each([
    'a',
    'A1',
    '1ab',
    '-ab',
    'has space',
    'under_score',
    'trailing\n',
    `a${'b'.repeat(41)}`,
    '',
  ])('rejects the reason %j', async (reason) => {
    await expect(insertSnapshot({ reason })).rejects.toThrow(
      /lottery_fire_value_snapshots_reason_chk/,
    );
  });

  it.each(['fire_ids', 'old_values', 'old_tags'])(
    'rejects a NULL %s: a CHECK passes on NULL, so NOT NULL is the only guard',
    async (column) => {
      const cols = ['fire_ids', 'old_values', 'old_tags'].map((c) =>
        c === column ? 'NULL' : `'{1}'`,
      );
      await expect(
        db.query(
          `INSERT INTO lottery_fire_value_snapshots
             (reason, column_name, to_version, fire_ids, old_values, old_tags)
           VALUES ('null-test', 'score', $1,
                   ${cols[0]}::bigint[], ${cols[1]}::float8[], ${cols[2]}::text[])`,
          [REFIT],
        ),
      ).rejects.toThrow(new RegExp(`null value in column "${column}"`));
    },
  );
});
