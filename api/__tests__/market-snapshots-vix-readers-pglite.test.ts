// @vitest-environment node

/**
 * REAL-SQL tests for the two readers that take "the VIX now" from
 * market_snapshots by created_at: the VIX/SPX divergence check
 * (vix-divergence.ts getVixAt, via computeVixSpxDivergence) and the
 * Periscope lottery's fetchLatestVix.
 *
 * A backtest save for a past date is created now but carries that date's
 * VIX, so created_at alone reads a replayed VIX as the current one. So
 * both now key on the row's date:
 *   - getVixAt is a point-in-time read: only rows for its window's own ET
 *     date(s).
 *   - fetchLatestVix takes the most recent date on or before its
 *     timestamp's ET date, then that date's latest row, rows created on the
 *     date itself first: yesterday's close stands in until today's first
 *     save, and neither an older date's replay nor a replay of yesterday
 *     made this morning wins over it.
 * The flag can't be the filter: rows saved before 2026-10-28 carry an
 * inverted is_backtest (today's live saves are true).
 *
 * pglite is real Postgres in WASM. Only the Neon driver is replaced:
 * getDb() gets a Neon-shaped tagged template over pglite. market_snapshots
 * comes from the real initDb(); index_candles_1m is a minimal fixture for
 * the divergence check's SPX side, which is not under test here.
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

import { _resetDb, initDb } from '../_lib/db.js';
import {
  computeVixSpxDivergence,
  formatVixDivergenceForClaude,
} from '../_lib/vix-divergence.js';
import { fetchLatestVix } from '../_lib/periscope-lottery-finder.js';

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await db.query(text, values)).rows;
  };
}

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await initDb();
  await pg.query(`
    CREATE TABLE index_candles_1m (
      symbol    TEXT NOT NULL,
      date      DATE NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      close     NUMERIC NOT NULL
    )
  `);
});

afterAll(async () => {
  await pg.close();
  _resetDb();
  process.env.DATABASE_URL = originalUrl;
});

beforeEach(async () => {
  await pg.query('TRUNCATE market_snapshots RESTART IDENTITY CASCADE');
  await pg.query('TRUNCATE index_candles_1m');
});

// 11:30 EDT on Tue 2026-03-10.
const NOW = new Date('2026-03-10T15:30:00.000Z');
const TODAY = '2026-03-10';
const PAST = '2026-02-02';

const minutesBefore = (d: Date, min: number) =>
  new Date(d.getTime() - min * 60_000);

/** Insert a market_snapshots row for `date` with VIX `vix`, created at `at`. */
async function snapshot(date: string, vix: number, at: Date): Promise<void> {
  await pg.query(
    `INSERT INTO market_snapshots (date, entry_time, vix, created_at)
     VALUES ($1, $2, $3, $4)`,
    [date, at.toISOString(), vix, at.toISOString()],
  );
}

async function spxBar(at: Date, close: number): Promise<void> {
  await pg.query(
    `INSERT INTO index_candles_1m (symbol, date, timestamp, close)
     VALUES ('SPX', $1, $2, $3)`,
    [TODAY, at.toISOString(), close],
  );
}

describe('computeVixSpxDivergence VIX side against Postgres (pglite)', () => {
  it('ignores a newer-created row for another date', async () => {
    await snapshot(TODAY, 20, minutesBefore(NOW, 6)); // prior window
    await snapshot(TODAY, 20.4, minutesBefore(NOW, 2)); // now window
    // Replays of a past date, saved later in each window.
    await snapshot(PAST, 10, minutesBefore(NOW, 5.5));
    await snapshot(PAST, 35, minutesBefore(NOW, 0.5));

    const result = await computeVixSpxDivergence(NOW);

    // 20.4 / 20 − 1, not 35 / 10 − 1.
    expect(result?.vixRet5m).toBeCloseTo(0.02, 10);
  });

  it("uses today's latest row in each window", async () => {
    await snapshot(TODAY, 18, minutesBefore(NOW, 9));
    await snapshot(TODAY, 19, minutesBefore(NOW, 6)); // latest ≤ now − 5 min
    await snapshot(TODAY, 19.5, minutesBefore(NOW, 3));
    await snapshot(TODAY, 19.95, minutesBefore(NOW, 1)); // latest ≤ now

    const result = await computeVixSpxDivergence(NOW);

    expect(result?.vixRet5m).toBeCloseTo(19.95 / 19 - 1, 10);
  });

  it('reports the VIX return as N/A, not 0, when only another date has rows', async () => {
    await snapshot(PAST, 30, minutesBefore(NOW, 6));
    await snapshot(PAST, 31, minutesBefore(NOW, 1));
    await spxBar(minutesBefore(NOW, 6), 6800);
    await spxBar(minutesBefore(NOW, 1), 6801);

    const result = await computeVixSpxDivergence(NOW);

    expect(result).not.toBeNull();
    expect(result!.vixRet5m).toBeNull();
    expect(result!.triggered).toBe(false);
    expect(formatVixDivergenceForClaude(result)).toContain(
      'VIX 5-min return: N/A',
    );
  });

  it('returns null, dropping the section, when neither side has data for today', async () => {
    await snapshot(PAST, 30, minutesBefore(NOW, 6));
    await snapshot(PAST, 31, minutesBefore(NOW, 1));

    expect(await computeVixSpxDivergence(NOW)).toBeNull();
  });
});

