// @vitest-environment node

/**
 * REAL-SQL tests for the Periscope lottery's SPX spot lookup: it reads
 * index_candles_1m only from the event's own ET session. A hole in the day's
 * candles then yields no spot (so no fire), not the previous session's close.
 * The 2026-11 placeholder repair found that gap: with no bar on the day the
 * lookup walked back days to the last bar before the event.
 *
 * The same SQL appears twice: the live `fetchCandidates` (detectPutLottery)
 * and the backfill's `fetchAllCandidatesForExpiry`
 * (detectPutLotteryAllForDate). Both are run against the same fixtures. The
 * put side is used because its filter has no rank floor, so one strike
 * pair makes one candidate.
 *
 * The bound is the event's ET date taken from the timestamptz
 * (`captured_at AT TIME ZONE 'America/New_York'`), so it must not move with
 * the session time zone. The cases below run it under UTC and Asia/Tokyo,
 * on an EDT and an EST day, with events late enough in the ET evening to be
 * past UTC midnight, and at mid-session where Tokyo has already rolled to the
 * next date.
 *
 * pglite is real Postgres in WASM. Only the Neon driver is replaced, with a
 * Neon-shaped tagged template. index_candles_1m and periscope_snapshots come
 * from the real migrations; the three tables the downstream lookups read
 * (gex_target_features, ws_option_trades, market_snapshots) are minimal
 * fixtures, since those lookups are not under test.
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

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@neondatabase/serverless', () => ({ neon: () => holder.sql }));

import { _resetDb } from '../_lib/db.js';
import {
  detectPutLottery,
  detectPutLotteryAllForDate,
} from '../_lib/periscope-lottery-finder.js';
import { applyMigration, neonOverPglite } from './pglite-migrations.js';

const MINUTE = 60_000;

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = neonOverPglite(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  // index_candles_1m: #52 creates spx_candles_1m, #54 adds a column the #112
  // compatibility view reads, #112 renames it, #113 and #114 finish it.
  for (const id of [52, 54, 112, 113, 114, 140]) await applyMigration(pg, id);
  await pg.exec(`
    CREATE TABLE gex_target_features (
      strike NUMERIC, mode TEXT, timestamp TIMESTAMPTZ,
      gex_dollars NUMERIC, call_ratio NUMERIC
    );
    CREATE TABLE ws_option_trades (
      ticker TEXT, expiry DATE, strike NUMERIC, option_type TEXT,
      executed_at TIMESTAMPTZ, canceled BOOLEAN, price NUMERIC
    );
    CREATE TABLE market_snapshots (
      date DATE, created_at TIMESTAMPTZ, vix NUMERIC
    );
  `);
}, 60_000);

afterAll(async () => {
  await pg.close();
  process.env.DATABASE_URL = originalUrl;
  _resetDb();
});

beforeEach(async () => {
  await pg.exec(`
    SET TimeZone = 'UTC';
    TRUNCATE periscope_snapshots, index_candles_1m, gex_target_features,
             ws_option_trades, market_snapshots;
  `);
});

/**
 * One put-lottery candidate at `eventAt`: charm at strike 7000 moves
 * 1000 -> 3000 over the last 10 minutes, with a cheap 6950 put trading just
 * after. Every later filter passes, so the spot alone decides the fire.
 */
async function seedEvent(eventAt: string, expiry: string): Promise<void> {
  const at = Date.parse(eventAt);
  const iso = (offsetMin: number) =>
    new Date(at + offsetMin * MINUTE).toISOString();
  for (const [slot, value] of [
    [iso(-10), 1000],
    [iso(0), 3000],
  ] as const) {
    await pg.query(
      `INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value)
       VALUES ($1, $2, 'charm', 7000, $3)`,
      [slot, expiry, value],
    );
  }
  await pg.query(
    `INSERT INTO gex_target_features (strike, mode, timestamp, gex_dollars, call_ratio)
     VALUES (7000, 'oi', $1, 500000000, 0.8)`,
    [iso(-1)],
  );
  await pg.query(
    `INSERT INTO ws_option_trades
       (ticker, expiry, strike, option_type, executed_at, canceled, price)
     VALUES ('SPXW', $1, 6950, 'P', $2, FALSE, 0.42)`,
    [expiry, iso(1)],
  );
}

