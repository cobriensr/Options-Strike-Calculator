// @vitest-environment node

/**
 * REAL-SQL test for the fill-only outcomes insert and the backfill that
 * uses it.
 *
 * `saveOutcome` is `ON CONFLICT (date) DO UPDATE` over every column. The
 * `?backfill=true` run of fetch-outcomes used it for each completed daily
 * candle of the last ~62 days, so one run overwrote every stored day in
 * that window and set `vix1d_close` to NULL on each (the daily bars carry
 * no VIX1D). Whether an existing row survives is a property of the SQL, so
 * this runs on pglite (Postgres in WASM), on the `outcomes` table the real
 * `initDb()` builds, instead of matching SQL text.
 *
 * Only the Neon driver is replaced: `getDb()` gets a Neon-shaped tagged
 * template over pglite, so `initDb`, `withDbRetry`, `insertOutcomeIfMissing`
 * and the backfill handler all run as in production. Schwab and Redis are
 * mocked at their modules.
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
import { mockRequest, mockResponse } from './helpers';

const holder = vi.hoisted(() => ({ sql: null as unknown }));
const mockRedisGet = vi.hoisted(() => vi.fn());

vi.mock('@neondatabase/serverless', () => ({ neon: () => holder.sql }));

vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    schwabFetch: vi.fn(),
    // Passthrough, so a retry never waits on a timer.
    withRetry: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../_lib/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/redis.js')>();
  return { ...actual, redis: { get: mockRedisGet } };
});

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  _resetDb,
  initDb,
  insertOutcomeIfMissing,
  saveOutcome,
} from '../_lib/db.js';
import { schwabFetch } from '../_lib/api-helpers.js';
import handler from '../cron/fetch-outcomes.js';

const mockedSchwabFetch = schwabFetch as ReturnType<typeof vi.fn>;

let pg: PGlite;
const originalUrl = process.env.DATABASE_URL;
const originalSecret = process.env.CRON_SECRET;

/** Every statement text the code under test sent to the database. */
const executed: string[] = [];

/** Neon-shaped tagged template over pglite: resolves to the rows. */
function taggedSql(db: PGlite) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    executed.push(text);
    return (await db.query(text, values)).rows;
  };
}

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = taggedSql(pg);
  process.env.DATABASE_URL = 'postgres://pglite';
  _resetDb();
  await initDb();
});

afterAll(async () => {
  await pg.close();
  _resetDb();
  process.env.DATABASE_URL = originalUrl;
  process.env.CRON_SECRET = originalSecret;
});

beforeEach(async () => {
  await pg.query('TRUNCATE outcomes RESTART IDENTITY');
  executed.length = 0;
  mockRedisGet.mockReset();
  mockedSchwabFetch.mockReset();
});

interface StoredOutcome {
  date: string;
  settlement: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  day_range_pts: number | null;
  day_range_pct: number | null;
  close_vs_open: number | null;
  vix_close: number | null;
  vix1d_close: number | null;
}

/** The stored row for `date`, NUMERIC columns read as numbers. */
async function stored(date: string): Promise<StoredOutcome | undefined> {
  const res = await pg.query<StoredOutcome>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            settlement::float8 AS settlement,
            day_open::float8 AS day_open,
            day_high::float8 AS day_high,
            day_low::float8 AS day_low,
            day_range_pts,
            day_range_pct::float8 AS day_range_pct,
            close_vs_open::float8 AS close_vs_open,
            vix_close::float8 AS vix_close,
            vix1d_close::float8 AS vix1d_close
       FROM outcomes WHERE date = $1`,
    [date],
  );
  return res.rows[0];
}

async function outcomeCount(): Promise<number> {
  const res = await pg.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM outcomes',
  );
  return res.rows[0]!.n;
}

/** A day already stored, with values no Schwab daily bar below matches. */
const STORED_DAY = {
  date: '2026-03-20',
  settlement: 5641.25,
  day_open: 5601,
  day_high: 5651,
  day_low: 5581,
  day_range_pts: 70,
  day_range_pct: 0.0125,
  close_vs_open: 40.25,
  vix_close: 18.4,
  vix1d_close: 14.8,
};

async function seedStoredDay(): Promise<void> {
  await pg.query(
    `INSERT INTO outcomes (date, settlement, day_open, day_high, day_low,
        day_range_pts, day_range_pct, close_vs_open, vix_close, vix1d_close)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    Object.values(STORED_DAY),
  );
}

