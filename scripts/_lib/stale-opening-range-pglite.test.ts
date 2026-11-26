// @vitest-environment node

/**
 * REAL-SQL test for the stale opening-range repair
 * (scripts/repair-stale-opening-range.ts -> ./stale-opening-range.ts).
 *
 * stale-opening-range.test.ts covers the pure plan. This runs every read and
 * write on pglite (Postgres in WASM): market_snapshots with the production
 * DECIMAL types (opening_range_high and _low DECIMAL(10,2),
 * opening_range_pct_consumed DECIMAL(6,4), median_hl_pct DECIMAL(6,4)), the
 * trust columns the feature pick reads (SNAPSHOT_TRUST_COLUMNS_SQL, run here
 * against real Postgres), and training_features from the real migration #9.
 * Three module boundaries are replaced: `getDb()` returns a neon-shaped client
 * over pglite (its `transaction` runs the queries of one date in one pglite
 * transaction, so a rolled-back date is really rolled back), `fetch` serves
 * /api/history from memory, and the pause between fetches returns at once. No
 * database, network or sleep is reached. The plan and backup files go to a temp
 * directory.
 *
 * The seed is a table of real-shaped rows (the ids are the insert order):
 *   2026-05-01  a morning stale until a reload: 8:30 to 8:55 CT carrying the
 *               previous session's range (ids 1-3, 6), one live save that saw
 *               the running bar (4, an as-of rebase), one right row (5), a
 *               live page a bar behind (26, lag), a replay that read the whole
 *               day (27, look-ahead) and a live row that lacks the 9:55 bar's
 *               last seconds (28, incomplete-range: written)
 *   2026-03-27  a single stale save at 8:45 among good ones (7-9)
 *   2026-05-22  a whole day stale, on a day whose bars sit 100 points higher
 *               than the rest, so a repair that read another date's candles
 *               shows (10-13; 13 has a NULL median_hl_pct)
 *   2026-11-12  a whole day stale in EST (14-16), whose features row holds
 *               other values than the pick row's
 *   2026-02-09  the previous trading date of the Feb artifacts (29-30), whose
 *               own range is the one 02-10's stale rows carry
 *   2026-02-10  a replay artifact before Schwab's candles (17-21), and a stale
 *               row that is not the previous date's range (31)
 *   2026-05-23  a Saturday (22) and 2099-01-02 (23): never planned
 *   2026-05-04  a whole day stale, no features row (24-25)
 * The stale rows hold 04-30's range: 7170.52 / 7130.33, consumed 0.5000,
 * MODERATE. The expected values below are plain arithmetic,
 * (high - low) / spot * 100 / median, checked outside the script.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  type MockInstance,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from '../../api/__tests__/pglite-migrations.js';

const holder = vi.hoisted(() => ({ sql: null as unknown }));
const { pause, getDbSpy } = vi.hoisted(() => ({
  pause: vi.fn(async () => undefined),
  getDbSpy: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => {
    getDbSpy();
    return holder.sql;
  },
}));
vi.mock('node:timers/promises', () => ({ setTimeout: pause }));

import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import type { SlotCandle } from '../../src/utils/snapshot-slot.js';
import { priorTradingDay } from '../../src/data/marketHours.js';
import { FETCH_PAUSE_MS, WRITE_CHUNK } from './snapshot-price-context.js';
import {
  exitCodeOf,
  exitCodeOfUndo,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  isWritten,
  runRepair,
  runUndo,
  type RunOptions,
} from './stale-opening-range.js';

const SECRET = 's3cret-owner-value';
const ORIGIN = 'https://app.example.test';
const PLAN_DB = 'postgres://owner:pw@ep-plan.neon.tech/neondb';

/** A query a hook may run: inside a transaction when the statement is in one. */
type Query = (text: string, params?: unknown[]) => Promise<unknown>;
/** What `sql\`...\`` returns here: a lazy query, run by `transaction`. */
interface LazyQuery {
  /** The SQL with `?` for each parameter, as the tests match it. */
  counted: string;
  /** The SQL with `$n` parameters, as pglite runs it. */
  text: string;
  params: unknown[];
}

let db: PGlite;
let backupDir: string;
/** The progress lines the run prints to stderr. */
let progress: MockInstance<typeof console.error>;
/** Rejects a statement whose SQL text and call number it matches. */
let failWhen: ((text: string, n: number) => Error | null) | null = null;
/**
 * Runs once, just before the first statement its pattern matches, with a
 * query on the same connection (inside the date's transaction, for one in it).
 */
let before: Array<{ match: RegExp; run: (query: Query) => Promise<void> }> = [];
const statements: string[] = [];
/** The row count of each market_snapshots UPDATE, from its ids array. */
const updateSizes: number[] = [];
const env = { ...process.env };

// ── The history the fetch stub serves ──────────────────────────────────────

const BAR_MS = 5 * 60_000;
/** [open, high, low, close] of the bars from 9:30 ET on (see the unit test). */
const BARS: ReadonlyArray<readonly [number, number, number, number]> = [
  [7180, 7186, 7175, 7183],
  [7183, 7190, 7181, 7188],
  [7188, 7194, 7186, 7192],
  [7192, 7198, 7189, 7195],
  [7195, 7200, 7192, 7197],
  [7197, 7203, 7194, 7201],
  [7201, 7210, 7199, 7208],
  [7208, 7212, 7205, 7210],
];
/** The one date whose bars sit higher: 7303 / 7275 is its opening range. */
const HIGH_DATE = '2026-05-22';
/** The close every date's previous session has, as stored and as served. */
const PREVIOUS_CLOSE = '7150.00';
/** Dates whose history reports no previous session. */
const noPreviousDay = new Set<string>();

/** A session's bars: 9:30 ET is 13:30Z in EDT and 14:30Z in EST. */
function session(date: string): SlotCandle[] {
  const edt = date >= '2026-03-08' && date < '2026-11-01';
  const shift = date === HIGH_DATE ? 100 : 0;
  return BARS.map(([open, high, low, close], i) => ({
    datetime: Date.parse(`${date}T${edt ? '13' : '14'}:30:00Z`) + i * BAR_MS,
    open: open + shift,
    high: high + shift,
    low: low + shift,
    close: close + shift,
  }));
}

function historyJson(date: string): string {
  return JSON.stringify({
    date,
    spx: {
      candles: session(date),
      previousClose: 0,
      previousDay: noPreviousDay.has(date)
        ? null
        : { date: priorTradingDay(date), close: Number(PREVIOUS_CLOSE) },
    },
  });
}

/** What to answer for a date; absent means a good history. */
const answers = new Map<string, () => Response | Promise<Response>>();
const fetchMock = vi.fn<typeof fetch>(async (input) => {
  const date = new URL(String(input)).searchParams.get('date') ?? '';
  const custom = answers.get(date);
  if (custom) return custom();
  return new Response(historyJson(date), { status: 200 });
});

const fetchedDates = (): string[] =>
  fetchMock.mock.calls.map(([url]) =>
    String(new URL(String(url)).searchParams.get('date')),
  );

// ── The tables ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await PGlite.create();
  await db.query(`
    CREATE TABLE market_snapshots (
      id            SERIAL PRIMARY KEY,
      date          DATE NOT NULL,
      entry_time    TEXT NOT NULL,
      spx           DECIMAL(10,2),
      spx_open      DECIMAL(10,2),
      spx_high      DECIMAL(10,2),
      spx_low       DECIMAL(10,2),
      prev_close    DECIMAL(10,2),
      median_hl_pct DECIMAL(6,4),
      opening_range_high         DECIMAL(10,2),
      opening_range_low          DECIMAL(10,2),
      opening_range_pct_consumed DECIMAL(6,4),
      opening_range_signal       TEXT,
      is_backtest   BOOLEAN DEFAULT FALSE,
      cluster_mult  DECIMAL(6,3),
      rv_annualized DECIMAL(8,4),
      created_at    TIMESTAMPTZ NOT NULL,
      UNIQUE (date, entry_time)
    )
  `);
  await applyMigration(db, 9); // training_features
  // Count each statement as it runs, fail the ones a test names, and run a hook
  // first. A date's queries run in one pglite transaction, as in Neon.
  const check = (text: string): void => {
    statements.push(text);
    const error = failWhen?.(text, statements.length) ?? null;
    if (error) throw error;
  };
  const trigger = async (text: string, query: Query): Promise<void> => {
    const at = before.findIndex((h) => h.match.test(text));
    if (at < 0) return;
    const [hook] = before.splice(at, 1);
    await hook?.run(query);
  };
  const tag = (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): LazyQuery => {
    const counted = strings.join('?');
    if (/UPDATE market_snapshots/.test(counted)) {
      updateSizes.push((params[0] as unknown[]).length);
    }
    return {
      counted,
      text: strings.reduce((acc, part, i) => `${acc}$${i}${part}`),
      params,
    };
  };
  holder.sql = Object.assign(tag, {
    query: async (text: string, params: unknown[] = []) => {
      check(text);
      await trigger(text, (t, p) => db.query(t, p));
      return (await db.query(text, params)).rows;
    },
    transaction: (queries: LazyQuery[]) =>
      db.transaction(async (tx) => {
        const results: unknown[][] = [];
        for (const q of queries) {
          check(q.counted);
          await trigger(q.counted, (t, p) => tx.query(t, p));
          results.push((await tx.query(q.text, q.params)).rows);
        }
        return results;
      }),
  });
});

