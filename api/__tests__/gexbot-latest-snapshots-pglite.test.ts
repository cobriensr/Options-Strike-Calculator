// @vitest-environment node

/**
 * REAL-SQL test for the latest-snapshot read behind `view=snapshots-latest`
 * (CharmClock, the summary strip, and the SPX net −vanna tile). The freshness
 * window and the stale-vendor-stamp rule live in SQL, so they are proven
 * against pglite on the table built by migration #156. Only the Date clock is
 * faked: the query binds JS `new Date()` as its "now", so pglite's own clock
 * is never consulted.
 *
 * The stale-stamp rule is the one the sibling, fire-time and velocity reads
 * already apply: at the 09:30-09:31 ET open the vendor can repeat the prior
 * session's final snapshot, so a fresh `captured_at` carries yesterday's
 * reading. `zvanna` read from it would put yesterday's net −vanna in the tile.
 */

import {
  afterAll,
  afterEach,
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

import { getLatestSnapshots } from '../_lib/gexbot-queries.js';

let pg: PGlite;

// 09:31 ET (EDT) on a Thursday: the first minute after the open.
const NOW = new Date('2026-10-29T13:31:00.000Z');
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function seed(
  ticker: string,
  capturedAt: string,
  zvanna: number,
  sourceTimestamp: number | null,
) {
  await pg.query(
    `INSERT INTO gexbot_snapshots
       (ticker, captured_at, source_timestamp, zvanna, raw_response)
     VALUES ($1, $2::timestamptz, $3, $4, '{}'::jsonb)`,
    [ticker, capturedAt, sourceTimestamp, zvanna],
  );
}

describe('getLatestSnapshots against real SQL', () => {
  beforeAll(async () => {
    pg = new PGlite();
    holder.sql = neonOverPglite(pg);
    await applyMigration(pg, 156);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.query('DELETE FROM gexbot_snapshots');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the newest row per ticker inside the 15-minute window', async () => {
    await seed(
      'SPX',
      '2026-10-29T13:29:00Z',
      100,
      epoch('2026-10-29T13:29:00Z'),
    );
    await seed(
      'SPX',
      '2026-10-29T13:30:30Z',
      200,
      epoch('2026-10-29T13:30:30Z'),
    );
    await seed(
      'NDX',
      '2026-10-29T13:30:30Z',
      300,
      epoch('2026-10-29T13:30:30Z'),
    );
    const rows = await getLatestSnapshots();
    expect(rows.map((r) => [r.ticker, r.zvanna]).sort()).toEqual([
      ['NDX', 300],
      ['SPX', 200],
    ]);
  });

  it('drops a row older than 15 minutes', async () => {
    // 13:10Z is 21 minutes before NOW.
    await seed(
      'SPX',
      '2026-10-29T13:10:00Z',
      100,
      epoch('2026-10-29T13:10:00Z'),
    );
    expect(await getLatestSnapshots()).toEqual([]);
  });

  it('drops a row whose vendor stamp is from the prior ET session', async () => {
    // The 09:30 replay: fresh captured_at, yesterday's 16:00 ET stamp.
    await seed(
      'SPX',
      '2026-10-29T13:30:10Z',
      912,
      epoch('2026-10-28T20:00:00Z'),
    );
    expect(await getLatestSnapshots()).toEqual([]);
  });

  it('falls back to an older fresh row when the newest carries a stale stamp', async () => {
    await seed(
      'SPX',
      '2026-10-29T13:30:00Z',
      150,
      epoch('2026-10-29T13:29:59Z'),
    );
    await seed(
      'SPX',
      '2026-10-29T13:30:50Z',
      912,
      epoch('2026-10-28T20:00:00Z'),
    );
    const rows = await getLatestSnapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: 'SPX', zvanna: 150 });
  });

  it('keeps a row with no vendor stamp: it is no evidence either way', async () => {
    await seed('SPX', '2026-10-29T13:30:10Z', 77, null);
    const rows = await getLatestSnapshots();
    expect(rows.map((r) => r.zvanna)).toEqual([77]);
  });

  it('judges each ticker on its own stamp', async () => {
    await seed('VIX', '2026-10-29T13:30:10Z', 5, epoch('2026-10-28T20:00:00Z'));
    await seed('SPX', '2026-10-29T13:30:10Z', 6, epoch('2026-10-29T13:30:09Z'));
    const rows = await getLatestSnapshots();
    expect(rows.map((r) => r.ticker)).toEqual(['SPX']);
  });

  it('keeps a same-ET-day stamp from after the close (the final snapshot)', async () => {
    // 17:01 ET: the last cron tick still carries the 16:00 ET final snapshot.
    vi.setSystemTime(new Date('2026-10-29T21:01:00Z'));
    await seed(
      'SPX',
      '2026-10-29T21:00:30Z',
      42,
      epoch('2026-10-29T20:00:00Z'),
    );
    const rows = await getLatestSnapshots();
    expect(rows.map((r) => r.zvanna)).toEqual([42]);
  });

  it('reads the ET day, not the UTC day, for the session start', async () => {
    // 23:30 ET on the 29th is 03:30Z on the 30th. The final 16:00 ET snapshot
    // (20:00Z on the 29th) is the same ET session, though a UTC-midnight
    // bound would call it yesterday's.
    vi.setSystemTime(new Date('2026-10-30T03:30:00Z'));
    await seed('SPX', '2026-10-30T03:25:00Z', 9, epoch('2026-10-29T20:00:00Z'));
    const rows = await getLatestSnapshots();
    expect(rows.map((r) => r.zvanna)).toEqual([9]);
  });
});
