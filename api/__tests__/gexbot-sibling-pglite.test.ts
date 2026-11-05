// @vitest-environment node

/**
 * REAL-SQL test for the two fire-time lookups: the sibling taker-flow read
 * (`getSiblingConfirmation`) and the fire-time badge stash
 * (`getLatestGexbotSnapshotAt`). The mocked gexbot-queries tests can only
 * match SQL text; this one runs the actual queries against pglite on the
 * table built by migration #156, so "the snapshot at or before the fire
 * time, not the latest" is proven by data: a later row of the opposite sign
 * sits in the table and must not be read.
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
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  getLatestGexbotSnapshotAt,
  getSiblingConfirmation,
} from '../_lib/gexbot-queries.js';

let pg: PGlite;

async function seed(
  ticker: string,
  capturedAt: string,
  netDex: number | null,
  zgr: number | null = null,
  sourceTimestamp: number | null = null,
) {
  await pg.query(
    `INSERT INTO gexbot_snapshots
       (ticker, captured_at, net_dex, zgr, source_timestamp, raw_response)
     VALUES ($1, $2::timestamptz, $3, $4, $5, '{}'::jsonb)`,
    [ticker, capturedAt, netDex, zgr, sourceTimestamp],
  );
}

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
});

describe('getSiblingConfirmation against real SQL', () => {
  const FIRE = new Date('2026-10-29T14:00:10.000Z');

  it('reads the snapshot at or before the fire time, not a later one', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 2_000_000, 0.9);
    // Later row, opposite sign: the current-minute read the old code made.
    await seed('QQQ', '2026-10-29T14:00:40Z', -9_000_000, 1.1);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    const qqq = rows.find((r) => r.ticker === 'QQQ');
    expect(qqq).toMatchObject({
      netDex: 2_000_000,
      zgr: 0.9,
      capturedAt: '2026-10-29T14:00:00.000Z',
      verdict: 'agree',
    });
    const put = await getSiblingConfirmation('SPY', 'put', FIRE);
    expect(put.find((r) => r.ticker === 'QQQ')?.verdict).toBe('disagree');
  });

  it('includes a snapshot exactly at the fire time', async () => {
    await seed('QQQ', '2026-10-29T14:00:10Z', -1_000_000);
    const rows = await getSiblingConfirmation('SPY', 'put', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('agree');
  });

  it('picks the newest of several rows inside the window', async () => {
    await seed('QQQ', '2026-10-29T13:58:00Z', -1_000_000);
    await seed('QQQ', '2026-10-29T14:00:05Z', 3_000_000);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.netDex).toBe(3_000_000);
  });

  it('returns no data when the only snapshot is older than 180 s', async () => {
    await seed('QQQ', '2026-10-29T13:56:00Z', 2_000_000);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')).toMatchObject({
      netDex: null,
      capturedAt: null,
      verdict: 'none',
    });
  });

  it('returns no data for a fire from a session the live table no longer holds', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 2_000_000);
    const rows = await getSiblingConfirmation(
      'SPY',
      'call',
      new Date('2026-10-20T14:00:10.000Z'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.verdict === 'none')).toBe(true);
  });

  it('reads none for a zero net_dex and for a null one', async () => {
    await seed('QQQ', '2026-10-29T14:00:00Z', 0);
    await seed('IWM', '2026-10-29T14:00:00Z', null, 1.2);
    const rows = await getSiblingConfirmation('SPY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'QQQ')?.verdict).toBe('none');
    expect(rows.find((r) => r.ticker === 'IWM')?.verdict).toBe('none');
  });

  // source_timestamp is the vendor payload timestamp in Unix SECONDS. At the
  // 09:30-09:31 ET open the vendor repeats VIX's prior close, so a fresh
  // captured_at can carry yesterday's reading (and yesterday's net_dex).
  const secs = (iso: string) => Date.parse(iso) / 1000;

  it('drops a row whose vendor timestamp predates the fire window', async () => {
    await seed(
      'VIX',
      '2026-10-29T14:00:00Z',
      4_000_000,
      null,
      secs('2026-10-28T20:00:00Z'),
    );
    const rows = await getSiblingConfirmation('UVXY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'VIX')).toMatchObject({
      netDex: null,
      capturedAt: null,
      verdict: 'none',
    });
  });

  it('keeps a row whose vendor timestamp is inside the window', async () => {
    await seed(
      'VIX',
      '2026-10-29T14:00:00Z',
      4_000_000,
      null,
      secs('2026-10-29T13:59:59Z'),
    );
    const rows = await getSiblingConfirmation('UVXY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'VIX')?.verdict).toBe('agree');
  });

  it('falls back to an older fresh row when the newest carries a stale vendor timestamp', async () => {
    await seed(
      'VIX',
      '2026-10-29T13:59:00Z',
      -2_000_000,
      null,
      secs('2026-10-29T13:58:59Z'),
    );
    await seed(
      'VIX',
      '2026-10-29T14:00:00Z',
      4_000_000,
      null,
      secs('2026-10-28T20:00:00Z'),
    );
    const rows = await getSiblingConfirmation('UVXY', 'call', FIRE);
    expect(rows.find((r) => r.ticker === 'VIX')).toMatchObject({
      netDex: -2_000_000,
      verdict: 'disagree',
    });
  });

  it('never reads the futures views even when they have rows', async () => {
    await seed('ES_SPX', '2026-10-29T14:00:00Z', 5_000_000);
    await seed('NQ_NDX', '2026-10-29T14:00:00Z', 5_000_000);
    const rows = await getSiblingConfirmation('SPX', 'call', FIRE);
    expect(rows.map((r) => r.ticker)).not.toContain('ES_SPX');
    expect(rows.map((r) => r.ticker)).not.toContain('NQ_NDX');
  });
});

describe('getLatestGexbotSnapshotAt against real SQL', () => {
  const FIRE = new Date('2026-10-29T14:00:10.000Z');
  const secs = (iso: string) => Date.parse(iso) / 1000;

  async function seedFire(
    ticker: string,
    capturedAt: string,
    zcvr: number,
    sourceTimestamp: number | null,
  ) {
    await pg.query(
      `INSERT INTO gexbot_snapshots
         (ticker, captured_at, zcvr, source_timestamp, raw_response)
       VALUES ($1, $2::timestamptz, $3, $4, '{}'::jsonb)`,
      [ticker, capturedAt, zcvr, sourceTimestamp],
    );
  }

  it('reads the newest row at or before the fire time', async () => {
    await seedFire(
      'VIX',
      '2026-10-29T13:59:30Z',
      1,
      secs('2026-10-29T13:59:29Z'),
    );
    await seedFire(
      'VIX',
      '2026-10-29T14:00:05Z',
      2,
      secs('2026-10-29T14:00:04Z'),
    );
    await seedFire(
      'VIX',
      '2026-10-29T14:00:40Z',
      3,
      secs('2026-10-29T14:00:39Z'),
    );
    const snap = await getLatestGexbotSnapshotAt('VIX', FIRE);
    expect(snap?.zcvr).toBe(2);
  });

  // The same rule as the sibling read: at the 09:30-09:31 ET open the vendor
  // repeats VIX's prior close, so a fresh captured_at can carry yesterday's
  // reading. The badge on the alert must not call it "at fire time".
  it('drops a row whose vendor timestamp predates the fire window', async () => {
    await seedFire(
      'VIX',
      '2026-10-29T14:00:00Z',
      9,
      secs('2026-10-28T20:00:00Z'),
    );
    expect(await getLatestGexbotSnapshotAt('VIX', FIRE)).toBeNull();
  });

  it('falls back to an older fresh row when the newest carries a stale vendor timestamp', async () => {
    await seedFire(
      'VIX',
      '2026-10-29T13:59:00Z',
      4,
      secs('2026-10-29T13:58:59Z'),
    );
    await seedFire(
      'VIX',
      '2026-10-29T14:00:00Z',
      9,
      secs('2026-10-28T20:00:00Z'),
    );
    const snap = await getLatestGexbotSnapshotAt('VIX', FIRE);
    expect(snap?.zcvr).toBe(4);
  });

  it('keeps a row with no vendor timestamp', async () => {
    await seedFire('VIX', '2026-10-29T14:00:00Z', 5, null);
    const snap = await getLatestGexbotSnapshotAt('VIX', FIRE);
    expect(snap?.zcvr).toBe(5);
  });

  it('keeps a row whose vendor timestamp is inside the window', async () => {
    await seedFire(
      'VIX',
      '2026-10-29T14:00:00Z',
      6,
      secs('2026-10-29T13:59:59Z'),
    );
    const snap = await getLatestGexbotSnapshotAt('VIX', FIRE);
    expect(snap).toMatchObject({ zcvr: 6 });
    expect(snap?.capturedAt.toISOString()).toBe('2026-10-29T14:00:00.000Z');
  });

  it('returns null when the only row is older than the window', async () => {
    await seedFire(
      'VIX',
      '2026-10-29T13:56:00Z',
      7,
      secs('2026-10-29T13:55:59Z'),
    );
    expect(await getLatestGexbotSnapshotAt('VIX', FIRE)).toBeNull();
  });
});