afterAll(async () => {
  await db.close();
});

/** The old range the stale rows carry. */
const STALE = {
  high: '7170.52',
  low: '7130.33',
  consumed: '0.5000',
  signal: 'MODERATE',
};

interface SeedRow {
  date: string;
  entry: string;
  spx: string;
  /** The stored range, [high, low, consumed, signal]; STALE by default. */
  or?: readonly [string, string, string, string];
  /** NULL stores none; 0.8800 by default. */
  median?: string | null;
  /** The stored previous close; the real one, 7150.00, by default. */
  prev?: string | null;
  backtest?: boolean;
}

const OWN = ['6981.59', '6956.78', '0.4051', 'MODERATE'] as const;
const FULL = ['7203.00', '7175.00', '0.4422', 'MODERATE'] as const;
const PREVIOUS_FEB = ['6938.54', '6905.87', '0.4600', 'MODERATE'] as const;

/** Ids 1-31, in this order. */
const SEED: readonly SeedRow[] = [
  { date: '2026-05-01', entry: '8:35 AM CT', spx: '7185.00' }, // 1
  { date: '2026-05-01', entry: '8:40 AM CT', spx: '7186.00' }, // 2
  { date: '2026-05-01', entry: '8:55 AM CT', spx: '7190.00' }, // 3
  {
    // 4: saw the 9:45 ET bar running: inside the band, not the as-of range
    date: '2026-05-01',
    entry: '8:45 AM CT',
    spx: '7192.00',
    or: ['7198.00', '7175.00', '0.2900', 'GREEN'],
  },
  {
    date: '2026-05-01',
    entry: '9:10 AM CT',
    spx: '7200.00',
    or: ['7203.00', '7175.00', '0.4419', 'MODERATE'],
  }, // 5
  { date: '2026-05-01', entry: '8:30 AM CT', spx: '7181.00' }, // 6
  { date: '2026-03-27', entry: '8:45 AM CT', spx: '7192.00' }, // 7
  { date: '2026-03-27', entry: '9:00 AM CT', spx: '7195.00', or: FULL }, // 8
  {
    date: '2026-03-27',
    entry: '10:00 AM CT',
    spx: '7205.00',
    or: ['7203.00', '7175.00', '0.4416', 'MODERATE'],
  }, // 9
  { date: '2026-05-22', entry: '8:30 AM CT', spx: '7281.00' }, // 10
  // 11: also holds a week-early previous close (reported, never repaired)
  { date: '2026-05-22', entry: '9:00 AM CT', spx: '7295.00', prev: '7513.66' },
  { date: '2026-05-22', entry: '10:00 AM CT', spx: '7305.00' }, // 12
  { date: '2026-05-22', entry: '1:00 PM CT', spx: '7290.00', median: null }, // 13
  { date: '2026-11-12', entry: '9:05 AM CT', spx: '7195.00' }, // 14
  { date: '2026-11-12', entry: '10:00 AM CT', spx: '7205.00' }, // 15
  { date: '2026-11-12', entry: '2:55 PM CT', spx: '7190.00' }, // 16
  { date: '2026-02-10', entry: '9:05 AM CT', spx: '6960.00', or: OWN }, // 17
  { date: '2026-02-10', entry: '10:00 AM CT', spx: '6960.00', or: OWN }, // 18
  { date: '2026-02-10', entry: '11:00 AM CT', spx: '6960.00', or: OWN }, // 19
  {
    date: '2026-02-10',
    entry: '2:55 PM CT',
    spx: '6960.00',
    or: PREVIOUS_FEB,
  }, // 20
  {
    date: '2026-02-10',
    entry: '8:45 AM CT',
    spx: '6960.00',
    or: PREVIOUS_FEB,
  }, // 21
  { date: '2026-05-23', entry: '9:00 AM CT', spx: '7195.00' }, // 22
  { date: '2099-01-02', entry: '9:00 AM CT', spx: '7195.00' }, // 23
  { date: '2026-05-04', entry: '9:00 AM CT', spx: '7195.00' }, // 24
  { date: '2026-05-04', entry: '10:00 AM CT', spx: '7205.00' }, // 25
  {
    // 26: a live page a bar behind at 8:50 CT (the range as of 8:45)
    date: '2026-05-01',
    entry: '8:50 AM CT',
    spx: '7192.00',
    or: ['7194.00', '7175.00', '0.2900', 'GREEN'],
  },
  {
    // 27: a replay that read the whole day, before 10:00 ET
    date: '2026-05-01',
    entry: '8:58 AM CT',
    spx: '7195.00',
    backtest: true,
    or: FULL,
  },
  {
    // 28: a live row at 10:00 ET that lacks the 9:55 bar's last seconds
    date: '2026-05-01',
    entry: '9:05 AM CT',
    spx: '7195.00',
    or: ['7200.00', '7175.00', '0.3900', 'GREEN'],
  },
  // 29-30: the previous trading date's own range, the one 02-10's stale rows hold
  { date: '2026-02-09', entry: '9:05 AM CT', spx: '6920.00', or: PREVIOUS_FEB },
  {
    date: '2026-02-09',
    entry: '10:00 AM CT',
    spx: '6920.00',
    or: PREVIOUS_FEB,
  },
  {
    // 31: stale, and not the previous date's range: no evidence it was carried over
    date: '2026-02-10',
    entry: '3:00 PM CT',
    spx: '6960.00',
    or: ['6990.00', '6960.00', '0.4000', 'MODERATE'],
  },
];

const clockText = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

async function seed(rows: readonly SeedRow[]): Promise<void> {
  for (const row of rows) {
    const [high, low, consumed, signal] = row.or ?? [
      STALE.high,
      STALE.low,
      STALE.consumed,
      STALE.signal,
    ];
    // A live save: first saved on its own date, at its own slot.
    const savedAtCt = `${row.date} ${clockText(parseEntryTimeMinutes(row.entry))}`;
    await db.query(
      `INSERT INTO market_snapshots
         (date, entry_time, spx, spx_open, spx_high, spx_low, median_hl_pct,
          opening_range_high, opening_range_low, opening_range_pct_consumed,
          opening_range_signal, is_backtest, cluster_mult, rv_annualized,
          created_at, prev_close)
       VALUES ($1::date, $2, $3::numeric, 7180, 7400, 7000, $4::numeric,
               $5::numeric, $6::numeric, $7::numeric, $8, $9::boolean,
               1.05, 0.12, $10::timestamp AT TIME ZONE 'America/Chicago',
               $11::numeric)`,
      [
        row.date,
        row.entry,
        row.spx,
        row.median === undefined ? '0.8800' : row.median,
        high,
        low,
        consumed,
        signal,
        row.backtest ?? row.date === '2026-02-10',
        savedAtCt,
        row.prev ?? PREVIOUS_CLOSE,
      ],
    );
  }
}

/** The features rows: 05-22 follows its pick row, 11-12 does not. */
async function seedFeatures(): Promise<void> {
  await db.query(
    `INSERT INTO training_features
       (date, opening_range_signal, opening_range_pct_consumed)
     VALUES ('2026-05-22', 'MODERATE', 0.5000),
            ('2026-11-12', 'MODERATE', 0.3000),
            ('2026-03-27', 'GREEN', 0.1000)`,
  );
}

type Or = [
  high: string | null,
  low: string | null,
  consumed: string | null,
  signal: string | null,
];

interface Dumped {
  id: number;
  or: Or;
}

async function dump(): Promise<Dumped[]> {
  const { rows } = await db.query<{
    id: number;
    high: string | null;
    low: string | null;
    consumed: string | null;
    signal: string | null;
  }>(
    `SELECT id, opening_range_high::text AS high, opening_range_low::text AS low,
            opening_range_pct_consumed::text AS consumed,
            opening_range_signal AS signal
       FROM market_snapshots ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id,
    or: [r.high, r.low, r.consumed, r.signal],
  }));
}

const orOf = (rows: readonly Dumped[], id: number): Or => {
  const found = rows.find((r) => r.id === id);
  if (found == null) throw new Error(`no row ${id}`);
  return found.or;
};

async function features(): Promise<
  Record<string, [string | null, string | null]>
> {
  const { rows } = await db.query<{
    day: string;
    signal: string | null;
    consumed: string | null;
  }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS day,
            opening_range_signal AS signal,
            opening_range_pct_consumed::text AS consumed
       FROM training_features ORDER BY date`,
  );
  return Object.fromEntries(rows.map((r) => [r.day, [r.signal, r.consumed]]));
}