describe('insertOutcomeIfMissing (pglite)', () => {
  const INPUT = {
    date: '2026-03-10',
    settlement: 5510,
    dayOpen: 5500,
    dayHigh: 5530,
    dayLow: 5480,
    vixClose: 17.5,
    vix1dClose: 14.8,
  };

  it('inserts a new date, returns true and stores the derived columns', async () => {
    expect(await insertOutcomeIfMissing(INPUT)).toBe(true);

    const row = await stored('2026-03-10');
    expect(row).toMatchObject({
      date: '2026-03-10',
      settlement: 5510,
      day_open: 5500,
      day_high: 5530,
      day_low: 5480,
      day_range_pts: 50,
      close_vs_open: 10,
      vix_close: 17.5,
      vix1d_close: 14.8,
    });
    expect(row!.day_range_pct).toBeCloseTo(50 / 5500, 4);
  });

  it('stores NULL day_range_pct when dayOpen is 0 (same derivation as saveOutcome)', async () => {
    await insertOutcomeIfMissing({ ...INPUT, dayOpen: 0 });
    await saveOutcome({ ...INPUT, date: '2026-03-11', dayOpen: 0 });

    const inserted = await stored('2026-03-10');
    const saved = await stored('2026-03-11');
    expect(inserted!.day_range_pct).toBeNull();
    expect(saved!.day_range_pct).toBeNull();
    expect(inserted!.close_vs_open).toBe(saved!.close_vs_open);
    expect(inserted!.day_range_pts).toBe(saved!.day_range_pts);
  });

  it('leaves an existing date untouched, vix1d_close included, and returns false', async () => {
    await seedStoredDay();

    const inserted = await insertOutcomeIfMissing({
      date: STORED_DAY.date,
      settlement: 1,
      dayOpen: 2,
      dayHigh: 3,
      dayLow: 0.5,
      vixClose: 99,
      vix1dClose: undefined,
    });

    expect(inserted).toBe(false);
    expect(await stored(STORED_DAY.date)).toEqual(STORED_DAY);
    expect(await outcomeCount()).toBe(1);
  });

  it('saveOutcome still overwrites an existing date, which the main run relies on', async () => {
    await seedStoredDay();

    await saveOutcome({
      date: STORED_DAY.date,
      settlement: 5700,
      dayOpen: 5690,
      dayHigh: 5710,
      dayLow: 5680,
      vixClose: 19,
    });

    expect(await stored(STORED_DAY.date)).toMatchObject({
      settlement: 5700,
      vix_close: 19,
      vix1d_close: null,
    });
  });

  it('rejects on a database error instead of reporting the day as present', async () => {
    await expect(
      insertOutcomeIfMissing({ ...INPUT, date: 'not-a-date' }),
    ).rejects.toThrow(/invalid input syntax for type date/);
  });

  it('sends the DO NOTHING insert and never a DO UPDATE', async () => {
    await insertOutcomeIfMissing(INPUT);

    const insert = executed.find((t) => t.includes('INTO outcomes'));
    expect(insert).toContain('ON CONFLICT (date) DO NOTHING');
    expect(insert).toContain('RETURNING date');
    expect(insert).not.toContain('DO UPDATE');
  });
});