/** One SPX minute bar. `date` is the bar's ET trading date. */
async function bar(date: string, at: string, close: number): Promise<void> {
  await pg.query(
    `INSERT INTO index_candles_1m
       (symbol, date, timestamp, open, high, low, close, volume, market_time)
     VALUES ('SPX', $1, $2, $3, $3, $3, $3, 0, 'r')`,
    [date, at, close],
  );
}

const variants = [
  ['live detectPutLottery', (expiry: string) => detectPutLottery(expiry)],
  [
    'backfill detectPutLotteryAllForDate',
    (expiry: string) =>
      detectPutLotteryAllForDate(expiry, { includeGexbot: true }),
  ],
] as const;

describe.each(variants)(
  "%s — SPX spot from the event's own session",
  (_name, detect) => {
    const DAY = '2026-07-22';
    const EVENT = '2026-07-22T15:00:00.000Z'; // 11:00 EDT

    it("uses the latest bar on the event's own day", async () => {
      await seedEvent(EVENT, DAY);
      await bar('2026-07-21', '2026-07-21T19:59:00.000Z', 6900); // yesterday
      await bar(DAY, '2026-07-22T14:00:00.000Z', 7040);
      await bar(DAY, '2026-07-22T14:55:00.000Z', 7050); // latest at or before
      await bar(DAY, '2026-07-22T15:05:00.000Z', 7099); // after the event

      const fires = await detect(DAY);

      expect(fires).toHaveLength(1);
      expect(fires[0]!.spotAtEvent).toBe(7050);
      expect(fires[0]!.strikeDist).toBe(50);
    });

    it("finds no spot when the day has no bars yet, instead of an earlier day's close", async () => {
      await seedEvent(EVENT, DAY);
      // A hole: the only bars are yesterday's. A 7050 close two days old must
      // not stand in for the spot, whatever its distance from the strike.
      await bar('2026-07-21', '2026-07-21T19:59:00.000Z', 7050);
      await bar('2026-07-20', '2026-07-20T19:59:00.000Z', 7040);

      const fires = await detect(DAY);

      expect(fires).toEqual([]);
    });

    it('finds no spot when the day has bars only after the event', async () => {
      await seedEvent(EVENT, DAY);
      await bar('2026-07-21', '2026-07-21T19:59:00.000Z', 7050);
      await bar(DAY, '2026-07-22T15:05:00.000Z', 7099);

      const fires = await detect(DAY);

      expect(fires).toEqual([]);
    });

    it.each([
      // After 8 pm ET the UTC date has already rolled; ET has not.
      [
        'UTC',
        '2026-07-22',
        '2026-07-23T00:40:00.000Z',
        '2026-07-22T23:30:00.000Z',
      ],
      [
        'UTC',
        '2026-11-20',
        '2026-11-21T01:40:00.000Z',
        '2026-11-21T00:30:00.000Z',
      ],
      // At 11:00 ET Tokyo is already on the next date.
      [
        'Asia/Tokyo',
        '2026-07-22',
        '2026-07-22T15:00:00.000Z',
        '2026-07-22T14:55:00.000Z',
      ],
      [
        'Asia/Tokyo',
        '2026-11-20',
        '2026-11-20T16:00:00.000Z',
        '2026-11-20T15:55:00.000Z',
      ],
    ])(
      "takes the event's ET date, not the %s session's (%s)",
      async (zone, etDate, eventAt, barAt) => {
        await pg.exec(`SET TimeZone = '${zone}'`);
        await seedEvent(eventAt, etDate);
        await bar(etDate, barAt, 7050);

        const fires = await detect(etDate);

        expect(fires).toHaveLength(1);
        expect(fires[0]!.spotAtEvent).toBe(7050);
      },
    );
  },
);