/** What every repaired row holds after a repair. */
const REPAIRED: Record<number, Or> = {
  1: ['7186.00', '7175.00', '0.1740', 'GREEN'],
  2: ['7190.00', '7175.00', '0.2372', 'GREEN'],
  3: ['7200.00', '7175.00', '0.3951', 'GREEN'],
  6: [null, null, null, null],
  7: ['7194.00', '7175.00', '0.3002', 'GREEN'],
  10: [null, null, null, null],
  11: ['7303.00', '7275.00', '0.4362', 'MODERATE'],
  12: ['7303.00', '7275.00', '0.4356', 'MODERATE'],
  14: ['7203.00', '7175.00', '0.4422', 'MODERATE'],
  15: ['7203.00', '7175.00', '0.4416', 'MODERATE'],
  16: ['7203.00', '7175.00', '0.4425', 'MODERATE'],
  20: ['6981.59', '6956.78', '0.4051', 'MODERATE'],
  24: ['7203.00', '7175.00', '0.4422', 'MODERATE'],
  25: ['7203.00', '7175.00', '0.4416', 'MODERATE'],
  28: ['7203.00', '7175.00', '0.4422', 'MODERATE'],
};

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  date: null,
  since: null,
  until: null,
  apply: false,
  planFile: null,
  all: false,
  backupDir,
  ...over,
});
const dry = (over: Partial<RunOptions> = {}) => runRepair(options(over));
/**
 * A dry run, then the apply of exactly the plan file it wrote. `all` is the
 * confirmation an all-dates plan needs; a one-date plan does not.
 */
async function applyPlanOf(over: Partial<RunOptions> = {}, all = false) {
  const planned = await dry(over);
  return runRepair(options({ apply: true, planFile: planned.planFile, all }));
}
const applyAll = () => applyPlanOf({}, true);
const applyDate = (date: string) => applyPlanOf({ date });

/** The error a run rejects with; a run that does not reject fails the test. */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    return err as Error;
  }
  throw new Error('the run was expected to fail and did not');
}

const filesIn = (prefix: string): string[] =>
  readdirSync(backupDir).filter((f) => f.startsWith(prefix));
const backups = (): string[] => filesIn('backup-');
const plansOnDisk = (): string[] => filesIn('dry-run-');
interface BackupFile {
  database: string;
  scope: string;
  rows: Array<{
    id: number;
    kind: string;
    before: Record<string, string | null>;
    after: Record<string, string | null>;
  }>;
  features: Array<{ date: string; pickId: number }>;
}
const readJson = <T>(file: string | null): T =>
  JSON.parse(readFileSync(file ?? '', 'utf8')) as T;
const readBackup = (file: string | null) => readJson<BackupFile>(file);

beforeEach(async () => {
  await db.query(
    'TRUNCATE market_snapshots, training_features RESTART IDENTITY',
  );
  await seed(SEED);
  await seedFeatures();
  backupDir = mkdtempSync(join(tmpdir(), 'stale-or-'));
  noPreviousDay.clear();
  statements.length = 0;
  updateSizes.length = 0;
  failWhen = null;
  before = [];
  answers.clear();
  fetchMock.mockClear();
  pause.mockClear();
  getDbSpy.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  progress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.OWNER_SECRET = SECRET;
  process.env.APP_URL = `${ORIGIN}/`;
  process.env.DATABASE_URL = PLAN_DB;
});

