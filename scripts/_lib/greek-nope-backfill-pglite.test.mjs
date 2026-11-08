// @vitest-environment node

/**
 * REAL-SQL test of the writes the three backfill scripts make into
 * vega_flow_etf and nope_ticks (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). The unit test
 * sees only the statement text; this file runs it in pglite (real Postgres in
 * WASM) on the tables built by the real migrations #60, #92, #129 and #207.
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

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { storeNopeRows, storeVegaFlowTicks } from './greek-nope-backfill.mjs';

let pg;
let sql;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 60);
  await applyMigration(pg, 92);
  await applyMigration(pg, 129);
  await applyMigration(pg, 207);
  await pg.query(`SET TimeZone = 'UTC'`);
  // The one method the script's neon handle is used through.
  sql = { query: (text, values) => pg.query(text, values).then((r) => r.rows) };
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await pg.query(
    'TRUNCATE vega_flow_etf, vega_flow_etf_revisions, nope_ticks, nope_ticks_revisions RESTART IDENTITY',
  );
});

const DATE = '2026-03-24';

const tick = (hhmm, flow = '1') => ({
  timestamp: `${DATE}T${hhmm}:00Z`,
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

const nopeRow = (hhmm, nope = '-0.000648', overrides = {}) => ({
  timestamp: `${DATE}T${hhmm}:00Z`,
  call_vol: 10,
  put_vol: 20,
  stock_vol: 1000,
  call_delta: '1.5',
  put_delta: '-2.5',
  call_fill_delta: '3.5',
  put_fill_delta: '-4.5',
  nope,
  nope_fill: '-0.000434',
  ...overrides,
});

const vegaLog = async () =>
  (
    await pg.query(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              to_char(expiry, 'YYYY-MM-DD') AS expiry,
              dir_vega_flow::text AS flow, writer, is_first
         FROM vega_flow_etf_revisions ORDER BY id`,
    )
  ).rows;

const vegaTable = async () =>
  (
    await pg.query(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              to_char(expiry, 'YYYY-MM-DD') AS expiry,
              dir_vega_flow::text AS flow
         FROM vega_flow_etf ORDER BY timestamp, expiry NULLS FIRST`,
    )
  ).rows;

const nopeLog = async () =>
  (
    await pg.query(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              nope::text AS nope, writer, is_first
         FROM nope_ticks_revisions ORDER BY id`,
    )
  ).rows;

const allExpiries = (ticks, writer = 'backfill-greek-flow-etf') =>
  storeVegaFlowTicks(sql, {
    ticker: 'SPY',
    date: DATE,
    expiry: null,
    ticks,
    writer,
  });

describe('storeVegaFlowTicks', () => {
  it('stores the all-expiries feed (NULL expiry), which the old script could not, and logs each minute as a first revision', async () => {
    const result = await allExpiries([
      tick('13:35', '100.5'),
      tick('13:36', '7'),
    ]);

    expect(result).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(await vegaTable()).toEqual([
      { ts: '13:35', expiry: null, flow: '100.5' },
      { ts: '13:36', expiry: null, flow: '7' },
    ]);
    expect(await vegaLog()).toEqual([
      {
        ts: '13:35',
        expiry: null,
        flow: '100.5',
        writer: 'backfill-greek-flow-etf',
        is_first: true,
      },
      {
        ts: '13:36',
        expiry: null,
        flow: '7',
        writer: 'backfill-greek-flow-etf',
        is_first: true,
      },
    ]);
  });

  it('re-running a day that has not changed writes and logs nothing', async () => {
    await allExpiries([tick('13:35'), tick('13:36')]);

    const result = await allExpiries([tick('13:35'), tick('13:36')]);

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      failed: 0,
    });
    expect(await vegaLog()).toHaveLength(2);
  });

  it('logs a value UW restated as a later revision under the writer, and leaves the table on the latest', async () => {
    await allExpiries([tick('13:35', '1')], 'fetch-greek-flow-etf');

    const result = await allExpiries([tick('13:35', '2')]);

    expect(result).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(await vegaTable()).toEqual([
      { ts: '13:35', expiry: null, flow: '2' },
    ]);
    expect(await vegaLog()).toEqual([
      expect.objectContaining({ flow: '1', writer: 'fetch-greek-flow-etf' }),
      expect.objectContaining({
        flow: '2',
        writer: 'backfill-greek-flow-etf',
        is_first: false,
      }),
    ]);
  });

  it('stores the 0DTE feed beside the all-expiries rows of the same minute', async () => {
    await allExpiries([tick('13:35', '1')]);

    const result = await storeVegaFlowTicks(sql, {
      ticker: 'SPY',
      date: DATE,
      expiry: DATE,
      ticks: [tick('13:35', '2')],
      writer: 'backfill-greek-flow-etf-0dte',
    });

    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(await vegaTable()).toEqual([
      { ts: '13:35', expiry: null, flow: '1' },
      { ts: '13:35', expiry: DATE, flow: '2' },
    ]);
    expect(await vegaLog()).toEqual([
      expect.objectContaining({
        expiry: null,
        writer: 'backfill-greek-flow-etf',
      }),
      expect.objectContaining({
        expiry: DATE,
        writer: 'backfill-greek-flow-etf-0dte',
      }),
    ]);
  });

  it('warns, reports the day as failed and leaves vega_flow_etf unchanged when the log insert fails (R4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await allExpiries([tick('13:35', '1')]);
    await pg.query('DROP TABLE vega_flow_etf_revisions');
    try {
      const result = await allExpiries([
        tick('13:35', '9'),
        tick('13:36', '9'),
      ]);

      expect(result).toEqual({
        inserted: 0,
        updated: 0,
        unchanged: 0,
        failed: 2,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('vega_flow_etf_revisions'),
      );
      expect(await vegaTable()).toEqual([
        { ts: '13:35', expiry: null, flow: '1' },
      ]);
    } finally {
      await applyMigration(pg, 207);
    }
  });
});

describe('storeNopeRows', () => {
  const store = (rows, writer = 'backfill-nope') =>
    storeNopeRows(sql, rows, writer);

  it('stores the day and logs each minute as a first revision under the writer', async () => {
    const result = await store([nopeRow('13:35'), nopeRow('13:36', '0.0001')]);

    expect(result).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(await nopeLog()).toEqual([
      {
        ts: '13:35',
        nope: '-0.0006480000',
        writer: 'backfill-nope',
        is_first: true,
      },
      {
        ts: '13:36',
        nope: '0.0001000000',
        writer: 'backfill-nope',
        is_first: true,
      },
    ]);
  });

  it('re-running an unchanged day writes and logs nothing', async () => {
    await store([nopeRow('13:35'), nopeRow('13:36')]);

    const result = await store([nopeRow('13:35'), nopeRow('13:36')]);

    expect(result).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await nopeLog()).toHaveLength(2);
  });

  it('logs a restated value and keeps ingested_at at the first ingest (the old script set it to now())', async () => {
    await store([nopeRow('13:35', '-0.000648')]);
    await pg.query(
      `UPDATE nope_ticks SET ingested_at = '2026-03-24T13:36:00Z'`,
    );

    const result = await store([nopeRow('13:35', '-0.0007')]);

    expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    const { rows } = await pg.query(
      `SELECT nope::text AS nope, ingested_at::text AS ingested_at FROM nope_ticks`,
    );
    expect(rows).toEqual([
      { nope: '-0.0007000000', ingested_at: '2026-03-24 13:36:00+00' },
    ]);
    expect(await nopeLog()).toEqual([
      expect.objectContaining({ nope: '-0.0006480000', is_first: true }),
      expect.objectContaining({ nope: '-0.0007000000', is_first: false }),
    ]);
  });

  it('stores nothing for a skipped row and says how many it skipped', async () => {
    const result = await store([
      nopeRow('13:35'),
      nopeRow('13:36', '0.1', { stock_vol: 0 }),
    ]);

    expect(result).toMatchObject({ inserted: 1, skipped: 1, failed: 0 });
    const { rows } = await pg.query('SELECT 1 FROM nope_ticks');
    expect(rows).toHaveLength(1);
  });

  it('warns, reports the rows as failed and leaves nope_ticks unchanged when the log insert fails (R4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store([nopeRow('13:35', '0.1')]);
    await pg.query('DROP TABLE nope_ticks_revisions');
    try {
      const result = await store([nopeRow('13:35', '0.9'), nopeRow('13:36')]);

      expect(result).toMatchObject({ inserted: 0, updated: 0, failed: 2 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('nope_ticks_revisions'),
      );
      const { rows } = await pg.query(
        `SELECT nope::text AS nope FROM nope_ticks ORDER BY timestamp`,
      );
      expect(rows).toEqual([{ nope: '0.1000000000' }]);
    } finally {
      await applyMigration(pg, 207);
    }
  });
});
