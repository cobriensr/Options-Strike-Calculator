// @vitest-environment node

/**
 * REAL-SQL test for the ticker-day net-flow series (`fetchTickerFlowSeries`).
 * The statement runs in pglite (Postgres in WASM) against the two flow tables
 * built from the real migrations (#121 ws_net_flow_per_ticker, #122
 * net_flow_per_ticker_history). The mocked test (ticker-flow-snapshot.test.ts)
 * cannot see a wrong UNION.
 *
 * The defect (2026-11-15): after the close both tables hold the same day's
 * flow, WS per tick (ts with milliseconds) and history per minute (ts on the
 * minute). The old statement was UNION ALL + DISTINCT ON (ts), which never
 * merges the two, so the running sum counted the day twice. The rule now: a
 * ticker-day with any WS row in its session is WS only; history is read only
 * for a ticker-day with none, and a history row (one whole minute) is reached
 * only once its minute is complete.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration, neonOverPglite } from './pglite-migrations';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
} from '../_lib/ticker-flow-snapshot.js';

type Db = Parameters<typeof fetchTickerFlowSeries>[0];

// 2026-10-29 is CDT: the session is 13:30Z to 20:00Z.
const DAY = '2026-10-29';

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = new PGlite();
  await pg.query("SET TIME ZONE 'America/Chicago'");
  await applyMigration(pg, 121);
  await applyMigration(pg, 122);
  db = neonOverPglite(pg) as unknown as Db;
}, 120_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM ws_net_flow_per_ticker; DELETE FROM net_flow_per_ticker_history;',
  );
});

/** One WS tick: a per-tick delta, `ts` with milliseconds. */
async function ws(
  ticker: string,
  ts: string,
  ncp: number,
  npp: number,
): Promise<void> {
  await pg.query(
    `INSERT INTO ws_net_flow_per_ticker
       (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol, raw_payload)
     VALUES ($1, $2::timestamptz, $3, 1, $4, 1, '{}'::jsonb)`,
    [ticker, ts, ncp, npp],
  );
}

/** One history minute: the whole minute starting at `ts`. */
async function hist(
  ticker: string,
  ts: string,
  ncp: number,
  npp: number,
  source = 'rest',
): Promise<void> {
  await pg.query(
    `INSERT INTO net_flow_per_ticker_history
       (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
        call_volume, call_volume_ask_side, call_volume_bid_side,
        put_volume, put_volume_ask_side, put_volume_bid_side, source)
     VALUES ($1, $2::timestamptz, $3, 1, $4, 1, 0, 0, 0, 0, 0, 0, $5)`,
    [ticker, ts, ncp, npp, source],
  );
}

const at = (iso: string): Date => new Date(iso);

