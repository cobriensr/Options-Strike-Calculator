// @vitest-environment node

/**
 * REAL-SQL test for the flow-at-fire backfill (scripts/backfill-ticker-flow-at-fire.ts):
 * the group selection, the series read and the batched UPDATE run against the
 * fire tables and the two net-flow tables built from the REAL migrations in
 * pglite, and the rows are read back.
 *
 * The defect it pins (2026-11-15): the script used to carry its own series SQL,
 * a UNION ALL of the WS tick table and the per-minute history table with
 * DISTINCT ON (ts), which counts a day twice once the history is loaded. It
 * filled 2,159 rows at about twice their flow. It now reads the series through
 * `fetchTickerFlowSeries`, so a fire gets the WS-only value.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { neonOverPglite } from '../../api/__tests__/pglite-migrations';
import {
  buildFireTables,
  clearFireData,
  insertHistoryMinute,
  insertWsTick,
  seedLotteryFire,
  seedSilentBoom,
} from '../../api/__tests__/fire-flow-test-helpers';
import {
  parseArgs,
  runBackfill,
  selectNullFlowGroups,
} from './ticker-flow-backfill.js';

type Db = Parameters<typeof runBackfill>[0];

// 2026-10-29 is CDT: the session is 13:30Z to 20:00Z.
const DAY = '2026-10-29';

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = new PGlite();
  await pg.query("SET TIME ZONE 'America/Chicago'");
  await buildFireTables(pg);
  db = neonOverPglite(pg) as unknown as Db;
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await clearFireData(pg);
});

const OPTIONS = {
  table: 'both',
  ticker: null,
  date: null,
  limit: 0,
  dryRun: false,
} as const;

async function flowOf(
  table: 'lottery_finder_fires' | 'silent_boom_alerts',
  id: number,
): Promise<{ ncp: string | null; npp: string | null }> {
  const r = await pg.query<{ ncp: string | null; npp: string | null }>(
    `SELECT cum_ncp_at_fire::text AS ncp, cum_npp_at_fire::text AS npp
       FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

/** META 2026-10-29: the same flow at both resolutions, as after the close. */
async function seedMetaBothResolutions(): Promise<void> {
  await insertWsTick(pg, 'META', '2026-10-29T14:30:00.984Z', 100, 10);
  await insertWsTick(pg, 'META', '2026-10-29T14:30:31.250Z', 50, 5);
  await insertWsTick(pg, 'META', '2026-10-29T14:31:02.007Z', 25, 2.5);
  await insertHistoryMinute(pg, 'META', '2026-10-29T14:30:00Z', 150, 15);
  await insertHistoryMinute(pg, 'META', '2026-10-29T14:31:00Z', 25, 2.5);
}