describe('fetchLatestVix against Postgres (pglite)', () => {
  const YESTERDAY = '2026-03-09';
  /** 14:55 and 15:55 EDT on 2026-03-09, yesterday's last live saves. */
  const yesterdayRows = async () => {
    await snapshot(YESTERDAY, 18.5, new Date('2026-03-09T18:55:00.000Z'));
    await snapshot(YESTERDAY, 19, new Date('2026-03-09T19:55:00.000Z'));
  };

  it('ignores a newer-created row for another date', async () => {
    await yesterdayRows();
    await snapshot(TODAY, 21.5, minutesBefore(NOW, 20));
    // A replay of an old date, created after yesterday's and today's rows.
    await snapshot(PAST, 33, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(21.5, 10);
  });

  it("uses the fire date's latest row at or before the fire time", async () => {
    await snapshot(TODAY, 20, minutesBefore(NOW, 30));
    await snapshot(TODAY, 21, minutesBefore(NOW, 2));
    await snapshot(TODAY, 25, minutesBefore(NOW, -3)); // after the fire

    expect(await fetchLatestVix(NOW)).toBeCloseTo(21, 10);
  });

  it("falls back to the last trading day's latest row when today has none", async () => {
    // Pre-market, or a day the app is never opened: no calculator row yet.
    await yesterdayRows();
    // A replay of an old date, created this morning after yesterday's rows,
    // must not stand in for yesterday's close.
    await snapshot(PAST, 33, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(19, 10);
  });

  it("prefers yesterday's own rows over a replay of yesterday created today", async () => {
    // Pre-market: today has no row yet, so yesterday stands in. A replay of
    // yesterday saved this morning carries a replayed VIX at some earlier
    // time; created_at alone would make it yesterday's "last" row.
    await yesterdayRows();
    await snapshot(YESTERDAY, 25, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(19, 10);
  });

  it('counts a late-evening save as created on its own ET date', async () => {
    // 23:30 EDT on 03-09 is 03:30Z on 03-10: the UTC date has rolled, the
    // ET date (the row's date) has not.
    await yesterdayRows();
    await snapshot(YESTERDAY, 19.5, new Date('2026-03-10T03:30:00.000Z'));
    await snapshot(YESTERDAY, 25, minutesBefore(NOW, 1)); // a replay

    expect(await fetchLatestVix(NOW)).toBeCloseTo(19.5, 10);
  });

  it('ranks the date before the tie-break: a replay of yesterday beats an older live row', async () => {
    // Yesterday has only a replay; 03-06 has its own live row. Yesterday's
    // VIX, even replayed, is the more recent one.
    await snapshot('2026-03-06', 17, new Date('2026-03-06T19:55:00.000Z'));
    await snapshot(YESTERDAY, 25, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(25, 10);
  });

  it('still takes the latest row when every row is a replay created later', async () => {
    // No row was created on its own date: the latest replay is all there is.
    await snapshot(YESTERDAY, 24, minutesBefore(NOW, 30));
    await snapshot(YESTERDAY, 25, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(25, 10);
  });

  it('ignores a future-dated row', async () => {
    await snapshot(TODAY, 21, minutesBefore(NOW, 10));
    // A tab left on a future date once saved live data under it.
    await snapshot('2026-03-12', 40, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeCloseTo(21, 10);
  });

  it('returns null when no row is on or before the fire date', async () => {
    await snapshot('2026-03-12', 40, minutesBefore(NOW, 1));

    expect(await fetchLatestVix(NOW)).toBeNull();
  });

  it("reads a past fire's own date first, as the fire backfill does", async () => {
    // scripts/backfill-periscope-lottery-fires.ts replays old fire times.
    const fire = new Date('2026-03-02T15:00:00.000Z');
    await snapshot('2026-03-02', 17.25, minutesBefore(fire, 5));
    await snapshot('2026-02-27', 26, minutesBefore(fire, 2)); // a replay
    await snapshot('2026-03-02', 30, new Date('2026-03-02T16:00:00.000Z')); // later

    expect(await fetchLatestVix(fire)).toBeCloseTo(17.25, 10);
  });

  it('keys on the ET date, not the UTC date, in the evening', async () => {
    // 21:30 EDT on 03-10 is 01:30Z on 03-11, so the UTC date is already
    // 03-11, a future date in ET.
    const fire = new Date('2026-03-11T01:30:00.000Z');
    await snapshot(TODAY, 22, new Date('2026-03-11T01:00:00.000Z'));
    await snapshot('2026-03-11', 41, new Date('2026-03-11T01:10:00.000Z'));

    expect(await fetchLatestVix(fire)).toBeCloseTo(22, 10);
  });
});