describe('fetchTickerFlowSeries (real SQL)', () => {
  it('a ticker-day with WS and history rows gives the WS-only sum, not the doubled one', async () => {
    // The same 14:30 to 14:32 flow, at both resolutions. WS: 100 + 50 at the
    // first minute, 25 in the second. History: the two minutes whole.
    await ws('META', '2026-10-29T14:30:00.984Z', 100, 10);
    await ws('META', '2026-10-29T14:30:31.250Z', 50, 5);
    await ws('META', '2026-10-29T14:31:02.007Z', 25, 2.5);
    await hist('META', '2026-10-29T14:30:00Z', 150, 15);
    await hist('META', '2026-10-29T14:31:00Z', 25, 2.5);

    const series = await fetchTickerFlowSeries(db, 'META', DAY);

    // WS rows only, in time order, with the WS timestamps.
    expect(series.ts).toEqual([
      Date.parse('2026-10-29T14:30:00.984Z'),
      Date.parse('2026-10-29T14:30:31.250Z'),
      Date.parse('2026-10-29T14:31:02.007Z'),
    ]);
    expect(series.cumNcp).toEqual([100, 150, 175]);
    expect(series.cumNpp).toEqual([10, 15, 17.5]);
    expect(flowAtFireTime(series, at('2026-10-29T14:45:00Z'))).toEqual({
      cumNcp: 175,
      cumNpp: 17.5,
    });
  });

  it('a WS tick that lands exactly on a history minute does not pull the history row in', async () => {
    // The old DISTINCT ON (ts) merged these two by accident (same ts) and then
    // counted every other history row. The WS-first rule has no such case.
    await ws('META', '2026-10-29T14:30:00.000Z', 100, 10);
    await ws('META', '2026-10-29T14:30:40.500Z', 50, 5);
    await hist('META', '2026-10-29T14:30:00Z', 150, 15);
    await hist('META', '2026-10-29T14:31:00Z', 25, 2.5);

    const series = await fetchTickerFlowSeries(db, 'META', DAY);

    expect(series.cumNcp).toEqual([100, 150]);
    expect(series.cumNpp).toEqual([10, 15]);
  });

  it('a ticker-day with only history rows gives the history sum, each minute reachable only once it is complete', async () => {
    await hist('IWM', '2026-10-29T14:30:00Z', 100, 10);
    await hist('IWM', '2026-10-29T14:31:00Z', 50, 5);
    await hist('IWM', '2026-10-29T14:32:00Z', 25, 2.5);

    const series = await fetchTickerFlowSeries(db, 'IWM', DAY);

    // The minute starting 14:30 is complete at 14:31:00, and so on.
    expect(series.ts).toEqual([
      Date.parse('2026-10-29T14:31:00Z'),
      Date.parse('2026-10-29T14:32:00Z'),
      Date.parse('2026-10-29T14:33:00Z'),
    ]);
    expect(series.cumNcp).toEqual([100, 150, 175]);
    expect(series.cumNpp).toEqual([10, 15, 17.5]);

    // No look-ahead: a fire 30 s into the 14:31 minute sees the 14:30 minute
    // only, not the 14:31 minute it is still inside.
    expect(flowAtFireTime(series, at('2026-10-29T14:31:30Z'))).toEqual({
      cumNcp: 100,
      cumNpp: 10,
    });
    // A fire in the first minute sees nothing.
    expect(flowAtFireTime(series, at('2026-10-29T14:30:45Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
    // At the exact end of a minute that minute counts (ts + 60 s <= fire).
    expect(flowAtFireTime(series, at('2026-10-29T14:32:00Z'))).toEqual({
      cumNcp: 150,
      cumNpp: 15,
    });
    expect(flowAtFireTime(series, at('2026-10-29T14:31:59.999Z'))).toEqual({
      cumNcp: 100,
      cumNpp: 10,
    });
  });

  it('counts a history minute once when two sources hold it', async () => {
    await hist('IWM', '2026-10-29T14:30:00Z', 100, 10, 'rest');
    await hist('IWM', '2026-10-29T14:30:00Z', 100, 10, 'backfill');
    await hist('IWM', '2026-10-29T14:31:00Z', 50, 5, 'rest');

    const series = await fetchTickerFlowSeries(db, 'IWM', DAY);

    expect(series.cumNcp).toEqual([100, 150]);
  });

  it('a ticker-day with neither gives an empty series, and no fire gets a value from it', async () => {
    const series = await fetchTickerFlowSeries(db, 'NOPE', DAY);

    expect(series).toEqual({ ts: [], cumNcp: [], cumNpp: [] });
    expect(flowAtFireTime(series, at('2026-10-29T15:00:00Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });

  it('decides per ticker: another ticker’s WS rows do not make this ticker WS', async () => {
    await ws('META', '2026-10-29T14:30:00.984Z', 100, 10);
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4);

    const series = await fetchTickerFlowSeries(db, 'IWM', DAY);

    expect(series.cumNcp).toEqual([40]);
  });

  it('decides per day: WS rows on another day do not make this day WS', async () => {
    await ws('IWM', '2026-10-28T14:30:00.984Z', 999, 99);
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4);

    const series = await fetchTickerFlowSeries(db, 'IWM', DAY);

    expect(series.cumNcp).toEqual([40]);
  });

  it('decides on the session window: a pre-open WS row does not make the session WS', async () => {
    // 07:00 CT is before the 08:30 CT open; the series window excludes it, so
    // it must not switch the day to a WS series with nothing in it.
    await ws('IWM', '2026-10-29T12:00:00.100Z', 999, 99);
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4);

    const series = await fetchTickerFlowSeries(db, 'IWM', DAY);

    expect(series.cumNcp).toEqual([40]);
  });

  it('bounds both sources by the session: the open is in, the close is in, outside is out', async () => {
    await ws('META', '2026-10-29T13:29:59.900Z', 1000, 100);
    await ws('META', '2026-10-29T13:30:00.000Z', 1, 1);
    await ws('META', '2026-10-29T20:00:00.000Z', 2, 2);
    await ws('META', '2026-10-29T20:00:00.100Z', 1000, 100);
    await hist('IWM', '2026-10-29T13:29:00Z', 1000, 100);
    await hist('IWM', '2026-10-29T13:30:00Z', 1, 1);
    await hist('IWM', '2026-10-29T20:00:00Z', 2, 2);
    await hist('IWM', '2026-10-29T20:01:00Z', 1000, 100);

    expect((await fetchTickerFlowSeries(db, 'META', DAY)).cumNcp).toEqual([
      1, 3,
    ]);
    expect((await fetchTickerFlowSeries(db, 'IWM', DAY)).cumNcp).toEqual([
      1, 3,
    ]);
  });

  it('follows an early-close session: nothing after 12:00 CT on a half day', async () => {
    // 2026-11-27 closes at 13:00 ET, so the session ends at 12:00 CT = 18:00Z.
    await ws('META', '2026-11-27T17:59:59.000Z', 5, 5);
    await ws('META', '2026-11-27T18:00:01.000Z', 1000, 100);

    const series = await fetchTickerFlowSeries(db, 'META', '2026-11-27');

    expect(series.cumNcp).toEqual([5]);
  });

  it('a live read (WS only, no history yet) returns the plain running sum', async () => {
    await ws('NVDA', '2026-10-29T14:30:00.100Z', 10, 1);
    await ws('NVDA', '2026-10-29T14:30:01.200Z', -4, 2);
    await ws('NVDA', '2026-10-29T14:30:02.300Z', 6, -1);

    const series = await fetchTickerFlowSeries(db, 'NVDA', DAY);

    expect(series.cumNcp).toEqual([10, 6, 12]);
    expect(series.cumNpp).toEqual([1, 3, 2]);
  });
});