afterEach(() => {
  progress.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...env };
  rmSync(backupDir, { recursive: true, force: true });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('a dry run', () => {
  it('plans every row of every date from its own date’s candles, and writes nothing', async () => {
    const stored = await dump();

    const result = await dry();

    expect(await dump()).toEqual(stored);
    expect(statements.every((s) => /^\s*SELECT/.test(s))).toBe(true);
    expect(backups()).toEqual([]);
    // The one thing it leaves behind is the plan file.
    expect(plansOnDisk()).toHaveLength(1);
    expect(result.planFile).toBe(join(backupDir, plansOnDisk()[0] ?? ''));
    expect(result.dates.map((d) => [d.date, d.source])).toEqual([
      ['2026-02-09', 'own-range'],
      ['2026-02-10', 'own-range'],
      ['2026-03-27', 'candles'],
      ['2026-05-01', 'candles'],
      ['2026-05-04', 'candles'],
      ['2026-05-22', 'candles'],
      ['2026-05-23', 'skipped'],
      ['2026-11-12', 'candles'],
      ['2099-01-02', 'skipped'],
    ]);
    const rows = result.dates.flatMap((d) => d.rows);
    expect(
      rows.map((r) => [r.row.id, r.kind === 'skip' ? r.reason : r.kind]),
    ).toEqual([
      [29, 'ok'],
      [30, 'ok'],
      [17, 'ok'],
      [18, 'ok'],
      [19, 'ok'],
      [20, 'repair'],
      [21, 'early-slot-no-candles'],
      [31, 'not-previous-range'],
      [7, 'repair'],
      [8, 'ok'],
      [9, 'ok'],
      [1, 'repair'],
      [2, 'repair'],
      [3, 'repair'],
      [4, 'rebase'],
      [5, 'ok'],
      [6, 'repair'],
      [26, 'lag'],
      [27, 'look-ahead'],
      [28, 'incomplete-range'],
      [24, 'repair'],
      [25, 'repair'],
      [10, 'repair'],
      [11, 'repair'],
      [12, 'repair'],
      [13, 'null-median'],
      [14, 'repair'],
      [15, 'repair'],
      [16, 'repair'],
    ]);
    for (const r of rows) {
      if (!isWritten(r)) continue;
      const [high, low, consumed, signal] = REPAIRED[r.row.id] ?? [];
      expect(r.after, `row ${r.row.id}`).toEqual({
        high,
        low,
        consumed,
        signal,
      });
    }
  });

  it('calls /api/history once for each date with candles, with the owner cookie, and for no other', async () => {
    await dry();

    expect(fetchedDates()).toEqual([
      '2026-03-27',
      '2026-05-01',
      '2026-05-04',
      '2026-05-22',
      '2026-11-12',
    ]);
    const init = fetchMock.mock.calls[0]?.[1] as {
      headers: { cookie: string };
      redirect: string;
    };
    expect(init.headers.cookie).toBe(`sc-owner=${SECRET}; sc-hint=1`);
    expect(init.redirect).toBe('error');
    expect(pause).toHaveBeenCalledTimes(4);
    expect(pause).toHaveBeenCalledWith(FETCH_PAUSE_MS);
  });

  it('reports a stored previous close that is not the real one, for the dates it checked, and never repairs it', async () => {
    noPreviousDay.add('2026-05-04');

    const result = await dry();

    const check = (date: string) =>
      result.dates.find((d) => d.date === date)?.previousClose;
    expect(check('2026-05-22')).toEqual({
      expected: 7150,
      off: [{ id: 11, entryTime: '9:00 AM CT', stored: '7513.66' }],
    });
    expect(check('2026-11-12')).toEqual({ expected: 7150, off: [] });
    // /api/history reported no previous session for 05-04: nothing checked.
    expect(check('2026-05-04')).toEqual({ expected: null, off: [] });
    // No candles, or never planned: no history was asked.
    expect(check('2026-02-10')).toBeNull();
    expect(check('2026-05-23')).toBeNull();
    const text = formatReport(result);
    expect(text).toContain(
      '2026-05-22: real previous close 7150.00, 1 rows off',
    );
    expect(text).toMatch(/Previous session not reported[^\n]*2026-05-04/);

    await applyAll();

    const { rows } = await db.query<{ prev_close: string }>(
      `SELECT prev_close::text FROM market_snapshots WHERE id = 11`,
    );
    expect(rows[0]?.prev_close).toBe('7513.66');
  });

  it('plans the training_features copy for a repaired pick row only when the features hold its old values', async () => {
    const result = await dry();

    const feature = (date: string) =>
      result.dates.find((d) => d.date === date)?.feature;
    expect(feature('2026-05-22')).toEqual({
      kind: 'copy',
      rowId: 12,
      before: { signal: 'MODERATE', consumed: '0.5000' },
      after: { signal: 'MODERATE', consumed: '0.4356' },
    });
    expect(feature('2026-11-12')).toEqual({ kind: 'out-of-sync', rowId: 15 });
    expect(feature('2026-05-04')).toEqual({
      kind: 'no-features-row',
      rowId: 25,
    });
    // The pick row of 03-27 needs no repair, and its features row differs from
    // it: reported, nothing copied.
    expect(feature('2026-03-27')).toEqual({ kind: 'out-of-sync', rowId: 9 });
    // 05-01's pick row is fine and it has no features row: nothing to say.
    expect(feature('2026-05-01')).toEqual({ kind: 'none' });
  });

  it('tells the same-session kinds apart on real rows: a lag and a look-ahead are counted and never written, an incomplete range is written', async () => {
    const result = await dry();

    const may1 = result.dates.find((d) => d.date === '2026-05-01');
    const kindOf = (id: number) =>
      may1?.rows.find((r) => r.row.id === id)?.kind;
    expect([kindOf(26), kindOf(27), kindOf(28)]).toEqual([
      'lag',
      'look-ahead',
      'incomplete-range',
    ]);
    const plan = readJson<{ rows: Array<{ id: number }> }>(result.planFile);
    expect(plan.rows.map((r) => r.id)).toContain(28);
    expect(plan.rows.map((r) => r.id)).not.toContain(26);
    expect(plan.rows.map((r) => r.id)).not.toContain(27);
  });

  it('repairs a stale Feb row only where it holds the previous date’s own range, and lists the one that does not', async () => {
    const result = await dry({ date: '2026-02-10' });

    const kinds = result.dates[0]?.rows.map((r) => [
      r.row.id,
      r.kind === 'skip' ? r.reason : r.kind,
    ]);
    expect(kinds).toEqual([
      [17, 'ok'],
      [18, 'ok'],
      [19, 'ok'],
      [20, 'repair'],
      [21, 'early-slot-no-candles'],
      [31, 'not-previous-range'],
    ]);
  });

  it('reads the previous trading date’s own range for a date with candles, and repairs a row that holds it instead of counting it a lag', async () => {
    // 06-01 holds 7186/7175 on two rows from 10:00 ET on: its own range. A
    // live row at 8:40 CT on 06-02 holds the same pair, which is also what a
    // page a bar behind would hold there.
    await db.query(
      'TRUNCATE market_snapshots, training_features RESTART IDENTITY',
    );
    const carried = ['7186.00', '7175.00', '0.3900', 'GREEN'] as const;
    await seed([
      { date: '2026-06-01', entry: '9:05 AM CT', spx: '7195.00', or: carried },
      { date: '2026-06-01', entry: '10:00 AM CT', spx: '7195.00', or: carried },
      { date: '2026-06-02', entry: '8:40 AM CT', spx: '7192.00', or: carried },
    ]);

    const withEvidence = await dry({ date: '2026-06-02' });
    await db.query(`DELETE FROM market_snapshots WHERE date = '2026-06-01'`);
    const without = await dry({ date: '2026-06-02' });

    expect(withEvidence.dates[0]?.rows[0]?.kind).toBe('repair');
    expect(without.dates[0]?.rows[0]?.kind).toBe('lag');
  });

  it('writes a plan file with the scope, the database host, every write and every features copy', async () => {
    const result = await dry({ date: '2026-05-22' });

    const plan = readJson<{
      note: string;
      database: string;
      scope: {
        date: string | null;
        since: string | null;
        until: string | null;
      };
      summary: string;
      rows: Array<{ id: number; kind: string; after: Record<string, string> }>;
      features: Array<{ date: string; pickId: number }>;
    }>(result.planFile);
    // The note is what the owner reads in the file: what an apply checks, and
    // that a plan for more than one date needs --all.
    expect(plan.note).toMatch(/the values it holds now/);
    expect(plan.note).toMatch(/more than one date/);
    expect(plan.note).toContain('--all');
    // The host and the database name, never the user or the password.
    expect(plan.database).toBe('ep-plan.neon.tech/neondb');
    expect(plan.scope).toEqual({
      date: '2026-05-22',
      since: null,
      until: null,
    });
    expect(plan.rows.map((r) => [r.id, r.kind])).toEqual([
      [10, 'repair'],
      [11, 'repair'],
      [12, 'repair'],
    ]);
    expect(plan.rows[2]?.after).toMatchObject({ consumed: '0.4356' });
    expect(plan.features).toEqual([
      expect.objectContaining({ date: '2026-05-22', pickId: 12 }),
    ]);
    expect(plan.summary).toMatch(/3 writes \(3 repairs, 0 incomplete-range\)/);
  });

  it('is limited to one date by --date: one read of its rows, one fetch', async () => {
    const result = await dry({ date: '2026-05-22' });

    expect(result.dates.map((d) => d.date)).toEqual(['2026-05-22']);
    expect(fetchedDates()).toEqual(['2026-05-22']);
    expect(pause).not.toHaveBeenCalled();
  });

  it('names a Saturday and a future date as skipped, and fetches neither', async () => {
    const result = await dry();

    for (const date of ['2026-05-23', '2099-01-02']) {
      expect(result.dates.find((d) => d.date === date)).toMatchObject({
        source: 'skipped',
        skipped: 'not-a-past-trading-day',
        rows: [],
      });
      expect(fetchedDates()).not.toContain(date);
    }
  });

  it('needs no owner cookie for a date before the candles', async () => {
    delete process.env.OWNER_SECRET;
    delete process.env.APP_URL;

    const result = await dry({ date: '2026-02-10' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.dates[0]?.rows.map((r) => [r.row.id, r.kind])).toEqual([
      [17, 'ok'],
      [18, 'ok'],
      [19, 'ok'],
      [20, 'repair'],
      [21, 'skip'],
      [31, 'skip'],
    ]);
    expect(progress).not.toHaveBeenCalled();
  });

  it('prints the history origin to stderr once, before the first fetch, and never the cookie', async () => {
    await dry({ date: '2026-05-22' });

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith('History origin: app.example.test');
    expect(progress.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('needs the cookie settings only when a date from the first candle date on is planned', async () => {
    delete process.env.OWNER_SECRET;

    await expect(dry({ date: '2026-03-27' })).rejects.toThrow(
      /OWNER_SECRET is not set/,
    );
    await expect(dry({ date: '2026-02-10' })).resolves.toBeDefined();
  });

  it('prints the repairs with the candles, the NULL-median row on its own, and never the secret', async () => {
    const text = formatReport(await dry());

    expect(text).toMatch(/DRY RUN/);
    expect(text).toContain('id 12  2026-05-22 10:00 AM CT');
    // Stored -> new, with the bars of the shifted date: 7303 / 7275.
    expect(text).toContain('high 7170.52  low 7130.33');
    expect(text).toContain('high 7303.00  low 7275.00  consumed 0.4356');
    expect(text).toContain('o7280.00 h7286.00 l7275.00 c7283.00');
    expect(text).toMatch(/NULL median_hl_pct \(1\)/);
    expect(text).toContain('id 13  2026-05-22 1:00 PM CT');
    expect(text).toContain('Date skipped: 2026-05-23');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ep-plan');
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('apply', () => {
  it('refuses without a plan file, before reading anything', async () => {
    await expect(runRepair(options({ apply: true }))).rejects.toThrow(
      /--plan <dry-run file>/,
    );

    expect(statements).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backups()).toEqual([]);
  });

  it.each([
    ['not JSON', 'this is not json'],
    ['the wrong shape', JSON.stringify({ rows: 'many' })],
    [
      'a plan from before it named its database',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        scope: { date: null, since: null, until: null },
        summary: 's',
        rows: [],
        features: [],
      }),
    ],
    [
      'a plan in the earlier format, which recorded dbHost, not database',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        dbHost: 'ep-plan.neon.tech',
        scope: { date: null, since: null, until: null },
        summary: 's',
        rows: [],
        features: [],
      }),
    ],
  ])('refuses a plan file that is %s, naming it', async (_label, content) => {
    const file = join(backupDir, 'not-a-plan.json');
    writeFileSync(file, content);

    await expect(
      runRepair(options({ apply: true, planFile: file })),
    ).rejects.toThrow(
      /not-a-plan\.json is not a dry-run plan this script wrote/,
    );

    expect(statements).toEqual([]);
    expect(backups()).toEqual([]);
  });

  it('applies the plan of one date: backup first, only that date’s rows, the NULL-median row untouched, features copied', async () => {
    const stored = await dump();
    let backupAtFirstWrite: string[] | null = null;
    before = [
      {
        match: /UPDATE market_snapshots/,
        run: async () => {
          backupAtFirstWrite = backups();
        },
      },
    ];

    const result = await applyDate('2026-05-22');

    // The backup was on disk when the first UPDATE ran.
    expect(backupAtFirstWrite).toHaveLength(1);
    // One fetch for the dry run, one for the fresh plan the apply checks.
    expect(fetchedDates()).toEqual(['2026-05-22', '2026-05-22']);
    const after = await dump();
    for (const row of stored) {
      const expected = [10, 11, 12].includes(row.id)
        ? REPAIRED[row.id]
        : row.or;
      expect(orOf(after, row.id), `row ${row.id}`).toEqual(expected);
    }
    // Row 13 has a stale range and a NULL median: nothing written to it.
    expect(orOf(after, 13)).toEqual([
      STALE.high,
      STALE.low,
      STALE.consumed,
      STALE.signal,
    ]);
    expect(await features()).toEqual({
      '2026-05-22': ['MODERATE', '0.4356'],
      '2026-11-12': ['MODERATE', '0.3000'],
      '2026-03-27': ['GREEN', '0.1000'],
    });
    expect(result.applied).toMatchObject({
      planned: 3,
      written: 3,
      changedSinceRead: [],
      featuresPlanned: 1,
      featuresWritten: 1,
    });
    expect(exitCodeOf(result)).toBe(0);
    expect(formatApplyReport(result.applied!)).toContain('3 of 3');
  });

  it('writes a backup that records the database host, each planned row’s kind, old and new values, and the pick row of each features copy', async () => {
    const result = await applyDate('2026-05-22');

    expect(backups()).toHaveLength(1);
    const file = readBackup(result.backupFile);
    expect(file.database).toBe('ep-plan.neon.tech/neondb');
    expect(file.scope).toBe('2026-05-22');
    expect(file.rows.map((r) => [r.id, r.kind])).toEqual([
      [10, 'repair'],
      [11, 'repair'],
      [12, 'repair'],
    ]);
    expect(file.rows[2]).toMatchObject({
      before: {
        high: STALE.high,
        low: STALE.low,
        consumed: '0.5000',
        signal: 'MODERATE',
      },
      after: {
        high: '7303.00',
        low: '7275.00',
        consumed: '0.4356',
        signal: 'MODERATE',
      },
    });
    expect(file.features).toEqual([
      expect.objectContaining({ date: '2026-05-22', pickId: 12 }),
    ]);
    expect(JSON.stringify(file)).not.toContain(SECRET);
  });

  it('applies every date: the incomplete-range row is written, the lag, look-ahead, rebase and skipped rows are not', async () => {
    const first = await applyAll();

    const after = await dump();
    for (const [id, expected] of Object.entries(REPAIRED)) {
      expect(orOf(after, Number(id)), `row ${id}`).toEqual(expected);
    }
    // Left as they were: right rows, the as-of rebase (4), the NULL-median row
    // (13), the lag (26), the look-ahead (27), the Feb rows no evidence covers
    // (21, 31) and the dates that were never planned (22, 23).
    const seeded = await seedOnly();
    for (const id of [
      4, 5, 8, 9, 13, 17, 18, 19, 21, 22, 23, 26, 27, 29, 30, 31,
    ]) {
      expect(orOf(after, id), `row ${id}`).toEqual(orOf(seeded, id));
    }
    expect(first.applied?.written).toBe(Object.keys(REPAIRED).length);
    expect(backups()).toHaveLength(1);
    expect(await features()).toEqual({
      '2026-05-22': ['MODERATE', '0.4356'],
      '2026-11-12': ['MODERATE', '0.3000'],
      '2026-03-27': ['GREEN', '0.1000'],
    });
  });

  it('applies the same plan twice: the second writes nothing and makes no second backup', async () => {
    const planned = await dry();
    const apply = () =>
      runRepair(
        options({ apply: true, planFile: planned.planFile, all: true }),
      );
    const first = await apply();
    const updatesAfterFirst = updateSizes.length;

    const second = await apply();

    expect(first.applied?.written).toBe(Object.keys(REPAIRED).length);
    // 8:30 CT rows, now NULL, read as right too.
    expect(second.applied).toMatchObject({
      planned: 0,
      written: 0,
      backupFile: null,
    });
    expect(updateSizes).toHaveLength(updatesAfterFirst);
    expect(backups()).toHaveLength(1);
  });

  it('refuses to overwrite a backup, and writes nothing to the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
    const taken = join(
      backupDir,
      'backup-2026-05-22-2026-11-25T12-00-00.000Z.json',
    );
    writeFileSync(taken, 'the record of an earlier run');
    const stored = await dump();

    await expect(applyDate('2026-05-22')).rejects.toThrow(
      /Refusing to overwrite .*backup-2026-05-22/,
    );

    expect(readFileSync(taken, 'utf8')).toBe('the record of an earlier run');
    expect(await dump()).toEqual(stored);
    expect(updateSizes).toEqual([]);
  });

  it.each([
    ['opening_range_high', '7301.50', 0],
    ['opening_range_low', '7274.00', 1],
    ['opening_range_pct_consumed', '0.7000', 2],
    ['opening_range_signal', "'RED'", 3],
  ] as const)(
    'does not overwrite a row whose %s changed since the read, and leaves its features row alone',
    async (column, value, at) => {
      // The pick row 12 is edited by someone else between the read and the
      // write; each of the four columns the update sets is guarded. The edit
      // is made inside the date's transaction, just before its first UPDATE.
      const planned = await dry({ date: '2026-05-22' });
      before = [
        {
          match: /UPDATE market_snapshots/,
          run: async (query) => {
            await query(
              `UPDATE market_snapshots SET ${column} = ${value} WHERE id = 12`,
            );
          },
        },
      ];

      const result = await runRepair(
        options({ apply: true, planFile: planned.planFile }),
      );

      const after = await dump();
      expect(orOf(after, 12)[at]).toBe(value.replaceAll("'", ''));
      expect(orOf(after, 11)).toEqual(REPAIRED[11]);
      expect(result.applied).toMatchObject({
        planned: 3,
        written: 2,
        changedSinceRead: [12],
        featuresPlanned: 1,
        featuresWritten: 0,
      });
      expect(await features()).toMatchObject({
        '2026-05-22': ['MODERATE', '0.5000'],
      });
      expect(exitCodeOf(result)).toBe(1);
      expect(formatApplyReport(result.applied!)).toContain('12');
    },
  );

  it.each([
    ['opening_range_pct_consumed', '0.7000', ['MODERATE', '0.7000']],
    ['opening_range_signal', "'RED'", ['RED', '0.5000']],
  ] as const)(
    'does not overwrite a features row whose %s changed since the read',
    async (column, value, held) => {
      const planned = await dry({ date: '2026-05-22' });
      before = [
        {
          match: /UPDATE training_features/,
          run: async (query) => {
            await query(
              `UPDATE training_features SET ${column} = ${value}
                WHERE date = '2026-05-22'`,
            );
          },
        },
      ];

      const result = await runRepair(
        options({ apply: true, planFile: planned.planFile }),
      );

      expect(result.applied).toMatchObject({
        written: 3,
        featuresPlanned: 1,
        featuresWritten: 0,
      });
      expect(await features()).toMatchObject({ '2026-05-22': held });
      expect(exitCodeOf(result)).toBe(1);
    },
  );

  it('writes a date in statements of 500 rows, all in one transaction', async () => {
    // One date, a row for every minute from 8:35 AM to 11:59 PM CT, all
    // carrying the previous session's range: 925 repairs.
    await seedBulk(['2026-06-01'], 515, 1439);

    const result = await applyAll();

    expect(WRITE_CHUNK).toBe(500);
    expect(updateSizes).toEqual([500, 425]);
    expect(result.applied).toMatchObject({ planned: 925, written: 925 });
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_snapshots
        WHERE opening_range_high = 7203.00 AND opening_range_low = 7175.00`,
    );
    // The 900 rows from 9:00 CT on hold the complete range; the 25 before it
    // hold the range as of their own slot.
    expect(rows[0]?.n).toBe(900);
  });

  it('repairs the Feb date’s stale row to the date’s own range, and nothing else, with no history asked', async () => {
    const result = await applyDate('2026-02-10');

    const after = await dump();
    expect(orOf(after, 20)).toEqual(REPAIRED[20]);
    expect(orOf(after, 21)).toEqual(PREVIOUS_FEB);
    expect(orOf(after, 31)).toEqual([
      '6990.00',
      '6960.00',
      '0.4000',
      'MODERATE',
    ]);
    expect(result.applied).toMatchObject({ planned: 1, written: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── The reviewed plan ───────────────────────────────────────────────────────

describe('the plan an apply is held to', () => {
  const apply = (planFile: string | null) =>
    runRepair(options({ apply: true, planFile }));

  it('refuses when a row’s new values differ from the file’s, writing nothing', async () => {
    const planned = await dry({ date: '2026-05-22' });
    // The spot of row 11 changed after the review: its consumed value moves.
    await db.query(`UPDATE market_snapshots SET spx = 7000 WHERE id = 11`);
    const stored = await dump();

    await expect(apply(planned.planFile)).rejects.toThrow(
      /A fresh plan is not the plan in[\s\S]*row 11: the new values differ/,
    );

    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
    expect(updateSizes).toEqual([]);
  });

  it('refuses when a row is planned now that the file did not list', async () => {
    const planned = await dry({ date: '2026-05-22' });
    await seed([{ date: '2026-05-22', entry: '9:15 AM CT', spx: '7295.00' }]);

    await expect(apply(planned.planFile)).rejects.toThrow(
      /row 32 is planned now and is not in the file/,
    );

    expect(backups()).toEqual([]);
  });

  it('refuses when a listed row is no longer planned, unless it already holds the file’s new values', async () => {
    const planned = await dry({ date: '2026-05-22' });
    await db.query(
      `UPDATE market_snapshots SET median_hl_pct = NULL WHERE id = 11`,
    );

    await expect(apply(planned.planFile)).rejects.toThrow(
      /row 11 \(2026-05-22 9:00 AM CT\) is in the file and is no longer planned \(now: skip\)/,
    );

    expect(backups()).toEqual([]);
  });

  it('refuses when a listed date cannot be read now, since its rows cannot be checked', async () => {
    const planned = await dry({ date: '2026-05-22' });
    answers.set(
      '2026-05-22',
      () => new Response(JSON.stringify({ code: 'x' }), { status: 502 }),
    );

    await expect(apply(planned.planFile)).rejects.toThrow(
      /row 10 .* no longer planned \(now: not read\)/,
    );

    expect(backups()).toEqual([]);
  });

  it.each([
    ['another host', 'postgres://owner:pw@ep-other.neon.tech/neondb'],
    [
      'the same host, another database',
      'postgres://owner:pw@ep-plan.neon.tech/otherdb',
    ],
  ])(
    'refuses a plan written for %s, before reading any row',
    async (_label, url) => {
      const planned = await dry({ date: '2026-05-22' });
      process.env.DATABASE_URL = url;
      statements.length = 0;

      await expect(apply(planned.planFile)).rejects.toThrow(
        /written for the database ep-plan\.neon\.tech\/neondb, and DATABASE_URL names a different database or is not a usable URL\./,
      );

      expect(statements).toEqual([]);
      expect(backups()).toEqual([]);
    },
  );

  it('applies a plan file whose note is an earlier wording: the note is text for the owner, not a check', async () => {
    const planned = await dry({ date: '2026-05-22' });
    const file = readJson<Record<string, unknown>>(planned.planFile);
    writeFileSync(
      planned.planFile ?? '',
      JSON.stringify({
        ...file,
        note: 'What a dry run would write. `--apply --plan <this file>` plans afresh and writes only if every row and its new values are the same as here.',
      }),
    );

    const result = await apply(planned.planFile);

    expect(result.applied).toMatchObject({ planned: 3, written: 3 });
  });

  it('refuses when a row’s stored values changed to another stale value since the dry run', async () => {
    const planned = await dry({ date: '2026-05-22' });
    // Row 11 still needs the same repair, but it no longer holds what the
    // owner reviewed: applying would overwrite a value nobody has seen.
    await db.query(
      `UPDATE market_snapshots SET opening_range_high = 7160.00 WHERE id = 11`,
    );
    const stored = await dump();

    await expect(apply(planned.planFile)).rejects.toThrow(
      /row 11: the stored values changed since the dry run \(7170\.52\/7130\.33\/0\.5000\/MODERATE then, 7160\.00\/7130\.33\/0\.5000\/MODERATE now\)/,
    );

    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
    expect(updateSizes).toEqual([]);
  });

  it.each([
    ['its consumed value', "'MODERATE'", '0.6000', 'MODERATE/0.6000'],
    ['its signal', "'GREEN'", '0.5000', 'GREEN/0.5000'],
    // A NULL is written as the word, as the row messages do, not as `null`.
    ['both cleared to NULL', 'NULL', 'NULL', 'NULL/NULL'],
  ])(
    'refuses when the features row changed since the dry run too: %s',
    async (_label, signal, consumed, shownNow) => {
      const planned = await dry({ date: '2026-05-22' });
      // The pick row (12) and its features row moved together, so the copy is
      // still planned: the rows would be repaired and the features copied from
      // values nobody reviewed. `signal` and `consumed` are SQL literals.
      await db.query(
        `UPDATE market_snapshots
            SET opening_range_signal = ${signal},
                opening_range_pct_consumed = ${consumed}
          WHERE id = 12`,
      );
      await db.query(
        `UPDATE training_features
            SET opening_range_signal = ${signal},
                opening_range_pct_consumed = ${consumed}
          WHERE date = '2026-05-22'`,
      );

      const failure = await failureOf(apply(planned.planFile));

      expect(failure.message).toMatch(/row 12: the stored values changed/);
      expect(failure.message).toContain(
        `the features row for 2026-05-22 changed since the dry run (MODERATE/0.5000 then, ${shownNow} now)`,
      );
      expect(backups()).toEqual([]);
    },
  );

  describe('a plan that covers more than one date', () => {
    it('is refused without --all, before reading anything: apply one date first', async () => {
      const planned = await dry();
      const stored = await dump();
      statements.length = 0;

      await expect(
        runRepair(options({ apply: true, planFile: planned.planFile })),
      ).rejects.toThrow(
        /covers more than one date \(all\)\. Apply one date first.*add --all\. Nothing was written/,
      );

      expect(statements).toEqual([]);
      expect(fetchedDates()).toHaveLength(5);
      expect(await dump()).toEqual(stored);
      expect(backups()).toEqual([]);
    });

    it('is applied with --all', async () => {
      const planned = await dry();

      const result = await runRepair(
        options({ apply: true, planFile: planned.planFile, all: true }),
      );

      expect(result.applied?.written).toBe(Object.keys(REPAIRED).length);
    });

    it('names a --since to --until range as many dates, and one day of it as one', async () => {
      const range = await dry({ since: '2026-05-01', until: '2026-05-04' });
      const oneDay = await dry({ since: '2026-05-22', until: '2026-05-22' });

      await expect(
        runRepair(options({ apply: true, planFile: range.planFile })),
      ).rejects.toThrow(
        /covers more than one date \(2026-05-01\.\.2026-05-04\)/,
      );
      const applied = await runRepair(
        options({ apply: true, planFile: oneDay.planFile }),
      );

      expect(applied.applied).toMatchObject({ planned: 3, written: 3 });
    });

    it('lets a one-date plan be applied without --all, and --all does no harm there', async () => {
      const first = await applyDate('2026-05-22');
      expect(first.applied?.written).toBe(3);

      const planned = await dry({ date: '2026-05-04' });
      const again = await runRepair(
        options({ apply: true, planFile: planned.planFile, all: true }),
      );
      expect(again.applied?.written).toBe(2);
    });

    it('does not ask for --all to check a plan without applying it', async () => {
      const planned = await dry();

      const checked = await runRepair(options({ planFile: planned.planFile }));

      expect(checked).toMatchObject({ apply: false, applied: null });
    });
  });

  it('checks a plan without --apply: it writes nothing and says so', async () => {
    const planned = await dry({ date: '2026-05-22' });
    const stored = await dump();

    const checked = await runRepair(options({ planFile: planned.planFile }));

    expect(checked).toMatchObject({
      apply: false,
      planFile: planned.planFile,
      applied: null,
      backupFile: null,
    });
    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
    expect(updateSizes).toEqual([]);
    // The check plans afresh with the file's own scope.
    expect(checked.dates.map((d) => d.date)).toEqual(['2026-05-22']);
  });
});

// ── One transaction a date ──────────────────────────────────────────────────

describe('one transaction a date', () => {
  it('rolls back a date whose features update fails, says what is and is not done, and a re-run copies the features', async () => {
    const planned = await dry({ date: '2026-05-22' });
    const stored = await dump();
    failWhen = (text) =>
      /UPDATE training_features/.test(text)
        ? new Error('connection lost')
        : null;

    const failure = await failureOf(
      runRepair(options({ apply: true, planFile: planned.planFile })),
    );

    expect(failure.message).toContain('connection lost');
    expect(failure.message).toMatch(/wrote 0 of 3 planned rows/);
    expect(failure.message).toContain(
      "2026-05-22's was rolled back); training_features not copied for 2026-05-22",
    );
    const [name] = backups();
    expect(failure.message).toContain(`Backup: ${join(backupDir, name ?? '')}`);
    expect(failure.message).toContain(
      `npx tsx scripts/repair-stale-opening-range.ts --undo-file ${join(backupDir, name ?? '')} --apply`,
    );
    // The rows were written in the same transaction, and are back.
    expect(await dump()).toEqual(stored);
    expect(await features()).toMatchObject({
      '2026-05-22': ['MODERATE', '0.5000'],
    });

    failWhen = null;
    const again = await runRepair(
      options({ apply: true, planFile: planned.planFile }),
    );

    expect(again.applied).toMatchObject({
      written: 3,
      featuresPlanned: 1,
      featuresWritten: 1,
    });
    expect(await features()).toMatchObject({
      '2026-05-22': ['MODERATE', '0.4356'],
    });
  });

  it('undoes the rows of a date whose second statement fails: all or nothing', async () => {
    await seedBulk(['2026-06-01'], 515, 1439);
    let updates = 0;
    failWhen = (text) =>
      /UPDATE market_snapshots/.test(text) && ++updates === 2
        ? new Error('connection lost')
        : null;

    await expect(applyAll()).rejects.toThrow(/wrote 0 of 925 planned rows/);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_snapshots
        WHERE opening_range_high = 7203.00`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('leaves the dates before a failed one written, and an undo restores them', async () => {
    // Two dates of 361 repairs, one transaction each; the second is rejected.
    await seedBulk(['2026-06-01', '2026-06-02'], 540, 900);
    let updates = 0;
    failWhen = (text) =>
      /UPDATE market_snapshots/.test(text) && ++updates === 2
        ? new Error('connection lost')
        : null;

    const failure = await failureOf(applyAll());

    expect(failure.message).toContain('connection lost');
    expect(failure.message).toMatch(/wrote 361 of 722 planned rows/);
    expect(failure.message).toContain("2026-06-02's was rolled back");
    expect(failure.message).toContain(
      'training_features not copied for no date',
    );
    const written = await db.query<{ day: string; n: number }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM market_snapshots WHERE opening_range_high = 7203.00
        GROUP BY date ORDER BY date`,
    );
    expect(written.rows).toEqual([{ day: '2026-06-01', n: 361 }]);

    failWhen = null;
    const [name] = backups();
    const undone = await runUndo({
      file: join(backupDir, name ?? ''),
      apply: true,
    });

    // The 361 rows of the date that was never written still hold their old
    // values, so the undo reports them as not holding the repaired ones.
    expect(undone.restored).toBe(361);
    expect(undone.changedSince).toHaveLength(361);
    const left = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM market_snapshots
        WHERE opening_range_high = 7170.52`,
    );
    expect(left.rows[0]?.n).toBe(722);
  });
});

// ── Undo ────────────────────────────────────────────────────────────────────

describe('undo', () => {
  it('counts a backup without --apply and writes nothing', async () => {
    const applied = await applyDate('2026-05-22');
    const repaired = await dump();
    updateSizes.length = 0;

    const counted = await runUndo({
      file: applied.backupFile ?? '',
      apply: false,
    });

    expect(counted).toMatchObject({
      apply: false,
      rows: 3,
      features: 1,
      restored: 0,
    });
    expect(formatUndoReport(counted)).toMatch(/nothing written/i);
    expect(await dump()).toEqual(repaired);
    expect(updateSizes).toEqual([]);
  });

  it('restores the rows and the features row, and a second undo restores nothing', async () => {
    const stored = await dump();
    const storedFeatures = await features();
    const applied = await applyDate('2026-05-22');

    const undone = await runUndo({
      file: applied.backupFile ?? '',
      apply: true,
    });

    expect(await dump()).toEqual(stored);
    expect(await features()).toEqual(storedFeatures);
    expect(undone).toMatchObject({
      restored: 3,
      featuresRestored: 1,
      changedSince: [],
    });
    expect(exitCodeOfUndo(undone)).toBe(0);
    expect(formatUndoReport(undone)).toContain('3 of 3');

    const again = await runUndo({
      file: applied.backupFile ?? '',
      apply: true,
    });

    expect(again).toMatchObject({ restored: 0, featuresRestored: 0 });
    expect(again.changedSince).toEqual([10, 11, 12]);
    expect(exitCodeOfUndo(again)).toBe(1);
  });

  it('does not restore a row that changed after the repair', async () => {
    const applied = await applyDate('2026-05-22');
    await db.query(
      `UPDATE market_snapshots SET opening_range_signal = 'RED' WHERE id = 11`,
    );

    const undone = await runUndo({
      file: applied.backupFile ?? '',
      apply: true,
    });

    const after = await dump();
    expect(orOf(after, 11)[3]).toBe('RED');
    expect(orOf(after, 12)).toEqual([
      STALE.high,
      STALE.low,
      STALE.consumed,
      STALE.signal,
    ]);
    expect(undone.changedSince).toEqual([11]);
    expect(exitCodeOfUndo(undone)).toBe(1);
  });

  it('restores a features row only together with its pick row, and counts the shortfall', async () => {
    const applied = await applyDate('2026-05-22');
    // The pick row (12) was edited after the repair, so it is not restored.
    await db.query(
      `UPDATE market_snapshots SET opening_range_signal = 'RED' WHERE id = 12`,
    );

    const undone = await runUndo({
      file: applied.backupFile ?? '',
      apply: true,
    });

    expect(undone).toMatchObject({
      restored: 2,
      changedSince: [12],
      features: 1,
      featuresRestored: 0,
    });
    // Rows 10 and 11 are back; the features row still follows the repair.
    const after = await dump();
    expect(orOf(after, 11)[0]).toBe(STALE.high);
    expect(await features()).toMatchObject({
      '2026-05-22': ['MODERATE', '0.4356'],
    });
    expect(exitCodeOfUndo(undone)).toBe(1);
  });

  it('exits 1 for a features row left behind even when every row was restored', async () => {
    const applied = await applyDate('2026-05-22');
    // The features row was edited after the repair: its guard no longer holds.
    await db.query(
      `UPDATE training_features SET opening_range_pct_consumed = 0.9000
        WHERE date = '2026-05-22'`,
    );

    const undone = await runUndo({
      file: applied.backupFile ?? '',
      apply: true,
    });

    expect(undone).toMatchObject({
      restored: 3,
      changedSince: [],
      features: 1,
      featuresRestored: 0,
    });
    expect(exitCodeOfUndo(undone)).toBe(1);
  });

  it('refuses a backup written for another database, counting or restoring', async () => {
    const applied = await applyDate('2026-05-22');
    const repaired = await dump();
    updateSizes.length = 0;

    for (const url of [
      'postgres://owner:pw@ep-other.neon.tech/neondb',
      'postgres://owner:pw@ep-plan.neon.tech/otherdb',
    ]) {
      process.env.DATABASE_URL = url;
      for (const apply of [false, true]) {
        await expect(
          runUndo({ file: applied.backupFile ?? '', apply }),
        ).rejects.toThrow(
          /written for the database ep-plan\.neon\.tech\/neondb, and DATABASE_URL names a different database or is not a usable URL\./,
        );
      }
    }

    expect(await dump()).toEqual(repaired);
    expect(updateSizes).toEqual([]);
  });

  it.each([
    ['not JSON', 'this is not json'],
    ['the wrong shape', JSON.stringify({ rows: 'many' })],
    [
      'a backup from before it named its database',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        scope: 'all',
        rows: [],
        features: [],
      }),
    ],
    [
      'a backup in the earlier format, which recorded dbHost, not database',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        dbHost: 'ep-plan.neon.tech',
        scope: 'all',
        rows: [],
        features: [],
      }),
    ],
    [
      'a features entry with no pick row',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        database: 'ep-plan.neon.tech/neondb',
        scope: 'all',
        rows: [],
        features: [
          {
            date: '2026-05-22',
            before: { signal: null, consumed: null },
            after: { signal: null, consumed: null },
          },
        ],
      }),
    ],
    [
      'an unknown key',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        database: 'ep-plan.neon.tech/neondb',
        scope: 'all',
        rows: [],
        features: [],
        extra: 1,
      }),
    ],
    [
      'an id past the integer column',
      JSON.stringify({
        note: 'n',
        createdAt: 'now',
        database: 'ep-plan.neon.tech/neondb',
        scope: 'all',
        rows: [
          {
            id: 2_147_483_648,
            date: '2026-05-22',
            entryTime: '9:00 AM CT',
            kind: 'repair',
            before: { high: null, low: null, consumed: null, signal: null },
            after: { high: null, low: null, consumed: null, signal: null },
          },
        ],
        features: [],
      }),
    ],
  ])(
    'refuses a file that is %s, naming it, and writes nothing',
    async (_label, content) => {
      const file = join(backupDir, 'not-a-backup.json');
      writeFileSync(file, content);
      const stored = await dump();
      statements.length = 0;

      await expect(runUndo({ file, apply: true })).rejects.toThrow(
        /not-a-backup\.json is not a backup this script wrote/,
      );

      expect(statements).toEqual([]);
      expect(await dump()).toEqual(stored);
      expect(updateSizes).toEqual([]);
    },
  );

  it('refuses a file that does not exist', async () => {
    await expect(
      runUndo({ file: join(backupDir, 'missing.json'), apply: true }),
    ).rejects.toThrow(/is not a backup this script wrote/);
  });
});

