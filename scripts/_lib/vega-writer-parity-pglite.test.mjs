// @vitest-environment node

/**
 * PARITY test of the two writers of vega_flow_etf (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md).
 *
 * The same table and the same revision log are written by two different
 * statements:
 *   - the crons, through `upsertGreekFlowTicks` (api/_lib/greek-flow-etf-store.ts),
 *     a hand-written data-modifying CTE over `unnest`;
 *   - the three backfill scripts, through `storeVegaFlowTicks`
 *     (scripts/_lib/greek-nope-backfill.mjs), which uses `bulkUpsert`'s
 *     VALUES form with its `revisionLog` option.
 *
 * Each has its own test, so nothing else notices if one drifts from the other
 * (a column added to one, a changed IS DISTINCT FROM guard, an `is_first` that
 * means something else). This file runs both on the same ticks against two
 * identical pglite databases built from the real migrations, step by step, and
 * asserts identical counts, identical vega_flow_etf rows and identical
 * revision rows (only the surrogate id and the clock columns are left out).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';

const holder = vi.hoisted(() => ({ sql: null }));

// The store reads its handle from getDb(); only the handle is replaced.
vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => holder.sql,
}));
vi.mock('../../api/_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
}));

import { upsertGreekFlowTicks } from '../../api/_lib/greek-flow-etf-store.ts';
import { storeVegaFlowTicks } from './greek-nope-backfill.mjs';

const DATE = '2026-03-24';
// Both writers log under the same name, so the writer column compares too.
const WRITER = 'parity-writer';
const EXPIRY = DATE;

let cronDb;
let scriptDb;
let cronSql;
let scriptSql;

async function freshDb() {
  const pg = await PGlite.create();
  // #207 creates and seeds both revision tables, so nope_ticks (#60) must exist.
  await applyMigration(pg, 60);
  await applyMigration(pg, 92);
  await applyMigration(pg, 129);
  await applyMigration(pg, 207);
  await pg.query(`SET TimeZone = 'UTC'`);
  return pg;
}

beforeAll(async () => {
  cronDb = await freshDb();
  scriptDb = await freshDb();
  cronSql = neonOverPglite(cronDb);
  scriptSql = neonOverPglite(scriptDb);
}, 120_000);

afterAll(async () => {
  await cronDb.close();
  await scriptDb.close();
});

/** A tick with a distinct value in every field, so a swapped column shows. */
function tick(hhmm, base) {
  const n = Number(base);
  return {
    timestamp: `${DATE}T${hhmm}:00Z`,
    ticker: 'SPY',
    total_delta_flow: String(n + 1),
    dir_delta_flow: String(-(n + 2)),
    total_vega_flow: String(n + 3.25),
    dir_vega_flow: String(-(n + 4.5)),
    otm_total_delta_flow: String(n + 5),
    otm_dir_delta_flow: String(-(n + 6)),
    otm_total_vega_flow: String(n + 7.75),
    otm_dir_vega_flow: String(-(n + 8.125)),
    transactions: 100 + Math.trunc(n),
    volume: 1000 + Math.trunc(n),
  };
}

/** Run one step through the cron's store. */
const viaCron = (ticks, expiry) => {
  holder.sql = cronSql;
  return upsertGreekFlowTicks('SPY', ticks, DATE, expiry, WRITER);
};

/** Run one step through the backfill scripts' writer. */
const viaScript = (ticks, expiry) =>
  storeVegaFlowTicks(scriptSql, {
    ticker: 'SPY',
    date: DATE,
    expiry,
    ticks,
    writer: WRITER,
  });

const COLUMNS = `ticker, date::text AS date, timestamp::text AS timestamp,
  expiry::text AS expiry,
  dir_vega_flow::text AS dir_vega_flow,
  otm_dir_vega_flow::text AS otm_dir_vega_flow,
  total_vega_flow::text AS total_vega_flow,
  otm_total_vega_flow::text AS otm_total_vega_flow,
  dir_delta_flow::text AS dir_delta_flow,
  otm_dir_delta_flow::text AS otm_dir_delta_flow,
  total_delta_flow::text AS total_delta_flow,
  otm_total_delta_flow::text AS otm_total_delta_flow,
  transactions, volume`;

