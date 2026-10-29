// @vitest-environment node

/**
 * REAL-SQL test: getStrikeExposures returns today's (0DTE) expiry only.
 *
 * fetch-strike-exposure writes the 0DTE and the next expiry's rows under
 * the same (date, timestamp). The reader used to filter only the
 * all-expiry sentinel, so the "SPX 0DTE Per-Strike Greek Profile",
 * zero-gamma and the get_strike_exposures Claude tool blended tomorrow's
 * expiry in (prod 2026-10-29 18:05Z: 81 rows for 10-29 plus 81 for 10-30,
 * the 1DTE rows ~58% of total |γ|).
 *
 * pglite is real Postgres in WASM; only the Neon driver is replaced, with
 * a Neon-shaped tagged template. The table comes from the real migration #8.
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
import { getStrikeExposures } from '../_lib/db-strike-helpers.js';
import { analyzeZeroGamma } from '../../src/utils/zero-gamma.js';
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

const DATE = '2026-10-29';
const NEXT_EXPIRY = '2026-10-30';
const ALL_EXPIRY = '1970-01-01';
const T1 = '2026-10-29T18:05:00Z';
/** A later snapshot that only the next expiry has. */
const T2 = '2026-10-29T18:10:00Z';

async function insertRow(
  timestamp: string,
  expiry: string,
  strike: number,
  gamma: number,
): Promise<void> {
  await pg.query(
    `INSERT INTO strike_exposures
       (date, timestamp, ticker, expiry, strike, price, call_gamma_oi, put_gamma_oi)
     VALUES ($1, $2, 'SPX', $3, $4, 6860, $5, 0)`,
    [DATE, timestamp, expiry, strike, gamma],
  );
}

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await applyMigration(pg, 8);
});

afterAll(async () => {
  await pg.close();
  process.env.DATABASE_URL = originalUrl;
  _resetDb();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM strike_exposures');
  // 0DTE: cumulative −300, −200, +200 → one flip between 6850 and 6900.
  for (const [strike, gamma] of [
    [6800, -300],
    [6850, 100],
    [6900, 400],
  ] as const) {
    await insertRow(T1, DATE, strike, gamma);
  }
  // Next expiry, same snapshot: large positive gamma that, blended in,
  // removes the 0DTE flip.
  for (const strike of [6800, 6850, 6900]) {
    await insertRow(T1, NEXT_EXPIRY, strike, 1000);
    await insertRow(T1, ALL_EXPIRY, strike, 5000);
  }
  await insertRow(T2, NEXT_EXPIRY, 6850, 999);
});

describe('getStrikeExposures — 0DTE expiry only', () => {
  it("returns only today's expiry, from today's latest 0DTE snapshot", async () => {
    const rows = await getStrikeExposures(DATE);
    expect(rows.map((r) => [r.strike, r.netGamma])).toEqual([
      [6800, -300],
      [6850, 100],
      [6900, 400],
    ]);
  });

  it('applies the same filter with an asOf cap', async () => {
    const rows = await getStrikeExposures(DATE, 'SPX', T2);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.netGamma !== 1000 && r.netGamma !== 999)).toBe(
      true,
    );
  });

  it('feeds zero-gamma from the 0DTE profile alone', async () => {
    const rows = await getStrikeExposures(DATE);
    const zg = analyzeZeroGamma(
      rows.map((r) => ({ strike: r.strike, netGamma: r.netGamma })),
      6860,
      null,
    );
    expect(zg.zeroGammaStrike).not.toBeNull();
    expect(zg.zeroGammaStrike!).toBeGreaterThan(6850);
    expect(zg.zeroGammaStrike!).toBeLessThan(6900);
  });
});
