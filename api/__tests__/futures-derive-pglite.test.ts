// @vitest-environment node

/**
 * REAL-SQL test for computeSnapshot's closed-bar rule: a 1-minute bar is
 * visible at `at` only once its minute has closed (ts <= at - 60 s), so the
 * bar of the minute `at` falls in is ignored by the latest-bar query, the
 * 20-day volume query and today's volume query, and the bar of the previous
 * minute is used. uw-stream writes a minute's bar only after that minute
 * closes, so this is the set the live cron has always seen.
 *
 * The session runs in UTC like Neon: the 20-day average groups by DATE(ts).
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
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';

import { neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({ pg: null as PGliteType | null }));

vi.mock('../_lib/db.js', () => ({
  getDb: () => {
    if (!holder.pg) throw new Error('pglite not started');
    return neonOverPglite(holder.pg);
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { computeSnapshot, type SnapshotRow } from '../_lib/futures-derive.js';

let pg: PGliteType;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.pg = pg;
  await pg.query(`SET TIME ZONE 'UTC'`);
  await pg.query(`
    CREATE TABLE futures_bars (
      id      BIGSERIAL PRIMARY KEY,
      symbol  TEXT NOT NULL,
      ts      TIMESTAMPTZ NOT NULL,
      open    NUMERIC(12,4) NOT NULL,
      high    NUMERIC(12,4) NOT NULL,
      low     NUMERIC(12,4) NOT NULL,
      close   NUMERIC(12,4) NOT NULL,
      volume  BIGINT NOT NULL DEFAULT 0,
      UNIQUE(symbol, ts)
    )
  `);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

async function bar(ts: string, close: number, volume: number): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ('ES', $1, $2, $2, $2, $2, $3)`,
    [ts, close, volume],
  );
}

/** 2026-04-14 is EDT: the cash open is 13:30Z. */
beforeEach(async () => {
  await pg.query('TRUNCATE futures_bars RESTART IDENTITY');
  await bar('2026-04-13T15:00:00Z', 6990, 1000); // prior day: volume 1000
  await bar('2026-04-14T13:30:00Z', 7000, 100); // day-open bar
  await bar('2026-04-14T13:31:00Z', 7000, 100); // hour-ago reference
  await bar('2026-04-14T14:30:00Z', 7005, 100); // last closed bar at 14:31:30
  await bar('2026-04-14T14:31:00Z', 7099, 5000); // the minute `at` is inside
  await bar('2026-04-14T14:32:00Z', 7200, 7000);
});

async function snapshotAt(at: string): Promise<SnapshotRow> {
  const result = await computeSnapshot('ES', '2026-04-14', new Date(at));
  expect(result.kind).toBe('fresh');
  if (result.kind !== 'fresh') throw new Error('unreachable');
  return result.snapshot;
}

describe('computeSnapshot on real SQL (pglite): closed bars only', () => {
  it('ignores the bar of the minute `at` is inside, in every query', async () => {
    const snap = await snapshotAt('2026-04-14T14:31:30.000Z');

    // Latest bar: 14:30 (7005), not 14:31 (7099).
    expect(snap.price).toBe(7005);
    expect(snap.latestTs).toBe('2026-04-14T14:30:00.000Z');
    // Hour-ago bar is the 13:31 bar; the day-open bar is 13:30.
    expect(snap.change1hPct).toBeCloseTo((5 / 7000) * 100, 10);
    expect(snap.changeDayPct).toBeCloseTo((5 / 7000) * 100, 10);
    // Today's volume 100 + 100 + 100 (not the 5000 of the open minute);
    // the 20-day average of the daily sums is (1000 + 300) / 2.
    expect(snap.volumeRatio).toBeCloseTo(300 / 650, 10);
  });

  it("uses the previous minute's bar from the first instant of the next minute", async () => {
    // at = 14:32:00.000: the 14:31 bar closed exactly now; 14:32 is open.
    const snap = await snapshotAt('2026-04-14T14:32:00.000Z');

    expect(snap.price).toBe(7099);
    expect(snap.latestTs).toBe('2026-04-14T14:31:00.000Z');
    // Today's volume 100 + 100 + 100 + 5000, daily sums 1000 and 5300.
    expect(snap.volumeRatio).toBeCloseTo(5300 / 3150, 10);
  });

  it('still ignores the open minute 59.999 s into it', async () => {
    const snap = await snapshotAt('2026-04-14T14:31:59.999Z');

    expect(snap.price).toBe(7005);
  });

  it('ignores a day-open bar until its minute has closed, then uses it', async () => {
    await bar('2026-04-14T13:29:00Z', 6999, 50); // the last closed bar at 13:30:30
    // at = 9:30:30 ET: the 13:30 bar is still printing, so there is no day change.
    const early = await snapshotAt('2026-04-14T13:30:30.000Z');
    expect(early.changeDayPct).toBeNull();

    // at = 9:31:30 ET: the 13:30 bar closed at 13:31:00. The latest closed bar
    // is the 13:30 bar itself (7000), so the change is 0 against an open of 7000.
    const later = await snapshotAt('2026-04-14T13:31:30.000Z');
    expect(later.changeDayPct).toBe(0);
  });

  it('measures the freshness gate from `at`: 15 minutes is fresh, 16 is stale', async () => {
    await pg.query('TRUNCATE futures_bars RESTART IDENTITY');
    await bar('2026-04-14T14:30:00Z', 7005, 100);

    // At 14:45:00 the 14:30 bar is exactly 15 minutes old.
    expect(
      (
        await computeSnapshot(
          'ES',
          '2026-04-14',
          new Date('2026-04-14T14:45:00Z'),
        )
      ).kind,
    ).toBe('fresh');
    expect(
      await computeSnapshot(
        'ES',
        '2026-04-14',
        new Date('2026-04-14T14:46:00Z'),
      ),
    ).toEqual({
      kind: 'stale',
      latestTs: '2026-04-14T14:30:00.000Z',
      ageMinutes: 16,
    });
  });

  it('reports a bar that is the only one in the open minute as missing, not as the price', async () => {
    await pg.query('TRUNCATE futures_bars RESTART IDENTITY');
    await bar('2026-04-14T14:31:00Z', 7099, 5000);

    const result = await computeSnapshot(
      'ES',
      '2026-04-14',
      new Date('2026-04-14T14:31:30.000Z'),
    );

    expect(result).toEqual({ kind: 'missing' });
  });
});