// ── The database a file is checked against ──────────────────────────────────

/**
 * The rule: a value derived from the current DATABASE_URL is printed or written
 * only after a query on that URL has succeeded. A URL that does not parse as
 * the driver would is not trusted to split into host, name and credentials, so
 * the refusals before any connection print only what the FILE recorded, and
 * never the URL's own parts. Each URL below parses to something that carries
 * part of the user or the password (or, for the last two, text after the
 * database name); `tokens` are the parts that must not appear.
 */
const AWKWARD_URLS: Array<
  [
    label: string,
    url: string,
    tokens: string[],
    // Whether the shape alone shows the URL's host is not what the string
    // says. The last entry has a real host: it parses and is trusted, the
    // text after the database name is only the name, and a connection to it
    // fails at the server, so no name derived from it is ever printed.
    unusableByShape: boolean,
  ]
> = [
  [
    'a slash after a numeric password prefix',
    'postgres://owner:12/34@ep-plan.neon.tech/neondb',
    ['owner', '12', '34'],
    true,
  ],
  [
    'an @ in the password, then a slash',
    'postgres://owner:p@ss/34@ep-plan.neon.tech/neondb',
    ['owner', 'ss', '34'],
    true,
  ],
  [
    'an @ in the password, then a question mark',
    'postgres://owner:p@ss?34@ep-plan.neon.tech/neondb',
    ['owner', 'ss', '34'],
    true,
  ],
  [
    'an @ in the password, then a hash',
    'postgres://owner:p@ss#34@ep-plan.neon.tech/neondb',
    ['owner', 'ss', '34'],
    true,
  ],
  [
    'an @ in the user',
    'postgres://ow@ner/34@ep-plan.neon.tech/neondb',
    ['ow', 'ner', '34'],
    true,
  ],
  [
    'an @ after the database name',
    'postgres://owner:pw@ep-plan.neon.tech/neondb@x',
    ['owner', 'pw', '@x'],
    true,
  ],
  [
    'a line feed inside, which the URL parser drops without a word',
    'postgres://owner:s3\ncret@ep-plan.neon.tech/neondb',
    ['owner', 's3', 'cret'],
    true,
  ],
  [
    'a NUL inside',
    'postgres://owner:s3\0cret@ep-plan.neon.tech/neondb',
    ['owner', 's3', 'cret'],
    true,
  ],
  [
    'a parameter after the database name',
    'postgres://owner:pw@ep-plan.neon.tech/neondb;password=x',
    ['owner', 'pw', 'password', '=x'],
    false,
  ],
];

