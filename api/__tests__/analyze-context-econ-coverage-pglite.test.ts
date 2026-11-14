// @vitest-environment node

/**
 * REAL-SQL test for fetchEconomicCalendarContext's coverage query.
 *
 * analyze-context-fetchers.test.ts mocks the DB: it queues the `prev` / `next`
 * row by hand, so it can say what the fetcher does with those two dates but
 * not whether the SQL finds the right ones. "The latest row before the date"
 * and "the earliest row after it" (strict `<` and `>`, the day itself
 * excluded, a NULL when a side has no row) are the behavior, so this file runs
 * the fetcher's ACTUAL statements against pglite (real Postgres in WASM).
 * economic_events is built from the real migration #11, which also alters
 * training_features, so a bare stub of that table is created first.
 *
 * The clock is pinned (Date only) at 22:00 ET on 2026-11-12, so "today",
 * "a later date" and "after today's fetch window" are fixed.
 *
 * Only the DB handle is replaced (the fetcher's other imports load for
 * real; their DB reads are never called here).
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

const holder = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => neonOverPglite(holder.pg),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// The fetcher imports uwFetch and schwabFetch from the barrel, which loads
// the Redis client; neither is called here.
vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  schwabFetch: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

import { fetchEconomicCalendarContext } from '../_lib/analyze-context-fetchers.js';

const NONE = 'No scheduled economic events today.';
const UNKNOWN =
  'Economic events for this date: UNKNOWN (the economic_events table does not cover this date; do not assume there are none; the Scheduled events line may still list events)';
const NOT_STORED_YET =
  "Economic events for this date: UNKNOWN (today's calendar is fetched at about 9:30 ET and has not been stored yet; do not assume there are none; the Scheduled events line may still list events)";
// Short it.each labels, mapped to the sentences above.
const VERDICT = { none: NONE, UNKNOWN } as const;

// 2026-11-13 03:00Z is 22:00 EST on 2026-11-12: ET today is 2026-11-12, the
// UTC date is a day later, and the 9:30 ET fetch window is long over.
const NIGHT = new Date('2026-11-13T03:00:00.000Z');
const ET_TODAY = '2026-11-12';

beforeAll(async () => {
  holder.pg = await PGlite.create();
  await holder.pg.query(
    'CREATE TABLE training_features (date DATE PRIMARY KEY)',
  );
  await applyMigration(holder.pg, 11);
}, 60_000);

afterAll(async () => {
  await holder.pg.close();
});

beforeEach(async () => {
  await holder.pg.query('TRUNCATE economic_events RESTART IDENTITY');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NIGHT);
});

afterEach(() => {
  vi.useRealTimers();
});

/** `date` shifted by `days` calendar days (UTC arithmetic on a plain date). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function insertEventOn(date: string): Promise<void> {
  await holder.pg.query(
    `INSERT INTO economic_events (date, event_name, event_type, event_time)
     VALUES ($1, $2, 'CPI', $3)`,
    [date, `event ${date}`, `${date}T12:30:00Z`],
  );
}

describe('fetchEconomicCalendarContext — coverage over real SQL', () => {
  const DATE = '2026-08-12';

  it('returns the formatted block, not a coverage verdict, when the date has rows', async () => {
    await insertEventOn(DATE);
    const result = await fetchEconomicCalendarContext(DATE);
    expect(result).toContain(`event ${DATE}`);
    expect(result).not.toBe(NONE);
    expect(result).not.toBe(UNKNOWN);
  });

  it.each([
    // [days before, days after, verdict]: the gap between the neighbours is
    // the sum, and 10 is the most that still counts as covered.
    [5, 5, 'none'],
    [1, 9, 'none'],
    [9, 1, 'none'],
    [1, 1, 'none'],
    [5, 6, 'UNKNOWN'],
    [10, 1, 'UNKNOWN'],
    [1, 10, 'UNKNOWN'],
    // A 13-day hole: both neighbours are within 7 days, so the +-7-day
    // windows this replaced read it as covered.
    [6, 7, 'UNKNOWN'],
  ] as const)(
    'a past date with its neighbouring rows %i days before and %i days after is %s',
    async (before, after, verdict) => {
      await insertEventOn(addDays(DATE, -before));
      await insertEventOn(addDays(DATE, after));
      expect(await fetchEconomicCalendarContext(DATE)).toBe(VERDICT[verdict]);
    },
  );

  it('uses the nearest neighbours, not the table edges', async () => {
    // Rows far out on both sides must not widen the gap the date sits in.
    await insertEventOn('2026-06-01');
    await insertEventOn('2026-08-10');
    await insertEventOn('2026-08-14');
    await insertEventOn('2026-10-01');
    expect(await fetchEconomicCalendarContext(DATE)).toBe(NONE);
  });

  it('says UNKNOWN across the 2026-07-21 to 09-08 hole, at its start, middle and end', async () => {
    await insertEventOn('2026-07-20');
    await insertEventOn('2026-07-21');
    await insertEventOn('2026-09-08');
    await insertEventOn('2026-09-09');
    expect(await fetchEconomicCalendarContext('2026-07-22')).toBe(UNKNOWN);
    expect(await fetchEconomicCalendarContext('2026-08-12')).toBe(UNKNOWN);
    expect(await fetchEconomicCalendarContext('2026-09-07')).toBe(UNKNOWN);
  });

  it('says "none" for a zero-row day inside a covered week', async () => {
    await insertEventOn('2026-07-20');
    await insertEventOn('2026-07-22');
    expect(await fetchEconomicCalendarContext('2026-07-21')).toBe(NONE);
  });

  it('says UNKNOWN for a date before the first row, however close the first row is', async () => {
    await insertEventOn('2026-08-13');
    await insertEventOn('2026-08-14');
    expect(await fetchEconomicCalendarContext(DATE)).toBe(UNKNOWN);
  });

  it('says UNKNOWN for a past date after the last row, however close the last row is', async () => {
    await insertEventOn('2026-08-10');
    await insertEventOn('2026-08-11');
    expect(await fetchEconomicCalendarContext(DATE)).toBe(UNKNOWN);
  });

  it.each([
    ['a past date', DATE],
    ['today', ET_TODAY],
    ['a later date', '2026-11-16'],
  ] as const)(
    'says UNKNOWN for %s when the table is empty',
    async (_l, date) => {
      expect(await fetchEconomicCalendarContext(date)).toBe(UNKNOWN);
    },
  );

  it.each([
    // The ET date, not the UTC date: 2026-11-13 is today in UTC only.
    ['2026-11-13'],
    ['2026-11-16'],
    ['2027-01-04'],
  ])(
    'says UNKNOWN for the later date %s, with rows right before it',
    async (date) => {
      await insertEventOn('2026-11-10');
      await insertEventOn(ET_TODAY);
      expect(await fetchEconomicCalendarContext(date)).toBe(UNKNOWN);
    },
  );

  it('says UNKNOWN for a later date even when rows sit on both sides of it', async () => {
    // The cron stores only today's events, so rows after today mean a manual
    // load. Neighbours 6 days apart would pass the gap rule for a past date;
    // a later date is still unknown.
    await insertEventOn(ET_TODAY);
    await insertEventOn('2026-11-18');
    expect(await fetchEconomicCalendarContext('2026-11-15')).toBe(UNKNOWN);
  });

  describe('today', () => {
    it.each([
      // [days back to its latest earlier row, verdict]
      [1, 'none'],
      [3, 'none'],
      [10, 'none'],
      [11, 'UNKNOWN'],
      [40, 'UNKNOWN'],
    ] as const)(
      'after the fetch window, with its latest earlier row %i days back, is %s',
      async (daysBack, verdict) => {
        await insertEventOn(addDays(ET_TODAY, -daysBack));
        expect(await fetchEconomicCalendarContext(ET_TODAY)).toBe(
          VERDICT[verdict],
        );
      },
    );

    it('says the calendar is not stored yet before the fetch window is over', async () => {
      // 08:00 EST on 2026-11-12, with rows from the day before.
      vi.setSystemTime(new Date('2026-11-12T13:00:00.000Z'));
      await insertEventOn('2026-11-11');
      expect(await fetchEconomicCalendarContext(ET_TODAY)).toBe(NOT_STORED_YET);
    });
  });
});
