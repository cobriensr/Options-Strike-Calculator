// @vitest-environment node

/**
 * REAL-SQL test for the closed-bucket upsert and the session row count shared
 * by fetch-etf-tide and fetch-zero-dte-flow. The cron tests mock the database
 * and can only match the SQL text; this file runs the actual statements
 * against pglite (real Postgres in WASM) on the table built by the real
 * migration #4, with the session in UTC as on Neon.
 *
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md
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
}));

import {
  sessionRowCounts,
  upsertClosedBuckets,
} from '../_lib/flow-bucket-store.js';
import {
  closedBuckets,
  type ClosedBucket,
  type TideMinute,
} from '../_lib/closed-buckets.js';

const SOURCE = 'spy_etf_tide';
const DATE = '2026-03-24'; // EDT: 09:30 ET is 13:30Z, 16:00 ET is 20:00Z

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 4);
  await pg.query(`SET TimeZone = 'UTC'`);
  const base = neonOverPglite(pg);
  type Txn = typeof base;
  holder.sql = Object.assign(
    (strings: TemplateStringsArray, ...params: unknown[]) =>
      base(strings, ...params),
    {
      // neon accepts a callback that receives the tagged template; the
      // helper takes the queries it builds.
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
  await pg.query('TRUNCATE flow_data RESTART IDENTITY');
});

const bucket = (
  hhmmZ: string,
  ncp: number,
  npp: number,
  netVolume: number | null,
): ClosedBucket => ({
  timestamp: `${DATE}T${hhmmZ}:00.000Z`,
  ncp,
  npp,
  netVolume,
});

interface StoredRow {
  id: number;
  timestamp: string;
  ncp: number | null;
  npp: number | null;
  net_volume: number | null;
  created_at: string;
}

async function stored(source = SOURCE): Promise<StoredRow[]> {
  const { rows } = await pg.query<StoredRow>(
    `SELECT id, to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS timestamp,
            ncp::float8 AS ncp, npp::float8 AS npp, net_volume,
            created_at::text AS created_at
       FROM flow_data WHERE source = $1 ORDER BY timestamp`,
    [source],
  );
  return rows;
}

async function insertRaw(
  date: string,
  timestamp: string,
  source: string,
  ncp: number | null,
  npp: number | null,
) {
  await pg.query(
    `INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [date, timestamp, source, ncp, npp],
  );
}

describe('upsertClosedBuckets', () => {
  it('inserts new buckets and counts them as inserted', async () => {
    const counts = await upsertClosedBuckets(
      [bucket('13:35', 100.5, -20.25, 7), bucket('13:40', 200, -40, 9)],
      SOURCE,
      DATE,
    );

    expect(counts).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    const rows = await stored();
    expect(rows.map((r) => [r.timestamp, r.ncp, r.npp, r.net_volume])).toEqual([
      ['13:35', 100.5, -20.25, 7],
      ['13:40', 200, -40, 9],
    ]);
  });

  it('leaves a bucket that already holds the same values untouched (no write)', async () => {
    const first = [bucket('13:35', 100.5, -20.25, 7)];
    await upsertClosedBuckets(first, SOURCE, DATE);
    const before = await stored();

    const counts = await upsertClosedBuckets(first, SOURCE, DATE);

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await stored()).toEqual(before);
  });

  it('updates a bucket whose value UW revised, keeping its id and created_at', async () => {
    await upsertClosedBuckets([bucket('13:35', 100, -20, 7)], SOURCE, DATE);
    const [before] = await stored();

    const counts = await upsertClosedBuckets(
      [bucket('13:35', 130.5, -20, 7)],
      SOURCE,
      DATE,
    );

    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [after] = await stored();
    expect(after).toEqual({ ...before, ncp: 130.5 });
    expect(after?.id).toBe(before?.id);
    expect(after?.created_at).toBe(before?.created_at);
  });

  it.each([
    ['ncp', bucket('13:35', 101, -20, 7)],
    ['npp', bucket('13:35', 100, -21, 7)],
    ['net_volume', bucket('13:35', 100, -20, 8)],
  ])('treats a revised %s alone as a change', async (_column, revised) => {
    await upsertClosedBuckets([bucket('13:35', 100, -20, 7)], SOURCE, DATE);
    const counts = await upsertClosedBuckets([revised], SOURCE, DATE);
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
  });

  it('counts a mixed batch: one new, one revised, one unchanged', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7), bucket('13:40', 200, -40, 9)],
      SOURCE,
      DATE,
    );

    const counts = await upsertClosedBuckets(
      [
        bucket('13:35', 100, -20, 7), // unchanged
        bucket('13:40', 250, -40, 9), // revised
        bucket('13:45', 300, -60, 11), // new
      ],
      SOURCE,
      DATE,
    );

    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect((await stored()).map((r) => r.ncp)).toEqual([100, 250, 300]);
  });

  it('stores a NULL net_volume, and a NULL that stays NULL is not a change', async () => {
    const nullVolume = [bucket('13:35', 100, -20, null)];
    expect(await upsertClosedBuckets(nullVolume, SOURCE, DATE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect((await stored())[0]?.net_volume).toBeNull();

    // NULL IS DISTINCT FROM NULL is false: no rewrite.
    expect(await upsertClosedBuckets(nullVolume, SOURCE, DATE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });

    // UW later sends the volume: that is a change.
    expect(
      await upsertClosedBuckets([bucket('13:35', 100, -20, 5)], SOURCE, DATE),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect((await stored())[0]?.net_volume).toBe(5);
  });

  it('compares at the column precision: a sub-cent difference is not a change', async () => {
    await upsertClosedBuckets([bucket('13:35', 100.5, -20, 7)], SOURCE, DATE);

    const counts = await upsertClosedBuckets(
      [bucket('13:35', 100.5004, -20, 7)],
      SOURCE,
      DATE,
    );

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('keys on date, timestamp and source: the other source and day are separate rows', async () => {
    await upsertClosedBuckets([bucket('13:35', 100, -20, 7)], SOURCE, DATE);

    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7)],
        'qqq_etf_tide',
        DATE,
      ),
    ).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7)],
        SOURCE,
        '2026-03-25',
      ),
    ).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await stored(SOURCE)).toHaveLength(2);
    expect(await stored('qqq_etf_tide')).toHaveLength(1);
  });

  it('does nothing for an empty batch', async () => {
    expect(await upsertClosedBuckets([], SOURCE, DATE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
    });
  });

  it('throws on a rejected write and stores nothing from the batch (R4)', async () => {
    // 1e13 overflows DECIMAL(14,2): Postgres rejects the statement, and the
    // transaction rolls the earlier good row back.
    await expect(
      upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7), bucket('13:40', 1e13, 0, 1)],
        SOURCE,
        DATE,
      ),
    ).rejects.toThrow(/numeric field overflow/i);
    expect(await stored()).toEqual([]);
  });
});

describe('sessionRowCounts', () => {
  it("counts only today's session rows, so yesterday's session stored under today's date cannot mask a dead day (R-quality)", async () => {
    // The F2 defect: the 09:27 run stored the previous session (real, non-zero
    // values) under today's date.
    await insertRaw(DATE, '2026-03-23T14:00:00Z', SOURCE, 500, -300);
    await insertRaw(DATE, '2026-03-23T19:55:00Z', SOURCE, 800, -100);
    // Today's rows are all zero: a dead day.
    await insertRaw(DATE, '2026-03-24T13:35:00Z', SOURCE, 0, 0);
    await insertRaw(DATE, '2026-03-24T13:40:00Z', SOURCE, 0, 0);

    expect(await sessionRowCounts(DATE, SOURCE)).toEqual({
      total: 2,
      nonzero: 0,
    });
  });

  it('includes the 09:30 ET and the 16:00 ET rows and excludes the minute before and after (EDT)', async () => {
    await insertRaw(DATE, '2026-03-24T13:29:59Z', SOURCE, 1, 1);
    await insertRaw(DATE, '2026-03-24T13:30:00Z', SOURCE, 1, 1);
    await insertRaw(DATE, '2026-03-24T20:00:00Z', SOURCE, 1, 1);
    await insertRaw(DATE, '2026-03-24T20:00:01Z', SOURCE, 1, 1);

    expect(await sessionRowCounts(DATE, SOURCE)).toEqual({
      total: 2,
      nonzero: 2,
    });
  });

  it('uses the EST offset in winter (09:30 ET is 14:30Z, 16:00 ET is 21:00Z)', async () => {
    const day = '2026-01-15';
    await insertRaw(day, '2026-01-15T13:30:00Z', SOURCE, 1, 1); // 08:30 ET: outside
    await insertRaw(day, '2026-01-15T14:30:00Z', SOURCE, 1, 1);
    await insertRaw(day, '2026-01-15T21:00:00Z', SOURCE, 1, 1);
    await insertRaw(day, '2026-01-15T21:05:00Z', SOURCE, 1, 1); // 16:05 ET: outside

    expect(await sessionRowCounts(day, SOURCE)).toEqual({
      total: 2,
      nonzero: 2,
    });
  });

  it('ends the session at 13:00 ET on an early-close day', async () => {
    const day = '2026-11-27'; // EST
    await insertRaw(day, '2026-11-27T18:00:00Z', SOURCE, 1, 1);
    await insertRaw(day, '2026-11-27T18:05:00Z', SOURCE, 1, 1);

    expect(await sessionRowCounts(day, SOURCE)).toEqual({
      total: 1,
      nonzero: 1,
    });
  });

  it('counts a NULL premium as zero and filters by source', async () => {
    await insertRaw(DATE, '2026-03-24T13:35:00Z', SOURCE, null, null);
    await insertRaw(DATE, '2026-03-24T13:40:00Z', SOURCE, 0, 5);
    await insertRaw(DATE, '2026-03-24T13:40:00Z', 'qqq_etf_tide', 9, 9);

    expect(await sessionRowCounts(DATE, SOURCE)).toEqual({
      total: 2,
      nonzero: 1,
    });
  });

  it('returns zero counts for a day with no rows', async () => {
    expect(await sessionRowCounts(DATE, SOURCE)).toEqual({
      total: 0,
      nonzero: 0,
    });
  });
});

/**
 * closedBuckets filters values before the write; the columns (migrations #4
 * and #48: ncp and npp DECIMAL(14,2), net_volume INTEGER) are the limit that
 * counts. The two must agree: a bucket the filter lets through that Postgres
 * rejects fails the batch, and one rejected bucket rolls back the whole day's
 * upsert for that source on every run.
 */
