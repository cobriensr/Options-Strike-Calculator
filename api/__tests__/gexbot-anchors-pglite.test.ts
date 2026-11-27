// @vitest-environment node

/**
 * REAL-SQL test for the closed-market anchors and the three readers that take
 * them (`getLatestSnapshots`, `getConvexityTrend`, `getMaxchangeWinners`).
 * After the cash close the readers stop measuring their windows from "now"
 * and end each ticker's window at that ticker's anchor: its last real capture
 * of the session. The probe (a max over an index, a 15-minute scan, and a
 * lookup of each row's previous row), the replay rule, the ET-midnight bound
 * and the `unnest` joins all live in SQL, so they are proven against pglite
 * on the tables built by migration #156.
 *
 * The session is 2026-11-20 (EST, so ET midnight is 05:00Z). The vendor
 * freezes at the 16:00 ET close (21:00Z) and its 16:01 capture repeats the
 * 16:00 row with the same `source_timestamp`.
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

import {
  getClosedAnchors,
  getConvexityTrend,
  getLatestSnapshots,
  getMaxchangeWinners,
  type ClosedAnchors,
} from '../_lib/gexbot-queries.js';

let pg: PGlite;

// 16:02:30 ET on the session day: after the close, so a clock-anchored read
// sees the replay row as the newest one.
const NOW = new Date('2026-11-20T21:02:30.000Z');

const DAY = '2026-11-20';
/** A bare `HH:MM:SSZ` is on the session day; a full ISO instant is as given. */
const iso = (at: string) => (at.includes('T') ? at : `${DAY}T${at}`);
const epoch = (at: string) => Math.floor(Date.parse(iso(at)) / 1000);

async function snap(
  ticker: string,
  at: string,
  stamp: string | null,
  extra: { spot?: number; zcvr?: number | null; dte?: number | null } = {},
) {
  await pg.query(
    `INSERT INTO gexbot_snapshots
       (ticker, captured_at, source_timestamp, spot, zcvr, min_dte, raw_response)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, '{}'::jsonb)`,
    [
      ticker,
      iso(at),
      stamp === null ? null : epoch(stamp),
      extra.spot ?? null,
      extra.zcvr ?? null,
      extra.dte ?? null,
    ],
  );
}

async function cap(
  ticker: string,
  category: string,
  at: string,
  stamp: string | null,
  raw: object = {},
  endpoint = 'classic',
) {
  await pg.query(
    `INSERT INTO gexbot_api_capture
       (ticker, endpoint, category, captured_at, source_timestamp, raw_response)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)`,
    [
      ticker,
      endpoint,
      category,
      iso(at),
      stamp === null ? null : epoch(stamp),
      JSON.stringify(raw),
    ],
  );
}

/** The session's closing minutes: replays, a late updater and two dropouts. */
async function seedClose() {
  // SPX: 21:01:49 repeats the 21:00:49 row (same stamp), a replay.
  await snap('SPX', '20:58:49Z', '20:58:00Z', { spot: 1 });
  await snap('SPX', '20:59:49Z', '20:59:00Z', { spot: 2 });
  await snap('SPX', '21:00:49Z', '21:00:00Z', { spot: 3 });
  await snap('SPX', '21:01:49Z', '21:00:00Z', { spot: 4 });
  // NDX: the same, one second later.
  await snap('NDX', '20:59:50Z', '20:59:01Z', { spot: 5 });
  await snap('NDX', '21:00:50Z', '21:00:01Z', { spot: 6 });
  await snap('NDX', '21:01:50Z', '21:00:01Z', { spot: 7 });
  // ES_SPX updates late: its 21:01:55 row has a new stamp, so it is real.
  await snap('ES_SPX', '21:00:55Z', '21:00:05Z', { spot: 8 });
  await snap('ES_SPX', '21:01:55Z', '21:01:05Z', { spot: 9 });
  // QQQ stopped 21 minutes before the table's newest row.
  await snap('QQQ', '20:40:00Z', '20:39:00Z', { spot: 10 });
  // IWM's last row has no vendor stamp, so its anchor is the row before it.
  await snap('IWM', '21:00:30Z', '20:59:40Z', { spot: 11 });
  await snap('IWM', '21:01:30Z', null, { spot: 12 });
}

