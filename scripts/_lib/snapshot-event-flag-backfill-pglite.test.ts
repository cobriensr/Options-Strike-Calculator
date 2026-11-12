// @vitest-environment node

/**
 * REAL-SQL test for the snapshot event-flag backfill
 * (scripts/backfill-snapshot-event-flags.ts ->
 * ./snapshot-event-flag-backfill.ts).
 *
 * snapshot-event-flag-backfill.test.ts covers the pure plan. This runs every
 * read and write on pglite (Postgres in WASM): training_features comes from
 * the production migration (#9), and market_snapshots, which initDb creates,
 * is the same columns the backfill uses with the production types. Only the DB
 * handle is replaced (getDb() returns a neon-shaped client over pglite) and
 * `fetchMarketEvents`, so no FRED, Finnhub, Redis or real database is reached.
 * The real `eventNamesForSnapshot` runs.
 *
 * "Today" is pinned to 2026-11-11 (ET). The seed has a row dated 11-12, which
 * the run must leave alone.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { fetchMarketEvents } = vi.hoisted(() => ({
  fetchMarketEvents: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => holder.sql,
}));
vi.mock('../../api/_lib/market-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/market-events.js')>()),
  fetchMarketEvents,
}));

import type { EventItem } from '../../api/_lib/market-events.js';
import {
  formatReport,
  READ_PAGE,
  runBackfill,
  writePlan,
} from './snapshot-event-flag-backfill.js';

let db: PGlite;
let undoDir: string;

type PgSql = ReturnType<typeof neonOverPglite>;
const pgSql = (): PgSql => holder.sql as PgSql;

const NOW = new Date('2026-11-11T15:30:00.123Z');
const UNDO_NAME = 'undo-2026-11-11T15-30-00-123Z.json';

const item = (date: string, event: string): EventItem => ({
  date,
  event,
  description: event,
  time: '8:30 AM',
  severity: 'high',
  source: 'fred',
});

/** What the lookup knows. 11-12 is in the future: it must never matter. */
const CALENDAR: EventItem[] = [
  item('2026-05-12', 'CPI'),
  item('2026-05-13', 'CPI'),
  item('2026-05-13', 'PPI'),
  item('2026-05-14', 'NFP'),
  item('2026-06-17', 'FOMC + SEP'),
  item('2026-11-12', 'CPI'),
];

beforeAll(async () => {
  db = await PGlite.create();
  await applyMigration(db, 9); // training_features
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
  holder.sql = neonOverPglite(db);
});

afterAll(async () => {
  await db.close();
});

// ── Seed ────────────────────────────────────────────────────────────────────

async function seedSnapshot(
  date: string,
  entryTime: string,
  isEventDay: boolean | null,
  names: string[] | null,
): Promise<void> {
  await db.query(
    `INSERT INTO market_snapshots (date, entry_time, is_event_day, event_names)
     VALUES ($1::date, $2, $3, $4::text[])`,
    [date, entryTime, isEventDay, names],
  );
}

async function seedFeature(
  date: string,
  isEventDay: boolean | null,
): Promise<void> {
  await db.query(
    `INSERT INTO training_features (date, is_event_day) VALUES ($1::date, $2)`,
    [date, isEventDay],
  );
}

/** Ids are assigned in this order, 1..13. */
async function seedAll(): Promise<void> {
  // The mislabelled FOMC day: both rows lose their flag.
  await seedSnapshot('2026-05-06', '09:00', true, ['FOMC']); // 1
  await seedSnapshot('2026-05-06', '10:00', true, ['FOMC']); // 2
  // A CPI day, the way a replay left it: two rows behind, one right.
  await seedSnapshot('2026-05-12', '09:00', false, []); // 3
  await seedSnapshot('2026-05-12', '10:00', false, null); // 4
  await seedSnapshot('2026-05-12', '11:00', true, ['CPI']); // 5
  // Same names in another order: already right, never written.
  await seedSnapshot('2026-05-13', '09:00', true, ['PPI', 'CPI']); // 6
  // Right names, wrong flag.
  await seedSnapshot('2026-05-14', '09:00', false, ['NFP']); // 7
  // NULL flag and NULL names on an FOMC + SEP day.
  await seedSnapshot('2026-06-17', '09:00', null, null); // 8
  // Quiet days that are right.
  await seedSnapshot('2026-07-01', '09:00', false, []); // 9
  // A quiet day with names that need escaping: quote, backslash.
  await seedSnapshot('2026-07-02', '09:00', true, [
    'He said "hi"',
    'back\\slash',
    'C:\\x',
  ]); // 10
  await seedSnapshot('2026-11-11', '09:00', false, []); // 11 (today)
  await seedSnapshot('2026-11-12', '09:00', false, []); // 12 (the future)
  // A stored earnings name the calendar does not have.
  await seedSnapshot('2026-05-20', '09:00', true, ['NVDA Earnings']); // 13

  await seedFeature('2026-04-01', true); // not a snapshot date: untouched
  await seedFeature('2026-05-06', true); // loses
  await seedFeature('2026-05-12', false); // gains
  await seedFeature('2026-05-13', true); // right
  await seedFeature('2026-05-14', false); // gains
  await seedFeature('2026-06-17', null); // NULL gains
  await seedFeature('2026-07-01', false); // right
  await seedFeature('2026-07-02', true); // loses
  await seedFeature('2026-11-11', false); // right
  // 2026-05-20 has no feature row: skipped.
}