/** The tokens of a message once the file path and the recorded name are cut out. */
const leaked = (message: string, file: string, tokens: string[]): string[] => {
  const rest = message
    .replace(file, '')
    .replace('ep-plan.neon.tech/neondb', '');
  return tokens.filter((token) => rest.includes(token));
};

/** A plan or backup file with its recorded `database` replaced. */
function recordDatabase(file: string | null, database: string): void {
  const parsed = readJson<Record<string, unknown>>(file);
  writeFileSync(file ?? '', JSON.stringify({ ...parsed, database }));
}

const NO_DATABASE = '(DATABASE_URL missing or not a URL)';

/** An apply of this plan file. */
const applyFile = (planFile: string | null) =>
  runRepair(options({ apply: true, planFile }));

describe('the database check prints only what the file recorded', () => {
  it.each(AWKWARD_URLS)(
    'refuses an apply of a plan with no part of the user or password in the message: %s',
    async (_label, url, tokens) => {
      const planned = await dry({ date: '2026-05-22' });
      process.env.DATABASE_URL = url;
      statements.length = 0;
      getDbSpy.mockClear();

      const failure = await failureOf(applyFile(planned.planFile));

      expect(failure.message).toMatch(
        /written for the database ep-plan\.neon\.tech\/neondb, and DATABASE_URL names a different database or is not a usable URL\./,
      );
      expect(leaked(failure.message, planned.planFile ?? '', tokens)).toEqual(
        [],
      );
      // Before any connection, and nothing written.
      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(backups()).toEqual([]);
    },
  );

  it.each(AWKWARD_URLS)(
    'refuses an undo, counting or restoring, with no part of the user or password in the message: %s',
    async (_label, url, tokens) => {
      const applied = await applyDate('2026-05-22');
      const repaired = await dump();
      process.env.DATABASE_URL = url;
      statements.length = 0;
      getDbSpy.mockClear();

      for (const restore of [false, true]) {
        const failure = await failureOf(
          runUndo({ file: applied.backupFile ?? '', apply: restore }),
        );

        expect(failure.message).toMatch(
          /written for the database ep-plan\.neon\.tech\/neondb, and DATABASE_URL names a different database or is not a usable URL\./,
        );
        expect(
          leaked(failure.message, applied.backupFile ?? '', tokens),
        ).toEqual([]);
      }

      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(await dump()).toEqual(repaired);
    },
  );

  it.each([
    ['a usable URL', PLAN_DB],
    ['no URL at all', 'not a url'],
  ])(
    'refuses a plan that records no database, with DATABASE_URL %s: the sentinel never matches',
    async (_label, url) => {
      const planned = await dry({ date: '2026-05-22' });
      recordDatabase(planned.planFile, NO_DATABASE);
      process.env.DATABASE_URL = url;
      statements.length = 0;
      getDbSpy.mockClear();

      await expect(applyFile(planned.planFile)).rejects.toThrow(
        /records no usable database name, so it cannot be matched to DATABASE_URL\. Nothing was written\./,
      );

      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(backups()).toEqual([]);
    },
  );

  it.each([
    ['a usable URL', PLAN_DB],
    ['no URL at all', 'not a url'],
  ])(
    'refuses a backup that records no database, counting or restoring, with DATABASE_URL %s',
    async (_label, url) => {
      const applied = await applyDate('2026-05-22');
      const repaired = await dump();
      recordDatabase(applied.backupFile, NO_DATABASE);
      process.env.DATABASE_URL = url;
      statements.length = 0;
      getDbSpy.mockClear();

      for (const restore of [false, true]) {
        await expect(
          runUndo({ file: applied.backupFile ?? '', apply: restore }),
        ).rejects.toThrow(/records no usable database name/);
      }

      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(await dump()).toEqual(repaired);
    },
  );

  it('refuses a plan for DATABASE_URL naming no usable database, saying so without echoing it', async () => {
    const planned = await dry({ date: '2026-05-22' });
    process.env.DATABASE_URL =
      'postgres://owner:12/34@ep-plan.neon.tech/neondb';
    statements.length = 0;
    getDbSpy.mockClear();

    const failure = await failureOf(applyFile(planned.planFile));

    expect(failure.message).toMatch(
      /DATABASE_URL names a different database or is not a usable URL/,
    );
    expect(
      leaked(failure.message, planned.planFile ?? '', ['owner', '12', '34']),
    ).toEqual([]);
    expect(getDbSpy).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });
});