describe('closed-market anchors against real SQL', () => {
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
    await pg.query('DELETE FROM gexbot_api_capture');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getClosedAnchors on gexbot_snapshots', () => {
    it('anchors each ticker on its newest non-replay row', async () => {
      await seedClose();
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(a?.sessionDate).toBe('2026-11-20');
      expect(Object.fromEntries(a!.byTicker)).toEqual({
        SPX: '2026-11-20T21:00:49.000Z',
        NDX: '2026-11-20T21:00:50.000Z',
        ES_SPX: '2026-11-20T21:01:55.000Z',
        IWM: '2026-11-20T21:00:30.000Z',
      });
    });

    it('returns null on an empty table', async () => {
      expect(await getClosedAnchors('gexbot_snapshots')).toBeNull();
    });

    it("takes the session date from the newest row's ET date, not its UTC date", async () => {
      // 23:30 EDT on 10-28 is 03:30Z on 10-29.
      await snap('SPX', '2026-10-29T03:30:00Z', '2026-10-29T03:29:00Z');
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(a?.sessionDate).toBe('2026-10-28');
    });

    it('keeps the session date when no ticker has a usable row', async () => {
      await snap('SPX', '21:00:49Z', null);
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(a?.sessionDate).toBe('2026-11-20');
      expect([...a!.byTicker]).toEqual([]);
    });

    it('compares a row with the row before it even when that row is outside the 15 minutes', async () => {
      // SPX's 20:50:00 row repeats the stamp of its 20:30:00 row. The earlier
      // row sits outside [newest - 15 min, newest], so a lookup limited to the
      // window would see no previous row and call the repeat a real update.
      await snap('SPX', '20:30:00Z', '20:29:00Z');
      await snap('SPX', '20:50:00Z', '20:29:00Z');
      await snap('NDX', '21:00:00Z', '20:59:00Z');
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(Object.fromEntries(a!.byTicker)).toEqual({
        NDX: '2026-11-20T21:00:00.000Z',
      });
    });

    it('treats a row after a stamp-less row as a real update', async () => {
      await snap('SPX', '20:58:00Z', null);
      await snap('SPX', '20:59:00Z', '20:58:30Z');
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(a?.byTicker.get('SPX')).toBe('2026-11-20T20:59:00.000Z');
    });

    it('keeps the window edge: a row exactly 15 minutes before the newest counts', async () => {
      await snap('QQQ', '20:46:55Z', '20:46:00Z');
      await snap('SPX', '21:01:55Z', '21:01:00Z');
      const a = await getClosedAnchors('gexbot_snapshots');
      expect(a?.byTicker.get('QQQ')).toBe('2026-11-20T20:46:55.000Z');
    });

    it('drops a ticker whose newest row is one second past the 15 minutes', async () => {
      await snap('QQQ', '20:46:54Z', '20:46:00Z');
      await snap('SPX', '21:01:55Z', '21:01:00Z');
      const a = await getClosedAnchors('gexbot_snapshots');
      expect([...a!.byTicker.keys()]).toEqual(['SPX']);
    });
  });

  describe('getClosedAnchors on gexbot_api_capture', () => {
    it('returns null on an empty table', async () => {
      expect(await getClosedAnchors('gexbot_api_capture')).toBeNull();
    });

    it('skips rows with no vendor stamp', async () => {
      await cap('SPX', 'gex_zero/maxchange', '21:00:49Z', '21:00:00Z');
      await cap('SPX', 'gex_zero/maxchange', '21:01:49Z', null);
      const a = await getClosedAnchors('gexbot_api_capture');
      expect(a?.sessionDate).toBe('2026-11-20');
      expect(Object.fromEntries(a!.byTicker)).toEqual({
        SPX: '2026-11-20T21:00:49.000Z',
      });
    });

    it("takes a ticker's newest stamped row across every endpoint and category", async () => {
      await cap('SPX', 'gex_zero/maxchange', '21:00:10Z', '21:00:00Z');
      await cap('SPX', 'gamma_zero', '21:00:49Z', '21:00:00Z', {}, 'state');
      await cap('NDX', 'gamma_zero', '21:00:30Z', '21:00:00Z', {}, 'state');
      const a = await getClosedAnchors('gexbot_api_capture');
      expect(Object.fromEntries(a!.byTicker)).toEqual({
        SPX: '2026-11-20T21:00:49.000Z',
        NDX: '2026-11-20T21:00:30.000Z',
      });
    });

    it('applies no replay rule: the capture table never holds one', async () => {
      // The partial unique index of migration #192 keeps a repeated stamp out
      // of this table, so the newest stamped row is the anchor as it stands.
      await cap('SPX', 'gamma_zero', '21:00:49Z', '21:00:00Z', {}, 'state');
      await cap('SPX', 'gamma_zero', '21:01:49Z', '21:00:00Z', {}, 'state');
      const a = await getClosedAnchors('gexbot_api_capture');
      expect(a?.byTicker.get('SPX')).toBe('2026-11-20T21:01:49.000Z');
    });

    it('drops a ticker with no stamped row in the 15 minutes up to the newest row', async () => {
      await cap('SPX', 'gamma_zero', '21:00:49Z', '21:00:00Z', {}, 'state');
      await cap('QQQ', 'gamma_zero', '20:40:00Z', '20:39:00Z', {}, 'state');
      await cap('IWM', 'gamma_zero', '21:00:30Z', null, {}, 'state');
      const a = await getClosedAnchors('gexbot_api_capture');
      expect([...a!.byTicker.keys()]).toEqual(['SPX']);
    });

    it('keeps a row exactly 15 minutes before the newest and drops one a second further', async () => {
      await cap('SPX', 'gamma_zero', '21:01:49Z', '21:01:00Z', {}, 'state');
      await cap('QQQ', 'gamma_zero', '20:46:49Z', '20:46:00Z', {}, 'state');
      await cap('IWM', 'gamma_zero', '20:46:48Z', '20:46:00Z', {}, 'state');
      const a = await getClosedAnchors('gexbot_api_capture');
      expect([...a!.byTicker.keys()].sort()).toEqual(['QQQ', 'SPX']);
    });
  });

  describe('getLatestSnapshots(anchors)', () => {
    it('returns the anchor row, not the replay', async () => {
      await seedClose();
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      const rows = await getLatestSnapshots(anchors);
      expect(rows.find((r) => r.ticker === 'SPX')?.capturedAt).toBe(
        '2026-11-20T21:00:49.000Z',
      );
      expect(rows.find((r) => r.ticker === 'SPX')?.spot).toBe(3);
      expect(rows.find((r) => r.ticker === 'NDX')?.spot).toBe(6);
      expect(rows.find((r) => r.ticker === 'ES_SPX')?.spot).toBe(9);
      expect(rows.find((r) => r.ticker === 'IWM')?.spot).toBe(11);
      expect(rows.some((r) => r.ticker === 'QQQ')).toBe(false);
      expect(rows).toHaveLength(4);
    });

    it('is what the clock-anchored read is not: it shows the replay after the close', async () => {
      // Same table, read from "now" (16:02:30 ET): the unanchored read takes
      // the replay row as the latest SPX snapshot.
      await seedClose();
      const live = await getLatestSnapshots();
      expect(live.find((r) => r.ticker === 'SPX')?.capturedAt).toBe(
        '2026-11-20T21:01:49.000Z',
      );
    });

    it('returns the anchor row when its capture time has microseconds', async () => {
      // `captured_at` defaults to now(), which has microsecond precision. The
      // anchor travels as a millisecond ISO string, so a plain `<=` against
      // it would drop the very row it names.
      await snap('SPX', '2026-11-20T21:00:49.123456Z', '21:00:00Z', {
        spot: 3,
      });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(anchors.byTicker.get('SPX')).toBe('2026-11-20T21:00:49.123Z');
      const rows = await getLatestSnapshots(anchors);
      expect(rows.map((r) => r.spot)).toEqual([3]);
    });

    it('falls back to an older row of the 15 minutes before the anchor when the anchor row has a stale stamp', async () => {
      // VIX's anchor row (21:00:49) carries the prior close's stamp (the day
      // before, 16:00 ET), so the session-start rule drops it and the ticker
      // falls back to the newest row of [anchor - 15 min, anchor].
      await snap('VIX', '20:46:49Z', '20:46:00Z', { spot: 2 });
      await snap('VIX', '21:00:49Z', '2026-11-19T21:00:00Z', { spot: 3 });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(anchors.byTicker.get('VIX')).toBe('2026-11-20T21:00:49.000Z');
      expect((await getLatestSnapshots(anchors)).map((r) => r.spot)).toEqual([
        2,
      ]);
    });

    it('starts the window exactly 15 minutes before the anchor', async () => {
      // Both tickers' anchor rows are dropped for a stale stamp, so each can
      // only fall back to its older row: 20:45:49 is exactly 15 minutes
      // before the 21:00:49 anchor (kept), 20:45:48 is a second further out.
      await snap('VIX', '20:45:49Z', '20:45:00Z', { spot: 1 });
      await snap('VIX', '21:00:49Z', '2026-11-19T21:00:00Z', { spot: 2 });
      await snap('UVXY', '20:45:48Z', '20:45:00Z', { spot: 3 });
      await snap('UVXY', '21:00:49Z', '2026-11-19T21:00:00Z', { spot: 4 });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(anchors.byTicker.size).toBe(2);
      const rows = await getLatestSnapshots(anchors);
      expect(rows.map((r) => [r.ticker, r.spot])).toEqual([['VIX', 1]]);
    });

    it('drops a ticker whose only rows in its window predate the session', async () => {
      await snap('VIX', '21:00:49Z', '2026-11-19T21:00:00Z', { spot: 3 });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(await getLatestSnapshots(anchors)).toEqual([]);
    });

    it('bounds the session start at the ET midnight of the session date (EDT)', async () => {
      // 2026-10-29 is EDT: ET midnight is 04:00Z. A stamp at 04:30Z (00:30
      // EDT) is inside the session; 03:30Z (23:30 EDT the day before) is not.
      // A fixed EST offset (05:00Z) would drop both.
      await snap('SPX', '2026-10-29T20:59:49Z', '2026-10-29T04:30:00Z', {
        spot: 1,
      });
      await snap('NDX', '2026-10-29T20:59:49Z', '2026-10-29T03:30:00Z', {
        spot: 2,
      });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(anchors.sessionDate).toBe('2026-10-29');
      expect((await getLatestSnapshots(anchors)).map((r) => r.ticker)).toEqual([
        'SPX',
      ]);
    });

    it('bounds the session start at the ET midnight of the session date (EST)', async () => {
      // 2026-11-20 is EST: ET midnight is 05:00Z. A stamp at 05:30Z (00:30
      // EST) is inside the session; 04:30Z (23:30 EST the day before) is not.
      // A fixed EDT offset (04:00Z) would keep both.
      await snap('SPX', '20:59:49Z', '2026-11-20T05:30:00Z', { spot: 1 });
      await snap('NDX', '20:59:49Z', '2026-11-20T04:30:00Z', { spot: 2 });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect((await getLatestSnapshots(anchors)).map((r) => r.ticker)).toEqual([
        'SPX',
      ]);
    });

    it('returns [] for anchors that name no ticker', async () => {
      await seedClose();
      const none: ClosedAnchors = {
        sessionDate: '2026-11-20',
        byTicker: new Map(),
      };
      expect(await getLatestSnapshots(none)).toEqual([]);
    });

    it('selects the same columns as the clock-anchored read', async () => {
      // The anchored query repeats the SELECT list, so a column added to one
      // and not the other would read as null on the closed path only.
      const columns = [
        'spot',
        'zero_gamma',
        'z_mlgamma',
        'z_msgamma',
        'zcvr',
        'zgr',
        'zvanna',
        'zcharm',
        'o_mlgamma',
        'o_msgamma',
        'ocvr',
        'ogr',
        'ovanna',
        'ocharm',
        'one_dexoflow',
        'one_gexoflow',
        'one_cvroflow',
        'zero_mcall',
        'zero_mput',
        'major_pos_vol',
        'major_pos_oi',
        'major_neg_vol',
        'major_neg_oi',
        'min_dte',
      ];
      const columnList = columns.join(', ');
      const placeholders = columns.map((_, i) => '$' + (i + 3)).join(', ');
      await pg.query(
        `INSERT INTO gexbot_snapshots
           (ticker, captured_at, source_timestamp, raw_response, ${columnList})
         VALUES ('SPX', $1::timestamptz, $2, '{}'::jsonb, ${placeholders})`,
        [iso('21:00:49Z'), epoch('21:00:00Z'), ...columns.map((_, i) => i + 1)],
      );
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      const anchored = await getLatestSnapshots(anchors);
      const clock = await getLatestSnapshots();
      expect(anchored).toEqual(clock);
      const [row] = anchored;
      const nulls = Object.entries(row!).filter(([, value]) => value === null);
      expect(nulls).toEqual([]);
    });
  });

  describe('getConvexityTrend(window, anchors)', () => {
    /** SPX every minute from 19:59:49 to 21:00:49, then the 21:01:49 replay. */
    async function seedSpxMinutes() {
      for (let m = 0; m <= 62; m++) {
        const minuteOfDay = 19 * 60 + 59 + m;
        const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
        const mm = String(minuteOfDay % 60).padStart(2, '0');
        await snap('SPX', `${hh}:${mm}:49Z`, `${hh}:${mm}:00Z`, {
          zcvr: m,
          dte: 0,
        });
      }
      // The replay: the 21:01:49 row repeats the 21:00:49 row's stamp.
      await pg.query(
        `UPDATE gexbot_snapshots SET source_timestamp = $1
          WHERE ticker = 'SPX' AND captured_at = $2::timestamptz`,
        [epoch('21:00:00Z'), iso('21:01:49Z')],
      );
      // ES_SPX updates late, which makes the table's newest row 21:01:55.
      await snap('ES_SPX', '21:01:55Z', '21:01:05Z', { zcvr: 99 });
    }

    it('ends each series at the anchor and starts it 60 minutes before', async () => {
      await seedSpxMinutes();
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(anchors.byTicker.get('SPX')).toBe('2026-11-20T21:00:49.000Z');
      const rows = await getConvexityTrend(60, anchors);
      const spx = rows.find((r) => r.ticker === 'SPX')!;
      expect(spx.series[0]).toEqual(['2026-11-20T20:00:49.000Z', 1]);
      expect(spx.series.at(-1)).toEqual(['2026-11-20T21:00:49.000Z', 61]);
      expect(spx.series).toHaveLength(61);
      expect(spx.minDte).toBe(0);
    });

    it('honours a shorter window', async () => {
      await seedSpxMinutes();
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      const rows = await getConvexityTrend(5, anchors);
      const spx = rows.find((r) => r.ticker === 'SPX')!;
      expect(spx.series[0]?.[0]).toBe('2026-11-20T20:55:49.000Z');
      expect(spx.series).toHaveLength(6);
    });

    it("measures each ticker's window from its own anchor", async () => {
      await seedSpxMinutes();
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      const rows = await getConvexityTrend(60, anchors);
      const es = rows.find((r) => r.ticker === 'ES_SPX')!;
      expect(es.series).toEqual([['2026-11-20T21:01:55.000Z', 99]]);
    });

    it('leaves out a ticker that has no anchor', async () => {
      await seedSpxMinutes();
      await snap('QQQ', '20:40:00Z', '20:39:00Z', { zcvr: 7 });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      const rows = await getConvexityTrend(60, anchors);
      expect(rows.some((r) => r.ticker === 'QQQ')).toBe(false);
    });

    it('keeps the anchor point when its capture time has microseconds', async () => {
      await snap('SPX', '2026-11-20T21:00:49.123456Z', '21:00:00Z', {
        zcvr: 4,
      });
      const anchors = (await getClosedAnchors('gexbot_snapshots'))!;
      expect(await getConvexityTrend(60, anchors)).toEqual([
        {
          ticker: 'SPX',
          minDte: null,
          series: [['2026-11-20T21:00:49.123Z', 4]],
        },
      ]);
    });

    it('returns [] for anchors that name no ticker', async () => {
      await seedSpxMinutes();
      const none: ClosedAnchors = {
        sessionDate: '2026-11-20',
        byTicker: new Map(),
      };
      expect(await getConvexityTrend(60, none)).toEqual([]);
    });
  });

  describe('getMaxchangeWinners(anchors)', () => {
    const MAX = 'gex_zero/maxchange';
    const win = (strike: number, change: number) => ({
      current: [strike, change],
      one: [strike + 5, change + 1],
      five: null,
      ten: [-2147483.648, -2147483.648],
      fifteen: [strike + 15, change + 15],
      thirty: [strike + 30, change + 30],
    });

    it('reads the 5 minutes up to the anchor only', async () => {
      await cap('SPX', MAX, '20:55:30Z', '20:55:00Z', win(6500, 1));
      await cap('SPX', MAX, '20:56:49Z', '20:56:00Z', win(6501, 2));
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      // The 21:01:49 capture has no stamp, so it is not an anchor, but it is
      // the table's newest row. It is after SPX's anchor and must stay out.
      await cap('SPX', MAX, '21:01:49Z', null, win(6599, 99));
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticker: 'SPX',
        endpoint: 'classic',
        category: MAX,
        capturedAt: '2026-11-20T21:00:49.000Z',
      });
      expect(rows[0]?.windows).toEqual({
        current: [6502, 3],
        one: [6507, 4],
        five: null,
        ten: null, // the INT32 sentinel drop stays
        fifteen: [6517, 18],
        thirty: [6532, 33],
      });
    });

    it('leaves out a category whose newest row is more than 5 minutes before the anchor', async () => {
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      await cap(
        'SPX',
        'gex_full/maxchange',
        '20:55:30Z',
        '20:55:00Z',
        win(1, 1),
      );
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows.map((r) => r.category)).toEqual([MAX]);
    });

    it('keeps a row exactly 5 minutes before the anchor', async () => {
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      await cap(
        'SPX',
        'gex_full/maxchange',
        '20:55:49Z',
        '20:55:00Z',
        win(1, 1),
      );
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows.map((r) => r.category).sort()).toEqual([
        'gex_full/maxchange',
        MAX,
      ]);
    });

    it('returns only maxchange categories', async () => {
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      await cap('SPX', 'gamma_zero', '21:00:49Z', '21:00:00Z', {}, 'state');
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows.map((r) => r.category)).toEqual([MAX]);
    });

    it("ends each ticker's window at its own anchor", async () => {
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      await cap('NDX', MAX, '20:58:10Z', '20:58:00Z', win(24000, 5));
      await cap('NDX', MAX, '21:01:10Z', null, win(1, 1));
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows.map((r) => [r.ticker, r.capturedAt]).sort()).toEqual([
        ['NDX', '2026-11-20T20:58:10.000Z'],
        ['SPX', '2026-11-20T21:00:49.000Z'],
      ]);
    });

    it('returns the anchor row when its capture time has microseconds', async () => {
      await cap(
        'SPX',
        MAX,
        '2026-11-20T21:00:49.123456Z',
        '21:00:00Z',
        win(6502, 3),
      );
      const anchors = (await getClosedAnchors('gexbot_api_capture'))!;
      const rows = await getMaxchangeWinners(anchors);
      expect(rows.map((r) => r.capturedAt)).toEqual([
        '2026-11-20T21:00:49.123Z',
      ]);
    });

    it('returns [] for anchors that name no ticker', async () => {
      await cap('SPX', MAX, '21:00:49Z', '21:00:00Z', win(6502, 3));
      const none: ClosedAnchors = {
        sessionDate: '2026-11-20',
        byTicker: new Map(),
      };
      expect(await getMaxchangeWinners(none)).toEqual([]);
    });
  });
});
