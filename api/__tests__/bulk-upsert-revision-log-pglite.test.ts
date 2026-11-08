// @vitest-environment node

/**
 * REAL-SQL test of bulkUpsert's opt-in revision log (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md), on nope_ticks and
 * vega_flow_etf as the real migrations #60, #92, #129 and #207 build them, in
 * pglite (real Postgres in WASM). bulk-upsert.test.ts mocks the driver and sees
 * only the statement text; this file runs the statements.
 *
 * With `revisionLog` set, the helper rewrites a conflicting row only when one
 * of the columns it updates differs, appends each inserted or changed row to
 * the log in the same statement, and counts what happened. Without it nothing
 * changes (bulk-upsert.test.ts).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';
import { bulkUpsert } from '../_lib/bulk-upsert.js';

let pg: PGlite;
// The two methods bulkUpsert uses on the neon handle, over pglite.
let sql: Parameters<typeof bulkUpsert>[0]['sql'];

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 60);
  await applyMigration(pg, 92);
  await applyMigration(pg, 129);
  await applyMigration(pg, 207);
  await pg.query(`SET TimeZone = 'UTC'`);
  const lazy = (text: string, params: unknown[]) => ({ text, params });
  sql = {
    query: (text: string, params: unknown[] = []) =>
      pg.query(text, params).then((r) => r.rows),
    // The callback form: `txn.query` builds the statement, the transaction runs
    // them in order and resolves to one row array per statement.
    transaction: (build: (txn: { query: typeof lazy }) => unknown[]) =>
      pg.transaction(async (tx) => {
        const results: unknown[] = [];
        for (const q of build({ query: lazy }) as ReturnType<typeof lazy>[]) {
          results.push((await tx.query(q.text, q.params)).rows);
        }
        return results;
      }),
  } as never;
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query(
    'TRUNCATE nope_ticks, nope_ticks_revisions, vega_flow_etf, vega_flow_etf_revisions RESTART IDENTITY',
  );
});

// ── nope_ticks ──────────────────────────────────────────────

const NOPE_COLUMNS = [
  'ticker',
  'timestamp',
  'call_vol',
  'put_vol',
  'stock_vol',
  'call_delta',
  'put_delta',
  'call_fill_delta',
  'put_fill_delta',
  'nope',
  'nope_fill',
] as const;

interface NopeRow extends Record<string, unknown> {
  ticker: string;
  timestamp: string;
  call_vol: number;
  put_vol: number;
  stock_vol: number;
  call_delta: string;
  put_delta: string;
  call_fill_delta: string;
  put_fill_delta: string;
  nope: string;
  nope_fill: string;
}

const nopeRow = (hhmm: string, nope: string, callVol = 10): NopeRow => ({
  ticker: 'SPY',
  timestamp: `2026-03-24T${hhmm}:00Z`,
  call_vol: callVol,
  put_vol: 20,
  stock_vol: 1000,
  call_delta: '1.5',
  put_delta: '-2.5',
  call_fill_delta: '3.5',
  put_fill_delta: '-4.5',
  nope,
  nope_fill: '-0.000434',
});

const upsertNope = (
  rows: NopeRow[],
  writer: string,
  extra: { chunkSize?: number } = {},
) =>
  bulkUpsert<NopeRow>({
    sql,
    table: 'nope_ticks',
    columns: NOPE_COLUMNS,
    rows,
    conflictTarget: '(ticker, timestamp)',
    revisionLog: { table: 'nope_ticks_revisions', writer },
    ...extra,
  });

const nopeLog = async () =>
  (
    await pg.query<{
      ts: string;
      nope: string;
      call_vol: number;
      writer: string;
      is_first: boolean;
    }>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              nope::text, call_vol, writer, is_first
         FROM nope_ticks_revisions ORDER BY id`,
    )
  ).rows;

const nopeTable = async () =>
  (
    await pg.query<{ ts: string; nope: string; ingested_at: string }>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              nope::text, ingested_at::text AS ingested_at
         FROM nope_ticks ORDER BY timestamp`,
    )
  ).rows;

describe('bulkUpsert with a revision log: nope_ticks', () => {
  it('logs an inserted row as a first revision with its writer, and counts it inserted', async () => {
    const result = await upsertNope(
      [nopeRow('13:35', '-0.000648')],
      'fetch-nope',
    );

    expect(result).toEqual({ rows: 1, inserted: 1, updated: 0, unchanged: 0 });
    expect(await nopeLog()).toEqual([
      {
        ts: '13:35',
        nope: '-0.0006480000',
        call_vol: 10,
        writer: 'fetch-nope',
        is_first: true,
      },
    ]);
  });

  it('rewrites nothing and logs nothing for a row that already holds these values', async () => {
    const same = [nopeRow('13:35', '-0.000648'), nopeRow('13:36', '0.0001')];
    await upsertNope(same, 'fetch-nope');
    const before = await nopeTable();

    const result = await upsertNope(same, 'fetch-nope');

    expect(result).toEqual({ rows: 2, inserted: 0, updated: 0, unchanged: 2 });
    expect(await nopeLog()).toHaveLength(2);
    // Not even ingested_at moved: the rows were not rewritten.
    expect(await nopeTable()).toEqual(before);
  });

  it('logs a changed value as a later revision and keeps ingested_at at the first ingest', async () => {
    await upsertNope([nopeRow('13:35', '-0.000648')], 'fetch-nope');
    await pg.query(
      `UPDATE nope_ticks SET ingested_at = '2026-03-24T13:36:00Z'`,
    );

    const result = await upsertNope(
      [nopeRow('13:35', '-0.000700')],
      'fetch-nope',
    );

    expect(result).toEqual({ rows: 1, inserted: 0, updated: 1, unchanged: 0 });
    expect(await nopeLog()).toEqual([
      expect.objectContaining({ nope: '-0.0006480000', is_first: true }),
      expect.objectContaining({ nope: '-0.0007000000', is_first: false }),
    ]);
    // The table holds the latest value, and ingested_at is still the first
    // ingest: the old cron set it to now() on every minute.
    expect(await nopeTable()).toEqual([
      {
        ts: '13:35',
        nope: '-0.0007000000',
        ingested_at: '2026-03-24 13:36:00+00',
      },
    ]);
  });

  it('compares at the column precision: a re-send with more digits than the column keeps is unchanged', async () => {
    // UW sends floats; call_delta is NUMERIC(20,4) and nope is NUMERIC(20,10).
    await upsertNope(
      [{ ...nopeRow('13:35', '0.12345678901234'), call_delta: '1.50001' }],
      'fetch-nope',
    );

    const result = await upsertNope(
      [{ ...nopeRow('13:35', '0.12345678901234'), call_delta: '1.50001' }],
      'fetch-nope',
    );

    expect(result).toEqual({ rows: 1, inserted: 0, updated: 0, unchanged: 1 });
    expect(await nopeLog()).toHaveLength(1);
  });

  it('logs a change of a single value column', async () => {
    await upsertNope([nopeRow('13:35', '0.1', 10)], 'fetch-nope');

    await upsertNope([nopeRow('13:35', '0.1', 11)], 'backfill-nope');

    expect(await nopeLog()).toEqual([
      expect.objectContaining({ call_vol: 10, writer: 'fetch-nope' }),
      expect.objectContaining({
        call_vol: 11,
        writer: 'backfill-nope',
        is_first: false,
      }),
    ]);
  });

  it('counts a mixed batch: one new, one revised, one unchanged, and logs two', async () => {
    await upsertNope(
      [nopeRow('13:35', '0.1'), nopeRow('13:36', '0.2')],
      'fetch-nope',
    );

    const result = await upsertNope(
      [
        nopeRow('13:35', '0.1'), // unchanged
        nopeRow('13:36', '0.25'), // revised
        nopeRow('13:37', '0.3'), // new
      ],
      'fetch-nope',
    );

    expect(result).toEqual({ rows: 3, inserted: 1, updated: 1, unchanged: 1 });
    expect((await nopeLog()).map((r) => [r.ts, r.is_first])).toEqual([
      ['13:35', true],
      ['13:36', true],
      ['13:36', false],
      ['13:37', true],
    ]);
  });

  it('runs more than one chunk in one transaction and sums the counts', async () => {
    const rows = ['13:30', '13:31', '13:32', '13:33', '13:34'].map((t) =>
      nopeRow(t, '0.1'),
    );
    await upsertNope(rows.slice(0, 2), 'fetch-nope');

    const result = await upsertNope(
      rows.map((r) =>
        r.timestamp.includes('13:31') ? { ...r, nope: '0.9' } : r,
      ),
      'fetch-nope',
      { chunkSize: 2 },
    );

    // 13:30 unchanged, 13:31 revised, 13:32-13:34 new, across three chunks.
    expect(result).toEqual({ rows: 5, inserted: 3, updated: 1, unchanged: 1 });
    expect(await nopeLog()).toHaveLength(2 + 3 + 1);
  });

  it('throws when the log insert fails and leaves nope_ticks as it was (R4)', async () => {
    await upsertNope([nopeRow('13:35', '0.1')], 'fetch-nope');
    await pg.query('DROP TABLE nope_ticks_revisions');
    try {
      await expect(
        upsertNope(
          [nopeRow('13:35', '0.9'), nopeRow('13:36', '0.2')],
          'fetch-nope',
        ),
      ).rejects.toThrow(/nope_ticks_revisions/);
      expect((await nopeTable()).map((r) => [r.ts, r.nope])).toEqual([
        ['13:35', '0.1000000000'],
      ]);
    } finally {
      await applyMigration(pg, 207);
    }
  });

  it('rolls back every chunk and every revision when a later chunk fails', async () => {
    const bad = {
      ...nopeRow('13:37', '0.3'),
      stock_vol: null,
    } as unknown as NopeRow;

    await expect(
      upsertNope(
        [nopeRow('13:35', '0.1'), nopeRow('13:36', '0.2'), bad],
        'fetch-nope',
        { chunkSize: 2 },
      ),
    ).rejects.toThrow();

    expect(await nopeTable()).toEqual([]);
    expect(await nopeLog()).toEqual([]);
  });

  it('refuses a log table name that is not a bare identifier', async () => {
    await expect(
      bulkUpsert<NopeRow>({
        sql,
        table: 'nope_ticks',
        columns: NOPE_COLUMNS,
        rows: [nopeRow('13:35', '0.1')],
        conflictTarget: '(ticker, timestamp)',
        revisionLog: { table: 'x; DROP TABLE nope_ticks', writer: 'w' },
      }),
    ).rejects.toThrow(/unsafe/);
  });
});

describe('the as-of query over nope_ticks_revisions', () => {
  const AS_OF_SQL = `
    SELECT DISTINCT ON (ticker, timestamp)
           to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts, nope::float8 AS nope
    FROM nope_ticks_revisions
    WHERE ticker = $1 AND timestamp <= $2::timestamptz AND seen_at <= $2::timestamptz
    ORDER BY ticker, timestamp, seen_at DESC, id DESC`;

  const asOf = async (t: string) =>
    (
      await pg.query<{ ts: string; nope: number }>(AS_OF_SQL, ['SPY', t])
    ).rows.map((r) => [r.ts, r.nope]);

  async function writeAt(seenAt: string, rows: NopeRow[]) {
    const { rows: m } = await pg.query<{ m: string | null }>(
      'SELECT MAX(id) AS m FROM nope_ticks_revisions',
    );
    const before = Number(m[0]!.m ?? 0);
    await upsertNope(rows, 'fetch-nope');
    await pg.query(
      'UPDATE nope_ticks_revisions SET seen_at = $1 WHERE id > $2',
      [seenAt, before],
    );
  }

  beforeEach(async () => {
    // 13:35 first stored at 13:36:30 (0.1), restated at 13:50 (0.2) and after
    // the close at 22:05 (0.3). 13:40 is stored once at 13:41:30 (0.5).
    await writeAt('2026-03-24T13:36:30Z', [nopeRow('13:35', '0.1')]);
    await writeAt('2026-03-24T13:41:30Z', [nopeRow('13:40', '0.5')]);
    await writeAt('2026-03-24T13:50:00Z', [nopeRow('13:35', '0.2')]);
    await writeAt('2026-03-24T22:05:00Z', [nopeRow('13:35', '0.3')]);
  });

  it('shows nothing before the first value was stored', async () => {
    expect(await asOf('2026-03-24T13:36:00Z')).toEqual([]);
  });

  it('shows the first value right after it was stored', async () => {
    expect(await asOf('2026-03-24T13:37:00Z')).toEqual([['13:35', 0.1]]);
  });

  it('shows the value between two revisions, not the final one', async () => {
    expect(await asOf('2026-03-24T14:00:00Z')).toEqual([
      ['13:35', 0.2],
      ['13:40', 0.5],
    ]);
  });

  it('shows the final value once every revision is in, and it matches the table', async () => {
    const final = await asOf('2026-03-24T23:00:00Z');
    expect(final).toEqual([
      ['13:35', 0.3],
      ['13:40', 0.5],
    ]);
    expect((await nopeTable()).map((r) => [r.ts, Number(r.nope)])).toEqual(
      final,
    );
  });
});

// ── vega_flow_etf ───────────────────────────────────────────

const VEGA_COLUMNS = [
  'ticker',
  'date',
  'timestamp',
  'expiry',
  'dir_vega_flow',
  'otm_dir_vega_flow',
  'total_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'otm_dir_delta_flow',
  'total_delta_flow',
  'otm_total_delta_flow',
  'transactions',
  'volume',
] as const;

interface VegaRow extends Record<string, unknown> {
  ticker: string;
  date: string;
  timestamp: string;
  expiry: string | null;
}

const vegaRow = (
  hhmm: string,
  flow: string,
  expiry: string | null = null,
  ticker = 'SPY',
): VegaRow => ({
  ticker,
  date: '2026-03-24',
  timestamp: `2026-03-24T${hhmm}:00Z`,
  expiry,
  dir_vega_flow: flow,
  otm_dir_vega_flow: flow,
  total_vega_flow: flow,
  otm_total_vega_flow: flow,
  dir_delta_flow: flow,
  otm_dir_delta_flow: flow,
  total_delta_flow: flow,
  otm_total_delta_flow: flow,
  transactions: 7,
  volume: 9,
});

const upsertVega = (rows: VegaRow[], writer: string) =>
  bulkUpsert<VegaRow>({
    sql,
    table: 'vega_flow_etf',
    columns: VEGA_COLUMNS,
    rows,
    conflictTarget: '(ticker, timestamp, expiry)',
    // `date` is part of the key's meaning, not a value UW restates.
    conflictUpdateColumns: VEGA_COLUMNS.filter(
      (c) => !['ticker', 'date', 'timestamp', 'expiry'].includes(c),
    ),
    revisionLog: { table: 'vega_flow_etf_revisions', writer },
  });

describe('bulkUpsert with a revision log: vega_flow_etf', () => {
  it('treats a NULL expiry as the same key on a re-send (NULLS NOT DISTINCT): unchanged, not a duplicate row', async () => {
    await upsertVega([vegaRow('13:35', '100.5')], 'backfill-greek-flow-etf');

    const result = await upsertVega(
      [vegaRow('13:35', '100.5')],
      'backfill-greek-flow-etf',
    );

    expect(result).toEqual({ rows: 1, inserted: 0, updated: 0, unchanged: 1 });
    const { rows } = await pg.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM vega_flow_etf',
    );
    expect(Number(rows[0]!.n)).toBe(1);
    const log = await pg.query('SELECT 1 FROM vega_flow_etf_revisions');
    expect(log.rows).toHaveLength(1);
  });

  it('logs a revised value for the all-expiries row and the per-expiry row separately', async () => {
    await upsertVega(
      [vegaRow('13:35', '1'), vegaRow('13:35', '2', '2026-03-24')],
      'backfill-greek-flow-etf-0dte',
    );

    const result = await upsertVega(
      [vegaRow('13:35', '1.5'), vegaRow('13:35', '2', '2026-03-24')],
      'backfill-greek-flow-etf-0dte',
    );

    expect(result).toEqual({ rows: 2, inserted: 0, updated: 1, unchanged: 1 });
    const { rows } = await pg.query<{
      expiry: string | null;
      dir_vega_flow: string;
      is_first: boolean;
    }>(
      `SELECT to_char(expiry, 'YYYY-MM-DD') AS expiry, dir_vega_flow::text, is_first
         FROM vega_flow_etf_revisions ORDER BY id`,
    );
    expect(rows).toEqual([
      { expiry: null, dir_vega_flow: '1', is_first: true },
      { expiry: '2026-03-24', dir_vega_flow: '2', is_first: true },
      { expiry: null, dir_vega_flow: '1.5', is_first: false },
    ]);
  });
});