describe('a dry run with no usable DATABASE_URL', () => {
  // The unusable ones by shape, each of which the driver would take (with the
  // user or part of the password as the host) and then POST the whole
  // connection string to that host on the first query: refused before getDb().
  const UNUSABLE: Array<[label: string, url: string | undefined]> = [
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
    ...AWKWARD_URLS.filter(([, , , unusable]) => unusable).map(
      ([label, url]): [string, string] => [label, url],
    ),
  ];

  it.each(UNUSABLE)(
    'is refused before getDb() and before any fetch, naming no part of the URL: %s',
    async (_label, url) => {
      if (url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = url;
      getDbSpy.mockClear();

      const failure = await failureOf(dry());

      // The exact fixed text: nothing of the URL can be in it.
      expect(failure.message).toBe(
        'DATABASE_URL is missing or is not a usable database URL. Nothing was read or written.',
      );
      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(plansOnDisk()).toEqual([]);
    },
  );

  it('names the database in its result, the same name the plan file records', async () => {
    const result = await dry({ date: '2026-05-22' });

    expect(result.database).toBe('ep-plan.neon.tech/neondb');
    expect(readJson<{ database: string }>(result.planFile).database).toBe(
      result.database,
    );
  });

  it('writes no plan and names no database when a read fails', async () => {
    failWhen = (text) =>
      /FROM market_snapshots/.test(text) ? new Error('connection lost') : null;

    const failure = await failureOf(dry({ date: '2026-05-22' }));

    expect(failure.message).toMatch(/connection lost/);
    expect(plansOnDisk()).toEqual([]);
  });

  it('names the file’s database in an apply and in an undo', async () => {
    const applied = await applyDate('2026-05-22');
    const undone = await runUndo({
      file: applied.backupFile ?? '',
      apply: false,
    });

    expect(applied.database).toBe('ep-plan.neon.tech/neondb');
    expect(readBackup(applied.backupFile).database).toBe(applied.database);
    expect(undone.database).toBe('ep-plan.neon.tech/neondb');
  });
});

// ── Failure modes ───────────────────────────────────────────────────────────

describe('failures', () => {
  it('skips a date whose history fails, names it, and still repairs the others: exit 1', async () => {
    answers.set(
      '2026-05-04',
      () =>
        new Response(JSON.stringify({ code: 'schwab_fetch_failed' }), {
          status: 502,
        }),
    );

    const result = await applyAll();

    expect(result.dates.find((d) => d.date === '2026-05-04')).toMatchObject({
      source: 'skipped',
      skipped: 'history-failed',
      detail: 'HTTP 502 (schwab_fetch_failed)',
    });
    const after = await dump();
    expect(orOf(after, 24)).toEqual([
      STALE.high,
      STALE.low,
      STALE.consumed,
      STALE.signal,
    ]);
    expect(orOf(after, 25)).toEqual([
      STALE.high,
      STALE.low,
      STALE.consumed,
      STALE.signal,
    ]);
    expect(orOf(after, 14)).toEqual(REPAIRED[14]);
    expect(formatReport(result)).toContain('HTTP 502 (schwab_fetch_failed)');
    expect(exitCodeOf(result)).toBe(1);
  });

  it('stops at once when Schwab is logged out: no plan, nothing written, no backup', async () => {
    answers.set(
      '2026-03-27',
      () =>
        new Response(JSON.stringify({ code: 'schwab_logged_out' }), {
          status: 503,
        }),
    );
    const stored = await dump();

    await expect(applyAll()).rejects.toThrow(/Schwab is logged out/);

    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
    expect(plansOnDisk()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops at once when the owner cookie is refused: nothing written, no backup', async () => {
    answers.set('2026-03-27', () => new Response('no', { status: 401 }));
    const stored = await dump();

    await expect(applyAll()).rejects.toThrow(
      /refused the owner cookie \(HTTP 401\)/,
    );

    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
  });

  it('surfaces a rejected read, writing nothing', async () => {
    failWhen = (text) =>
      /FROM market_snapshots\s+WHERE date = \$1/.test(text)
        ? new Error('relation "market_snapshots" is broken')
        : null;
    const stored = await dump();

    await expect(applyAll()).rejects.toThrow(/market_snapshots" is broken/);

    expect(await dump()).toEqual(stored);
    expect(backups()).toEqual([]);
  });

  it('reports nothing to do when no row has an opening range in the range', async () => {
    await expect(
      dry({ since: '2025-01-01', until: '2025-01-31' }),
    ).rejects.toThrow(/no market_snapshots rows with an opening range/);
  });
});

/**
 * Replace the seed with one row for every minute from `first` to `last`
 * (minutes after midnight CT) on each date, all carrying the previous
 * session's range.
 */
async function seedBulk(
  days: readonly string[],
  first: number,
  last: number,
): Promise<void> {
  await db.query(
    'TRUNCATE market_snapshots, training_features RESTART IDENTITY',
  );
  const dates: string[] = [];
  const entries: string[] = [];
  for (const date of days) {
    for (let minutes = first; minutes <= last; minutes += 1) {
      const hour = Math.floor(minutes / 60);
      const clock = `${hour > 12 ? hour - 12 : hour}:${String(minutes % 60).padStart(2, '0')}`;
      dates.push(date);
      entries.push(`${clock} ${hour >= 12 ? 'PM' : 'AM'} CT`);
    }
  }
  await db.query(
    `INSERT INTO market_snapshots
       (date, entry_time, spx, spx_open, spx_high, spx_low, median_hl_pct,
        opening_range_high, opening_range_low, opening_range_pct_consumed,
        opening_range_signal, cluster_mult, rv_annualized, created_at,
        prev_close)
     SELECT d::date, e, 7195, 7180, 7400, 7000, 0.88, 7170.52, 7130.33,
            0.5, 'MODERATE', 1.05, 0.12, TIMESTAMPTZ '2026-11-24 12:00 UTC',
            7150
       FROM unnest($1::text[], $2::text[]) AS t(d, e)`,
    [dates, entries],
  );
}

/** The seed rows' stored ranges, for "left alone" checks after an apply. */
async function seedOnly(): Promise<Dumped[]> {
  return SEED.map((row, i) => ({
    id: i + 1,
    or: row.or
      ? [row.or[0], row.or[1], row.or[2], row.or[3]]
      : [STALE.high, STALE.low, STALE.consumed, STALE.signal],
  }));
}
