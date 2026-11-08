// @vitest-environment node

/**
 * REAL-SQL test for the closed-bucket upsert and the session row count shared
 * by fetch-etf-tide, fetch-zero-dte-flow and fetch-greek-flow (which also
 * writes the OTM wings). The cron tests mock the database
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
  closedGreekFlowBuckets,
  type ClosedBucket,
  type GreekFlowMinute,
  type TideMinute,
} from '../_lib/closed-buckets.js';

const SOURCE = 'spy_etf_tide';
const DATE = '2026-03-24'; // EDT: 09:30 ET is 13:30Z, 16:00 ET is 20:00Z
/** The writer name every call logs its revisions under. */
const WRITER = 'test-writer';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 4);
  // #48 adds otm_ncp and otm_npp (DECIMAL(14,2)), written by greek flow only.
  await applyMigration(pg, 48);
  // #206 adds flow_data_revisions, the log every upsert appends to.
  await applyMigration(pg, 206);
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
  await pg.query('TRUNCATE flow_data, flow_data_revisions RESTART IDENTITY');
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

/** A bucket that carries the OTM wings (greek flow). */
const greekBucket = (
  hhmmZ: string,
  ncp: number,
  npp: number,
  netVolume: number | null,
  otmNcp: number,
  otmNpp: number,
): ClosedBucket => ({
  timestamp: `${DATE}T${hhmmZ}:00.000Z`,
  ncp,
  npp,
  netVolume,
  otm: { ncp: otmNcp, npp: otmNpp },
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
      WRITER,
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
    await upsertClosedBuckets(first, SOURCE, DATE, WRITER);
    const before = await stored();

    const counts = await upsertClosedBuckets(first, SOURCE, DATE, WRITER);

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await stored()).toEqual(before);
  });

  it('updates a bucket whose value UW revised, keeping its id and created_at', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );
    const [before] = await stored();

    const counts = await upsertClosedBuckets(
      [bucket('13:35', 130.5, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
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
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );
    const counts = await upsertClosedBuckets([revised], SOURCE, DATE, WRITER);
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
  });

  it('counts a mixed batch: one new, one revised, one unchanged', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7), bucket('13:40', 200, -40, 9)],
      SOURCE,
      DATE,
      WRITER,
    );

    const counts = await upsertClosedBuckets(
      [
        bucket('13:35', 100, -20, 7), // unchanged
        bucket('13:40', 250, -40, 9), // revised
        bucket('13:45', 300, -60, 11), // new
      ],
      SOURCE,
      DATE,
      WRITER,
    );

    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect((await stored()).map((r) => r.ncp)).toEqual([100, 250, 300]);
  });

  it('stores a NULL net_volume, and a NULL that stays NULL is not a change', async () => {
    const nullVolume = [bucket('13:35', 100, -20, null)];
    expect(await upsertClosedBuckets(nullVolume, SOURCE, DATE, WRITER)).toEqual(
      {
        inserted: 1,
        updated: 0,
        unchanged: 0,
      },
    );
    expect((await stored())[0]?.net_volume).toBeNull();

    // NULL IS DISTINCT FROM NULL is false: no rewrite.
    expect(await upsertClosedBuckets(nullVolume, SOURCE, DATE, WRITER)).toEqual(
      {
        inserted: 0,
        updated: 0,
        unchanged: 1,
      },
    );

    // UW later sends the volume: that is a change.
    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 5)],
        SOURCE,
        DATE,
        WRITER,
      ),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect((await stored())[0]?.net_volume).toBe(5);
  });

  it('compares at the column precision: a sub-cent difference is not a change', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100.5, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    const counts = await upsertClosedBuckets(
      [bucket('13:35', 100.5004, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('keys on date, timestamp and source: the other source and day are separate rows', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7)],
        'qqq_etf_tide',
        DATE,
        WRITER,
      ),
    ).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7)],
        SOURCE,
        '2026-03-25',
        WRITER,
      ),
    ).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await stored(SOURCE)).toHaveLength(2);
    expect(await stored('qqq_etf_tide')).toHaveLength(1);
  });

  it('does nothing for an empty batch', async () => {
    expect(await upsertClosedBuckets([], SOURCE, DATE, WRITER)).toEqual({
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
        WRITER,
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

  // [label, minute overrides, stored ncp text, stored npp text, stored net_volume].
  // The default minute carries premiums of 1 (stored '1.00') and a volume of 1.
  it.each<[string, Partial<TideMinute>, string, string, number]>([
    [
      'the largest ncp',
      { net_call_premium: LARGEST_PREMIUM },
      '999999999999.99',
      '1.00',
      1,
    ],
    [
      'the smallest ncp',
      { net_call_premium: SMALLEST_PREMIUM },
      '-999999999999.99',
      '1.00',
      1,
    ],
    [
      'the largest npp',
      { net_put_premium: LARGEST_PREMIUM },
      '1.00',
      '999999999999.99',
      1,
    ],
    [
      'the smallest npp',
      { net_put_premium: SMALLEST_PREMIUM },
      '1.00',
      '-999999999999.99',
      1,
    ],
    [
      'the largest net_volume',
      { net_volume: 2_147_483_647 },
      '1.00',
      '1.00',
      2_147_483_647,
    ],
    [
      'the smallest net_volume',
      { net_volume: -2_147_483_648 },
      '1.00',
      '1.00',
      -2_147_483_648,
    ],
    // Postgres rounds 999999999999.994 to .99, which fits.
    [
      'a premium that rounds down to the largest',
      { net_call_premium: 999_999_999_999.994 },
      '999999999999.99',
      '1.00',
      1,
    ],
  ])(
    'accepts %s, and Postgres stores it',
    async (_label, overrides, ncpText, nppText, volume) => {
      const result = closedBuckets([minute(overrides)], NOW);
      expect(result.buckets).toHaveLength(1);

      await expect(
        upsertClosedBuckets(result.buckets, SOURCE, DATE, WRITER),
      ).resolves.toEqual({ inserted: 1, updated: 0, unchanged: 0 });

      const { rows } = await pg.query<{ ncp: string; npp: string; v: number }>(
        `SELECT ncp::text AS ncp, npp::text AS npp, net_volume AS v FROM flow_data`,
      );
      // Compared as text: a float comparison would pass a boundary value that
      // Postgres had rounded or clipped.
      expect(rows).toEqual([{ ncp: ncpText, npp: nppText, v: volume }]);
    },
  );

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
        upsertClosedBuckets([direct], SOURCE, DATE, WRITER),
      ).rejects.toThrow();
      expect(await stored()).toEqual([]);
    },
  );
});