describe('fetch-outcomes backfill against Postgres (pglite)', () => {
  // Tuesday 2026-03-24, 5:00 PM ET. Today's daily bar is not completed, so
  // the backfill skips it.
  const NOW = new Date('2026-03-24T21:00:00.000Z');

  function dailyCandle(date: string, open: number, close: number) {
    return {
      open,
      high: Math.max(open, close) + 10,
      low: Math.min(open, close) - 10,
      close,
      volume: 1000,
      datetime: new Date(`${date}T05:00:00.000Z`).getTime(),
    };
  }

  /** Schwab: SPX daily bars for 03-20..03-23 plus today's, then VIX bars. */
  function mockSchwabDailyHistory(): void {
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        candles: [
          dailyCandle('2026-03-20', 5600, 5640),
          dailyCandle('2026-03-21', 5640, 5690),
          dailyCandle('2026-03-22', 5690, 5700),
          dailyCandle('2026-03-23', 5700, 5725),
          dailyCandle('2026-03-24', 5725, 5740),
        ],
        symbol: '$SPX',
        empty: false,
      },
    });
    mockedSchwabFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        candles: [
          dailyCandle('2026-03-20', 17, 18),
          dailyCandle('2026-03-21', 18, 19),
          dailyCandle('2026-03-22', 19, 20),
          dailyCandle('2026-03-23', 20, 21),
        ],
        symbol: '$VIX',
        empty: false,
      },
    });
  }

  const VIX1D_MAP = {
    '2026-03-20': { o: 14, h: 16, l: 13, c: 15.1 },
    '2026-03-21': { o: 15, h: 16, l: 14, c: 15.2 },
    '2026-03-22': { o: 15, h: 17, l: 14, c: 15.3 },
    '2026-03-23': { o: 15, h: 18, l: 14, c: 15.4 },
  };

  async function runBackfill() {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { backfill: 'true' },
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    return res;
  }

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills the missing days and leaves the stored day exactly as it was', async () => {
    await seedStoredDay();
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(VIX1D_MAP);

    const res = await runBackfill();

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      backfill: true,
      status: 'success',
      saved: 3,
      present: 1,
      skipped: 0,
      insertedDates: ['2026-03-21', '2026-03-22', '2026-03-23'],
      vix1dMissingDates: [],
    });
    // The stored day keeps its settlement, VIX and, above all, vix1d_close.
    expect(await stored('2026-03-20')).toEqual(STORED_DAY);
    // A missing day is inserted from the daily bar, VIX1D from the CBOE map.
    expect(await stored('2026-03-21')).toMatchObject({
      settlement: 5690,
      day_open: 5640,
      vix_close: 19,
      vix1d_close: 15.2,
    });
    expect(await stored('2026-03-23')).toMatchObject({
      settlement: 5725,
      vix1d_close: 15.4,
    });
    // Today's bar is not a completed day.
    expect(await stored('2026-03-24')).toBeUndefined();
    expect(await outcomeCount()).toBe(4);
  });

  it('never sends a DO UPDATE to the outcomes table', async () => {
    await seedStoredDay();
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(VIX1D_MAP);

    await runBackfill();

    const writes = executed.filter((t) => t.includes('INTO outcomes'));
    // initDb ran before `executed` was cleared, so these are the backfill's.
    expect(writes).toHaveLength(4);
    for (const text of writes) {
      expect(text).toContain('ON CONFLICT (date) DO NOTHING');
      expect(text).not.toContain('DO UPDATE');
    }
  });

  it('a second run changes nothing and reports every day as present', async () => {
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(VIX1D_MAP);
    await runBackfill();
    const afterFirst = await Promise.all(
      Object.keys(VIX1D_MAP).map((d) => stored(d)),
    );

    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(VIX1D_MAP);
    const res = await runBackfill();

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      backfill: true,
      status: 'success',
      saved: 0,
      present: 4,
      skipped: 0,
      insertedDates: [],
      vix1dMissingDates: [],
    });
    expect(
      await Promise.all(Object.keys(VIX1D_MAP).map((d) => stored(d))),
    ).toEqual(afterFirst);
  });

  it('stores NULL for a day the map has no close for, names it, and a re-run cannot repair it', async () => {
    const mapWithGap = Object.fromEntries(
      Object.entries(VIX1D_MAP).filter(([date]) => date !== '2026-03-22'),
    );
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(mapWithGap);

    const first = await runBackfill();

    expect(first._json).toMatchObject({
      saved: 4,
      insertedDates: ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23'],
      vix1dMissingDates: ['2026-03-22'],
    });
    expect((await stored('2026-03-22'))!.vix1d_close).toBeNull();
    expect((await stored('2026-03-21'))!.vix1d_close).toBe(15.2);

    // The map gets the close later; the day is stored, so DO NOTHING keeps
    // its NULL. That is why the first run's response names it.
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(VIX1D_MAP);
    const second = await runBackfill();

    expect(second._json).toMatchObject({
      saved: 0,
      present: 4,
      insertedDates: [],
      vix1dMissingDates: [],
    });
    expect((await stored('2026-03-22'))!.vix1d_close).toBeNull();
  });

  it('with no VIX1D map it still fills the gaps (NULL vix1d_close) and keeps the stored day', async () => {
    await seedStoredDay();
    mockSchwabDailyHistory();
    mockRedisGet.mockResolvedValueOnce(null);

    const res = await runBackfill();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      saved: 3,
      present: 1,
      skipped: 0,
      insertedDates: ['2026-03-21', '2026-03-22', '2026-03-23'],
      // No map: every inserted day is stored without a VIX1D close.
      vix1dMissingDates: ['2026-03-21', '2026-03-22', '2026-03-23'],
    });
    expect((await stored('2026-03-21'))!.vix1d_close).toBeNull();
    expect(await stored('2026-03-20')).toEqual(STORED_DAY);
  });
});
