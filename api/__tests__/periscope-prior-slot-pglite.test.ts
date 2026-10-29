// @vitest-environment node

/**
 * REAL-SQL test for fetchPriorPeriscopeSlot's era bound (owner decision D1
 * revised, 2026-10-29). UW Periscope (scraper) and GEXBot slices measure
 * different things, so a GEXBot slice must never take a scraper slice as
 * its prior: a "sign flip" between them is a feed change, not a flip.
 *
 * The rows reproduce the production cutover on 2026-05-26: the last
 * scraper slice at 17:13:26.475Z and the first GEXBot slice at
 * 17:29:32.914Z. pglite is real Postgres in WASM; only the Neon driver is
 * replaced, with a Neon-shaped tagged template. The table comes from the
 * real migration #140.
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

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@neondatabase/serverless', () => ({ neon: () => holder.sql }));

import { _resetDb } from '../_lib/db.js';
import { fetchPriorPeriscopeSlot } from '../_lib/periscope-format.js';
import { applyMigration } from './pglite-migrations.js';

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await db.query(text, values)).rows;
  };
}

const EXPIRY = '2026-05-26';
const SCRAPER_EARLIER = '2026-05-26T17:03:26.000Z';
const SCRAPER_LAST = '2026-05-26T17:13:26.475Z';
const GEXBOT_FIRST = '2026-05-26T17:29:32.914Z';
const GEXBOT_SECOND = '2026-05-26T17:39:32.000Z';

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await applyMigration(pg, 140);
});

afterAll(async () => {
  await pg.close();
  process.env.DATABASE_URL = originalUrl;
  _resetDb();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM periscope_snapshots');
  for (const [at, value] of [
    [SCRAPER_EARLIER, 100],
    [SCRAPER_LAST, 200],
    [GEXBOT_FIRST, -300],
    [GEXBOT_SECOND, 400],
  ] as const) {
    await pg.query(
      `INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value)
       VALUES ($1, $2, 'gamma', 5000, $3)`,
      [at, EXPIRY, value],
    );
  }
});

describe('fetchPriorPeriscopeSlot — prior stays in the latest slice era', () => {
  it('gives the first GEXBot slice no prior, not the 17:13:26Z scraper slice', async () => {
    expect(await fetchPriorPeriscopeSlot(EXPIRY, GEXBOT_FIRST)).toBeNull();
  });

  it('pairs a later GEXBot slice with the previous GEXBot slice', async () => {
    const prior = await fetchPriorPeriscopeSlot(EXPIRY, GEXBOT_SECOND);
    expect(prior?.capturedAt).toBe(GEXBOT_FIRST);
    expect(prior?.gamma).toEqual([{ strike: 5000, value: -300 }]);
  });

  it('still pairs a scraper slice with the previous scraper slice', async () => {
    const prior = await fetchPriorPeriscopeSlot(EXPIRY, SCRAPER_LAST);
    expect(prior?.capturedAt).toBe(SCRAPER_EARLIER);
  });
});
