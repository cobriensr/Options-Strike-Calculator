// @vitest-environment node

/**
 * REAL-SQL test for the velocity-tape query. The LAG window, the 3-minute
 * gap rule, the stale-source-repeat rule and the per-ticker median all live
 * in SQL, so they are proven against pglite on the table built by migration
 * #156. Only the Date clock is faked: the query binds JS `new Date()` as its
 * "now", so pglite's own clock is never consulted. The last block reads the
 * tape from closed-market anchors instead, where the clock plays no part.
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
  getVelocityTape,
  type ClosedAnchors,
} from '../_lib/gexbot-queries.js';

let pg: PGlite;

// 10:05 ET (EDT) on a Thursday: well inside the session, same ET day as the
// seeded rows, and 14:05Z so a "yesterday" row is unambiguously a prior day.
const NOW = new Date('2026-10-29T14:05:00.000Z');

interface SeedRow {
  ticker?: string;
  at: string;
  src?: number | null;
  agg?: number | null;
  zgr?: number | null;
  zcvr?: number | null;
  dte?: number | null;
}

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const EPOCH_1403 = epoch('2026-10-29T14:03:00Z');

// Vendor `timestamp` is Unix seconds; by default it tracks the capture time,
// like a live feed. Pass `src` to model a replayed or null timestamp.
async function seed(r: SeedRow) {
  await pg.query(
    `INSERT INTO gexbot_snapshots
       (ticker, captured_at, source_timestamp, agg_dex, zgr, zcvr, min_dte, raw_response)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, '{}'::jsonb)`,
    [
      r.ticker ?? 'SPX',
      r.at,
      r.src === undefined ? epoch(r.at) : r.src,
      r.agg ?? null,
      r.zgr ?? null,
      r.zcvr ?? null,
      r.dte === undefined ? 0 : r.dte,
    ],
  );
}

describe('getVelocityTape against real SQL', () => {
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

  it('returns the minute-over-minute change from the latest two snapshots', async () => {
    await seed({
      at: '2026-10-29T14:02:00Z',
      agg: 100,
      zgr: 1.0,
      zcvr: 5,
    });
    await seed({
      at: '2026-10-29T14:03:00Z',
      agg: 130,
      zgr: 1.25,
      zcvr: 4,
    });
    await seed({
      at: '2026-10-29T14:04:00Z',
      agg: 170,
      zgr: 1.0,
      zcvr: 6,
    });
    const rows = await getVelocityTape();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticker: 'SPX',
      capturedAt: '2026-10-29T14:04:00.000Z',
      minDte: 0,
      dAggDex: 40,
      dZgr: -0.25,
      dZcvr: 2,
    });
  });

  it('gives null deltas on the first snapshot of the session', async () => {
    await seed({
      at: '2026-10-29T14:04:00Z',
      agg: 170,
      zgr: 1,
      zcvr: 6,
    });
    const [row] = await getVelocityTape();
    expect(row).toMatchObject({
      ticker: 'SPX',
      dAggDex: null,
      dZgr: null,
      dZcvr: null,
    });
  });

  it('does not pair across the day boundary (previous ET session)', async () => {
    // Yesterday 15:59 ET; agg_dex is session-cumulative so it would be junk.
    await seed({
      at: '2026-10-28T19:59:00Z',
      agg: 9_000_000,
      zgr: 3,
      zcvr: 9,
    });
    await seed({
      at: '2026-10-29T14:04:00Z',
      agg: 170,
      zgr: 1,
      zcvr: 6,
    });
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBeNull();
  });

  it('gives null deltas when the prior snapshot is more than 3 minutes older', async () => {
    await seed({
      at: '2026-10-29T13:59:30Z',
      agg: 100,
      zgr: 1,
      zcvr: 5,
    });
    await seed({
      at: '2026-10-29T14:04:00Z',
      agg: 170,
      zgr: 2,
      zcvr: 6,
    });
    const [row] = await getVelocityTape();
    expect(row).toMatchObject({ dAggDex: null, dZgr: null, dZcvr: null });
  });

  it('keeps the delta when the prior snapshot is exactly 3 minutes older', async () => {
    await seed({ at: '2026-10-29T14:01:00Z', agg: 100 });
    await seed({ at: '2026-10-29T14:04:00Z', agg: 170 });
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBe(70);
  });

  it('gives null deltas when the vendor repeated the prior source timestamp', async () => {
    // The 09:30 VIX case: the feed replays the prior close with the same
    // source timestamp, so the "change" is an artifact.
    await seed({
      ticker: 'VIX',
      at: '2026-10-29T14:03:00Z',
      src: EPOCH_1403,
      agg: 10,
    });
    await seed({
      ticker: 'VIX',
      at: '2026-10-29T14:04:00Z',
      src: EPOCH_1403,
      agg: 10,
    });
    await seed({ at: '2026-10-29T14:03:00Z', agg: 100 });
    await seed({ at: '2026-10-29T14:04:00Z', agg: 150 });
    const rows = await getVelocityTape();
    const vix = rows.find((r) => r.ticker === 'VIX');
    const spx = rows.find((r) => r.ticker === 'SPX');
    expect(vix?.dAggDex).toBeNull();
    expect(spx?.dAggDex).toBe(50);
  });

  it("keeps VIX's open jump out of the typical change", async () => {
    // Prod pattern: the open row carries the prior close's vendor timestamp
    // and agg_dex (-1.24); the next row is fresh. Without the session check
    // the 1.24 jump would be VIX's largest "change" of the day.
    await seed({
      ticker: 'VIX',
      at: '2026-10-29T14:02:00Z',
      src: epoch('2026-10-28T20:00:00Z'),
      agg: -1.24,
    });
    await seed({ ticker: 'VIX', at: '2026-10-29T14:03:00Z', agg: 0 });
    await seed({ ticker: 'VIX', at: '2026-10-29T14:04:00Z', agg: 0.02 });
    const [vix] = await getVelocityTape();
    expect(vix?.dAggDex).toBeCloseTo(0.02, 10);
    expect(vix?.typicalAbsDAggDex).toBeCloseTo(0.02, 10);
  });

  it('nulls the open delta itself when the prior is from the prior session', async () => {
    await seed({
      ticker: 'VIX',
      at: '2026-10-29T14:03:00Z',
      src: epoch('2026-10-28T20:00:00Z'),
      agg: -1.24,
    });
    await seed({ ticker: 'VIX', at: '2026-10-29T14:04:00Z', agg: 0 });
    const [vix] = await getVelocityTape();
    expect(vix?.dAggDex).toBeNull();
    expect(vix?.typicalAbsDAggDex).toBeNull();
  });

  it('still computes a delta when source timestamps are missing', async () => {
    await seed({ at: '2026-10-29T14:03:00Z', src: null, agg: 100 });
    await seed({ at: '2026-10-29T14:04:00Z', src: null, agg: 120 });
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBe(20);
  });

  it('computes each delta independently when one scalar is null', async () => {
    await seed({
      at: '2026-10-29T14:03:00Z',
      agg: null,
      zgr: 1,
      zcvr: 5,
    });
    await seed({
      at: '2026-10-29T14:04:00Z',
      agg: 50,
      zgr: 3,
      zcvr: 5,
    });
    const [row] = await getVelocityTape();
    expect(row).toMatchObject({ dAggDex: null, dZgr: 2, dZcvr: 0 });
  });

  it('reports the median |change| of the ticker over the session', async () => {
    // agg_dex: 0, 10, 40, 40 -> |d| = 10, 30, 0 -> median 10.
    await seed({ at: '2026-10-29T14:01:00Z', agg: 0 });
    await seed({ at: '2026-10-29T14:02:00Z', agg: 10 });
    await seed({ at: '2026-10-29T14:03:00Z', agg: 40 });
    await seed({ at: '2026-10-29T14:04:00Z', agg: 40 });
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBe(0);
    expect(row?.typicalAbsDAggDex).toBe(10);
  });

  it("keeps the previous ET session's minutes out of the typical change", async () => {
    // Yesterday's minutes move 100 apiece; today's move 1. Yesterday's rows
    // carry no vendor timestamp (NULL = no evidence, so the pre-session
    // prior rule cannot null them), and the 3-minute gap rule only nulls
    // today's first delta. That leaves the ET-midnight bound as the one
    // thing keeping yesterday's four 100s out of the median. Without it the
    // median would be 100, and today's highlight would be judged against
    // yesterday's tape.
    for (const [at, agg, src] of [
      ['2026-10-28T14:00:00Z', 1000, null],
      ['2026-10-28T14:01:00Z', 1100, null],
      ['2026-10-28T14:02:00Z', 1200, null],
      ['2026-10-28T14:03:00Z', 1300, null],
      ['2026-10-28T14:04:00Z', 1400, null],
      ['2026-10-29T14:01:00Z', 5, undefined],
      ['2026-10-29T14:02:00Z', 6, undefined],
      ['2026-10-29T14:03:00Z', 7, undefined],
      ['2026-10-29T14:04:00Z', 8, undefined],
    ] as const) {
      await seed({ at, agg, src });
    }
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBe(1);
    expect(row?.typicalAbsDAggDex).toBe(1);
  });

  it('puts the ET-midnight bound at 05:00Z once the clocks fall back (EST)', async () => {
    // 2026-11-01 is the DST change, so Monday 11-02 starts at 05:00Z, not
    // 04:00Z. A fixed EDT offset would let the 04:58Z-04:59Z minutes (23:58
    // and 23:59 EST on Sunday) into Monday's median. NULL vendor timestamps,
    // as above, so only the bound can exclude them.
    vi.setSystemTime(new Date('2026-11-02T15:05:00.000Z'));
    for (const [at, agg, src] of [
      ['2026-11-02T04:58:00Z', 100, null],
      ['2026-11-02T04:59:00Z', 150, null],
      ['2026-11-02T15:03:00Z', 10, undefined],
      ['2026-11-02T15:04:00Z', 11, undefined],
    ] as const) {
      await seed({ at, agg, src });
    }
    const [row] = await getVelocityTape();
    expect(row?.dAggDex).toBe(1);
    expect(row?.typicalAbsDAggDex).toBe(1);
  });

  it('leaves the median null when the session has no valid change yet', async () => {
    await seed({ at: '2026-10-29T14:04:00Z', agg: 40 });
    const [row] = await getVelocityTape();
    expect(row?.typicalAbsDAggDex).toBeNull();
  });

  it('drops tickers whose newest snapshot is older than 15 minutes', async () => {
    await seed({ ticker: 'SLV', at: '2026-10-29T13:40:00Z', agg: 1 });
    await seed({ ticker: 'SLV', at: '2026-10-29T13:41:00Z', agg: 2 });
    await seed({ at: '2026-10-29T14:04:00Z', agg: 40 });
    const rows = await getVelocityTape();
    expect(rows.map((r) => r.ticker)).toEqual(['SPX']);
  });

  it('keeps each ticker independent and carries its own min_dte', async () => {
    await seed({
      ticker: 'SPX',
      at: '2026-10-29T14:03:00Z',
      agg: 100,
      dte: 0,
    });
    await seed({
      ticker: 'SPX',
      at: '2026-10-29T14:04:00Z',
      agg: 110,
      dte: 0,
    });
    await seed({
      ticker: 'HYG',
      at: '2026-10-29T14:03:00Z',
      agg: 5,
      dte: 2,
    });
    await seed({
      ticker: 'HYG',
      at: '2026-10-29T14:04:00Z',
      agg: -5,
      dte: 2,
    });
    const rows = await getVelocityTape();
    expect(rows.find((r) => r.ticker === 'SPX')).toMatchObject({
      dAggDex: 10,
      minDte: 0,
    });
    expect(rows.find((r) => r.ticker === 'HYG')).toMatchObject({
      dAggDex: -10,
      minDte: 2,
    });
  });

  it('returns [] when the table is empty', async () => {
    expect(await getVelocityTape()).toEqual([]);
  });

  // ── closed market: each ticker measured from its own anchor ──────────
  //
  // After the cash close the tape stops measuring from "now" and measures from
  // each ticker's anchor, its last real capture of the session. The session is
  // Friday 2026-11-20 (EST, so ET midnight is 05:00Z) and the clock is the
  // Saturday after, so a clock-anchored read finds nothing.
  describe('with anchors (the market is closed)', () => {
    const SATURDAY = new Date('2026-11-21T15:00:00.000Z');
    const D = '2026-11-20';

    beforeEach(() => {
      vi.setSystemTime(SATURDAY);
    });

    const anchorsOfSnapshots = async () =>
      (await getClosedAnchors('gexbot_snapshots'))!;

    /** SPX's closing minutes: a real 20:59, the 21:00 close, then a replay. */
    async function seedSpxClose() {
      await seed({
        at: `${D}T20:59:49Z`,
        src: epoch(`${D}T20:59:00Z`),
        agg: 100,
        zgr: 1,
        zcvr: 5,
      });
      await seed({
        at: `${D}T21:00:49Z`,
        src: epoch(`${D}T21:00:00Z`),
        agg: 130,
        zgr: 1.5,
        zcvr: 4,
      });
      await seed({
        at: `${D}T21:01:49Z`,
        src: epoch(`${D}T21:00:00Z`),
        agg: 130,
        zgr: 1.5,
        zcvr: 4,
      });
    }

    it('reads the clock-anchored tape as empty on the weekend', async () => {
      // The control for everything below: the live read has nothing to show.
      await seedSpxClose();
      expect(await getVelocityTape()).toEqual([]);
    });

    it('SPX delta is the anchor minus the previous minute, not nulled by the replay', async () => {
      await seedSpxClose();
      const rows = await getVelocityTape(await anchorsOfSnapshots());
      const spx = rows.find((r) => r.ticker === 'SPX')!;
      expect(spx.capturedAt).toBe('2026-11-20T21:00:49.000Z');
      expect(spx.dAggDex).toBe(30);
      expect(spx.dZgr).toBe(0.5);
      expect(spx.dZcvr).toBe(-1);
      expect(rows).toHaveLength(1);
    });

    it('leaves a ticker with no anchor out of the tape', async () => {
      await seedSpxClose();
      // QQQ stopped 20 minutes before the table's newest row: no anchor.
      await seed({ ticker: 'QQQ', at: `${D}T20:40:00Z`, agg: 7 });
      const anchors = await anchorsOfSnapshots();
      expect(anchors.byTicker.has('QQQ')).toBe(false);
      const rows = await getVelocityTape(anchors);
      expect(rows.map((r) => r.ticker)).toEqual(['SPX']);
    });

    it("measures each ticker from its own anchor, not one shared 'now'", async () => {
      await seedSpxClose();
      // ES_SPX updates late: its newest row is the table's newest row.
      await seed({
        ticker: 'ES_SPX',
        at: `${D}T21:00:55Z`,
        src: epoch(`${D}T21:00:05Z`),
        agg: 10,
      });
      await seed({
        ticker: 'ES_SPX',
        at: `${D}T21:01:55Z`,
        src: epoch(`${D}T21:01:05Z`),
        agg: 25,
      });
      const rows = await getVelocityTape(await anchorsOfSnapshots());
      expect(rows.map((r) => [r.ticker, r.capturedAt, r.dAggDex])).toEqual([
        ['ES_SPX', '2026-11-20T21:01:55.000Z', 15],
        ['SPX', '2026-11-20T21:00:49.000Z', 30],
      ]);
    });

    it('applies the 3-minute gap rule from the anchor', async () => {
      await seed({ at: `${D}T20:55:49Z`, agg: 100 });
      await seed({ at: `${D}T21:00:49Z`, agg: 130 });
      const [row] = await getVelocityTape(await anchorsOfSnapshots());
      expect(row).toMatchObject({ dAggDex: null, dZgr: null, dZcvr: null });
    });

    it('keeps the delta when the prior row is exactly 3 minutes before the anchor', async () => {
      await seed({ at: `${D}T20:57:49Z`, agg: 100 });
      await seed({ at: `${D}T21:00:49Z`, agg: 130 });
      const [row] = await getVelocityTape(await anchorsOfSnapshots());
      expect(row?.dAggDex).toBe(30);
    });

    it('nulls the anchor delta when its prior row carries the prior session stamp', async () => {
      // VIX's open row replays the prior close's stamp. Seen from the close,
      // the same rule nulls a prior whose stamp predates the session.
      await seed({
        ticker: 'VIX',
        at: `${D}T20:59:49Z`,
        src: epoch('2026-11-19T21:00:00Z'),
        agg: -1.24,
      });
      await seed({
        ticker: 'VIX',
        at: `${D}T21:00:49Z`,
        src: epoch(`${D}T21:00:00Z`),
        agg: 0,
      });
      const [vix] = await getVelocityTape(await anchorsOfSnapshots());
      expect(vix?.capturedAt).toBe('2026-11-20T21:00:49.000Z');
      expect(vix?.dAggDex).toBeNull();
      expect(vix?.typicalAbsDAggDex).toBeNull();
    });

    it('reports the median |change| over the session up to the anchor only', async () => {
      // |d| = 10, 30 up to the 21:00:49 anchor, so the median is 20. The row
      // after the anchor has no vendor stamp (so the stale rule cannot null
      // it) and moves 500: it must reach neither the median nor the tape.
      await seed({ at: `${D}T20:58:49Z`, agg: 0 });
      await seed({ at: `${D}T20:59:49Z`, agg: 10 });
      await seed({ at: `${D}T21:00:49Z`, agg: 40 });
      await seed({ at: `${D}T21:01:49Z`, src: null, agg: 540 });
      const anchors = await anchorsOfSnapshots();
      expect(anchors.byTicker.get('SPX')).toBe('2026-11-20T21:00:49.000Z');
      const [row] = await getVelocityTape(anchors);
      expect(row?.capturedAt).toBe('2026-11-20T21:00:49.000Z');
      expect(row?.dAggDex).toBe(30);
      expect(row?.typicalAbsDAggDex).toBe(20);
    });

    it("keeps the previous ET session's minutes out of the typical change (EST)", async () => {
      // Yesterday's minutes move 100 apiece, today's move 1. NULL vendor
      // stamps (the anchor row apart, which needs one) so only the ET-midnight
      // bound of the session date can drop them: 04:57Z-04:59Z on 11-20 is
      // 23:57-23:59 EST on 11-19, before the 05:00Z start. A fixed EDT offset
      // (04:00Z) would keep them and push the median to 50.5.
      for (const [at, agg] of [
        [`${D}T04:57:00Z`, 1000],
        [`${D}T04:58:00Z`, 1100],
        [`${D}T04:59:00Z`, 1200],
        [`${D}T20:58:49Z`, 5],
        [`${D}T20:59:49Z`, 6],
      ] as const) {
        await seed({ at, agg, src: null });
      }
      await seed({ at: `${D}T21:00:49Z`, agg: 7 });
      const [row] = await getVelocityTape(await anchorsOfSnapshots());
      expect(row?.dAggDex).toBe(1);
      expect(row?.typicalAbsDAggDex).toBe(1);
    });

    it("keeps the session's own early minutes in the typical change (EDT)", async () => {
      // 2026-10-29 is EDT: the session starts at 04:00Z. A fixed EST offset
      // (05:00Z) would drop the 04:30Z minutes that belong to the session, and
      // the 03:57Z-03:59Z minutes (23:57-23:59 EDT the day before) must stay
      // out. NULL stamps again, except on the anchor row.
      const day = '2026-10-29';
      for (const [at, agg] of [
        [`${day}T03:57:00Z`, 1000],
        [`${day}T03:58:00Z`, 1100],
        [`${day}T03:59:00Z`, 1200],
        [`${day}T04:30:00Z`, 5],
        [`${day}T04:31:00Z`, 7],
      ] as const) {
        await seed({ at, agg, src: null });
      }
      await seed({ at: `${day}T04:32:00Z`, agg: 10 });
      const anchors = await anchorsOfSnapshots();
      expect(anchors.sessionDate).toBe(day);
      const [row] = await getVelocityTape(anchors);
      expect(row?.dAggDex).toBe(3);
      expect(row?.typicalAbsDAggDex).toBe(2.5);
    });

    it('keeps the anchor row when its capture time has microseconds', async () => {
      // captured_at defaults to now(), so it keeps microseconds, while the
      // anchor travels as a millisecond ISO string: a plain `<=` against the
      // anchor would drop the very row it names.
      await seed({
        at: `${D}T20:59:49.123456Z`,
        src: epoch(`${D}T20:59:00Z`),
        agg: 100,
      });
      await seed({
        at: `${D}T21:00:49.123456Z`,
        src: epoch(`${D}T21:00:00Z`),
        agg: 130,
      });
      const anchors = await anchorsOfSnapshots();
      expect(anchors.byTicker.get('SPX')).toBe('2026-11-20T21:00:49.123Z');
      const rows = await getVelocityTape(anchors);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        capturedAt: '2026-11-20T21:00:49.123Z',
        dAggDex: 30,
      });
    });

    it('returns [] for anchors that name no ticker', async () => {
      await seedSpxClose();
      const none: ClosedAnchors = { sessionDate: D, byTicker: new Map() };
      expect(await getVelocityTape(none)).toEqual([]);
    });

    it('gives the same tape as the clock-anchored read when both see the same session', async () => {
      // The anchored query repeats the live one's differencing, so a rule
      // changed in one and not the other would split them. In-session data
      // with no replay rows, read at 10:05 ET, must come out identical.
      vi.setSystemTime(NOW);
      await seed({ at: '2026-10-28T19:59:00Z', agg: 9_000_000, src: null });
      await seed({ at: '2026-10-29T14:02:00Z', agg: 100, zgr: 1, zcvr: 5 });
      await seed({ at: '2026-10-29T14:03:00Z', agg: 130, zgr: 1.25, zcvr: 4 });
      await seed({ at: '2026-10-29T14:04:00Z', agg: 170, zgr: 1, zcvr: 6 });
      // A gap (null deltas) and a prior-session prior (null deltas).
      await seed({ ticker: 'HYG', at: '2026-10-29T13:59:30Z', agg: 5, dte: 2 });
      await seed({ ticker: 'HYG', at: '2026-10-29T14:04:00Z', agg: 9, dte: 2 });
      await seed({
        ticker: 'VIX',
        at: '2026-10-29T14:03:00Z',
        src: epoch('2026-10-28T20:00:00Z'),
        agg: -1.24,
      });
      await seed({ ticker: 'VIX', at: '2026-10-29T14:04:00Z', agg: 0 });
      const live = await getVelocityTape();
      const anchored = await getVelocityTape(await anchorsOfSnapshots());
      expect(live).toHaveLength(3);
      expect(anchored).toEqual(live);
    });
  });
});
