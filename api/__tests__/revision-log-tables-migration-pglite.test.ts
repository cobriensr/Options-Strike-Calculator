// @vitest-environment node

/**
 * REAL-SQL test of migration #207, the vega_flow_etf_revisions and
 * nope_ticks_revisions tables and their seed (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). The source tables
 * are built by the real migrations #60 (nope_ticks), #92 and #129
 * (vega_flow_etf), then #207, in pglite (real Postgres in WASM). The migration
 * is applied again after rows are put in the source tables, which is what its
 * seed statements do on a database that already holds data, and what a re-run
 * does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 60);
  await applyMigration(pg, 92);
  await applyMigration(pg, 129);
  await applyMigration(pg, 207);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query(
    'TRUNCATE vega_flow_etf, vega_flow_etf_revisions, nope_ticks, nope_ticks_revisions RESTART IDENTITY',
  );
});

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

async function columns(table: string): Promise<ColumnInfo[]> {
  const { rows } = await pg.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}

/** The log's own columns, which the source table does not have. */
const LOG_COLUMNS = ['id', 'seen_at', 'writer', 'is_first'];

describe.each([
  {
    source: 'vega_flow_etf',
    log: 'vega_flow_etf_revisions',
    // Source columns the log does not copy: the surrogate key and the
    // first-insert time (seen_at is the log's time).
    notCopied: ['id', 'inserted_at'],
    index: 'idx_vega_flow_etf_revisions_asof',
  },
  {
    source: 'nope_ticks',
    log: 'nope_ticks_revisions',
    notCopied: ['ingested_at'],
    index: 'idx_nope_ticks_revisions_asof',
  },
])('migration #207: $log', ({ source, log, notCopied, index }) => {
  it('copies every key and value column of its table with the same type, precision and nullability, column by column', async () => {
    const sourceColumns = (await columns(source)).filter(
      (c) => !notCopied.includes(c.column_name),
    );
    const logColumns = await columns(log);

    // The same columns plus the log's own. Order is not compared: vega_flow_etf
    // gained `expiry` after `inserted_at` (migration #129), and the log lists
    // it with the key.
    expect(logColumns.map((c) => c.column_name).sort()).toEqual(
      [
        'id',
        ...sourceColumns.map((c) => c.column_name),
        'seen_at',
        'writer',
        'is_first',
      ].sort(),
    );
    for (const wanted of sourceColumns) {
      expect(
        logColumns.find((c) => c.column_name === wanted.column_name),
        wanted.column_name,
      ).toEqual(wanted);
    }
  });

  it('has the log columns: a bigint id, seen_at defaulting to now(), a text writer and a boolean is_first, all NOT NULL', async () => {
    const byName = Object.fromEntries(
      (await columns(log)).map((c) => [c.column_name, c]),
    );
    expect(byName.id).toMatchObject({ data_type: 'bigint', is_nullable: 'NO' });
    expect(byName.seen_at).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    });
    expect(byName.writer).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(byName.is_first).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'NO',
    });
    expect(Object.keys(byName).filter((n) => LOG_COLUMNS.includes(n))).toEqual(
      expect.arrayContaining(LOG_COLUMNS),
    );
  });

  it('is keyed by its id and indexed on (ticker, timestamp, seen_at) for the as-of query', async () => {
    const { rows } = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
      [log],
    );
    const defs = rows.map((r) => r.indexdef.replaceAll(/\s+/g, ' '));
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `${log}_pkey ON public.${log} USING btree (id)`,
        ),
        expect.stringContaining(
          `${index} ON public.${log} USING btree (ticker, "timestamp", seen_at)`,
        ),
      ]),
    );
    expect(defs).toHaveLength(2);
  });
});

async function putVega(
  ticker: string,
  hhmmZ: string,
  expiry: string | null,
  flow: number,
  insertedAt = '2026-03-24T13:36:00Z',
) {
  await pg.query(
    `INSERT INTO vega_flow_etf
       (ticker, date, timestamp, expiry, dir_vega_flow, otm_dir_vega_flow,
        total_vega_flow, otm_total_vega_flow, dir_delta_flow, otm_dir_delta_flow,
        total_delta_flow, otm_total_delta_flow, transactions, volume, inserted_at)
     VALUES ($1, '2026-03-24', $2, $3, $4, $4, $4, $4, $4, $4, $4, $4, 7, 9, $5)`,
    [ticker, `2026-03-24T${hhmmZ}:00Z`, expiry, flow, insertedAt],
  );
}

async function putNope(ticker: string, hhmmZ: string, nope: string) {
  await pg.query(
    `INSERT INTO nope_ticks
       (ticker, timestamp, call_vol, put_vol, stock_vol, call_delta, put_delta,
        call_fill_delta, put_fill_delta, nope, nope_fill, ingested_at)
     VALUES ($1, $2, 10, 20, 1000, 1.5, -2.5, 3.5, -4.5, $3, -0.000434, '2026-03-24T13:59:00Z')`,
    [ticker, `2026-03-24T${hhmmZ}:00Z`, nope],
  );
}