/**
 * Greek flow (source zero_dte_greek_flow) also carries the OTM wings in
 * otm_ncp and otm_npp (migration #48, DECIMAL(14,2)). The upsert writes them
 * for a bucket that has them, and compares them in its IS DISTINCT FROM
 * clause, so a revised wing is healed like a revised ncp.
 */
describe('upsertClosedBuckets with the OTM wings (greek flow)', () => {
  const GREEK = 'zero_dte_greek_flow';

  interface StoredWingRow {
    timestamp: string;
    ncp: string | null;
    npp: string | null;
    net_volume: number | null;
    otm_ncp: string | null;
    otm_npp: string | null;
  }

  /** Every column as the text Postgres stores, so no float comparison blurs a value. */
  async function storedWings(source = GREEK): Promise<StoredWingRow[]> {
    const { rows } = await pg.query<StoredWingRow>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS timestamp,
              ncp::text AS ncp, npp::text AS npp, net_volume,
              otm_ncp::text AS otm_ncp, otm_npp::text AS otm_npp
         FROM flow_data WHERE source = $1 ORDER BY timestamp`,
      [source],
    );
    return rows;
  }

  it('inserts a bucket with its OTM wings and counts it as inserted', async () => {
    const counts = await upsertClosedBuckets(
      [greekBucket('13:35', 5000000, -3000000, 120000, 2500000.5, -1800000.25)],
      GREEK,
      DATE,
      WRITER,
    );

    expect(counts).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await storedWings()).toEqual([
      {
        timestamp: '13:35',
        ncp: '5000000.00',
        npp: '-3000000.00',
        net_volume: 120000,
        otm_ncp: '2500000.50',
        otm_npp: '-1800000.25',
      },
    ]);
  });

  it('leaves a bucket that already holds the same values and wings untouched', async () => {
    const first = [greekBucket('13:35', 100, -20, 7, 60, -10)];
    await upsertClosedBuckets(first, GREEK, DATE, WRITER);
    const before = await storedWings();

    expect(await upsertClosedBuckets(first, GREEK, DATE, WRITER)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(await storedWings()).toEqual(before);
  });

  it.each([
    ['otm_ncp', greekBucket('13:35', 100, -20, 7, 61, -10), '61.00', '-10.00'],
    ['otm_npp', greekBucket('13:35', 100, -20, 7, 60, -11), '60.00', '-11.00'],
  ])(
    'treats a revised %s alone as a change and rewrites it',
    async (_column, revised, otmNcp, otmNpp) => {
      await upsertClosedBuckets(
        [greekBucket('13:35', 100, -20, 7, 60, -10)],
        GREEK,
        DATE,
        WRITER,
      );

      const counts = await upsertClosedBuckets([revised], GREEK, DATE, WRITER);

      expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
      expect(await storedWings()).toEqual([
        {
          timestamp: '13:35',
          ncp: '100.00',
          npp: '-20.00',
          net_volume: 7,
          otm_ncp: otmNcp,
          otm_npp: otmNpp,
        },
      ]);
    },
  );

  it('still treats a revised ncp, npp or volume as a change and keeps the wings', async () => {
    await upsertClosedBuckets(
      [greekBucket('13:35', 100, -20, 7, 60, -10)],
      GREEK,
      DATE,
      WRITER,
    );

    for (const revised of [
      greekBucket('13:35', 101, -20, 7, 60, -10),
      greekBucket('13:35', 101, -21, 7, 60, -10),
      greekBucket('13:35', 101, -21, 8, 60, -10),
    ]) {
      expect(await upsertClosedBuckets([revised], GREEK, DATE, WRITER)).toEqual(
        {
          inserted: 0,
          updated: 1,
          unchanged: 0,
        },
      );
    }
    expect(await storedWings()).toEqual([
      {
        timestamp: '13:35',
        ncp: '101.00',
        npp: '-21.00',
        net_volume: 8,
        otm_ncp: '60.00',
        otm_npp: '-10.00',
      },
    ]);
  });

  it('fills the wings of a row stored without them (history, or the old cron), as a change', async () => {
    await pg.query(
      `INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
       VALUES ($1, '2026-03-24T13:35:00Z', $2, 100, -20, 7)`,
      [DATE, GREEK],
    );

    const counts = await upsertClosedBuckets(
      [greekBucket('13:35', 100, -20, 7, 60, -10)],
      GREEK,
      DATE,
      WRITER,
    );

    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect((await storedWings())[0]).toMatchObject({
      otm_ncp: '60.00',
      otm_npp: '-10.00',
    });
  });

  it('compares the wings at the column precision: a sub-cent difference is not a change', async () => {
    await upsertClosedBuckets(
      [greekBucket('13:35', 100, -20, 7, 60.5, -10)],
      GREEK,
      DATE,
      WRITER,
    );

    expect(
      await upsertClosedBuckets(
        [greekBucket('13:35', 100, -20, 7, 60.5004, -10.0004)],
        GREEK,
        DATE,
        WRITER,
      ),
    ).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('keeps one counting path: a mixed batch of new, revised and unchanged greek buckets', async () => {
    await upsertClosedBuckets(
      [
        greekBucket('13:35', 100, -20, 7, 60, -10),
        greekBucket('13:40', 200, -40, 9, 120, -20),
      ],
      GREEK,
      DATE,
      WRITER,
    );

    const counts = await upsertClosedBuckets(
      [
        greekBucket('13:35', 100, -20, 7, 60, -10), // unchanged
        greekBucket('13:40', 200, -40, 9, 125, -20), // wing revised
        greekBucket('13:45', 300, -60, null, 180, -30), // new, NULL volume
      ],
      GREEK,
      DATE,
      WRITER,
    );

    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect((await storedWings()).map((r) => r.otm_ncp)).toEqual([
      '60.00',
      '125.00',
      '180.00',
    ]);
  });

  it('never touches the wings of a bucket that has none (a tide bucket): they are not written and not compared', async () => {
    // A row that carries wings, hit by a bucket without any.
    await pg.query(
      `INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp)
       VALUES ($1, '2026-03-24T13:35:00Z', $2, 100, -20, 7, 60, -10)`,
      [DATE, SOURCE],
    );

    // Same ncp, npp and volume: unchanged, whatever the wings hold.
    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7)],
        SOURCE,
        DATE,
        WRITER,
      ),
    ).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    // A changed ncp: updated, and the wings are left as they were.
    expect(
      await upsertClosedBuckets(
        [bucket('13:35', 130, -20, 7)],
        SOURCE,
        DATE,
        WRITER,
      ),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect((await storedWings(SOURCE))[0]).toMatchObject({
      ncp: '130.00',
      otm_ncp: '60.00',
      otm_npp: '-10.00',
    });
    // A new tide bucket leaves them NULL.
    await upsertClosedBuckets([bucket('13:40', 1, 1, 1)], SOURCE, DATE, WRITER);
    expect((await storedWings(SOURCE))[1]).toMatchObject({
      otm_ncp: null,
      otm_npp: null,
    });
  });

  it('throws on a rejected write and stores nothing from the batch (R4)', async () => {
    // An OTM wing of 1e13 overflows DECIMAL(14,2): the statement is rejected
    // and the earlier good row in the same transaction is rolled back.
    await expect(
      upsertClosedBuckets(
        [
          greekBucket('13:35', 100, -20, 7, 60, -10),
          greekBucket('13:40', 1, 1, 1, 1e13, 0),
        ],
        GREEK,
        DATE,
        WRITER,
      ),
    ).rejects.toThrow(/numeric field overflow/i);
    expect(await storedWings()).toEqual([]);
  });
});

/**
 * closedGreekFlowBuckets filters the OTM wings before the write; otm_ncp and
 * otm_npp are DECIMAL(14,2). The filter and the columns must draw the line in
 * the same place: a bucket the filter lets through that Postgres rejects fails
 * the batch, and one rejected bucket rolls back the whole day's upsert.
 */
describe('closedGreekFlowBuckets and the OTM columns agree on the ranges', () => {
  const GREEK = 'zero_dte_greek_flow';
  // 25 minutes after the 09:30-09:35 bucket ended: an unusable one is stuck.
  const NOW = new Date('2026-03-24T14:00:00.000Z');
  const minute = (overrides: Partial<GreekFlowMinute>): GreekFlowMinute => ({
    timestamp: '2026-03-24T13:34:00.000Z',
    total_delta_flow: '1',
    dir_delta_flow: '1',
    otm_total_delta_flow: '1',
    otm_dir_delta_flow: '1',
    volume: 1,
    ...overrides,
  });

  interface WingText {
    ncp: string;
    npp: string;
    otm_ncp: string;
    otm_npp: string;
    v: number;
  }

  // [label, overrides, then the ncp, npp, otm_ncp and otm_npp Postgres stores, as text].
  it.each<[string, Partial<GreekFlowMinute>, string, string, string, string]>([
    [
      'the largest otm_ncp',
      { otm_total_delta_flow: '999999999999.99' },
      '1.00',
      '1.00',
      '999999999999.99',
      '1.00',
    ],
    [
      'the smallest otm_ncp',
      { otm_total_delta_flow: '-999999999999.99' },
      '1.00',
      '1.00',
      '-999999999999.99',
      '1.00',
    ],
    [
      'the largest otm_npp',
      { otm_dir_delta_flow: 999_999_999_999.99 },
      '1.00',
      '1.00',
      '1.00',
      '999999999999.99',
    ],
    [
      'the smallest otm_npp',
      { otm_dir_delta_flow: -999_999_999_999.99 },
      '1.00',
      '1.00',
      '1.00',
      '-999999999999.99',
    ],
    // Postgres rounds 999999999999.994 to .99, which fits.
    [
      'an otm_ncp that rounds down to the largest',
      { otm_total_delta_flow: 999_999_999_999.994 },
      '1.00',
      '1.00',
      '999999999999.99',
      '1.00',
    ],
    [
      'the largest total_delta_flow and the smallest dir_delta_flow',
      {
        total_delta_flow: '999999999999.99',
        dir_delta_flow: '-999999999999.99',
      },
      '999999999999.99',
      '-999999999999.99',
      '1.00',
      '1.00',
    ],
  ])(
    'accepts %s, and Postgres stores it',
    async (_label, overrides, ncp, npp, otmNcp, otmNpp) => {
      const result = closedGreekFlowBuckets([minute(overrides)], NOW);
      expect(result.buckets).toHaveLength(1);

      await expect(
        upsertClosedBuckets(result.buckets, GREEK, DATE, WRITER),
      ).resolves.toEqual({ inserted: 1, updated: 0, unchanged: 0 });

      const { rows } = await pg.query<WingText>(
        `SELECT ncp::text AS ncp, npp::text AS npp, otm_ncp::text AS otm_ncp,
                otm_npp::text AS otm_npp, net_volume AS v FROM flow_data`,
      );
      // Compared as text: a float comparison would pass a boundary value that
      // Postgres had rounded or clipped.
      expect(rows).toEqual([
        { ncp, npp, otm_ncp: otmNcp, otm_npp: otmNpp, v: 1 },
      ]);
    },
  );

  it.each<[string, Partial<GreekFlowMinute>, { ncp: number; npp: number }]>([
    [
      'otm_ncp of 1e12',
      { otm_total_delta_flow: '1000000000000' },
      { ncp: 1e12, npp: 1 },
    ],
    [
      'otm_ncp of -1e12',
      { otm_total_delta_flow: '-1000000000000' },
      { ncp: -1e12, npp: 1 },
    ],
    ['otm_npp of 1e12', { otm_dir_delta_flow: 1e12 }, { ncp: 1, npp: 1e12 }],
    ['otm_npp of -1e12', { otm_dir_delta_flow: -1e12 }, { ncp: 1, npp: -1e12 }],
    // Postgres rounds 999999999999.995 up to 1e12, which does not fit.
    [
      'an otm_ncp that rounds up past the largest',
      { otm_total_delta_flow: '999999999999.995' },
      { ncp: 999_999_999_999.995, npp: 1 },
    ],
    [
      'an otm_npp that rounds past the smallest',
      { otm_dir_delta_flow: '-999999999999.995' },
      { ncp: 1, npp: -999_999_999_999.995 },
    ],
  ])(
    'rejects %s before the write, and Postgres would reject it too',
    async (_label, overrides, otm) => {
      // The filter leaves the bucket out and counts it as stuck ...
      const filtered = closedGreekFlowBuckets([minute(overrides)], NOW);
      expect(filtered.buckets).toEqual([]);
      expect(filtered.stuck).toBe(1);

      // ... and the same values written directly are refused by Postgres.
      await expect(
        upsertClosedBuckets(
          [
            {
              timestamp: '2026-03-24T13:35:00.000Z',
              ncp: 1,
              npp: 1,
              netVolume: 1,
              otm,
            },
          ],
          GREEK,
          DATE,
          WRITER,
        ),
      ).rejects.toThrow();
      const { rows } = await pg.query('SELECT 1 FROM flow_data');
      expect(rows).toEqual([]);
    },
  );
});

/**
 * The revision log (spec P0.8, migration #206). flow_data keeps the latest
 * value; every write that inserts a row or changes a value also appends the
 * row, as stored, to flow_data_revisions in the same statement. An unchanged
 * row writes none.
 */
describe('upsertClosedBuckets and the flow_data_revisions log', () => {
  const GREEK = 'zero_dte_greek_flow';

  interface LogRow {
    ts: string;
    ncp: string | null;
    npp: string | null;
    net_volume: number | null;
    otm_ncp: string | null;
    otm_npp: string | null;
    writer: string;
    is_first: boolean;
  }

  /** The log of one source, oldest write first, values as the text Postgres stores. */
  async function log(source = SOURCE): Promise<LogRow[]> {
    const { rows } = await pg.query<LogRow>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              ncp::text AS ncp, npp::text AS npp, net_volume,
              otm_ncp::text AS otm_ncp, otm_npp::text AS otm_npp,
              writer, is_first
         FROM flow_data_revisions WHERE source = $1 ORDER BY id`,
      [source],
    );
    return rows;
  }

  const count = async (table: 'flow_data' | 'flow_data_revisions') =>
    Number(
      (await pg.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`))
        .rows[0]!.n,
    );

  it('logs an inserted row as a first revision with its writer and stored values', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100.5, -20.25, 7)],
      SOURCE,
      DATE,
      'fetch-etf-tide',
    );

    expect(await log()).toEqual([
      {
        ts: '13:35',
        ncp: '100.50',
        npp: '-20.25',
        net_volume: 7,
        otm_ncp: null,
        otm_npp: null,
        writer: 'fetch-etf-tide',
        is_first: true,
      },
    ]);
  });

  it('writes no revision for a row that already holds the same values', async () => {
    const same = [bucket('13:35', 100.5, -20.25, 7)];
    await upsertClosedBuckets(same, SOURCE, DATE, WRITER);

    const counts = await upsertClosedBuckets(same, SOURCE, DATE, WRITER);

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await log()).toHaveLength(1);
  });

  it('writes no revision for a sub-cent difference, which is not a change', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100.5, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    await upsertClosedBuckets(
      [bucket('13:35', 100.5004, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    expect(await log()).toHaveLength(1);
  });

  it('logs a changed value as a later revision (is_first false) and flow_data holds the latest', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      'fetch-etf-tide',
    );
    await upsertClosedBuckets(
      [bucket('13:35', 130.5, -20, 7)],
      SOURCE,
      DATE,
      'fetch-etf-tide',
    );

    expect(await log()).toEqual([
      expect.objectContaining({ ncp: '100.00', is_first: true }),
      expect.objectContaining({
        ncp: '130.50',
        npp: '-20.00',
        is_first: false,
      }),
    ]);
    expect((await stored())[0]).toMatchObject({ ncp: 130.5 });
    expect(await count('flow_data')).toBe(1);
  });

  it.each([
    ['net_volume', bucket('13:35', 100, -20, 8)],
    ['npp', bucket('13:35', 100, -21, 7)],
  ])('logs a revised %s alone', async (_column, revised) => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    await upsertClosedBuckets([revised], SOURCE, DATE, WRITER);

    expect((await log()).map((r) => r.is_first)).toEqual([true, false]);
  });

  it('logs a change of an OTM wing alone, with both wings as stored', async () => {
    await upsertClosedBuckets(
      [greekBucket('13:35', 100, -20, 7, 60, -10)],
      GREEK,
      DATE,
      'fetch-greek-flow',
    );

    await upsertClosedBuckets(
      [greekBucket('13:35', 100, -20, 7, 61.5, -10)],
      GREEK,
      DATE,
      'fetch-greek-flow',
    );

    expect(await log(GREEK)).toEqual([
      expect.objectContaining({
        otm_ncp: '60.00',
        otm_npp: '-10.00',
        is_first: true,
      }),
      expect.objectContaining({
        otm_ncp: '61.50',
        otm_npp: '-10.00',
        is_first: false,
      }),
    ]);
  });

  it("logs a reconcile's change under the reconcile's own writer name", async () => {
    await upsertClosedBuckets(
      [greekBucket('13:35', -2281, -900, 54, -300, 12)],
      GREEK,
      DATE,
      'fetch-greek-flow',
    );

    // UW restated the figures after the close.
    const counts = await upsertClosedBuckets(
      [greekBucket('13:35', -14505, -9000, 54, -7000, -6500)],
      GREEK,
      DATE,
      'reconcile-zero-dte-greek-flow',
    );

    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(await log(GREEK)).toEqual([
      expect.objectContaining({
        ncp: '-2281.00',
        writer: 'fetch-greek-flow',
        is_first: true,
      }),
      expect.objectContaining({
        ncp: '-14505.00',
        writer: 'reconcile-zero-dte-greek-flow',
        is_first: false,
      }),
    ]);
  });

  it('logs exactly the rows a mixed batch inserted or changed: one new, one revised, one unchanged', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7), bucket('13:40', 200, -40, 9)],
      SOURCE,
      DATE,
      WRITER,
    );

    const counts = await upsertClosedBuckets(
      [
        bucket('13:35', 100, -20, 7), // unchanged
        bucket('13:40', 250, -40, 9), // revised
        bucket('13:45', 300, -60, 11), // new
      ],
      SOURCE,
      DATE,
      'second-writer',
    );

    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect((await log()).map((r) => [r.ts, r.writer, r.is_first])).toEqual([
      ['13:35', WRITER, true],
      ['13:40', WRITER, true],
      ['13:40', 'second-writer', false],
      ['13:45', 'second-writer', true],
    ]);
  });

  it('logs the whole row as stored: a tide change keeps the wings the row already carried', async () => {
    await pg.query(
      `INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp)
       VALUES ($1, '2026-03-24T13:35:00Z', $2, 100, -20, 7, 60, -10)`,
      [DATE, SOURCE],
    );

    await upsertClosedBuckets(
      [bucket('13:35', 130, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );

    expect(await log()).toEqual([
      expect.objectContaining({
        ncp: '130.00',
        otm_ncp: '60.00',
        otm_npp: '-10.00',
        is_first: false,
      }),
    ]);
  });

  it('keeps each source and each day apart in the log', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      'qqq_etf_tide',
      DATE,
      WRITER,
    );
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      '2026-03-25',
      WRITER,
    );

    expect(await log(SOURCE)).toHaveLength(2);
    expect(await log('qqq_etf_tide')).toHaveLength(1);
  });

  it('writes nothing, and logs nothing, for an empty batch', async () => {
    await upsertClosedBuckets([], SOURCE, DATE, WRITER);

    expect(await count('flow_data_revisions')).toBe(0);
  });

  it('throws when the log insert fails, and flow_data does not change (R4)', async () => {
    await upsertClosedBuckets(
      [bucket('13:35', 100, -20, 7)],
      SOURCE,
      DATE,
      WRITER,
    );
    await pg.query('DROP TABLE flow_data_revisions');
    try {
      // A revised value and a new row: both must be refused with the log.
      await expect(
        upsertClosedBuckets(
          [bucket('13:35', 999, -20, 7), bucket('13:40', 1, 1, 1)],
          SOURCE,
          DATE,
          WRITER,
        ),
      ).rejects.toThrow(/flow_data_revisions/);
      expect(await stored()).toEqual([
        expect.objectContaining({ timestamp: '13:35', ncp: 100 }),
      ]);
    } finally {
      await applyMigration(pg, 206);
    }
  });

  it('a rejected bucket in the batch rolls back every bucket and every revision', async () => {
    await expect(
      upsertClosedBuckets(
        [bucket('13:35', 100, -20, 7), bucket('13:40', 1e13, 0, 1)],
        SOURCE,
        DATE,
        WRITER,
      ),
    ).rejects.toThrow(/numeric field overflow/i);

    expect(await count('flow_data')).toBe(0);
    expect(await count('flow_data_revisions')).toBe(0);
  });
});

/**
 * What the system showed at time T: the query the spec documents (P0.8). For
 * each bucket, the latest revision whose label and storing time are both not
 * after T; the first value is the earliest revision, and the final one is the
 * flow_data row.
 */
describe('the as-of query over flow_data_revisions', () => {
  const AS_OF_SQL = `
    SELECT DISTINCT ON (date, timestamp, source)
           to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
           ncp::float8 AS ncp
    FROM flow_data_revisions
    WHERE source = $1 AND timestamp <= $2::timestamptz AND seen_at <= $2::timestamptz
    ORDER BY date, timestamp, source, seen_at DESC, id DESC`;

  const asOf = async (t: string) =>
    (
      await pg.query<{ ts: string; ncp: number }>(AS_OF_SQL, [SOURCE, t])
    ).rows.map((r) => [r.ts, r.ncp]);

  /** Run an upsert, then stamp the revisions it just wrote with the time they were seen. */
  async function writeAt(seenAt: string, buckets: ClosedBucket[]) {
    const { rows } = await pg.query<{ m: string | null }>(
      'SELECT MAX(id) AS m FROM flow_data_revisions',
    );
    const before = Number(rows[0]!.m ?? 0);
    await upsertClosedBuckets(buckets, SOURCE, DATE, WRITER);
    await pg.query(
      'UPDATE flow_data_revisions SET seen_at = $1 WHERE id > $2',
      [seenAt, before],
    );
  }

  beforeEach(async () => {
    // 13:35 is first stored at 13:36:30 (ncp 100), restated at 13:50 (ncp 120)
    // and again after the close at 22:05 (ncp 150). 13:40 is first stored at
    // 13:41:30 (ncp 200) and never revised.
    await writeAt('2026-03-24T13:36:30Z', [bucket('13:35', 100, -20, 7)]);
    await writeAt('2026-03-24T13:41:30Z', [bucket('13:40', 200, -40, 9)]);
    await writeAt('2026-03-24T13:50:00Z', [bucket('13:35', 120, -20, 7)]);
    await writeAt('2026-03-24T22:05:00Z', [bucket('13:35', 150, -20, 7)]);
  });

  it('shows nothing before a row was first stored', async () => {
    expect(await asOf('2026-03-24T13:36:00Z')).toEqual([]);
  });

  it('shows the first value right after it was stored', async () => {
    expect(await asOf('2026-03-24T13:37:00Z')).toEqual([['13:35', 100]]);
  });

  it('shows the value between two revisions, not the final one', async () => {
    expect(await asOf('2026-03-24T13:45:00Z')).toEqual([
      ['13:35', 100],
      ['13:40', 200],
    ]);
    expect(await asOf('2026-03-24T14:00:00Z')).toEqual([
      ['13:35', 120],
      ['13:40', 200],
    ]);
  });

  it('shows the final value once every revision is in, and it matches flow_data', async () => {
    const final = await asOf('2026-03-24T23:00:00Z');
    expect(final).toEqual([
      ['13:35', 150],
      ['13:40', 200],
    ]);
    expect((await stored()).map((r) => [r.timestamp, r.ncp])).toEqual(final);
  });

  it('does not show a bucket whose label is after T even if it was stored by T', async () => {
    // 13:40 is labelled 13:40: at 13:39 it is not visible, whenever it was stored.
    await pg.query(
      `UPDATE flow_data_revisions SET seen_at = '2026-03-24T13:30:00Z' WHERE timestamp = '2026-03-24T13:40:00Z'`,
    );
    expect(await asOf('2026-03-24T13:39:00Z')).toEqual([['13:35', 100]]);
  });

  it('answers first seen from the earliest revision, not the latest', async () => {
    const { rows } = await pg.query<{ ncp: number; seen_at: string }>(
      `SELECT DISTINCT ON (date, timestamp, source)
              ncp::float8 AS ncp, seen_at::text AS seen_at
         FROM flow_data_revisions
        WHERE source = $1 AND timestamp = '2026-03-24T13:35:00Z'
        ORDER BY date, timestamp, source, seen_at, id`,
      [SOURCE],
    );
    expect(rows).toEqual([{ ncp: 100, seen_at: '2026-03-24 13:36:30+00' }]);
  });
});
