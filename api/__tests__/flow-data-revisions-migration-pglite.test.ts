// @vitest-environment node

/**
 * REAL-SQL test of migration #206, the flow_data_revisions table and its seed
 * (spec P0.7, docs/superpowers/specs/live-data-integrity-2026-11-06.md). The
 * table is built by the real migrations #4 and #48 (flow_data) and #206, in
 * pglite (real Postgres in WASM). The migration is applied again after rows
 * are put in flow_data, which is what its seed statement does on a database
 * that already holds data, and what a re-run does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 4);
  await applyMigration(pg, 48);
  await applyMigration(pg, 206);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE flow_data, flow_data_revisions RESTART IDENTITY');
});

/** The four sources the closed-bucket path writes. */
const TRACKED = [
  'qqq_etf_tide',
  'spy_etf_tide',
  'zero_dte_greek_flow',
  'zero_dte_index',
];
/** Sources that are first-write-wins snapshots: never logged, never seeded. */
const UNTRACKED = [
  'market_tide',
  'market_tide_otm',
  'spx_flow',
  'spy_flow',
  'qqq_flow',
];

async function putFlow(
  source: string,
  timestamp: string,
  createdAt: string,
  values: {
    ncp?: number | null;
    npp?: number | null;
    netVolume?: number | null;
    otmNcp?: number | null;
    otmNpp?: number | null;
  } = {},
  date = '2026-03-24',
) {
  await pg.query(
    `INSERT INTO flow_data
       (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      date,
      timestamp,
      source,
      values.ncp ?? 100.5,
      values.npp ?? -20.25,
      values.netVolume === undefined ? 7 : values.netVolume,
      values.otmNcp ?? null,
      values.otmNpp ?? null,
      createdAt,
    ],
  );
}

interface RevisionRow {
  source: string;
  ts: string;
  ncp: string | null;
  npp: string | null;
  net_volume: number | null;
  otm_ncp: string | null;
  otm_npp: string | null;
  seen_at: string;
  writer: string;
  is_first: boolean;
}

async function revisions(): Promise<RevisionRow[]> {
  const { rows } = await pg.query<RevisionRow>(
    `SELECT source, to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
            ncp::text, npp::text, net_volume, otm_ncp::text, otm_npp::text,
            seen_at::text, writer, is_first
       FROM flow_data_revisions ORDER BY source, timestamp, id`,
  );
  return rows;
}

describe('migration #206: the flow_data_revisions table', () => {
  it('has the key columns of flow_data, the value columns the closed-bucket path writes, and the log columns', async () => {
    const { rows } = await pg.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = 'flow_data_revisions' ORDER BY ordinal_position`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        column_name: 'date',
        data_type: 'date',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        column_name: 'timestamp',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        column_name: 'source',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      ...['ncp', 'npp'].map((column_name) =>
        expect.objectContaining({
          column_name,
          data_type: 'numeric',
          is_nullable: 'YES',
          numeric_precision: 14,
          numeric_scale: 2,
        }),
      ),
      expect.objectContaining({
        column_name: 'net_volume',
        data_type: 'integer',
        is_nullable: 'YES',
      }),
      ...['otm_ncp', 'otm_npp'].map((column_name) =>
        expect.objectContaining({
          column_name,
          data_type: 'numeric',
          is_nullable: 'YES',
          numeric_precision: 14,
          numeric_scale: 2,
        }),
      ),
      expect.objectContaining({
        column_name: 'seen_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        column_name: 'writer',
        data_type: 'text',
        is_nullable: 'NO',
      }),
      expect.objectContaining({
        column_name: 'is_first',
        data_type: 'boolean',
        is_nullable: 'NO',
      }),
    ]);
  });

  it('has the same value types as flow_data, column for column', async () => {
    const types = async (table: string) =>
      (
        await pg.query(
          `SELECT column_name, data_type, numeric_precision, numeric_scale
             FROM information_schema.columns
            WHERE table_name = $1
              AND column_name IN ('date','timestamp','source','ncp','npp','net_volume','otm_ncp','otm_npp')
            ORDER BY column_name`,
          [table],
        )
      ).rows;
    expect(await types('flow_data_revisions')).toEqual(
      await types('flow_data'),
    );
  });

  it('is indexed on (source, timestamp, seen_at) for the as-of query and keyed by its id', async () => {
    const { rows: idx } = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'flow_data_revisions' ORDER BY indexname`,
    );
    expect(idx.map((r) => r.indexdef.replaceAll(/\s+/g, ' '))).toEqual([
      expect.stringContaining(
        'flow_data_revisions_pkey ON public.flow_data_revisions USING btree (id)',
      ),
      expect.stringContaining(
        'idx_flow_data_revisions_asof ON public.flow_data_revisions USING btree (source, "timestamp", seen_at)',
      ),
    ]);
  });

  it('stamps seen_at with the time of the insert when a writer does not name it', async () => {
    const before = Date.now();
    await pg.query(
      `INSERT INTO flow_data_revisions (date, timestamp, source, writer, is_first)
       VALUES ('2026-03-24', '2026-03-24T13:35:00Z', 'spy_etf_tide', 'test', true)`,
    );
    const { rows } = await pg.query<{ seen_ms: number }>(
      `SELECT (EXTRACT(EPOCH FROM seen_at) * 1000)::float8 AS seen_ms FROM flow_data_revisions`,
    );
    expect(rows[0]!.seen_ms).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.seen_ms).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('migration #206: the seed', () => {
  it('copies exactly the four closed-bucket sources and no other', async () => {
    for (const [i, source] of [...TRACKED, ...UNTRACKED].entries()) {
      await putFlow(
        source,
        `2026-03-24T13:${35 + i}:00Z`,
        '2026-03-24T13:50:00Z',
      );
    }

    await applyMigration(pg, 206);

    const rows = await revisions();
    expect(rows.map((r) => r.source).sort()).toEqual(TRACKED);
    expect(rows.map((r) => r.source)).not.toContain('market_tide');
  });

  it("seeds seen_at = created_at, writer 'seed', is_first true, and the stored values (OTM wings included)", async () => {
    await putFlow(
      'zero_dte_greek_flow',
      '2026-03-24T13:35:00Z',
      '2026-03-24T13:36:07Z',
      { ncp: -2281, npp: -900.5, netVolume: 54, otmNcp: -300.25, otmNpp: 12 },
    );
    await putFlow(
      'zero_dte_index',
      '2026-03-24T13:40:00Z',
      '2026-03-24T13:42:00Z',
      {
        netVolume: null,
      },
    );

    await applyMigration(pg, 206);

    expect(await revisions()).toEqual([
      {
        source: 'zero_dte_greek_flow',
        ts: '13:35',
        ncp: '-2281.00',
        npp: '-900.50',
        net_volume: 54,
        otm_ncp: '-300.25',
        otm_npp: '12.00',
        seen_at: '2026-03-24 13:36:07+00',
        writer: 'seed',
        is_first: true,
      },
      {
        source: 'zero_dte_index',
        ts: '13:40',
        ncp: '100.50',
        npp: '-20.25',
        net_volume: null,
        otm_ncp: null,
        otm_npp: null,
        seen_at: '2026-03-24 13:42:00+00',
        writer: 'seed',
        is_first: true,
      },
    ]);
  });

  it('is idempotent: a second run adds nothing', async () => {
    await putFlow(
      'spy_etf_tide',
      '2026-03-24T13:35:00Z',
      '2026-03-24T13:36:00Z',
    );
    await putFlow(
      'qqq_etf_tide',
      '2026-03-24T13:35:00Z',
      '2026-03-24T13:36:00Z',
    );

    await applyMigration(pg, 206);
    const first = await revisions();
    await applyMigration(pg, 206);

    expect(first).toHaveLength(2);
    expect(await revisions()).toEqual(first);
  });

  it('fills only the keys that have no revision yet when it runs again', async () => {
    await putFlow(
      'spy_etf_tide',
      '2026-03-24T13:35:00Z',
      '2026-03-24T13:36:00Z',
    );
    await applyMigration(pg, 206);
    // A later row, and an existing row that already has a (non-seed) revision.
    await putFlow(
      'spy_etf_tide',
      '2026-03-24T13:40:00Z',
      '2026-03-24T13:41:00Z',
    );
    await pg.query(
      `INSERT INTO flow_data_revisions (date, timestamp, source, ncp, writer, is_first)
       VALUES ('2026-03-24', '2026-03-24T13:45:00Z', 'spy_etf_tide', 1, 'fetch-etf-tide', true)`,
    );
    await putFlow(
      'spy_etf_tide',
      '2026-03-24T13:45:00Z',
      '2026-03-24T13:46:00Z',
    );

    await applyMigration(pg, 206);

    const rows = await revisions();
    expect(rows.map((r) => [r.ts, r.writer])).toEqual([
      ['13:35', 'seed'],
      ['13:40', 'seed'],
      ['13:45', 'fetch-etf-tide'],
    ]);
  });

  it('seeds nothing, and does not fail, when flow_data holds none of those sources', async () => {
    await putFlow(
      'market_tide',
      '2026-03-24T13:35:00Z',
      '2026-03-24T13:36:00Z',
    );

    await applyMigration(pg, 206);

    expect(await revisions()).toEqual([]);
  });

  it('keeps the same timestamp on two dates apart (the key is date, timestamp, source)', async () => {
    await putFlow(
      'zero_dte_greek_flow',
      '2026-03-23T19:55:00Z',
      '2026-03-24T13:28:00Z',
      {},
      '2026-03-24',
    );
    await putFlow(
      'zero_dte_greek_flow',
      '2026-03-23T19:55:00Z',
      '2026-03-23T19:56:00Z',
      {},
      '2026-03-23',
    );

    await applyMigration(pg, 206);

    const { rows } = await pg.query<{ date: string; seen_at: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, seen_at::text
         FROM flow_data_revisions ORDER BY date`,
    );
    expect(rows).toEqual([
      { date: '2026-03-23', seen_at: '2026-03-23 19:56:00+00' },
      { date: '2026-03-24', seen_at: '2026-03-24 13:28:00+00' },
    ]);
  });
});