describe('migration #207: the seed', () => {
  it("seeds vega_flow_etf with seen_at = the migration's now(), writer 'seed_restated' and is_first true, keeping a NULL expiry", async () => {
    await putVega('SPY', '13:35', null, 100.5);
    await putVega('SPY', '13:35', '2026-03-24', 200);
    await putVega('QQQ', '13:35', null, 300);
    const before = Date.now();

    await applyMigration(pg, 207);

    const { rows } = await pg.query<{
      ticker: string;
      expiry: string | null;
      dir_vega_flow: string;
      transactions: number;
      writer: string;
      is_first: boolean;
      seen_ms: number;
    }>(
      `SELECT ticker, to_char(expiry, 'YYYY-MM-DD') AS expiry,
              dir_vega_flow::text, transactions, writer, is_first,
              (EXTRACT(EPOCH FROM seen_at) * 1000)::float8 AS seen_ms
         FROM vega_flow_etf_revisions ORDER BY ticker, expiry NULLS FIRST`,
    );
    expect(rows.map((r) => [r.ticker, r.expiry, r.dir_vega_flow])).toEqual([
      ['QQQ', null, '300'],
      ['SPY', null, '100.5'],
      ['SPY', '2026-03-24', '200'],
    ]);
    for (const r of rows) {
      expect(r.writer).toBe('seed_restated');
      expect(r.is_first).toBe(true);
      expect(r.transactions).toBe(7);
      // The migration's time, not the row's first-insert time (13:36 on 03-24).
      expect(r.seen_ms).toBeGreaterThanOrEqual(before - 1000);
      expect(r.seen_ms).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it('seeds nope_ticks the same way, and does not copy ingested_at', async () => {
    await putNope('SPY', '13:35', '-0.000648');
    await putNope('SPY', '13:36', '0.000100');
    const before = Date.now();

    await applyMigration(pg, 207);

    const { rows } = await pg.query<{
      ts: string;
      nope: string;
      call_delta: string;
      writer: string;
      is_first: boolean;
      seen_ms: number;
    }>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              nope::text, call_delta::text, writer, is_first,
              (EXTRACT(EPOCH FROM seen_at) * 1000)::float8 AS seen_ms
         FROM nope_ticks_revisions ORDER BY timestamp`,
    );
    expect(rows.map((r) => [r.ts, r.nope, r.call_delta])).toEqual([
      ['13:35', '-0.0006480000', '1.5000'],
      ['13:36', '0.0001000000', '1.5000'],
    ]);
    for (const r of rows) {
      expect(r.writer).toBe('seed_restated');
      expect(r.is_first).toBe(true);
      // Not the overwritten ingested_at (13:59 on 03-24).
      expect(r.seen_ms).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('is idempotent: a second run adds nothing', async () => {
    await putVega('SPY', '13:35', null, 1);
    await putNope('SPY', '13:35', '0.1');

    await applyMigration(pg, 207);
    await applyMigration(pg, 207);

    const count = async (table: string) =>
      Number(
        (await pg.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`))
          .rows[0]!.n,
      );
    expect(await count('vega_flow_etf_revisions')).toBe(1);
    expect(await count('nope_ticks_revisions')).toBe(1);
  });

  it('on a re-run adds only the keys with no revision, and leaves a key that already has one alone', async () => {
    await putVega('SPY', '13:35', null, 1);
    await applyMigration(pg, 207);
    // A later row, and an existing row that already has a (non-seed) revision.
    await putVega('SPY', '13:40', null, 2);
    await putVega('SPY', '13:45', null, 3);
    await pg.query(
      `INSERT INTO vega_flow_etf_revisions
         (ticker, date, timestamp, expiry, dir_vega_flow, otm_dir_vega_flow,
          total_vega_flow, otm_total_vega_flow, dir_delta_flow, otm_dir_delta_flow,
          total_delta_flow, otm_total_delta_flow, transactions, volume, writer, is_first)
       VALUES ('SPY', '2026-03-24', '2026-03-24T13:45:00Z', NULL, 3, 3, 3, 3, 3, 3, 3, 3, 7, 9, 'fetch-greek-flow-etf', true)`,
    );

    await applyMigration(pg, 207);

    const { rows } = await pg.query<{ ts: string; writer: string }>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts, writer
         FROM vega_flow_etf_revisions ORDER BY timestamp`,
    );
    expect(rows.map((r) => [r.ts, r.writer])).toEqual([
      ['13:35', 'seed_restated'],
      ['13:40', 'seed_restated'],
      ['13:45', 'fetch-greek-flow-etf'],
    ]);
  });

  it('seeds nothing, and does not fail, when the source tables are empty', async () => {
    await applyMigration(pg, 207);

    for (const table of ['vega_flow_etf_revisions', 'nope_ticks_revisions']) {
      const { rows } = await pg.query(`SELECT 1 FROM ${table}`);
      expect(rows).toEqual([]);
    }
  });
});
