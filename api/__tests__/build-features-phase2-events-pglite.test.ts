// @vitest-environment node

/**
 * REAL-SQL test for addEventFeatures' `days_to_next_event` query.
 *
 * build-features-phase2.test.ts mocks the DB, so it can only pass a number
 * through. The bug this guards was in the arithmetic itself: the old code
 * read a DATE back as a JS Date (UTC midnight) and subtracted noon ET, so a
 * next-day event came out as 0. The fix is `(MIN(date) - $1::date)` in SQL,
 * and only a real Postgres can say what that returns. This file runs
 * addEventFeatures' ACTUAL statements against pglite.
 *
 * economic_events is built from the real migration #11. That migration also
 * alters training_features, so a bare stub of it is created first.
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

import { applyMigration, neonOverPglite } from './pglite-migrations';

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

import { addEventFeatures } from '../_lib/build-features-phase2.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.query('CREATE TABLE training_features (date DATE PRIMARY KEY)');
  await applyMigration(pg, 11);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE economic_events RESTART IDENTITY');
});

async function insertEvents(
  rows: Array<[date: string, name: string, type: string]>,
): Promise<void> {
  for (const [date, name, type] of rows) {
    await pg.query(
      `INSERT INTO economic_events (date, event_name, event_type)
       VALUES ($1, $2, $3)`,
      [date, name, type],
    );
  }
}

async function eventFeatures(dateStr: string): Promise<FeatureRow> {
  const features: FeatureRow = {};
  await addEventFeatures(neonOverPglite(pg) as never, dateStr, features);
  return features;
}

describe('addEventFeatures real SQL', () => {
  it.each([
    ['the next calendar day', '2026-03-24', '2026-03-25', 1],
    ['Friday to Monday', '2026-03-27', '2026-03-30', 3],
    [
      'Friday to Monday across the spring DST change',
      '2026-03-06',
      '2026-03-09',
      3,
    ],
    ['across the fall DST change', '2026-10-30', '2026-11-03', 4],
    ['across a month and a year end', '2026-12-30', '2027-01-04', 5],
  ])('counts calendar days: %s', async (_label, today, next, gap) => {
    await insertEvents([[next, 'Some release', 'CPI']]);

    expect((await eventFeatures(today)).days_to_next_event).toBe(gap);
  });

  // A longer gap means calendar rows are missing, not a quiet calendar.
  it.each([
    ['10 days is kept', '2026-04-03', 10],
    ['11 days is unset', '2026-04-04', undefined],
  ])('gap rule on real dates: %s', async (_label, next, expected) => {
    await insertEvents([[next, 'Some release', 'CPI']]);

    expect((await eventFeatures('2026-03-24')).days_to_next_event).toBe(
      expected,
    );
  });

  it('measures to the earliest later date, not a later one', async () => {
    await insertEvents([
      ['2026-04-10', 'Far release', 'GDP'],
      ['2026-03-30', 'Near release', 'CPI'],
      ['2026-03-30', 'Same-day release', 'PCE'],
    ]);

    expect((await eventFeatures('2026-03-27')).days_to_next_event).toBe(3);
  });

  it('ignores events on the date itself and earlier', async () => {
    await insertEvents([
      ['2026-03-26', 'Yesterday', 'CPI'],
      ['2026-03-27', 'Today', 'PCE'],
    ]);

    expect((await eventFeatures('2026-03-27')).days_to_next_event).toBe(
      undefined,
    );
  });

  it('leaves days_to_next_event unset on an empty calendar', async () => {
    expect((await eventFeatures('2026-03-27')).days_to_next_event).toBe(
      undefined,
    );
  });

  it('reads the day rows and types them: FED rows on a plain day', async () => {
    await insertEvents([
      ['2026-03-24', 'Fed Chair speaks', 'FED'],
      ['2026-03-24', 'Richmond Fed manufacturing survey', 'PMI'],
    ]);

    const features = await eventFeatures('2026-03-24');

    expect(features).toMatchObject({
      is_fomc: false,
      event_type: 'FED',
      event_count: 2,
    });
  });

  it('flags a scheduled decision day with no rows', async () => {
    const features = await eventFeatures('2026-07-29');

    expect(features).toMatchObject({
      is_fomc: true,
      event_type: 'FOMC',
      event_count: 0,
    });
  });
});