describe('runBackfill (real SQL)', () => {
  it('fills a fire from the WS-only series, not the WS plus history sum', async () => {
    await seedMetaBothResolutions();
    await seedLotteryFire(pg, {
      id: 1,
      date: DAY,
      at: '2026-10-29T14:45:00Z',
    });
    await seedSilentBoom(pg, { id: 7, date: DAY, at: '2026-10-29T14:45:00Z' });

    const summary = await runBackfill(db, OPTIONS, () => {});

    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: '175',
      npp: '17.5',
    });
    expect(await flowOf('silent_boom_alerts', 7)).toEqual({
      ncp: '175',
      npp: '17.5',
    });
    expect(summary).toMatchObject({
      groups: 1,
      lotteryUpdated: 1,
      silentUpdated: 1,
      emptyGroups: 0,
    });
  });

  it('reads the flow at the fire, not the day total', async () => {
    await seedMetaBothResolutions();
    await seedLotteryFire(pg, {
      id: 1,
      date: DAY,
      at: '2026-10-29T14:30:40Z',
    });

    await runBackfill(db, OPTIONS, () => {});

    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: '150',
      npp: '15',
    });
  });

  it('a history-only day fills each fire with the minutes complete at it, none from its own minute', async () => {
    await insertHistoryMinute(pg, 'IWM', '2026-10-29T14:30:00Z', 100, 10);
    await insertHistoryMinute(pg, 'IWM', '2026-10-29T14:31:00Z', 50, 5);
    await seedLotteryFire(pg, {
      id: 1,
      date: DAY,
      ticker: 'IWM',
      at: '2026-10-29T14:31:30Z',
    });

    await runBackfill(db, OPTIONS, () => {});

    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: '100',
      npp: '10',
    });
  });

  it('leaves a fire NULL when the ticker-day has no flow rows, and one that precedes the first tick', async () => {
    await insertWsTick(pg, 'META', '2026-10-29T14:30:00.984Z', 100, 10);
    await seedLotteryFire(pg, {
      id: 1,
      date: DAY,
      ticker: 'NOPE',
      at: '2026-10-29T14:45:00Z',
    });
    await seedLotteryFire(pg, {
      id: 2,
      date: DAY,
      ticker: 'META',
      at: '2026-10-29T13:45:00Z',
    });

    const summary = await runBackfill(db, OPTIONS, () => {});

    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: null,
      npp: null,
    });
    expect(await flowOf('lottery_finder_fires', 2)).toEqual({
      ncp: null,
      npp: null,
    });
    expect(summary).toMatchObject({
      groups: 2,
      emptyGroups: 1,
      leftNullEmptySeries: 1,
      leftNullPreSeries: 1,
      lotteryUpdated: 0,
    });
  });

  it('writes nothing on a dry run, and never over a value already stored', async () => {
    await seedMetaBothResolutions();
    await seedLotteryFire(pg, { id: 1, date: DAY, at: '2026-10-29T14:45:00Z' });
    await seedLotteryFire(pg, {
      id: 2,
      date: DAY,
      at: '2026-10-29T14:46:00Z',
      ncp: 999,
      npp: 1,
    });

    const dry = await runBackfill(db, { ...OPTIONS, dryRun: true }, () => {});
    expect(dry.lotteryUpdated).toBe(1);
    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: null,
      npp: null,
    });

    await runBackfill(db, OPTIONS, () => {});
    expect(await flowOf('lottery_finder_fires', 1)).toEqual({
      ncp: '175',
      npp: '17.5',
    });
    // The stored row is not a candidate, and keeps its value.
    expect(await flowOf('lottery_finder_fires', 2)).toEqual({
      ncp: '999',
      npp: '1',
    });

    // A second run finds nothing left.
    const again = await runBackfill(db, OPTIONS, () => {});
    expect(again).toMatchObject({ groups: 0, lotteryUpdated: 0 });
  });

  it('honours --table, --ticker and --date', async () => {
    await seedMetaBothResolutions();
    await insertWsTick(pg, 'NVDA', '2026-10-29T14:30:00.100Z', 10, 1);
    await seedLotteryFire(pg, { id: 1, date: DAY, at: '2026-10-29T14:45:00Z' });
    await seedLotteryFire(pg, {
      id: 2,
      date: DAY,
      ticker: 'NVDA',
      at: '2026-10-29T14:45:00Z',
    });
    await seedSilentBoom(pg, { id: 7, date: DAY, at: '2026-10-29T14:45:00Z' });

    await runBackfill(
      db,
      { ...OPTIONS, table: 'lottery', ticker: 'META', date: DAY },
      () => {},
    );

    expect((await flowOf('lottery_finder_fires', 1)).ncp).toBe('175');
    expect((await flowOf('lottery_finder_fires', 2)).ncp).toBeNull();
    expect((await flowOf('silent_boom_alerts', 7)).ncp).toBeNull();
  });

  it('caps the groups processed at --limit, newest day first', async () => {
    await insertWsTick(pg, 'META', '2026-10-29T14:30:00.100Z', 10, 1);
    await insertWsTick(pg, 'META', '2026-10-28T14:30:00.100Z', 20, 2);
    await seedLotteryFire(pg, { id: 1, date: DAY, at: '2026-10-29T14:45:00Z' });
    await seedLotteryFire(pg, {
      id: 2,
      date: '2026-10-28',
      at: '2026-10-28T14:45:00Z',
    });

    const groups = await selectNullFlowGroups(db, { ...OPTIONS, limit: 1 });

    expect(groups).toEqual([{ ticker: 'META', date: DAY, nRows: 1 }]);
  });

  it('surfaces a database failure instead of reporting a summary', async () => {
    await seedLotteryFire(pg, { id: 1, date: DAY, at: '2026-10-29T14:45:00Z' });
    await insertWsTick(pg, 'META', '2026-10-29T14:30:00.100Z', 10, 1);
    const broken = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('').includes('UPDATE')) {
        return Promise.reject(new Error('connection lost'));
      }
      return (
        db as unknown as (s: TemplateStringsArray, ...p: unknown[]) => unknown
      )(strings, ...v);
    }) as unknown as Db;

    await expect(runBackfill(broken, OPTIONS, () => {})).rejects.toThrow(
      'connection lost',
    );
  });
});

describe('parseArgs', () => {
  it('defaults to both tables, no filters, and writing', () => {
    expect(parseArgs([])).toEqual({
      table: 'both',
      ticker: null,
      date: null,
      limit: 0,
      dryRun: false,
      envFile: null,
      help: false,
    });
  });

  it('reads every option', () => {
    expect(
      parseArgs([
        '--limit',
        '5',
        '--table',
        'silentboom',
        '--ticker',
        'META',
        '--date',
        DAY,
        '--dry-run',
        '--env-file',
        '.env.local',
      ]),
    ).toEqual({
      table: 'silentboom',
      ticker: 'META',
      date: DAY,
      limit: 5,
      dryRun: true,
      envFile: '.env.local',
      help: false,
    });
  });

  it.each([
    [['--table', 'both2'], '--table must be one of'],
    [['--date', '2026-13-40'], 'is not a YYYY-MM-DD date'],
    [['--limit', 'x'], '--limit needs a whole number'],
    [['--ticker'], '--ticker needs a value'],
    [['--nope'], 'unknown argument --nope'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
