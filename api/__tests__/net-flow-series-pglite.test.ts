// @vitest-environment node

/**
 * REAL-SQL test for the two past-day chart readers, /api/net-flow-history (the
 * per-fire Net Flow chart) and /api/ticker-net-flow-current (the Flow Match
 * badges). Their statements run in pglite against the flow tables built from
 * the real migrations (#121, #122); the mocked tests
 * (net-flow-history.test.ts, ticker-net-flow-current.test.ts) only match SQL
 * text.
 *
 * The defect (2026-11-15): both read `ws_net_flow_per_ticker` UNION ALL
 * `net_flow_per_ticker_history` with DISTINCT ON (ts). After the close both
 * hold the same day, WS per tick (ts with milliseconds) and history per minute
 * (ts on the minute), DISTINCT ON never merges them, and the cumulative line
 * for any past day came out about twice the true value. The rule now: a
 * ticker-day with WS rows in its session is read from WS only; history is read
 * only for a ticker-day with none, and only the minutes that are complete at
 * read time (`ts + 60 s <= now`).
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone.
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

const { pgRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
}));

// getDb() is a Neon-shaped client over pglite; the rest of db.js stays real
// (withDbRetry, the transient classifier the error path uses).
vi.mock('../_lib/db.js', async (importOriginal) => {
  const { neonOverPglite } = await import('./pglite-migrations');
  return {
    ...(await importOriginal<typeof import('../_lib/db.js')>()),
    getDb: () => {
      const pg = pgRef.current;
      if (!pg) throw new Error('pglite not started');
      return neonOverPglite(pg);
    },
  };
});
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

import { applyMigration } from './pglite-migrations';
import { mockRequest, mockResponse } from './helpers';
import netFlowHistory from '../net-flow-history.js';
import tickerNetFlowCurrent from '../ticker-net-flow-current.js';

// 2026-10-29 is CDT: the session is 13:30Z to 20:00Z.
const DAY = '2026-10-29';
// A read a week after the day, long after the 21:25 UTC history load.
const WEEK_LATER = Date.parse('2026-11-05T15:00:00Z');

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  pgRef.current = pg;
  await pg.query("SET TIME ZONE 'America/Chicago'");
  await applyMigration(pg, 121);
  await applyMigration(pg, 122);
}, 120_000);

afterAll(async () => {
  await pg.close();
  pgRef.current = null;
});

beforeEach(async () => {
  // Only Date is faked: pglite's own timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WEEK_LATER);
  await pg.exec(
    'DELETE FROM ws_net_flow_per_ticker; DELETE FROM net_flow_per_ticker_history;',
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function ws(
  ticker: string,
  ts: string,
  ncp: number,
  npp: number,
): Promise<void> {
  await pg.query(
    `INSERT INTO ws_net_flow_per_ticker
       (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol, raw_payload)
     VALUES ($1, $2::timestamptz, $3, 2, $4, 3, '{}'::jsonb)`,
    [ticker, ts, ncp, npp],
  );
}

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
     VALUES ($1, $2::timestamptz, $3, 2, $4, 3, 0, 0, 0, 0, 0, 0, $5)`,
    [ticker, ts, ncp, npp, source],
  );
}

interface ChartPoint {
  ts: string;
  ncp: number;
  npp: number;
  cumNcp: number;
  cumNpp: number;
  cumNcv: number;
  cumNpv: number;
}

async function chart(
  ticker: string,
  query: Record<string, string> = {},
): Promise<{ count: number; series: ChartPoint[] }> {
  const res = mockResponse();
  await netFlowHistory(
    mockRequest({ method: 'GET', query: { ticker, date: DAY, ...query } }),
    res,
  );
  expect(res._status).toBe(200);
  return res._json as { count: number; series: ChartPoint[] };
}

interface Snapshot {
  ticker: string;
  asOfTs: string;
  cumNcp: number;
  cumNpp: number;
}

async function badges(tickers: string): Promise<Snapshot[]> {
  const res = mockResponse();
  await tickerNetFlowCurrent(
    mockRequest({ method: 'GET', query: { tickers, date: DAY } }),
    res,
  );
  expect(res._status).toBe(200);
  return (res._json as { snapshots: Snapshot[] }).snapshots;
}

describe('/api/net-flow-history (real SQL)', () => {
  it('a past day with WS and history rows draws the WS-only cumulative line, not the doubled one', async () => {
    await ws('META', '2026-10-29T14:30:00.984Z', 100, 10);
    await ws('META', '2026-10-29T14:30:31.250Z', 50, 5);
    await ws('META', '2026-10-29T14:31:02.007Z', 25, 2.5);
    await hist('META', '2026-10-29T14:30:00Z', 150, 15);
    await hist('META', '2026-10-29T14:31:00Z', 25, 2.5);

    const { count, series } = await chart('META');

    expect(count).toBe(3);
    expect(series.map((p) => p.ts)).toEqual([
      '2026-10-29T14:30:00.984Z',
      '2026-10-29T14:30:31.250Z',
      '2026-10-29T14:31:02.007Z',
    ]);
    expect(series.map((p) => p.cumNcp)).toEqual([100, 150, 175]);
    expect(series.map((p) => p.cumNpp)).toEqual([10, 15, 17.5]);
    // The volume columns follow the same single source.
    expect(series.map((p) => p.cumNcv)).toEqual([2, 4, 6]);
  });

  it('a past day with history only draws the history line at the minute-start stamps', async () => {
    await hist('IWM', '2026-10-29T14:30:00Z', 100, 10);
    await hist('IWM', '2026-10-29T14:31:00Z', 50, 5);

    const { count, series } = await chart('IWM');

    expect(count).toBe(2);
    expect(series.map((p) => p.ts)).toEqual([
      '2026-10-29T14:30:00.000Z',
      '2026-10-29T14:31:00.000Z',
    ]);
    expect(series.map((p) => p.cumNcp)).toEqual([100, 150]);
  });

  it('reads a history minute only once it is complete', async () => {
    // Now is 30 s into the 14:32 minute, on the day itself.
    vi.setSystemTime(Date.parse('2026-10-29T14:32:30Z'));
    await hist('IWM', '2026-10-29T14:30:00Z', 100, 10);
    await hist('IWM', '2026-10-29T14:31:00Z', 50, 5);
    await hist('IWM', '2026-10-29T14:32:00Z', 25, 2.5);

    const { series } = await chart('IWM');

    expect(series.map((p) => p.cumNcp)).toEqual([100, 150]);

    // At the end of the minute it counts.
    vi.setSystemTime(Date.parse('2026-10-29T14:33:00Z'));
    expect((await chart('IWM')).series.map((p) => p.cumNcp)).toEqual([
      100, 150, 175,
    ]);
  });

  it('draws an empty line when neither table has the ticker-day', async () => {
    const { count, series } = await chart('NOPE');

    expect(count).toBe(0);
    expect(series).toEqual([]);
  });

  it('decides on the whole ticker-day, not on the requested window', async () => {
    // WS covers 15:30Z only; history covers the morning. A 08:30 to 09:30 CT
    // window has no WS row in it, but the day is WS, so the window is empty
    // rather than switching to the other resolution.
    await ws('META', '2026-10-29T15:30:00.500Z', 7, 7);
    await hist('META', '2026-10-29T14:30:00Z', 100, 10);

    const { count } = await chart('META', { from: '08:30', to: '09:30' });

    expect(count).toBe(0);
  });

  it('a window inside a WS day starts its cumulative at the window, from WS rows only', async () => {
    await ws('META', '2026-10-29T14:30:00.984Z', 100, 10);
    await ws('META', '2026-10-29T15:30:00.250Z', 40, 4);
    await hist('META', '2026-10-29T14:30:00Z', 100, 10);
    await hist('META', '2026-10-29T15:30:00Z', 40, 4);

    const { series } = await chart('META', { from: '10:00', to: '11:00' });

    expect(series.map((p) => p.ts)).toEqual(['2026-10-29T15:30:00.250Z']);
    expect(series.map((p) => p.cumNcp)).toEqual([40]);
  });
});

describe('/api/ticker-net-flow-current (real SQL)', () => {
  it('gives each ticker its own single source: WS where it has WS rows, history where it has none', async () => {
    await ws('META', '2026-10-29T14:30:00.984Z', 100, 10);
    await ws('META', '2026-10-29T14:31:02.007Z', 25, 2.5);
    await hist('META', '2026-10-29T14:30:00Z', 100, 10);
    await hist('META', '2026-10-29T14:31:00Z', 25, 2.5);
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4);
    await hist('IWM', '2026-10-29T14:31:00Z', 20, 2);

    const snapshots = await badges('META,IWM,NOPE');

    expect(snapshots).toHaveLength(2);
    const meta = snapshots.find((s) => s.ticker === 'META');
    const iwm = snapshots.find((s) => s.ticker === 'IWM');
    expect(meta).toMatchObject({
      asOfTs: '2026-10-29T14:31:02.007Z',
      cumNcp: 125,
      cumNpp: 12.5,
    });
    expect(iwm).toMatchObject({
      asOfTs: '2026-10-29T14:31:00.000Z',
      cumNcp: 60,
      cumNpp: 6,
    });
  });

  it('reads a history minute only once it is complete', async () => {
    vi.setSystemTime(Date.parse('2026-10-29T14:31:30Z'));
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4);
    await hist('IWM', '2026-10-29T14:31:00Z', 20, 2);

    const snapshots = await badges('IWM');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      asOfTs: '2026-10-29T14:30:00.000Z',
      cumNcp: 40,
    });
  });

  it('counts a history minute once when two sources hold it', async () => {
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4, 'rest');
    await hist('IWM', '2026-10-29T14:30:00Z', 40, 4, 'backfill');

    const snapshots = await badges('IWM');

    expect(snapshots[0]).toMatchObject({ cumNcp: 40, cumNpp: 4 });
  });
});