interface Dump {
  snapshots: Array<{
    id: number;
    date: string;
    is_event_day: boolean | null;
    event_names: string[] | null;
  }>;
  features: Array<{ date: string; is_event_day: boolean | null }>;
}

async function dump(): Promise<Dump> {
  const snapshots = await db.query<Dump['snapshots'][number]>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, is_event_day, event_names
       FROM market_snapshots ORDER BY id`,
  );
  const features = await db.query<Dump['features'][number]>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, is_event_day
       FROM training_features ORDER BY date`,
  );
  return { snapshots: snapshots.rows, features: features.rows };
}

beforeEach(async () => {
  await db.query(
    'TRUNCATE market_snapshots, training_features RESTART IDENTITY',
  );
  await seedAll();
  undoDir = mkdtempSync(join(tmpdir(), 'snapshot-event-flags-'));
  fetchMarketEvents.mockReset();
  fetchMarketEvents.mockImplementation((start: string, end: string) =>
    Promise.resolve({
      events: CALENDAR.filter((e) => e.date >= start && e.date <= end),
      complete: true,
    }),
  );
  vi.stubEnv('FRED_API_KEY', 'f');
  vi.stubEnv('FINNHUB_API_KEY', 'h');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(undoDir, { recursive: true, force: true });
});

const run = (over: { apply?: boolean; keepEarnings?: boolean } = {}) =>
  runBackfill({ apply: false, keepEarnings: false, undoDir, ...over });

