// @vitest-environment node

/**
 * REAL-SQL tests for the market-internals settle's database side
 * (api/_lib/market-internals-settle.ts). The cron tests mock the database and
 * can only match SQL text; this file runs the actual statements against
 * pglite (real Postgres in WASM) on the table built by the real migrations
 * #63 and #64, with the session timezone set away from New York so a bound
 * that leaned on it would fail.
 *
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5)
 *
 * Only the DB handle is replaced: getDb returns the pglite-backed client, with
 * the callback form of `transaction` that neon's driver offers.
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

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('../_lib/db.js', () => ({
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  allZeroSessions,
  diffBars,
  planSymbol,
  readStoredBars,
  sessionRowCounts,
  upsertInternalBars,
  type InternalBarRow,
  type SettleCandle,
} from '../_lib/market-internals-settle.js';

const MIN = 60_000;
let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 63);
  await applyMigration(pg, 64);
  await pg.query(`SET TimeZone = 'Asia/Tokyo'`);
  const base = neonOverPglite(pg);
  type Txn = typeof base;
  holder.sql = Object.assign(
    (strings: TemplateStringsArray, ...params: unknown[]) =>
      base(strings, ...params),
    {
      transaction: (queries: unknown) =>
        base.transaction(
          typeof queries === 'function'
            ? (queries as (txn: Txn) => Parameters<Txn['transaction']>[0])(base)
            : (queries as Parameters<Txn['transaction']>[0]),
        ),
    },
  );
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE market_internals');
});

const row = (
  ts: string,
  symbol: InternalBarRow['symbol'],
  open: number,
  high: number,
  low: number,
  close: number,
): InternalBarRow => ({ ts, symbol, open, high, low, close });

const minuteBars = (
  openIso: string,
  count: number,
  make: (i: number) => [number, number, number, number],
): SettleCandle[] => {
  const start = Date.parse(openIso);
  return Array.from({ length: count }, (_, i) => {
    const [open, high, low, close] = make(i);
    return { open, high, low, close, datetime: start + i * MIN };
  });
};

interface Stored {
  ts: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  xmin: string;
  ctid: string;
}

async function stored(symbol?: string): Promise<Stored[]> {
  const { rows } = await pg.query<Stored>(
    `SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS ts, symbol,
            open::float8 AS open, high::float8 AS high, low::float8 AS low,
            close::float8 AS close, xmin::text AS xmin, ctid::text AS ctid
       FROM market_internals
      WHERE $1::text IS NULL OR symbol = $1
      ORDER BY symbol, ts`,
    [symbol ?? null],
  );
  return rows;
}

/** Seed rows straight into the table (what the old cron left behind). */
async function seed(rows: InternalBarRow[]): Promise<void> {
  await pg.query(
    `INSERT INTO market_internals (ts, symbol, open, high, low, close)
     SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::numeric[],
                          $4::numeric[], $5::numeric[], $6::numeric[])`,
    [
      rows.map((r) => r.ts),
      rows.map((r) => r.symbol),
      rows.map((r) => r.open),
      rows.map((r) => r.high),
      rows.map((r) => r.low),
      rows.map((r) => r.close),
    ],
  );
}