describe('closedBuckets and the flow_data columns agree on the ranges', () => {
  // 25 minutes after the 09:30-09:35 bucket ended: an unusable one is stuck.
  const NOW = new Date('2026-03-24T14:00:00.000Z');
  const minute = (overrides: Partial<TideMinute>): TideMinute => ({
    timestamp: '2026-03-24T13:34:00.000Z',
    net_call_premium: '1',
    net_put_premium: '1',
    net_volume: 1,
    ...overrides,
  });

  const LARGEST_PREMIUM = '999999999999.99';
  const SMALLEST_PREMIUM = '-999999999999.99';

  it.each<[string, Partial<TideMinute>]>([
    ['the largest ncp', { net_call_premium: LARGEST_PREMIUM }],
    ['the smallest ncp', { net_call_premium: SMALLEST_PREMIUM }],
    ['the largest npp', { net_put_premium: LARGEST_PREMIUM }],
    ['the smallest npp', { net_put_premium: SMALLEST_PREMIUM }],
    ['the largest net_volume', { net_volume: 2_147_483_647 }],
    ['the smallest net_volume', { net_volume: -2_147_483_648 }],
    // Postgres rounds 999999999999.994 to .99, which fits.
    [
      'a premium that rounds down to the largest',
      { net_call_premium: 999_999_999_999.994 },
    ],
  ])('accepts %s, and Postgres stores it', async (_label, overrides) => {
    const result = closedBuckets([minute(overrides)], NOW);
    expect(result.buckets).toHaveLength(1);

    await expect(
      upsertClosedBuckets(result.buckets, SOURCE, DATE),
    ).resolves.toEqual({ inserted: 1, updated: 0, unchanged: 0 });

    const { rows } = await pg.query<{ ncp: string; npp: string; v: number }>(
      `SELECT ncp::text AS ncp, npp::text AS npp, net_volume AS v FROM flow_data`,
    );
    const bucket = result.buckets[0]!;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.ncp)).toBeCloseTo(bucket.ncp, 2);
    expect(Number(rows[0]?.npp)).toBeCloseTo(bucket.npp, 2);
    expect(rows[0]?.v).toBe(bucket.netVolume);
  });

  it.each<[string, Partial<TideMinute>]>([
    ['ncp of 1e12', { net_call_premium: '1000000000000' }],
    ['ncp of -1e12', { net_call_premium: '-1000000000000' }],
    ['npp of 1e12', { net_put_premium: '1000000000000' }],
    ['npp of -1e12', { net_put_premium: -1_000_000_000_000 }],
    // Postgres rounds 999999999999.995 up to 1e12, which does not fit.
    [
      'a premium that rounds up past the largest',
      { net_call_premium: '999999999999.995' },
    ],
    [
      'a negative premium that rounds past the smallest',
      { net_put_premium: '-999999999999.995' },
    ],
    ['net_volume one above INTEGER', { net_volume: 2_147_483_648 }],
    ['net_volume one below INTEGER', { net_volume: -2_147_483_649 }],
    ['a fractional net_volume', { net_volume: 12.5 }],
  ])(
    'rejects %s before the write, and Postgres would reject it too',
    async (_label, overrides) => {
      // The filter leaves the bucket out and counts it as stuck ...
      const filtered = closedBuckets([minute(overrides)], NOW);
      expect(filtered.buckets).toEqual([]);
      expect(filtered.stuck).toBe(1);

      // ... and the same values written directly are refused by Postgres, so
      // the filter and the columns draw the line in the same place.
      const direct: ClosedBucket = {
        timestamp: '2026-03-24T13:35:00.000Z',
        ncp: Number(overrides.net_call_premium ?? 1),
        npp: Number(overrides.net_put_premium ?? 1),
        netVolume: Number(overrides.net_volume ?? 1),
      };
      await expect(
        upsertClosedBuckets([direct], SOURCE, DATE),
      ).rejects.toThrow();
      expect(await stored()).toEqual([]);
    },
  );
});
