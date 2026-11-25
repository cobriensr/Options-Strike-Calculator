// @vitest-environment node

/**
 * upsertFeatures through the REAL @neondatabase/serverless client.
 *
 * The overwrite path hands the client a strings array it built, not one a
 * template literal made. The client throws on an array with no `raw`
 * ("can now be called only as a tagged-template function"), and neither the
 * mocked `sql` of build-features.test.ts nor the pglite executor checks that.
 * Here the client's fetch is a local stub, so nothing leaves the process, and
 * each test reads the request body the client would have posted.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureRow } from '../_lib/build-features-types.js';

interface Posted {
  query: string;
  params: unknown[];
}

const posted: Posted[] = [];
let sql: unknown;

// Read when a test calls getDb(), after beforeAll has built the client.
vi.mock('../_lib/db.js', () => ({
  getDb: () => sql,
}));

import { upsertFeatures } from '../_lib/build-features-upsert.js';

// The suite's setup replaces neon() with a function that throws, for every
// test file. The real one is taken here on purpose: its fetch is the local
// stub below, so it never connects, and the network block (src/__tests__/
// net-guard.ts) still sits beneath it and fails the test on any outside host.
beforeAll(async () => {
  const actual = await vi.importActual<
    typeof import('@neondatabase/serverless')
  >('@neondatabase/serverless');
  actual.neonConfig.fetchFunction = async (
    _url: string,
    init: { body: string },
  ) => {
    posted.push(JSON.parse(init.body) as Posted);
    return new Response(
      JSON.stringify({ rows: [], fields: [], command: 'INSERT', rowCount: 0 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  sql = actual.neon('postgresql://user:pw@ep-test.neon.invalid/db');
});

const ROW: FeatureRow = {
  date: '2026-04-07',
  vix: 18.5,
  dp_concentration: null,
};

/** The INSERT's column list, in order, from the posted query. */
function columnsOf(query: string): string[] {
  const list = /INSERT INTO training_features\s*\(([^)]*)\)/.exec(query)![1]!;
  return list.split(',').map((c) => c.trim());
}

beforeEach(() => {
  posted.length = 0;
});

describe('upsertFeatures through the real Neon client', () => {
  it('posts the default statement with COALESCE on every column', async () => {
    await upsertFeatures(ROW);

    expect(posted).toHaveLength(1);
    const { query, params } = posted[0]!;
    const columns = columnsOf(query);
    expect(params).toHaveLength(columns.length);
    expect(query).toContain('$1');
    expect(query).toContain(`$${columns.length}`);
    expect(query).toContain(
      'dp_concentration = COALESCE(EXCLUDED.dp_concentration, training_features.dp_concentration)',
    );
    expect(query).not.toMatch(/= EXCLUDED\./);
  });

  it('accepts the overwrite statement and posts EXCLUDED for the named column only', async () => {
    // Without a `raw` array on the strings the client throws here, before any
    // request is made.
    await upsertFeatures(ROW, { overwrite: ['dp_concentration'] });

    expect(posted).toHaveLength(1);
    const { query, params } = posted[0]!;
    const columns = columnsOf(query);
    expect(query).toContain('dp_concentration = EXCLUDED.dp_concentration');
    expect(query).not.toContain('dp_concentration = COALESCE');
    expect(query).toContain(
      'vix = COALESCE(EXCLUDED.vix, training_features.vix)',
    );
    // Values still travel as parameters, the date first and the null as null.
    expect(params).toHaveLength(columns.length);
    expect(params[0]).toBe('2026-04-07');
    expect(params[columns.indexOf('vix')]).toBe('18.5');
    expect(params[columns.indexOf('dp_concentration')]).toBeNull();
  });

  it('posts nothing for a name that is not a feature column', async () => {
    await expect(
      upsertFeatures(ROW, { overwrite: ['dp_concentration', 'not_a_column'] }),
    ).rejects.toThrow(TypeError);

    expect(posted).toHaveLength(0);
  });
});
