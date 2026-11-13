// @vitest-environment node

/**
 * REAL-SQL test for fetchEconomicCalendarContext's coverage query.
 *
 * analyze-context-fetchers.test.ts mocks the DB: it queues the coverage
 * row by hand, so it can say what the fetcher does with `has_before` and
 * `has_after` but not whether the SQL computes them over the right days.
 * The window arithmetic (`$1::date - 7 .. - 1`, `+ 1 .. + 7`) and the
 * EXISTS shape are the behavior, so this file runs the fetcher's ACTUAL
 * statements against pglite (real Postgres in WASM). economic_events is
 * built from the real migration #11, which also alters training_features,
 * so a bare stub of that table is created first.
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
  'Economic events for this date: UNKNOWN (the economic_events table has no rows around this date, so it does not cover it; do not assume there are none)';

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
    [-8, UNKNOWN],
    [-7, NONE],
    [-1, NONE],
  ] as const)(
    'a past date with a row %i days from it (and one 1 day after) is %s',
    async (offset, expected) => {
      await insertEventOn(addDays(DATE, offset));
      await insertEventOn(addDays(DATE, 1));
      expect(await fetchEconomicCalendarContext(DATE)).toBe(expected);
    },
  );

  it.each([
    [1, NONE],
    [7, NONE],
    [8, UNKNOWN],
    [30, UNKNOWN],
  ] as const)(
    'a past date with a row %i days after (and one 1 day before) is %s',
    async (offset, expected) => {
      await insertEventOn(addDays(DATE, -1));
      await insertEventOn(addDays(DATE, offset));
      expect(await fetchEconomicCalendarContext(DATE)).toBe(expected);
    },
  );

  it('says UNKNOWN for the first days of a gap: rows the week before, none after', async () => {
    // 2026-07-20 week has rows; nothing from 2026-07-27 to 2026-08-31.
    await insertEventOn('2026-07-20');
    await insertEventOn('2026-07-22');
    await insertEventOn('2026-09-02');
    expect(await fetchEconomicCalendarContext('2026-07-27')).toBe(UNKNOWN);
    expect(await fetchEconomicCalendarContext('2026-07-29')).toBe(UNKNOWN);
    expect(await fetchEconomicCalendarContext('2026-08-12')).toBe(UNKNOWN);
  });

  it('says "none" for a zero-row day inside a covered week', async () => {
    await insertEventOn('2026-07-20');
    await insertEventOn('2026-07-22');
    expect(await fetchEconomicCalendarContext('2026-07-21')).toBe(NONE);
  });

  it('says UNKNOWN for an empty table', async () => {
    expect(await fetchEconomicCalendarContext(DATE)).toBe(UNKNOWN);
  });

  it('waives the after side for today in ET, but still needs a row before', async () => {
    // 2026-11-13 03:00Z is 22:00 EST on 2026-11-12: ET today is 11-12.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T03:00:00.000Z'));
    await insertEventOn('2026-11-10');
    expect(await fetchEconomicCalendarContext('2026-11-12')).toBe(NONE);
    // The same row is 8 days before 2026-11-18, and that date is later than
    // today, so it still needs a row before it.
    expect(await fetchEconomicCalendarContext('2026-11-18')).toBe(UNKNOWN);
  });
});