const dump = async (pg) => ({
  table: (
    await pg.query(
      `SELECT ${COLUMNS} FROM vega_flow_etf
        ORDER BY timestamp, expiry NULLS FIRST`,
    )
  ).rows,
  // Order by the key, then id: the order within one statement is not part of
  // the contract, the order of one row's revisions is.
  log: (
    await pg.query(
      `SELECT ${COLUMNS}, writer, is_first FROM vega_flow_etf_revisions
        ORDER BY timestamp, expiry NULLS FIRST, id`,
    )
  ).rows,
});

/** Run a step on both writers and require the same counts and the same state. */
async function step(ticks, expiry) {
  const cron = await viaCron(ticks, expiry);
  const script = await viaScript(ticks, expiry);

  // The cron's result has no `unchanged`; the three it has must match.
  expect({
    inserted: script.inserted,
    updated: script.updated,
    failed: script.failed,
  }).toEqual(cron);

  const [a, b] = [await dump(cronDb), await dump(scriptDb)];
  expect(b.table).toEqual(a.table);
  expect(b.log).toEqual(a.log);
  return a;
}

describe('vega_flow_etf: the cron store and the backfill writer agree', () => {
  // One database pair, built once; the steps are cumulative on purpose, because
  // what is compared is how each writer treats a row it has seen before.
  it('a first load of the all-expiries feed: same rows, same first-seen revisions', async () => {
    const state = await step(
      [tick('13:35', 10), tick('13:36', 20), tick('13:37', 30)],
      null,
    );

    expect(state.table).toHaveLength(3);
    expect(state.log).toHaveLength(3);
    expect(state.log.every((r) => r.is_first && r.writer === WRITER)).toBe(
      true,
    );
  });

  it('a first load of the per-expiry (0DTE) scope beside it, on the same minutes', async () => {
    const state = await step([tick('13:35', 11), tick('13:36', 21)], EXPIRY);

    // NULLS NOT DISTINCT (migration #129): the two scopes are different keys.
    expect(state.table).toHaveLength(5);
    expect(state.log).toHaveLength(5);
  });

  it('re-sending the day unchanged writes and logs nothing in either', async () => {
    const before = await dump(cronDb);

    const state = await step(
      [tick('13:35', 10), tick('13:36', 20), tick('13:37', 30)],
      null,
    );

    expect(state.log).toEqual(before.log);
  });

  it('a restated value and a new minute: one update, one insert, one extra revision each', async () => {
    const state = await step(
      [tick('13:35', 10), tick('13:36', 99), tick('13:38', 40)],
      null,
    );

    // 5 first-seen + 1 restatement of 13:36 + 1 new minute 13:38.
    expect(state.log).toHaveLength(7);
    const restated = state.log.filter(
      (r) => r.timestamp.includes('13:36:00') && r.expiry === null,
    );
    expect(restated.map((r) => r.is_first)).toEqual([true, false]);
  });

  it('a change in only the integer columns still counts as a change in both', async () => {
    const changed = { ...tick('13:35', 10), transactions: 5, volume: 6 };

    const state = await step([changed], null);

    const rows = state.log.filter(
      (r) => r.timestamp.includes('13:35:00') && r.expiry === null,
    );
    expect(rows.map((r) => r.is_first)).toEqual([true, false]);
    expect(rows.at(-1)).toMatchObject({ transactions: 5, volume: 6 });
  });

  it('negative, fractional and large values round-trip the same', async () => {
    const odd = {
      ...tick('13:40', 0),
      total_delta_flow: '-1234567890123.45',
      dir_delta_flow: '0',
      total_vega_flow: '0.01',
      dir_vega_flow: '-0.01',
    };

    const state = await step([odd], null);

    const row = state.table.find((r) => r.timestamp.includes('13:40:00'));
    expect(row).toMatchObject({
      total_delta_flow: '-1234567890123.45',
      dir_delta_flow: '0',
    });
  });
});
