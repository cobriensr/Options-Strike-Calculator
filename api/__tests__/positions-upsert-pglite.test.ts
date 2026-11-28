// @vitest-environment node

/**
 * REAL-SQL test for savePositions' upsert on positions UNIQUE(date,
 * fetch_time), and for getLatestCsvPositions.
 *
 * db-positions.test.ts mocks the driver, so it can only match the guard's
 * text. This file runs the statements against pglite (real Postgres in
 * WASM), on the table migration #1 builds, to pin which save may replace an
 * existing row: a Schwab save never replaces a paperMoney CSV row in the
 * same (date, CT minute); a CSV save replaces any row in its minute.
 *
 * Only the Neon driver is replaced: getDb() gets a Neon-shaped tagged
 * template over pglite, so initDb, withDbRetry, savePositions and
 * getLatestCsvPositions all run as in production.
 *
 * initDb() supplies market_snapshots, which positions.snapshot_id references.
 * Migrations #17 (created_at NOT NULL) and #18 (the legs-is-an-array CHECK)
 * alter many tables at once and are not applied here; neither touches the
 * guard.
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

import {
  _resetDb,
  getLatestCsvPositions,
  initDb,
  savePositions,
  type PositionInput,
  type PositionLeg,
} from '../_lib/db.js';
import { applyMigration } from './pglite-migrations';

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await db.query(text, values)).rows;
  };
}

/** The migration that creates the positions table. */
const POSITIONS_TABLE_ID = 1;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await initDb();
  await applyMigration(pg, POSITIONS_TABLE_ID);
});

afterAll(async () => {
  await pg.close();
  _resetDb();
  process.env.DATABASE_URL = originalUrl;
});

beforeEach(async () => {
  await pg.query('TRUNCATE positions RESTART IDENTITY');
});

const KEY = { date: '2026-06-08', fetchTime: '10:15' };

const CSV_LEGS: PositionLeg[] = [
  {
    putCall: 'CALL',
    symbol: 'SPXW  260608C06900000',
    strike: 6900,
    expiration: '2026-06-08',
    quantity: -1,
    averagePrice: 2,
    marketValue: -150,
  },
];
const SCHWAB_LEGS: PositionLeg[] = [
  {
    putCall: 'PUT',
    symbol: 'SPXW260608P6700',
    strike: 6700,
    expiration: '2026-06-08',
    quantity: -2,
    averagePrice: 1.5,
    marketValue: -200,
  },
];

function csvSave(over: Partial<PositionInput> = {}): PositionInput {
  return {
    ...KEY,
    accountHash: 'paperMoney',
    summary: 'csv summary',
    legs: CSV_LEGS,
    totalSpreads: 1,
    callSpreads: 1,
    netDelta: -0.2,
    unrealizedPnl: 40,
    ...over,
  };
}

function schwabSave(over: Partial<PositionInput> = {}): PositionInput {
  return {
    ...KEY,
    accountHash: 'hash1',
    summary: 'schwab summary',
    legs: SCHWAB_LEGS,
    totalSpreads: 2,
    putSpreads: 2,
    netDelta: 0.5,
    unrealizedPnl: -10,
    ...over,
  };
}

interface StoredRow {
  account_hash: string;
  summary: string;
  legs: PositionLeg[];
}

/** The rows stored for (date, fetchTime), the key's own by default. */
async function stored(
  date = KEY.date,
  fetchTime = KEY.fetchTime,
): Promise<StoredRow[]> {
  const res = await pg.query<StoredRow>(
    `SELECT account_hash, summary, legs FROM positions
     WHERE date = $1 AND fetch_time = $2`,
    [date, fetchTime],
  );
  return res.rows;
}

/** Every column of every row, for a before/after comparison. */
async function everything(): Promise<Record<string, unknown>[]> {
  const res = await pg.query<Record<string, unknown>>(
    'SELECT * FROM positions ORDER BY id',
  );
  return res.rows;
}

