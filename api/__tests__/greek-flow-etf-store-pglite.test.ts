// @vitest-environment node

/**
 * REAL-SQL test of upsertGreekFlowTicks and the vega_flow_etf revision log
 * (spec P0.9, docs/superpowers/specs/live-data-integrity-2026-11-06.md). The
 * cron tests mock the store and can only match the SQL text; this file runs the
 * statement against pglite (real Postgres in WASM) on vega_flow_etf as the real
 * migrations #92 and #129 build it, and vega_flow_etf_revisions from #207, with
 * the session in UTC as on Neon.
 *
 * Only the DB handle is replaced: getDb returns the pglite-backed client.
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
vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
}));

import { upsertGreekFlowTicks } from '../_lib/greek-flow-etf-store.js';
import type { GreekFlowTick } from '../_lib/greek-flow-etf-store.js';
import { metrics } from '../_lib/sentry.js';

const DATE = '2026-03-24';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  // #207 creates and seeds both revision tables, so nope_ticks (#60) must exist.
  await applyMigration(pg, 60);
  await applyMigration(pg, 92);
  await applyMigration(pg, 129);
  await applyMigration(pg, 207);
  await pg.query(`SET TimeZone = 'UTC'`);
  holder.sql = neonOverPglite(pg);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.mocked(metrics.increment).mockClear();
  await pg.query(
    'TRUNCATE vega_flow_etf, vega_flow_etf_revisions RESTART IDENTITY',
  );
});

const tick = (hhmm: string, flow: string, ticker = 'SPY'): GreekFlowTick => ({
  timestamp: `${DATE}T${hhmm}:00Z`,
  ticker,
  total_delta_flow: flow,
  dir_delta_flow: flow,
  total_vega_flow: flow,
  dir_vega_flow: flow,
  otm_total_delta_flow: flow,
  otm_dir_delta_flow: flow,
  otm_total_vega_flow: flow,
  otm_dir_vega_flow: flow,
  transactions: 7,
  volume: 9,
});

interface LogRow {
  ts: string;
  expiry: string | null;
  flow: string;
  writer: string;
  is_first: boolean;
}

const log = async (): Promise<LogRow[]> =>
  (
    await pg.query<LogRow>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              to_char(expiry, 'YYYY-MM-DD') AS expiry,
              dir_vega_flow::text AS flow, writer, is_first
         FROM vega_flow_etf_revisions ORDER BY id`,
    )
  ).rows;

const table = async () =>
  (
    await pg.query<{
      ts: string;
      expiry: string | null;
      flow: string;
      inserted_at: string;
    }>(
      `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
              to_char(expiry, 'YYYY-MM-DD') AS expiry,
              dir_vega_flow::text AS flow, inserted_at::text AS inserted_at
         FROM vega_flow_etf ORDER BY timestamp, expiry NULLS FIRST`,
    )
  ).rows;

describe('upsertGreekFlowTicks: the revision log', () => {
  it('logs every inserted minute as a first revision under the writer, and counts them inserted', async () => {
    const result = await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5'), tick('13:36', '101.5')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 2, updated: 0, failed: 0 });
    expect(await log()).toEqual([
      {
        ts: '13:35',
        expiry: null,
        flow: '100.5',
        writer: 'fetch-greek-flow-etf',
        is_first: true,
      },
      {
        ts: '13:36',
        expiry: null,
        flow: '101.5',
        writer: 'fetch-greek-flow-etf',
        is_first: true,
      },
    ]);
  });

  it('rewrites nothing and logs nothing when the day is re-sent unchanged (the every-minute case)', async () => {
    const day = [tick('13:35', '100.5'), tick('13:36', '101.5')];
    await upsertGreekFlowTicks('SPY', day, DATE, null, 'fetch-greek-flow-etf');
    const before = await table();

    const result = await upsertGreekFlowTicks(
      'SPY',
      day,
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 0, updated: 0, failed: 0 });
    expect(await log()).toHaveLength(2);
    expect(await table()).toEqual(before);
  });

  it('compares numerically: "100.50" for a stored 100.5 is not a change', async () => {
    await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    const result = await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5000')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 0, updated: 0, failed: 0 });
    expect(await log()).toHaveLength(1);
  });

  it('logs a restated value as a later revision, keeps the latest in the table, and counts it updated', async () => {
    await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5'), tick('13:36', '101.5')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    const result = await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5'), tick('13:36', '90')],
      DATE,
      null,
      'reconcile-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 0, updated: 1, failed: 0 });
    expect(await log()).toEqual([
      expect.objectContaining({ ts: '13:35', flow: '100.5', is_first: true }),
      expect.objectContaining({ ts: '13:36', flow: '101.5', is_first: true }),
      {
        ts: '13:36',
        expiry: null,
        flow: '90',
        writer: 'reconcile-greek-flow-etf',
        is_first: false,
      },
    ]);
    expect((await table()).map((r) => [r.ts, r.flow])).toEqual([
      ['13:35', '100.5'],
      ['13:36', '90'],
    ]);
  });

  it('logs a change of only the transactions column', async () => {
    await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '1')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    const result = await upsertGreekFlowTicks(
      'SPY',
      [{ ...tick('13:35', '1'), transactions: 8 }],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 0, updated: 1, failed: 0 });
    expect(await log()).toHaveLength(2);
  });

  it('keeps the all-expiries row and the 0DTE row of the same minute apart, each logged under its own expiry', async () => {
    await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '1')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );
    const zeroDte = await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '2')],
      DATE,
      DATE,
      'fetch-greek-flow-etf',
    );
    // A NULL expiry is the same key on a re-send (NULLS NOT DISTINCT).
    const resend = await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '1')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(zeroDte).toEqual({ inserted: 1, updated: 0, failed: 0 });
    expect(resend).toEqual({ inserted: 0, updated: 0, failed: 0 });
    expect(await table()).toEqual([
      expect.objectContaining({ expiry: null, flow: '1' }),
      expect.objectContaining({ expiry: DATE, flow: '2' }),
    ]);
    expect((await log()).map((r) => [r.expiry, r.flow])).toEqual([
      [null, '1'],
      [DATE, '2'],
    ]);
  });

  it('returns failed, logs the error, and leaves vega_flow_etf unchanged when the log insert fails (R4)', async () => {
    await upsertGreekFlowTicks(
      'SPY',
      [tick('13:35', '100.5')],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );
    await pg.query('DROP TABLE vega_flow_etf_revisions');
    try {
      const result = await upsertGreekFlowTicks(
        'SPY',
        [tick('13:35', '999'), tick('13:36', '1')],
        DATE,
        null,
        'fetch-greek-flow-etf',
      );

      // The store reports the failure to its caller instead of throwing: the
      // live cron counts failed legs, and the reconcile now fails its run on
      // one. The data table did not change without its revision.
      expect(result).toEqual({ inserted: 0, updated: 0, failed: 2 });
      expect(metrics.increment).toHaveBeenCalledWith(
        'greek_flow_etf.store_error',
      );
      expect((await table()).map((r) => [r.ts, r.flow])).toEqual([
        ['13:35', '100.5'],
      ]);
    } finally {
      await applyMigration(pg, 207);
    }
  });

  it('returns zeroes for no ticks without touching the database', async () => {
    const result = await upsertGreekFlowTicks(
      'SPY',
      [],
      DATE,
      null,
      'fetch-greek-flow-etf',
    );

    expect(result).toEqual({ inserted: 0, updated: 0, failed: 0 });
    expect(await log()).toEqual([]);
  });
});

describe('the as-of query over vega_flow_etf_revisions', () => {
  const AS_OF_SQL = `
    SELECT DISTINCT ON (ticker, timestamp, expiry)
           to_char(timestamp AT TIME ZONE 'UTC', 'HH24:MI') AS ts,
           dir_vega_flow::float8 AS flow
    FROM vega_flow_etf_revisions
    WHERE ticker = $1 AND expiry IS NOT DISTINCT FROM $3::date
      AND timestamp <= $2::timestamptz AND seen_at <= $2::timestamptz
    ORDER BY ticker, timestamp, expiry, seen_at DESC, id DESC`;

  const asOf = async (t: string) =>
    (
      await pg.query<{ ts: string; flow: number }>(AS_OF_SQL, ['SPY', t, null])
    ).rows.map((r) => [r.ts, r.flow]);

  async function writeAt(seenAt: string, ticks: GreekFlowTick[]) {
    const { rows } = await pg.query<{ m: string | number | null }>(
      'SELECT MAX(id) AS m FROM vega_flow_etf_revisions',
    );
    const before = Number(rows[0]!.m ?? 0);
    await upsertGreekFlowTicks(
      'SPY',
      ticks,
      DATE,
      null,
      'fetch-greek-flow-etf',
    );
    await pg.query(
      'UPDATE vega_flow_etf_revisions SET seen_at = $1 WHERE id > $2',
      [seenAt, before],
    );
  }

  beforeEach(async () => {
    // 13:35 first stored at 13:36:30 (1), restated at 13:50 (2) and after the
    // close at 22:05 (3). 13:40 is stored once at 13:41:30 (5).
    await writeAt('2026-03-24T13:36:30Z', [tick('13:35', '1')]);
    await writeAt('2026-03-24T13:41:30Z', [tick('13:40', '5')]);
    await writeAt('2026-03-24T13:50:00Z', [tick('13:35', '2')]);
    await writeAt('2026-03-24T22:05:00Z', [tick('13:35', '3')]);
  });

  it('shows nothing before the first value was stored', async () => {
    expect(await asOf('2026-03-24T13:36:00Z')).toEqual([]);
  });

  it('shows the first value right after it was stored', async () => {
    expect(await asOf('2026-03-24T13:37:00Z')).toEqual([['13:35', 1]]);
  });

  it('shows the value between two revisions, not the final one', async () => {
    expect(await asOf('2026-03-24T14:00:00Z')).toEqual([
      ['13:35', 2],
      ['13:40', 5],
    ]);
  });

  it('shows the final value once every revision is in, and it matches the table', async () => {
    const final = await asOf('2026-03-24T23:00:00Z');
    expect(final).toEqual([
      ['13:35', 3],
      ['13:40', 5],
    ]);
    expect((await table()).map((r) => [r.ts, Number(r.flow)])).toEqual(final);
  });
});
