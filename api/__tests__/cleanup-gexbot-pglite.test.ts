// @vitest-environment node

/**
 * REAL-SQL test for the cleanup-gexbot cutoff.
 *
 * cleanup-gexbot.test.ts scripts the dates row, so it cannot see whether the
 * SQL computes `newest_cutoff` correctly. This file runs the handler's ACTUAL
 * dates SELECT, `listUnarchivedDates` and DELETE against pglite (real
 * Postgres in WASM, with tzdata), on the tables built by the real migration
 * #156, with the session in UTC as on Neon.
 *
 * The after-close panels show each table's newest stored session until the
 * next open. On a Monday the Friday session has an audit row (archived
 * Saturday) and is older than yesterday, so the old cutoff
 * (`min(yesterday, gate)`) deleted it and Monday 06:15-08:30 CT showed
 * nothing. The newest-session bound is the ET date of `max(captured_at)`
 * minus one day, so the delete stops before the newest session's own day.
 *
 * Expected survivors are hard-coded instants, independent of the SQL.
 * Only the DB handle (a Neon-shaped wrapper over pglite) and cronGuard (which
 * supplies `today`) are replaced.
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

import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
  today: '',
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => neonOverPglite(holder.pg),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: () => ({ today: holder.today, apiKey: '' }),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

import handler from '../cron/cleanup-gexbot.js';
import { Sentry } from '../_lib/sentry.js';

type Table = 'gexbot_snapshots' | 'gexbot_api_capture';

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.pg = pg;
  await applyMigration(pg, 156);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.mocked(Sentry.captureException).mockClear();
  await pg.query(
    'TRUNCATE gexbot_snapshots, gexbot_api_capture, gexbot_archive_audit RESTART IDENTITY',
  );
});

async function seed(table: Table, instants: string[]): Promise<void> {
  // Each table has its own insert: an identifier is not a bind parameter.
  if (table === 'gexbot_snapshots') {
    await pg.query(
      `INSERT INTO gexbot_snapshots (captured_at, ticker, raw_response)
       SELECT t, 'SPX', '{}'::jsonb FROM unnest($1::timestamptz[]) AS t`,
      [instants],
    );
  } else {
    await pg.query(
      `INSERT INTO gexbot_api_capture
         (captured_at, ticker, endpoint, category, raw_response)
       SELECT t, 'SPX', 'state', 'gamma_zero', '{}'::jsonb
         FROM unnest($1::timestamptz[]) AS t`,
      [instants],
    );
  }
}

/** One audit row per (table, date): the day is archived. */
async function archive(table: Table, dates: string[]): Promise<void> {
  await pg.query(
    `INSERT INTO gexbot_archive_audit
       (table_name, archive_date, row_count, blob_url, blob_size_bytes, sha256)
     SELECT $1, d, 1, 'blob://x', 1, 'sha'
       FROM unnest($2::date[]) AS d`,
    [table, dates],
  );
}

async function survivors(table: Table): Promise<string[]> {
  const res =
    table === 'gexbot_snapshots'
      ? await pg.query<{ captured_at: Date }>(
          'SELECT captured_at FROM gexbot_snapshots ORDER BY captured_at',
        )
      : await pg.query<{ captured_at: Date }>(
          'SELECT captured_at FROM gexbot_api_capture ORDER BY captured_at',
        );
  return res.rows.map((r) => r.captured_at.toISOString());
}

async function sweep(today: string) {
  holder.today = today;
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET' }), res);
  return res;
}

describe('cleanup-gexbot against Postgres (pglite, UTC session)', () => {
  // Thursday 2026-11-19 and Friday 2026-11-20, 13:30-21:00 UTC sessions.
  const THURSDAY = ['2026-11-19T14:30:00.000Z', '2026-11-19T20:55:00.000Z'];
  const FRIDAY = ['2026-11-20T14:30:00.000Z', '2026-11-20T20:55:00.000Z'];

  it("Monday keeps Friday's rows and deletes Thursday's, in each table", async () => {
    for (const table of ['gexbot_snapshots', 'gexbot_api_capture'] as const) {
      await seed(table, [...THURSDAY, ...FRIDAY]);
      await archive(table, ['2026-11-19', '2026-11-20']);
    }

    const res = await sweep('2026-11-23');

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 4 });
    expect(await survivors('gexbot_snapshots')).toEqual(FRIDAY);
    expect(await survivors('gexbot_api_capture')).toEqual(FRIDAY);
    expect(Sentry.captureException).not.toHaveBeenCalled();

    // Idempotent: a second sweep finds nothing below the cutoff.
    const again = await sweep('2026-11-23');
    expect(again._json).toMatchObject({ status: 'success', rows: 0 });
    expect(await survivors('gexbot_snapshots')).toEqual(FRIDAY);
  });

  it("bounds each table by its own newest row, not the other table's", async () => {
    // Snapshots end Friday; captures stopped Thursday. Both archived.
    await seed('gexbot_snapshots', [...THURSDAY, ...FRIDAY]);
    await seed('gexbot_api_capture', THURSDAY);
    await archive('gexbot_snapshots', ['2026-11-19', '2026-11-20']);
    await archive('gexbot_api_capture', ['2026-11-19']);

    await sweep('2026-11-23');

    expect(await survivors('gexbot_snapshots')).toEqual(FRIDAY);
    expect(await survivors('gexbot_api_capture')).toEqual(THURSDAY);
  });

  it("uses the newest row's ET date, so a late evening row keeps its ET session", async () => {
    // 2026-11-21T01:30Z is Friday 20:30 ET. The UTC calendar date is the
    // 21st, but the ET session is the 20th: the bound must keep the 20th.
    const lateFriday = '2026-11-21T01:30:00.000Z';
    await seed('gexbot_snapshots', [...THURSDAY, ...FRIDAY, lateFriday]);
    await archive('gexbot_snapshots', [
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
    ]);

    await sweep('2026-11-23');

    expect(await survivors('gexbot_snapshots')).toEqual([
      ...FRIDAY,
      lateFriday,
    ]);
  });

  it('Tuesday removes Friday and keeps Monday, the newest session', async () => {
    // Monday's session is stored and archived, so Friday goes and Monday
    // stays (it is yesterday, which the old rule would also have deleted).
    const monday = ['2026-11-23T14:30:00.000Z', '2026-11-23T20:55:00.000Z'];
    await seed('gexbot_snapshots', [...FRIDAY, ...monday]);
    await archive('gexbot_snapshots', ['2026-11-20', '2026-11-23']);

    await sweep('2026-11-24');

    expect(await survivors('gexbot_snapshots')).toEqual(monday);
  });

  it('keeps an unarchived session even when it is not the newest', async () => {
    // The archive gate still wins when lower: Thursday has no audit row.
    await seed('gexbot_snapshots', [...THURSDAY, ...FRIDAY]);
    await archive('gexbot_snapshots', ['2026-11-20']);

    await sweep('2026-11-23');

    expect(await survivors('gexbot_snapshots')).toEqual([
      ...THURSDAY,
      ...FRIDAY,
    ]);
  });

  it('runs cleanly on empty tables', async () => {
    const res = await sweep('2026-11-23');

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