/** The rows a default apply leaves, in id order. */
const SETTLED = [
  [1, false, []],
  [2, false, []],
  [3, true, ['CPI']],
  [4, true, ['CPI']],
  [5, true, ['CPI']],
  [6, true, ['PPI', 'CPI']], // order-only: untouched
  [7, true, ['NFP']],
  [8, true, ['FOMC + SEP']],
  [9, false, []],
  [10, false, []],
  [11, false, []],
  [12, false, []], // the future: untouched
  [13, false, []],
] as const;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('snapshot event-flag backfill (pglite)', () => {
  it('a dry run reads the plan and writes nothing, not even an undo file', async () => {
    const before = await dump();
    const transaction = vi.spyOn(pgSql(), 'transaction');

    const result = await run();

    expect(result.outcome).toBeNull();
    expect(result.undoFile).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(await dump()).toEqual(before);
    expect(readdirSync(undoDir)).toEqual([]);

    const { plan } = result;
    // 13 rows seeded, the future one not read.
    expect(plan.snapshotRows).toBe(12);
    expect(plan.snapshotChanges.map((c) => c.id)).toEqual([
      1, 2, 3, 4, 7, 8, 10, 13,
    ]);
    expect(plan.featureRows).toBe(8);
    expect(plan.featureChanges.map((c) => [c.date, c.from, c.to])).toEqual([
      ['2026-05-06', true, false],
      ['2026-05-12', false, true],
      ['2026-05-14', false, true],
      ['2026-06-17', null, true],
      ['2026-07-02', true, false],
    ]);
    expect(plan.nameDays).toEqual([
      { name: 'C:\\x', gained: 0, lost: 1 },
      { name: 'CPI', gained: 1, lost: 0 },
      { name: 'FOMC', gained: 0, lost: 1 },
      { name: 'FOMC + SEP', gained: 1, lost: 0 },
      { name: 'He said "hi"', gained: 0, lost: 1 },
      { name: 'NVDA Earnings', gained: 0, lost: 1 },
      { name: 'back\\slash', gained: 0, lost: 1 },
    ]);
    expect(plan.lostFlagDates.map((d) => d.date)).toEqual([
      '2026-05-06',
      '2026-05-20',
      '2026-07-02',
    ]);
    expect(plan.gainedFlagDates).toEqual(['2026-06-17']);
  });

  it('looks events up once per month with snapshot dates, in turn, and never past today', async () => {
    await run();

    expect(fetchMarketEvents.mock.calls).toEqual([
      ['2026-05-06', '2026-05-31'],
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-31'],
      ['2026-11-01', '2026-11-11'],
    ]);
  });

  it('--apply writes the planned rows and the undo file, and nothing else', async () => {
    const before = await dump();

    const result = await run({ apply: true });

    expect(result.outcome).toEqual({
      written: { market_snapshots: 8, training_features: 5 },
      skipped: { snapshotIds: [], featureDates: [] },
    });

    const after = await dump();
    expect(
      after.snapshots.map((s) => [s.id, s.is_event_day, s.event_names]),
    ).toEqual(SETTLED.map((s) => [...s]));
    // Dates and entry times never change.
    expect(after.snapshots.map((s) => s.date)).toEqual(
      before.snapshots.map((s) => s.date),
    );
    expect(after.features).toEqual([
      { date: '2026-04-01', is_event_day: true }, // not a snapshot date
      { date: '2026-05-06', is_event_day: false },
      { date: '2026-05-12', is_event_day: true },
      { date: '2026-05-13', is_event_day: true },
      { date: '2026-05-14', is_event_day: true },
      { date: '2026-06-17', is_event_day: true },
      { date: '2026-07-01', is_event_day: false },
      { date: '2026-07-02', is_event_day: false },
      { date: '2026-11-11', is_event_day: false },
    ]);

    // The undo file holds every planned row's old values, exactly as read.
    expect(result.undoFile).toBe(join(undoDir, UNDO_NAME));
    expect(readdirSync(undoDir)).toEqual([UNDO_NAME]);
    const undo = JSON.parse(readFileSync(join(undoDir, UNDO_NAME), 'utf8'));
    expect(undo.createdAt).toBe('2026-11-11T15:30:00.123Z');
    expect(undo.snapshots).toEqual(
      [1, 2, 3, 4, 7, 8, 10, 13].map((id) => {
        const old = before.snapshots.find((s) => s.id === id);
        return {
          id,
          isEventDay: old?.is_event_day,
          eventNames: old?.event_names,
        };
      }),
    );
    expect(undo.snapshots.find((s: { id: number }) => s.id === 4)).toEqual({
      id: 4,
      isEventDay: false,
      eventNames: null,
    });
    expect(undo.snapshots.find((s: { id: number }) => s.id === 10)).toEqual({
      id: 10,
      isEventDay: true,
      eventNames: ['He said "hi"', 'back\\slash', 'C:\\x'],
    });
    expect(undo.features).toEqual([
      { date: '2026-05-06', isEventDay: true },
      { date: '2026-05-12', isEventDay: false },
      { date: '2026-05-14', isEventDay: false },
      { date: '2026-06-17', isEventDay: null },
      { date: '2026-07-02', isEventDay: true },
    ]);
    expect(formatReport(result)).toContain(`Undo file: ${result.undoFile}`);
  });

  it('a second --apply plans zero writes, opens no transaction and leaves no second undo file', async () => {
    await run({ apply: true });
    const settled = await dump();
    const transaction = vi.spyOn(pgSql(), 'transaction');

    const second = await run({ apply: true });

    expect(second.plan.snapshotChanges).toEqual([]);
    expect(second.plan.featureChanges).toEqual([]);
    expect(second.outcome).toBeNull();
    expect(second.undoFile).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(readdirSync(undoDir)).toEqual([UNDO_NAME]);
    expect(await dump()).toEqual(settled);
    expect(formatReport(second)).toContain('Nothing to change');
  });

  it('skips and reports a row, or a feature date, that changed between the plan and the write', async () => {
    const sql = pgSql();
    const real = sql.transaction;
    // A save lands after the read and before the write: row 3's names, row 7's
    // flag (its names are already right) and 05-12's feature flag.
    sql.transaction = async (queries) => {
      await db.query(
        `UPDATE market_snapshots SET event_names = ARRAY['LATE'] WHERE id = 3`,
      );
      await db.query(
        `UPDATE market_snapshots SET is_event_day = true WHERE id = 7`,
      );
      await db.query(
        `UPDATE training_features SET is_event_day = true
          WHERE date = '2026-05-12'`,
      );
      return real(queries);
    };

    const result = await run({ apply: true }).finally(() => {
      sql.transaction = real;
    });

    expect(result.outcome).toEqual({
      written: { market_snapshots: 6, training_features: 4 },
      skipped: { snapshotIds: [3, 7], featureDates: ['2026-05-12'] },
    });
    const after = await dump();
    // Row 3 keeps the concurrent save; it was not overwritten.
    expect(after.snapshots[2]).toEqual({
      id: 3,
      date: '2026-05-12',
      is_event_day: false,
      event_names: ['LATE'],
    });
    expect(after.snapshots[6]?.event_names).toEqual(['NFP']);
    const text = formatReport(result);
    expect(text).toContain(
      'WARNING: 2 market_snapshots rows skipped, changed since the read: ids 3, 7',
    );
    expect(text).toContain(
      'WARNING: 1 training_features row skipped, changed since the read: 2026-05-12',
    );
  });

  it('the guards make a replayed plan write zero rows', async () => {
    const first = await run();
    await run({ apply: true });
    const settled = await dump();

    const replay = await writePlan(pgSql() as never, first.plan);

    expect(replay.written).toEqual({
      market_snapshots: 0,
      training_features: 0,
    });
    expect(replay.skipped.snapshotIds).toEqual([1, 2, 3, 4, 7, 8, 10, 13]);
    expect(replay.skipped.featureDates).toHaveLength(5);
    expect(await dump()).toEqual(settled);
  });

  it('a failure mid-transaction writes nothing to either table', async () => {
    const before = await dump();
    const sql = pgSql();
    const real = sql.transaction;
    // After every real UPDATE has run, inside the same transaction.
    sql.transaction = (queries) => real([...queries, sql`SELECT 1 / 0`]);

    try {
      await expect(run({ apply: true })).rejects.toThrow(/division by zero/);
    } finally {
      sql.transaction = real;
    }

    expect(await dump()).toEqual(before);
    // The undo file is written before the transaction opens, so it is there.
    expect(readdirSync(undoDir)).toEqual([UNDO_NAME]);
    // The failure left nothing half-done: the next apply still finds it all.
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const retry = await run({ apply: true });
    expect(retry.outcome?.written).toEqual({
      market_snapshots: 8,
      training_features: 5,
    });
  });

  it('--keep-earnings leaves a stored earnings name the calendar lacks', async () => {
    const result = await run({ apply: true, keepEarnings: true });

    expect(result.outcome?.written.market_snapshots).toBe(7);
    const after = await dump();
    expect(after.snapshots[12]).toEqual({
      id: 13,
      date: '2026-05-20',
      is_event_day: true,
      event_names: ['NVDA Earnings'],
    });
    expect(result.plan.lostFlagDates.map((d) => d.date)).toEqual([
      '2026-05-06',
      '2026-07-02',
    ]);
  });

  it('refuses an empty market_snapshots before any lookup or write', async () => {
    await db.query('TRUNCATE market_snapshots, training_features');
    const transaction = vi.spyOn(pgSql(), 'transaction');

    await expect(run({ apply: true })).rejects.toThrow(
      /no market_snapshots rows dated 2026-11-11 or earlier/,
    );

    expect(fetchMarketEvents).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(readdirSync(undoDir)).toEqual([]);
  });

  it('refuses an incomplete month and writes nothing, no undo file either', async () => {
    const before = await dump();
    fetchMarketEvents.mockImplementation((start: string) =>
      Promise.resolve({ events: [], complete: !start.startsWith('2026-07') }),
    );
    const transaction = vi.spyOn(pgSql(), 'transaction');

    await expect(run({ apply: true })).rejects.toThrow(/events for 2026-07 /);

    expect(transaction).not.toHaveBeenCalled();
    expect(await dump()).toEqual(before);
    expect(existsSync(join(undoDir, UNDO_NAME))).toBe(false);
  });

  it('reads and writes more than one page and one chunk of rows', async () => {
    // More than one READ_PAGE of extra rows on the CPI day, all behind.
    const extra = READ_PAGE + 300;
    await db.query(
      `INSERT INTO market_snapshots (date, entry_time, is_event_day, event_names)
       SELECT DATE '2026-05-12', 'x' || g, false, '{}'
         FROM generate_series(1, ${extra}) AS g`,
    );

    const result = await run({ apply: true });

    // Every row is read once: neither dropped nor repeated at a page edge.
    expect(result.plan.snapshotRows).toBe(12 + extra);
    expect(result.outcome?.written.market_snapshots).toBe(8 + extra);
    expect(result.outcome?.skipped.snapshotIds).toEqual([]);
    const stillBehind = await db.query(
      `SELECT count(*)::int AS n FROM market_snapshots
        WHERE date = '2026-05-12' AND event_names <> '{CPI}'`,
    );
    expect(stillBehind.rows).toEqual([{ n: 0 }]);
  }, 60_000);
});