describe('savePositions upsert against Postgres (pglite)', () => {
  it.each([
    ['a CSV save', csvSave],
    ['a Schwab save', schwabSave],
  ])('%s inserts a new (date, minute) and returns its id', async (_l, make) => {
    const id = await savePositions(make());

    expect(id).toEqual(expect.any(Number));
    expect(await stored()).toHaveLength(1);
  });

  it('a CSV row, then a Schwab save in the same minute: the CSV row is kept and the save returns null', async () => {
    const csvId = await savePositions(csvSave());
    expect(csvId).toEqual(expect.any(Number));

    const schwabId = await savePositions(schwabSave());

    // RETURNING yields no row when the conflict update is skipped.
    expect(schwabId).toBeNull();
    expect(await stored()).toEqual([
      { account_hash: 'paperMoney', summary: 'csv summary', legs: CSV_LEGS },
    ]);
  });

  it('a Schwab save leaves every column of the CSV row alone, not just account_hash', async () => {
    await savePositions(csvSave({ spxPrice: 6850.5, totalCredit: 100 }));
    const before = await everything();
    expect(before).toHaveLength(1);

    await savePositions(schwabSave({ spxPrice: 6900, totalCredit: 5 }));

    expect(await everything()).toEqual(before);
  });

  it('a Schwab row, then a CSV in the same minute: the CSV replaces it and keeps the row id', async () => {
    const schwabId = await savePositions(schwabSave());

    const csvId = await savePositions(csvSave());

    expect(csvId).toBe(schwabId);
    expect(await stored()).toEqual([
      { account_hash: 'paperMoney', summary: 'csv summary', legs: CSV_LEGS },
    ]);
  });

  it('a CSV, then a second CSV in the same minute: the second replaces the first', async () => {
    const first = await savePositions(csvSave());
    const secondLegs: PositionLeg[] = [];

    const second = await savePositions(
      csvSave({ summary: 'second csv', legs: secondLegs }),
    );

    expect(second).toBe(first);
    expect(await stored()).toEqual([
      { account_hash: 'paperMoney', summary: 'second csv', legs: secondLegs },
    ]);
  });

  it('a Schwab row, then a Schwab save in the same minute: replaced, as before the guard', async () => {
    const first = await savePositions(schwabSave());

    const second = await savePositions(
      schwabSave({ summary: 'schwab again', legs: [] }),
    );

    expect(second).toBe(first);
    expect(await stored()).toEqual([
      { account_hash: 'hash1', summary: 'schwab again', legs: [] },
    ]);
  });

  it('a Schwab save in another minute inserts a row beside the CSV row', async () => {
    await savePositions(csvSave());

    const id = await savePositions(schwabSave({ fetchTime: '10:16' }));

    expect(id).toEqual(expect.any(Number));
    expect(await stored(KEY.date, '10:15')).toHaveLength(1);
    expect(await stored(KEY.date, '10:16')).toEqual([
      { account_hash: 'hash1', summary: 'schwab summary', legs: SCHWAB_LEGS },
    ]);
  });

  it('a Schwab save on another date in the same minute inserts too', async () => {
    await savePositions(csvSave());

    const id = await savePositions(schwabSave({ date: '2026-06-09' }));

    expect(id).toEqual(expect.any(Number));
    expect(await stored('2026-06-08', KEY.fetchTime)).toEqual([
      { account_hash: 'paperMoney', summary: 'csv summary', legs: CSV_LEGS },
    ]);
  });
});

describe('getLatestCsvPositions against Postgres (pglite)', () => {
  /** Give the row at `fetchTime` a known created_at, so "newest" is fixed. */
  async function stamp(fetchTime: string, createdAt: string) {
    await pg.query(
      'UPDATE positions SET created_at = $1 WHERE date = $2 AND fetch_time = $3',
      [createdAt, KEY.date, fetchTime],
    );
  }

  it('returns null when the date has no row at all', async () => {
    expect(await getLatestCsvPositions(KEY.date)).toBeNull();
  });

  it('returns null when the date has only Schwab rows', async () => {
    await savePositions(schwabSave());

    expect(await getLatestCsvPositions(KEY.date)).toBeNull();
  });

  it('returns the newest CSV row of the date, not an older CSV and not a newer Schwab row', async () => {
    const olderLegs: PositionLeg[] = [
      CSV_LEGS[0]!,
      { ...CSV_LEGS[0]!, strike: 6925, quantity: 1 },
    ];
    await savePositions(csvSave({ fetchTime: '09:40', legs: olderLegs }));
    await savePositions(csvSave({ fetchTime: '10:15' }));
    await savePositions(schwabSave({ fetchTime: '10:30' }));
    await stamp('09:40', '2026-06-08T14:40:00Z');
    await stamp('10:15', '2026-06-08T15:15:00Z');
    await stamp('10:30', '2026-06-08T15:30:00Z');

    expect(await getLatestCsvPositions(KEY.date)).toEqual({
      legs: CSV_LEGS,
      fetchTime: '10:15',
    });
  });

  it('ignores other dates', async () => {
    await savePositions(csvSave({ date: '2026-06-05' }));

    expect(await getLatestCsvPositions(KEY.date)).toBeNull();
    expect(await getLatestCsvPositions('2026-06-05')).toEqual({
      legs: CSV_LEGS,
      fetchTime: '10:15',
    });
  });

  it('a CSV with no open legs is still the newest CSV row', async () => {
    await savePositions(csvSave({ fetchTime: '09:40' }));
    await savePositions(csvSave({ fetchTime: '11:02', legs: [] }));
    await stamp('09:40', '2026-06-08T14:40:00Z');
    await stamp('11:02', '2026-06-08T16:02:00Z');

    expect(await getLatestCsvPositions(KEY.date)).toEqual({
      legs: [],
      fetchTime: '11:02',
    });
  });

  it('after an upload and a plain GET in the same minute, still answers the CSV legs', async () => {
    // The scenario the guard exists for: another tab's plain GET lands in the
    // minute of the upload and must not turn the row into the live account's.
    await savePositions(csvSave());
    await savePositions(schwabSave());

    expect(await getLatestCsvPositions(KEY.date)).toEqual({
      legs: CSV_LEGS,
      fetchTime: KEY.fetchTime,
    });
  });
});