describe('upsertInternalBars', () => {
  it('inserts new rows and counts them as inserted', async () => {
    const result = await upsertInternalBars([
      row('2026-11-06T14:30:00.000Z', '$TICK', 832, 837, 673, 682),
      row('2026-11-06T14:31:00.000Z', '$TICK', 675, 713, -464, -470),
    ]);

    expect(result.counts).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect([...result.changed]).toEqual([
      ['2026-11-06T14:30:00.000Z', 'inserted'],
      ['2026-11-06T14:31:00.000Z', 'inserted'],
    ]);
    const rows = await stored();
    expect(rows.map((r) => [r.ts, r.symbol, r.open, r.low, r.close])).toEqual([
      ['2026-11-06T14:30', '$TICK', 832, 673, 682],
      ['2026-11-06T14:31', '$TICK', 675, -464, -470],
    ]);
  });

  it('replaces a stored clamped $TICK row with the settled one', async () => {
    // What the live feed stored: the negative minute clamped to all zeros.
    await seed([row('2026-11-06T14:31:00.000Z', '$TICK', 0, 0, 0, 0)]);

    const result = await upsertInternalBars([
      row('2026-11-06T14:31:00.000Z', '$TICK', 34, 51, -170, -120),
    ]);

    expect(result.counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect([...result.changed]).toEqual([
      ['2026-11-06T14:31:00.000Z', 'updated'],
    ]);
    const [only, ...rest] = await stored();
    expect(rest).toEqual([]);
    expect([only!.open, only!.high, only!.low, only!.close]).toEqual([
      34, 51, -170, -120,
    ]);
  });

  it('replaces a flat zero $ADD row (the /quotes placeholder) with the settled bar', async () => {
    await seed([row('2026-11-06T14:30:00.000Z', '$ADD', 0, 0, 0, 0)]);
    const result = await upsertInternalBars([
      row('2026-11-06T14:30:00.000Z', '$ADD', 200, 1151, 200, 980),
    ]);
    expect(result.counts.updated).toBe(1);
    expect((await stored('$ADD'))[0]).toMatchObject({
      open: 200,
      high: 1151,
      low: 200,
      close: 980,
    });
  });

  it('does not rewrite a row that already holds the values', async () => {
    const same = row('2026-11-06T14:30:00.000Z', '$TRIN', 0.83, 0.9, 0.8, 0.85);
    await upsertInternalBars([same]);
    const before = await stored();

    const result = await upsertInternalBars([same]);

    expect(result.counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(result.changed.size).toBe(0);
    // No new tuple version: the same xmin and the same physical position.
    expect(await stored()).toEqual(before);
  });

  it('rewrites only the rows that differ when a batch mixes all three outcomes', async () => {
    await seed([
      row(
        '2026-11-06T14:30:00.000Z',
        '$VOLD',
        7025605,
        9000000,
        7000000,
        8000000,
      ),
      row('2026-11-06T14:31:00.000Z', '$VOLD', 0, 0, 0, 0),
    ]);
    const before = await stored();

    const result = await upsertInternalBars([
      row(
        '2026-11-06T14:30:00.000Z',
        '$VOLD',
        7025605,
        9000000,
        7000000,
        8000000,
      ),
      row(
        '2026-11-06T14:31:00.000Z',
        '$VOLD',
        8000000,
        9100000,
        7900000,
        9000000,
      ),
      row(
        '2026-11-06T14:32:00.000Z',
        '$VOLD',
        9000000,
        9500000,
        8800000,
        9400000,
      ),
    ]);

    expect(result.counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    const after = await stored();
    expect(after[0]!.xmin).toBe(before[0]!.xmin); // untouched
    expect(after[1]!.xmin).not.toBe(before[1]!.xmin); // rewritten
    expect(after).toHaveLength(3);
  });

  it('keeps a symbol apart: the same minute of another symbol is its own row', async () => {
    await seed([row('2026-11-06T14:30:00.000Z', '$ADD', 1, 2, 0, 1)]);
    const result = await upsertInternalBars([
      row('2026-11-06T14:30:00.000Z', '$TICK', 5, 6, 4, 5),
    ]);
    expect(result.counts.inserted).toBe(1);
    expect(await stored()).toHaveLength(2);
  });

  it('writes more than one 500-row chunk in a single transaction', async () => {
    const start = Date.parse('2026-11-06T14:30:00Z');
    const rows = Array.from({ length: 1_203 }, (_, i) =>
      row(new Date(start + i * MIN).toISOString(), '$ADD', i, i + 1, i - 1, i),
    );

    const result = await upsertInternalBars(rows);

    expect(result.counts).toEqual({
      inserted: 1_203,
      updated: 0,
      unchanged: 0,
    });
    expect(await stored()).toHaveLength(1_203);
    const again = await upsertInternalBars(rows);
    expect(again.counts).toEqual({ inserted: 0, updated: 0, unchanged: 1_203 });
  });

  it('stores doubles exactly: they read back equal, so an unchanged row stays unchanged', async () => {
    const tricky = row(
      '2026-11-06T14:30:00.000Z',
      '$TRIN',
      0.1 + 0.2,
      0.8300000000000001,
      1e-7,
      126111323.5,
    );
    await upsertInternalBars([tricky]);
    const [back] = await stored();
    expect([back!.open, back!.high, back!.low, back!.close]).toEqual([
      0.1 + 0.2,
      0.8300000000000001,
      1e-7,
      126111323.5,
    ]);
    const second = await upsertInternalBars([tricky]);
    expect(second.counts.unchanged).toBe(1);
  });

  it('a rejected write throws and leaves nothing of the batch behind', async () => {
    const start = Date.parse('2026-11-06T14:30:00Z');
    const good = Array.from({ length: 500 }, (_, i) =>
      row(new Date(start + i * MIN).toISOString(), '$ADD', 1, 2, 0, 1),
    );
    // The second chunk holds a timestamp Postgres cannot read.
    const bad = row('not-a-time', '$ADD', 1, 2, 0, 1);

    await expect(upsertInternalBars([...good, bad])).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });

  it('is a no-op for no rows', async () => {
    const result = await upsertInternalBars([]);
    expect(result.counts).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
  });
});

describe('readStoredBars and diffBars: the dry run agrees with the real upsert', () => {
  it('reads the window as ISO strings and numbers, leaving out other symbols and other days', async () => {
    await seed([
      row('2026-11-05T21:30:00.000Z', '$ADD', 9, 9, 9, 9), // before the window
      row('2026-11-06T14:30:00.000Z', '$ADD', 1, 2, 0, 1),
      row('2026-11-06T14:30:00.000Z', '$TICK', 5, 6, 4, 5),
      row('2026-11-06T21:00:00.000Z', '$ADD', 7, 7, 7, 7), // the close itself
    ]);

    expect(await readStoredBars('$ADD', ['2026-11-06'])).toEqual([
      { ts: '2026-11-06T14:30:00.000Z', open: 1, high: 2, low: 0, close: 1 },
    ]);
  });

  it('predicts the counts the upsert then returns', async () => {
    const candles = minuteBars('2026-11-06T14:30:00Z', 390, (i) => [
      100 + i,
      110 + i,
      90 + i,
      105 + i,
    ]);
    const plan = planSymbol('$ADD', candles, ['2026-11-06']);
    // 10 rows already right, 5 stored as the zero placeholder.
    await seed([
      ...plan.rows.slice(0, 10),
      ...plan.rows.slice(10, 15).map((r) => row(r.ts, r.symbol, 0, 0, 0, 0)),
    ]);

    const predicted = diffBars(
      plan.rows,
      await readStoredBars('$ADD', ['2026-11-06']),
    );
    const applied = await upsertInternalBars(plan.rows);

    expect(predicted.counts).toEqual({
      inserted: 375,
      updated: 5,
      unchanged: 10,
    });
    expect(applied.counts).toEqual(predicted.counts);
    expect([...applied.changed]).toEqual([...predicted.changed]);
  });
});

describe('sessionRowCounts', () => {
  it('counts rows per symbol and session, and how many are not all-zero', async () => {
    await seed([
      // $ADD stored as the /quotes placeholder all session.
      ...Array.from({ length: 390 }, (_, i) =>
        row(
          new Date(Date.parse('2026-11-06T14:30:00Z') + i * MIN).toISOString(),
          '$ADD',
          0,
          0,
          0,
          0,
        ),
      ),
      // $TICK is fine.
      ...Array.from({ length: 390 }, (_, i) =>
        row(
          new Date(Date.parse('2026-11-06T14:30:00Z') + i * MIN).toISOString(),
          '$TICK',
          5,
          9,
          -3,
          2,
        ),
      ),
    ]);

    const counts = await sessionRowCounts(['2026-11-06']);

    expect(counts).toEqual([
      { symbol: '$ADD', date: '2026-11-06', total: 390, nonzero: 0 },
      { symbol: '$TICK', date: '2026-11-06', total: 390, nonzero: 390 },
    ]);
    // The F9 regression: $ADD all zero must be flagged although $TICK is not.
    expect(allZeroSessions(counts).map((c) => c.symbol)).toEqual(['$ADD']);
  });

  it('counts a bar with only some fields zero as non-zero', async () => {
    await seed(
      Array.from({ length: 12 }, (_, i) =>
        row(
          new Date(Date.parse('2026-11-06T14:30:00Z') + i * MIN).toISOString(),
          '$TICK',
          0,
          0,
          -4,
          0,
        ),
      ),
    );
    expect(await sessionRowCounts(['2026-11-06'])).toEqual([
      { symbol: '$TICK', date: '2026-11-06', total: 12, nonzero: 12 },
    ]);
  });

  it('counts only rows inside the session: extended-hours rows cannot hide a dead session', async () => {
    await seed([
      row('2026-11-06T14:29:00.000Z', '$ADD', 5, 5, 5, 5), // 09:29 ET, before the open
      row('2026-11-06T14:30:00.000Z', '$ADD', 0, 0, 0, 0), // 09:30 ET, in
      row('2026-11-06T20:59:00.000Z', '$ADD', 0, 0, 0, 0), // 15:59 ET, in
      row('2026-11-06T21:00:00.000Z', '$ADD', 5, 5, 5, 5), // 16:00 ET, out
      row('2026-11-06T23:30:00.000Z', '$ADD', 5, 5, 5, 5), // 18:30 ET, out
    ]);
    expect(await sessionRowCounts(['2026-11-06'])).toEqual([
      { symbol: '$ADD', date: '2026-11-06', total: 2, nonzero: 0 },
    ]);
  });

  it('follows the clock: EST and EDT sessions, and the half-day close', async () => {
    await seed([
      // 2026-03-06 is EST: open 14:30Z. 13:30Z is before it.
      row('2026-03-06T13:30:00.000Z', '$ADD', 1, 1, 1, 1),
      row('2026-03-06T14:30:00.000Z', '$ADD', 1, 1, 1, 1),
      // 2026-03-09 is EDT (DST began 03-08): open 13:30Z. 13:29Z is before it.
      row('2026-03-09T13:29:00.000Z', '$ADD', 1, 1, 1, 1),
      row('2026-03-09T13:30:00.000Z', '$ADD', 1, 1, 1, 1),
      // 2026-11-27 is the half day: the close is 13:00 ET = 18:00Z.
      row('2026-11-27T17:59:00.000Z', '$ADD', 1, 1, 1, 1),
      row('2026-11-27T18:00:00.000Z', '$ADD', 1, 1, 1, 1),
    ]);
    const counts = await sessionRowCounts([
      '2026-03-06',
      '2026-03-09',
      '2026-11-27',
    ]);
    expect(counts.map((c) => [c.date, c.total])).toEqual([
      ['2026-03-06', 1],
      ['2026-03-09', 1],
      ['2026-11-27', 1],
    ]);
  });

  it('is empty for no sessions and for sessions with no rows', async () => {
    expect(await sessionRowCounts([])).toEqual([]);
    expect(await sessionRowCounts(['2026-11-06'])).toEqual([]);
  });
});
