// @vitest-environment node

/**
 * REAL-SQL test of the revision log write the flow_data backfill scripts make
 * (spec P0.8, docs/superpowers/specs/live-data-integrity-2026-11-06.md). The
 * scripts insert with ON CONFLICT DO NOTHING, so they only ever add rows; each
 * row they add is appended to flow_data_revisions in the same statement, under
 * the script's name. flow-data-backfill.test.mjs and backfill-cli.test.mjs see
 * only the statement text; this file runs it in pglite (real Postgres in WASM)
 * on flow_data and flow_data_revisions built by the real migrations #4, #48
 * and #206.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { storeRows } from './backfill-cli.mjs';
import {
  FLOW_DATA_TARGET,
  loggedFlowDataTarget,
} from './flow-data-backfill.mjs';

let pg;
let sql;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 4);
  await applyMigration(pg, 48);
  await applyMigration(pg, 206);
  await pg.query(`SET TimeZone = 'UTC'`);
  // The one method the script's neon handle is used through.
  sql = { query: (text, values) => pg.query(text, values).then((r) => r.rows) };
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE flow_data, flow_data_revisions RESTART IDENTITY');
});

const DAY = '2026-03-24';
const row = (hhmmZ, source, ncp, npp, netVolume = 7) => ({
  date: DAY,
  timestamp: `${DAY}T${hhmmZ}:00.000Z`,
  source,
  ncp,
  npp,
  net_volume: netVolume,
});

const flowRows = async () =>
  (
    await pg.query(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts, source,
              ncp::text AS ncp, npp::text AS npp, net_volume
         FROM flow_data ORDER BY source, timestamp`,
    )
  ).rows;

const logRows = async () =>
  (
    await pg.query(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts, source,
              ncp::text AS ncp, npp::text AS npp, net_volume, writer, is_first
         FROM flow_data_revisions ORDER BY source, timestamp, id`,
    )
  ).rows;

describe('a logged flow_data backfill insert', () => {
  const target = loggedFlowDataTarget('backfill-etf-tide');

  it('adds each row it inserts to the log as a first-seen row under the script name, with the values as stored', async () => {
    const stored = await storeRows(
      sql,
      target,
      [
        // UW sends strings; the DECIMAL(14,2) column rounds the third decimal.
        row('13:35', 'spy_etf_tide', '1000.456', '-500'),
        row('13:35', 'qqq_etf_tide', '2000', '-700.5', null),
      ],
      { dryRun: false },
    );

    expect(stored).toBe(2);
    expect(await flowRows()).toEqual([
      {
        ts: '13:35',
        source: 'qqq_etf_tide',
        ncp: '2000.00',
        npp: '-700.50',
        net_volume: null,
      },
      {
        ts: '13:35',
        source: 'spy_etf_tide',
        ncp: '1000.46',
        npp: '-500.00',
        net_volume: 7,
      },
    ]);
    expect(await logRows()).toEqual([
      {
        ts: '13:35',
        source: 'qqq_etf_tide',
        ncp: '2000.00',
        npp: '-700.50',
        net_volume: null,
        writer: 'backfill-etf-tide',
        is_first: true,
      },
      {
        ts: '13:35',
        source: 'spy_etf_tide',
        ncp: '1000.46',
        npp: '-500.00',
        net_volume: 7,
        writer: 'backfill-etf-tide',
        is_first: true,
      },
    ]);
  });

  it('leaves a row a live cron already stored untouched and logs nothing for it', async () => {
    await pg.query(
      `INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
       VALUES ($1, '2026-03-24T13:35:00Z', 'spy_etf_tide', 5, 5, 5)`,
      [DAY],
    );

    const stored = await storeRows(
      sql,
      target,
      [
        row('13:35', 'spy_etf_tide', 100, -100),
        row('13:40', 'spy_etf_tide', 200, -200),
      ],
      { dryRun: false },
    );

    expect(stored).toBe(1);
    expect((await flowRows()).map((r) => [r.ts, r.ncp])).toEqual([
      ['13:35', '5.00'],
      ['13:40', '200.00'],
    ]);
    // Only the row this script inserted is in the log.
    expect((await logRows()).map((r) => [r.ts, r.writer])).toEqual([
      ['13:40', 'backfill-etf-tide'],
    ]);
  });

  it('adds nothing to either table when the log insert fails (R4)', async () => {
    await pg.query('DROP TABLE flow_data_revisions');
    try {
      await expect(
        storeRows(sql, target, [row('13:35', 'spy_etf_tide', 100, -100)], {
          dryRun: false,
        }),
      ).rejects.toThrow();
      expect(await flowRows()).toEqual([]);
    } finally {
      await applyMigration(pg, 206);
    }
  });

  it('logs nothing for a first-write-wins source written through the unlogged target', async () => {
    await storeRows(
      sql,
      FLOW_DATA_TARGET,
      [row('13:35', 'market_tide', 100, -100)],
      {
        dryRun: false,
      },
    );

    expect(await flowRows()).toHaveLength(1);
    expect(await logRows()).toEqual([]);
  });

  it('logs rows beyond one statement: each chunk carries its own log entries', async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      row(
        `${String(13 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        'zero_dte_index',
        i,
        -i,
      ),
    );

    const stored = await storeRows(
      sql,
      loggedFlowDataTarget('backfill-zero-dte-flow'),
      rows,
      { dryRun: false },
    );

    expect(stored).toBe(501);
    expect(await logRows()).toHaveLength(501);
  });
});
