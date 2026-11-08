// @vitest-environment node

/**
 * REAL-SQL test for the duplicate guard's count (countForeignRows).
 *
 * The guard decides whether backfill-zero-gamma writes a date, so its SQL is
 * pinned against pglite (Postgres in WASM) with zero_gamma_levels built from
 * the real migration #82. What it must get right:
 *   - only the one ticker's rows;
 *   - only rows on the ET calendar day: ET midnight to the next ET midnight,
 *     under EDT (UTC-4), EST (UTC-5) and across a DST change (a 23-hour day);
 *   - a row whose ts equals one of this run's labels is not foreign;
 *   - any other ts on the date is.
 *
 * The session runs in America/Chicago, not Neon's UTC, so a bound that
 * silently followed the session time zone would fail here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';
import { countForeignRows } from './zero-gamma-backfill.js';

let pg: PGlite;
let sql: Parameters<typeof countForeignRows>[0];

// The two ladders this run would write on 2026-03-24 (EDT): 09:55 and 10:00 ET.
const LABELS = ['2026-03-24T13:55:00.000Z', '2026-03-24T14:00:00.000Z'];

async function seed(ticker: string, ...stamps: string[]): Promise<void> {
  for (const ts of stamps) {
    await pg.query(
      `INSERT INTO zero_gamma_levels (ticker, spot, ts) VALUES ($1, 7105, $2)`,
      [ticker, ts],
    );
  }
}

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 82);
  await pg.exec(`SET TIME ZONE 'America/Chicago'`);
  const { rows } = await pg.query<{ TimeZone: string }>('SHOW TIME ZONE');
  expect(rows[0]!.TimeZone).toBe('America/Chicago');
  sql = neonOverPglite(pg) as unknown as typeof sql;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('DELETE FROM zero_gamma_levels');
});

describe('countForeignRows against real Postgres', () => {
  it('counts nothing when every row on the date is one of this run labels', async () => {
    await seed('SPX', ...LABELS);

    expect(await countForeignRows(sql, 'SPX', '2026-03-24', LABELS)).toBe(0);
  });

  it('counts a row on the date whose ts is not a label (the cron compute-time stamps)', async () => {
    // Two compute-time stamps, one minute before each label, and a label row.
    await seed(
      'SPX',
      '2026-03-24T13:54:03.000Z',
      '2026-03-24T13:59:04.000Z',
      LABELS[0]!,
    );

    expect(await countForeignRows(sql, 'SPX', '2026-03-24', LABELS)).toBe(2);
  });

  it('counts a row that is one millisecond off a label', async () => {
    await seed('SPX', '2026-03-24T13:55:00.001Z');

    expect(await countForeignRows(sql, 'SPX', '2026-03-24', LABELS)).toBe(1);
  });

  it('counts only the asked ticker', async () => {
    await seed('SPX', '2026-03-24T13:54:03.000Z');
    await seed('SPY', '2026-03-24T13:54:03.000Z', '2026-03-24T13:59:04.000Z');
    await seed('QQQ', '2026-03-24T13:54:03.000Z');

    expect(await countForeignRows(sql, 'SPX', '2026-03-24', LABELS)).toBe(1);
    expect(await countForeignRows(sql, 'SPY', '2026-03-24', LABELS)).toBe(2);
    expect(await countForeignRows(sql, 'NDX', '2026-03-24', LABELS)).toBe(0);
  });

  it('counts only the ET day under EDT: 04:00Z to 04:00Z next day', async () => {
    await seed(
      'SPX',
      '2026-03-24T03:59:59.000Z', // 23:59:59 ET on the 23rd: not this day
      '2026-03-24T04:00:00.000Z', // ET midnight: first moment of the day
      '2026-03-25T03:59:59.000Z', // 23:59:59 ET on the 24th: last moment
      '2026-03-25T04:00:00.000Z', // ET midnight of the 25th: not this day
    );

    expect(await countForeignRows(sql, 'SPX', '2026-03-24', LABELS)).toBe(2);
  });

  it('counts only the ET day under EST: 05:00Z to 05:00Z next day', async () => {
    const labels = ['2026-01-06T15:00:00.000Z'];
    await seed(
      'SPX',
      '2026-01-06T04:59:59.000Z', // 23:59:59 ET on the 5th: not this day
      '2026-01-06T05:00:00.000Z', // ET midnight: first moment of the day
      '2026-01-07T04:59:59.000Z', // 23:59:59 ET on the 6th: last moment
      '2026-01-07T05:00:00.000Z', // ET midnight of the 7th: not this day
    );

    expect(await countForeignRows(sql, 'SPX', '2026-01-06', labels)).toBe(2);
  });

  it('uses the 23-hour ET day when the clocks spring forward (2026-03-08)', async () => {
    // Midnight 03-08 is EST (05:00Z); the next midnight is EDT (04:00Z).
    const labels = ['2026-03-08T15:00:00.000Z'];
    await seed(
      'SPX',
      '2026-03-08T04:59:59.000Z', // still the 7th in ET
      '2026-03-08T05:00:00.000Z', // first moment of the 8th
      '2026-03-09T03:59:59.000Z', // last moment of the 8th
      '2026-03-09T04:00:00.000Z', // midnight of the 9th (EDT): not this day
    );

    expect(await countForeignRows(sql, 'SPX', '2026-03-08', labels)).toBe(2);
  });
});
