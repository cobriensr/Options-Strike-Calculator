// @vitest-environment node

/**
 * REAL-SQL test for the economic-event label backfill
 * (scripts/backfill-economic-event-labels.ts -> ./econ-label-backfill.ts).
 *
 * econ-label-backfill.test.ts covers the pure plan. This runs every read and
 * every UPDATE on pglite (Postgres in WASM), against the REAL schemas:
 * training_features (#9) and economic_events (#11) and ws_gamma_setup_fires
 * (#179) come from the production migrations. market_snapshots is created in
 * initDb, not a migration, so it is the same columns the backfill uses, with
 * the production types. Only the DB handle is replaced: getDb() returns a
 * neon-shaped client over pglite, and withDbRetry runs its callback once.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may
 * depend on the session time zone.
 *
 * The seed is a small production-shaped slice: speeches typed FOMC on days
 * the Fed is silent, the real decision typed OTHER, a budget release typed
 * FOMC, a decision day with no event rows, and both snapshot dates.
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

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations.js';

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  plannedWrites,
  runBackfill,
  writePlan,
} from './econ-label-backfill.js';

let db: PGlite;

type PgSql = ReturnType<typeof neonOverPglite>;
const pgSql = (): PgSql => holder.sql as PgSql;

beforeAll(async () => {
  db = await PGlite.create();
  await applyMigration(db, 9); // training_features
  await applyMigration(db, 11); // economic_events (+ the event columns)
  await applyMigration(db, 179); // ws_gamma_setup_fires
  // initDb's market_snapshots, trimmed to the columns the backfill reads and
  // writes (types as in api/_lib/db.ts).
  await db.query(`
    CREATE TABLE market_snapshots (
      id           SERIAL PRIMARY KEY,
      date         DATE NOT NULL,
      entry_time   TEXT NOT NULL,
      is_event_day BOOLEAN DEFAULT FALSE,
      event_names  TEXT[],
      UNIQUE (date, entry_time)
    )
  `);
  await db.query(`SET TIME ZONE 'America/Chicago'`);
  holder.sql = neonOverPglite(db);
});

afterAll(async () => {
  await db.close();
});

// ── Seed ────────────────────────────────────────────────────────────────────

async function seedEvent(
  date: string,
  name: string,
  time: string | null,
  type: string,
): Promise<void> {
  await db.query(
    `INSERT INTO economic_events (date, event_name, event_time, event_type)
     VALUES ($1::date, $2, $3::timestamptz, $4)`,
    [date, name, time, type],
  );
}

async function seedFeature(
  date: string,
  isFomc: boolean | null,
  eventType: string | null,
  daysToNext: number | null,
  eventCount: number,
  isEventDay: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO training_features
       (date, is_fomc, event_type, days_to_next_event, event_count, is_event_day)
     VALUES ($1::date, $2, $3, $4, $5, $6)`,
    [date, isFomc, eventType, daysToNext, eventCount, isEventDay],
  );
}

async function seedSnapshot(
  date: string,
  entryTime: string,
  names: string[] | null,
  isEventDay: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO market_snapshots (date, entry_time, event_names, is_event_day)
     VALUES ($1::date, $2, $3::text[], $4)`,
    [date, entryTime, names, isEventDay],
  );
}

let strike = 7000;
async function seedFire(firedAt: string, isFomcDay: boolean): Promise<void> {
  strike += 5; // UNIQUE (fired_at, signal_type, node_strike)
  await db.query(
    `INSERT INTO ws_gamma_setup_fires
       (fired_at, signal_type, dow_label, confidence_tier, spot_at_fire,
        node_strike, node_gex, bar_open, bar_high, bar_low, bar_close,
        bar_range, is_fomc_day)
     VALUES ($1::timestamptz, 'e1_long_call', 'Wed', 'HIGH', 7000, $2, 1, 1, 1,
             1, 1, 1, $3)`,
    [firedAt, strike, isFomcDay],
  );
}

async function seedAll(): Promise<void> {
  // economic_events, in id order 1..7.
  await seedEvent(
    '2026-05-06',
    'Fed speech: Fed governor Michelle Bowman',
    '2026-05-06T13:00:00Z',
    'FOMC',
  );
  // A NULL event_time never `=` itself, so the update must key on the id.
  await seedEvent('2026-05-06', 'Fed Beige Book', null, 'FOMC');
  await seedEvent(
    '2026-06-10',
    'Monthly U.S. federal budget',
    '2026-06-10T18:00:00Z',
    'FOMC',
  );
  await seedEvent(
    '2026-10-28',
    'U.S. interest rate decision',
    '2026-10-28T18:00:00Z',
    'OTHER',
  );
  await seedEvent(
    '2026-10-28',
    'Fed Chair Powell press conference',
    '2026-10-28T18:30:00Z',
    'FOMC',
  );
  await seedEvent(
    '2026-11-06',
    'Nonfarm payrolls',
    '2026-11-06T12:30:00Z',
    'JOBS',
  );
  await seedEvent(
    '2026-11-06',
    'Initial jobless claims',
    '2026-11-06T12:30:00Z',
    'OTHER',
  );
  // The first row in the table (id 8): earlier dates predate it.
  await seedEvent(
    '2026-03-25',
    'Initial jobless claims',
    '2026-03-25T12:30:00Z',
    'OTHER',
  );

  // training_features: (date, is_fomc, event_type, days_to_next, event_count,
  // is_event_day). event_count is 9, 8, ... so a rewrite would show.
  await seedFeature('2026-03-18', false, null, 6, 9, false); // decision day, before the table; old gap of 6 to 03-25
  await seedFeature('2026-03-24', false, null, 1, 10, false); // the day before the first event row: still before the table
  await seedFeature('2026-04-29', true, 'FOMC', 7, 8, false); // decision day, right but is_event_day false
  await seedFeature('2026-05-06', true, 'FOMC', null, 7, true); // the old wrong date
  await seedFeature('2026-06-10', true, 'FOMC', 126, 6, false); // budget typed FOMC
  await seedFeature('2026-07-29', false, null, null, 5, false); // decision day in the gap
  await seedFeature('2026-10-17', false, null, 4, 12, false); // 11 days to 10-28: a hole in the calendar
  await seedFeature('2026-10-18', false, null, 99, 13, false); // 10 days to 10-28: the largest plausible gap
  await seedFeature('2026-10-28', false, 'OTHER', 8, 4, false); // decision typed OTHER
  await seedFeature('2026-11-05', false, null, 1, 3, false); // already right
  await seedFeature('2026-11-06', false, 'JOBS', 0, 2, false); // last event day, old 0

  // market_snapshots.
  await seedSnapshot('2026-04-29', '09:00', null, false);
  await seedSnapshot('2026-04-29', '10:00', [], false);
  await seedSnapshot('2026-04-29', '11:00', ['GDP'], true); // already has a name
  await seedSnapshot('2026-05-06', '09:00', ['FOMC'], true);
  await seedSnapshot('2026-05-06', '10:00', ['FOMC'], true);
  await seedSnapshot('2026-05-06', '11:00', [], false); // nothing to remove
  await seedSnapshot('2026-05-06', '12:00', null, false); // nothing to remove
  await seedSnapshot('2026-05-07', '09:00', ['FOMC'], true); // another date

  // ws_gamma_setup_fires.
  await seedFire('2026-10-28T18:30:00Z', false); // 14:30 ET on a decision day
  await seedFire('2026-10-29T02:00:00Z', false); // 22:00 ET on 10-28: UTC date 10-29, ET date 10-28
  await seedFire('2026-10-28T03:00:00Z', false); // 23:00 ET on 10-27: UTC date 10-28, ET date 10-27
  await seedFire('2026-10-27T15:00:00Z', false); // not a decision day
  await seedFire('2026-07-29T15:00:00Z', true); // already true
  await seedFire('2026-10-29T01:00:00Z', false); // 21:00 ET on 10-28: UTC date 10-29, ET date 10-28
}

interface Dump {
  events: unknown[];
  features: unknown[];
  snapshots: unknown[];
  fires: unknown[];
}

async function dump(): Promise<Dump> {
  const q = async (text: string) => (await db.query(text)).rows;
  return {
    events: await q(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, event_name, event_type
         FROM economic_events ORDER BY id`,
    ),
    features: await q(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, is_fomc, event_type,
              days_to_next_event, event_count, is_event_day
         FROM training_features ORDER BY date`,
    ),
    snapshots: await q(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, entry_time,
              is_event_day, event_names
         FROM market_snapshots ORDER BY id`,
    ),
    fires: await q(
      `SELECT id::int AS id, to_char(fired_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI') AS fired_at, is_fomc_day
         FROM ws_gamma_setup_fires ORDER BY id`,
    ),
  };
}

beforeEach(async () => {
  await db.query(
    `TRUNCATE economic_events, training_features, market_snapshots,
              ws_gamma_setup_fires RESTART IDENTITY`,
  );
  strike = 7000;
  await seedAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const feature = (d: Dump, date: string) =>
  d.features.find((f) => (f as { date: string }).date === date);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('economic-event label backfill (pglite)', () => {
  it('a dry run reads the plan and writes nothing', async () => {
    const before = await dump();
    const transaction = vi.spyOn(pgSql(), 'transaction');

    const result = await runBackfill({ apply: false });

    expect(result.written).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(await dump()).toEqual(before);

    const { plan } = result;
    expect(plan.eventRows).toBe(8);
    expect(plan.eventChanges.map((c) => [c.id, c.from, c.to])).toEqual([
      [1, 'FOMC', 'FED'],
      [2, 'FOMC', 'FED'],
      [3, 'FOMC', 'OTHER'],
      [4, 'OTHER', 'FOMC'],
    ]);
    expect(plan.featureRows).toBe(11);
    expect(plan.featureChanges.map((c) => c.date)).toEqual([
      '2026-03-18',
      '2026-03-24',
      '2026-05-06',
      '2026-06-10',
      '2026-07-29',
      '2026-10-17',
      '2026-10-18',
      '2026-10-28',
      '2026-11-06',
    ]);
    // The two NULL rules, counted apart: 03-18 and 03-24 predate the table
    // (gaps of 7 and 1); 05-06, 06-10, 07-29 and 10-17 sit over a hole.
    expect(plan.firstEventDate).toBe('2026-03-25');
    expect(plan.featureRowsBeforeFirstEvent).toBe(2);
    expect(plan.featureRowsNulledByGap).toBe(4);
    expect(plan.isFomcBefore).toBe(3);
    expect(plan.isFomcAfter).toBe(4);
    expect(plan.snapshotsMissed).toEqual({ total: 3, matched: 2 });
    expect(plan.snapshotsWrong).toEqual({ total: 4, matched: 2 });
    expect(plan.featuresEventDayMissed).toEqual({ total: 1, matched: 1 });
    expect(plan.featuresEventDayWrong).toEqual({ total: 1, matched: 1 });
    expect(plan.fires).toEqual({ total: 6, matched: 3 });
  });

  it('--apply writes the corrected values and nothing else', async () => {
    const before = await dump();

    const result = await runBackfill({ apply: true });

    // The dry-run numbers are what the transaction then writes.
    expect(result.written).toEqual(plannedWrites(result.plan));
    expect(result.written).toEqual({
      economic_events: 4,
      training_features: 9,
      market_snapshots_missed: 2,
      market_snapshots_wrong: 2,
      training_features_event_day_missed: 1,
      training_features_event_day_wrong: 1,
      ws_gamma_setup_fires: 3,
    });

    const after = await dump();

    // 1. economic_events: only event_type changes, the NULL-time row too.
    expect(after.events).toEqual([
      { ...(before.events[0] as object), event_type: 'FED' },
      { ...(before.events[1] as object), event_type: 'FED' },
      { ...(before.events[2] as object), event_type: 'OTHER' },
      { ...(before.events[3] as object), event_type: 'FOMC' },
      before.events[4],
      before.events[5],
      before.events[6],
      before.events[7],
    ]);

    // 2. training_features: exact integers, and event_count is untouched.
    // days_to_next_event is NULL where the value would come from missing
    // data: before the first event row (03-25), or more than 10 days to the
    // next one.
    expect(after.features).toEqual([
      // Decision day before the table: FOMC from the schedule. The gap to
      // 03-25 is 7, but the table did not exist yet: NULL (old value 6).
      {
        date: '2026-03-18',
        is_fomc: true,
        event_type: 'FOMC',
        days_to_next_event: null,
        event_count: 9,
        is_event_day: false,
      },
      // One day before the first event row: still before the table.
      {
        date: '2026-03-24',
        is_fomc: false,
        event_type: null,
        days_to_next_event: null,
        event_count: 10,
        is_event_day: false,
      },
      // Already right in step 2 (7 days to 05-06); step 3 sets is_event_day.
      {
        date: '2026-04-29',
        is_fomc: true,
        event_type: 'FOMC',
        days_to_next_event: 7,
        event_count: 8,
        is_event_day: true,
      },
      // The speech day: not FOMC any more. 35 days to 06-10 is a hole in the
      // calendar: NULL. Step 4 clears is_event_day (no names are left on the
      // snapshots).
      {
        date: '2026-05-06',
        is_fomc: false,
        event_type: 'FED',
        days_to_next_event: null,
        event_count: 7,
        is_event_day: false,
      },
      // 140 days to 10-28: NULL (old value 126).
      {
        date: '2026-06-10',
        is_fomc: false,
        event_type: 'OTHER',
        days_to_next_event: null,
        event_count: 6,
        is_event_day: false,
      },
      // The decision day with no event rows; 91 days to 10-28: NULL.
      {
        date: '2026-07-29',
        is_fomc: true,
        event_type: 'FOMC',
        days_to_next_event: null,
        event_count: 5,
        is_event_day: false,
      },
      // 11 days to 10-28: one past the limit, NULL (old value 4).
      {
        date: '2026-10-17',
        is_fomc: false,
        event_type: null,
        days_to_next_event: null,
        event_count: 12,
        is_event_day: false,
      },
      // 10 days to 10-28: the largest plausible gap, kept (old value 99).
      {
        date: '2026-10-18',
        is_fomc: false,
        event_type: null,
        days_to_next_event: 10,
        event_count: 13,
        is_event_day: false,
      },
      {
        date: '2026-10-28',
        is_fomc: true,
        event_type: 'FOMC',
        days_to_next_event: 9,
        event_count: 4,
        is_event_day: false,
      },
      // Untouched: it was already right.
      {
        date: '2026-11-05',
        is_fomc: false,
        event_type: null,
        days_to_next_event: 1,
        event_count: 3,
        is_event_day: false,
      },
      // No later event: NULL, not the old 0.
      {
        date: '2026-11-06',
        is_fomc: false,
        event_type: 'JOBS',
        days_to_next_event: null,
        event_count: 2,
        is_event_day: false,
      },
    ]);

    // 3 and 4. market_snapshots.
    expect(after.snapshots).toEqual([
      // 04-29: no names gain FOMC; one that already has a name is left alone.
      {
        id: 1,
        date: '2026-04-29',
        entry_time: '09:00',
        is_event_day: true,
        event_names: ['FOMC'],
      },
      {
        id: 2,
        date: '2026-04-29',
        entry_time: '10:00',
        is_event_day: true,
        event_names: ['FOMC'],
      },
      before.snapshots[2],
      // 05-06: FOMC leaves, is_event_day follows what is left (nothing).
      {
        id: 4,
        date: '2026-05-06',
        entry_time: '09:00',
        is_event_day: false,
        event_names: [],
      },
      {
        id: 5,
        date: '2026-05-06',
        entry_time: '10:00',
        is_event_day: false,
        event_names: [],
      },
      before.snapshots[5],
      before.snapshots[6],
      // Another date is never touched.
      before.snapshots[7],
    ]);

    // 5. Fires: the ET date decides, not the UTC date.
    expect(after.fires).toEqual([
      { id: 1, fired_at: '2026-10-28T18:30', is_fomc_day: true },
      { id: 2, fired_at: '2026-10-29T02:00', is_fomc_day: true },
      { id: 3, fired_at: '2026-10-28T03:00', is_fomc_day: false },
      { id: 4, fired_at: '2026-10-27T15:00', is_fomc_day: false },
      { id: 5, fired_at: '2026-07-29T15:00', is_fomc_day: true },
      { id: 6, fired_at: '2026-10-29T01:00', is_fomc_day: true },
    ]);
  });

  it('a second --apply changes zero rows and opens no transaction', async () => {
    await runBackfill({ apply: true });
    const settled = await dump();
    const transaction = vi.spyOn(pgSql(), 'transaction');

    const second = await runBackfill({ apply: true });

    expect(second.written).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(plannedWrites(second.plan)).toEqual({
      economic_events: 0,
      training_features: 0,
      market_snapshots_missed: 0,
      market_snapshots_wrong: 0,
      training_features_event_day_missed: 0,
      training_features_event_day_wrong: 0,
      ws_gamma_setup_fires: 0,
    });
    expect(await dump()).toEqual(settled);
  });

  it('the guards make a replayed plan write zero rows', async () => {
    // The short-circuit above never reaches the SQL. Replay the FIRST plan
    // (stale by now) against the settled tables: every UPDATE must match
    // nothing, whatever the plan says.
    const first = await runBackfill({ apply: false });
    await runBackfill({ apply: true });
    const settled = await dump();

    const replay = await writePlan(pgSql() as never, first.plan);

    expect(replay).toEqual({
      economic_events: 0,
      training_features: 0,
      market_snapshots_missed: 0,
      market_snapshots_wrong: 0,
      training_features_event_day_missed: 0,
      training_features_event_day_wrong: 0,
      ws_gamma_setup_fires: 0,
    });
    expect(await dump()).toEqual(settled);
  });

  it('a failure mid-transaction rolls back every table', async () => {
    const before = await dump();
    const sql = pgSql();
    const real = sql.transaction;
    // After every real UPDATE has run, inside the same transaction.
    sql.transaction = (queries) => real([...queries, sql`SELECT 1 / 0`]);

    try {
      await expect(runBackfill({ apply: true })).rejects.toThrow(
        /division by zero/,
      );
    } finally {
      sql.transaction = real;
    }

    expect(await dump()).toEqual(before);
    // The failure left nothing half-done: the next apply still finds it all.
    const retry = await runBackfill({ apply: true });
    expect(retry.written?.economic_events).toBe(4);
  });

  it('a failing read rejects before any write', async () => {
    const before = await dump();
    const transaction = vi.spyOn(pgSql(), 'transaction');
    await db.query('ALTER TABLE training_features RENAME TO tf_renamed');
    try {
      await expect(runBackfill({ apply: true })).rejects.toThrow(
        /training_features/,
      );
    } finally {
      await db.query('ALTER TABLE tf_renamed RENAME TO training_features');
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(await dump()).toEqual(before);
  });

  it('removes only FOMC from a snapshot that also names another event', async () => {
    await db.query(`DELETE FROM market_snapshots WHERE date = '2026-05-06'`);
    await seedSnapshot('2026-05-06', '09:00', ['FOMC', 'CPI'], true);
    await seedSnapshot('2026-05-06', '10:00', ['FOMC'], true);

    await runBackfill({ apply: true });

    const names = (await dump()).snapshots.filter(
      (s) => (s as { date: string }).date === '2026-05-06',
    );
    expect(names).toMatchObject([
      { entry_time: '09:00', event_names: ['CPI'], is_event_day: true },
      { entry_time: '10:00', event_names: [], is_event_day: false },
    ]);
    // A name is left on the day, so the feature row stays an event day.
    expect(feature(await dump(), '2026-05-06')).toMatchObject({
      is_event_day: true,
    });
  });

  it('writes more than one chunk when more rows change than WRITE_CHUNK', async () => {
    // 1,203 FOMC-typed budget rows on distinct days: 3 chunks of at most 500.
    await db.query(
      `INSERT INTO economic_events (date, event_name, event_time, event_type)
       SELECT DATE '2025-01-01' + g, 'Monthly U.S. federal budget',
              (DATE '2025-01-01' + g)::timestamptz, 'FOMC'
         FROM generate_series(0, 1202) AS g`,
    );

    const result = await runBackfill({ apply: true });

    // The 4 seed rows that change, plus the 1,203.
    expect(result.written?.economic_events).toBe(1207);
    const left = await db.query(
      `SELECT count(*)::int AS n FROM economic_events
        WHERE event_name = 'Monthly U.S. federal budget'
          AND event_type <> 'OTHER'`,
    );
    expect(left.rows).toEqual([{ n: 0 }]);
  });
});
