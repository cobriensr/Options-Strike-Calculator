// @vitest-environment node

/**
 * REAL-SQL test for upsertFeatures' conflict clause.
 *
 * build-features.test.ts reads the statement's text, so it can say which
 * columns are written as `EXCLUDED.col` and which as COALESCE, but not what
 * Postgres then stores. This file sends upsertFeatures' ACTUAL statement to
 * pglite, over a training_features built from the real migrations, and reads
 * the row back: a default rebuild must keep a stored value its NULL cannot
 * replace, and an overwrite must replace it, NULL included.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration, neonOverPglite } from './pglite-migrations';

let pg: PGlite;

vi.mock('../_lib/db.js', () => ({
  getDb: () => neonOverPglite(pg),
}));

import { DP_COLUMNS, upsertFeatures } from '../_lib/build-features-upsert.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

// Every migration that creates training_features (#9) or adds a column the
// INSERT writes. Each stands alone, so they apply in order. Add the id of any
// migration that adds a training_features column the INSERT writes; until then
// this file's INSERT fails on the missing column. #214 adds only columns the
// INSERT does not write yet, so it is left out.
const TRAINING_FEATURES_MIGRATIONS = [
  9, 11, 21, 22, 24, 26, 29, 31, 33, 61, 213,
];

beforeAll(async () => {
  pg = await PGlite.create();
  for (const id of TRAINING_FEATURES_MIGRATIONS) await applyMigration(pg, id);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE training_features');
});

const DATE = '2026-04-07';

/** A rebuild that read every dark-pool value and VIX. */
const FIRST: FeatureRow = {
  date: DATE,
  vix: 18.5,
  dp_total_premium: 1500000,
  dp_cluster_count: 3,
  dp_top_cluster_dist: -12.5,
  dp_support_premium: 900000,
  dp_resistance_premium: 600000,
  dp_support_resistance_ratio: 1.5,
  dp_concentration: 0.4,
};

/**
 * A later rebuild: a new premium, a NULL ratio, the rest of the dark-pool
 * keys unset (no levels came back), and no VIX.
 */
const SECOND: FeatureRow = {
  date: DATE,
  dp_total_premium: 2500000,
  dp_support_resistance_ratio: null,
};

/** The stored row, every NUMERIC read as a number. */
async function stored(): Promise<Record<string, number | null>> {
  const selected = ['vix', ...DP_COLUMNS]
    .map((c) => c + '::float8 AS ' + c)
    .join(', ');
  const { rows } = await pg.query<Record<string, number | null>>(
    `SELECT ${selected} FROM training_features WHERE date = $1`,
    [DATE],
  );
  return rows[0]!;
}

const FIRST_STORED = {
  vix: 18.5,
  dp_total_premium: 1500000,
  dp_cluster_count: 3,
  dp_top_cluster_dist: -12.5,
  dp_support_premium: 900000,
  dp_resistance_premium: 600000,
  dp_support_resistance_ratio: 1.5,
  dp_concentration: 0.4,
};

describe('upsertFeatures real SQL', () => {
  it('stores a first row', async () => {
    await upsertFeatures(FIRST);

    expect(await stored()).toEqual(FIRST_STORED);
  });

  it('keeps every stored value a later NULL cannot replace, by default', async () => {
    await upsertFeatures(FIRST);
    await upsertFeatures(SECOND);

    // Only the one new value landed.
    expect(await stored()).toEqual({
      ...FIRST_STORED,
      dp_total_premium: 2500000,
    });
  });

  it('replaces the stored dark-pool values, NULL and unset included, with DP_COLUMNS', async () => {
    await upsertFeatures(FIRST);
    await upsertFeatures(SECOND, { overwrite: DP_COLUMNS });

    expect(await stored()).toEqual({
      vix: 18.5, // not in the list: still kept
      dp_total_premium: 2500000,
      dp_cluster_count: null,
      dp_top_cluster_dist: null,
      dp_support_premium: null,
      dp_resistance_premium: null,
      dp_support_resistance_ratio: null,
      dp_concentration: null,
    });
  });

  it('replaces only the columns it is given', async () => {
    await upsertFeatures(FIRST);
    await upsertFeatures(SECOND, { overwrite: ['vix'] });

    expect(await stored()).toEqual({
      ...FIRST_STORED,
      vix: null, // overwritten by the unset VIX
      dp_total_premium: 2500000, // new value, kept by COALESCE as before
    });
  });

  it('writes the same row for an empty overwrite list as for none', async () => {
    await upsertFeatures(FIRST);
    await upsertFeatures(SECOND, { overwrite: [] });

    expect(await stored()).toEqual({
      ...FIRST_STORED,
      dp_total_premium: 2500000,
    });
  });
});

describe('DP_COLUMNS against the real table', () => {
  it('are columns of training_features, in table order', async () => {
    const { rows } = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'training_features' AND column_name LIKE 'dp\\_%'
        ORDER BY ordinal_position`,
    );
    const tableDp = rows.map((r) => r.column_name);

    expect(tableDp.filter((c) => DP_COLUMNS.includes(c))).toEqual(DP_COLUMNS);
    // The three the upsert never writes (migration #21 added them).
    expect(tableDp.filter((c) => !DP_COLUMNS.includes(c))).toEqual([
      'dp_buyer_initiated',
      'dp_seller_initiated',
      'dp_net_bias',
    ]);
  });
});
