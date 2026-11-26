// @vitest-environment node

/**
 * REAL-SQL test for the snapshot price-context backfill
 * (scripts/backfill-snapshot-price-context.ts -> ./snapshot-price-context.ts).
 *
 * snapshot-price-context.test.ts covers the pure plan. This runs every read
 * and write on pglite (Postgres in WASM), against a market_snapshots table
 * with the production DECIMAL types (api/_lib/db.ts: spx_open, spx_high,
 * spx_low and prev_close DECIMAL(10,2), overnight_gap DECIMAL(6,2)), the
 * `is_backtest` and `created_at` columns the build-features trust rule reads
 * (its SQL text, SNAPSHOT_TRUST_COLUMNS_SQL, runs here against real Postgres,
 * time-zone cases included) and an outcomes table with its settlement
 * DECIMAL(10,2), so rounding, NaN, NULL and the guards behave as they do in
 * Neon. Three module boundaries are replaced:
 * `getDb()` returns a neon-shaped client over pglite, `fetch` serves
 * /api/history from memory (one case uses a real loopback server), and the
 * pause between fetches returns at once. No database, network or sleep is
 * reached.
 *
 * The seed is two dates read from the same page (ids 1-6): a live date whose
 * rows have no open (one stored NaN) and a backtest date whose rows have one.
 * A row dated 2099 must never be read. The settlements of both prior sessions
 * are seeded, equal to the previous closes the stub serves.
 *
 * A dry run writes a plan file; `runApply` applies exactly that file, so most
 * apply cases make a dry run first.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
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

import { neonOverPglite } from '../../api/__tests__/pglite-migrations.js';

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
// Everything else of node:fs is real; a case can make the writing of an apply
// report fail, as a full disk would.
const fsHook = vi.hoisted(() => ({ failApplyReport: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (fsHook.failApplyReport && String(path).includes('apply-')) {
      throw new Error('disk full');
    }
    return (real.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof real.writeFileSync;
  return { ...real, default: { ...real, writeFileSync }, writeFileSync };
});

import { SNAPSHOT_TRUST_COLUMNS_SQL } from '../../api/cron/build-features.js';
import { priorTradingDay } from '../../src/data/marketHours.js';
import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import type { SlotCandle } from '../../src/utils/snapshot-slot.js';
import {
  exitCodeOfApply,
  exitCodeOfDryRun,
  exitCodeOfUndo,
  FETCH_PAUSE_MS,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  historyOrigin,
  runApply,
  runDryRun,
  runUndo,
  toDecimal2,
  WRITE_CHUNK,
  writePlanFile,
  type DatePlan,
} from './snapshot-price-context.js';

type PgSql = ReturnType<typeof neonOverPglite>;

const SECRET = 's3cret-owner-value';
const ORIGIN = 'https://app.example.test';
const LIVE_DATE = '2026-11-05';
const BACKTEST_DATE = '2026-11-06';
const EMPTY_DETAIL =
  "empty history: a Schwab failure, or a date older than Schwab's 5-minute window";

let db: PGlite;
let undoDir: string;
let inner: PgSql;
let progress: MockInstance<typeof console.error>;
/** Rejects a statement whose SQL text and call number it matches. */
let failWhen: ((text: string, n: number) => Error | null) | null = null;
const statements: string[] = [];
/** The row count of each UPDATE, from its first array (the ids). */
const updateSizes: number[] = [];

// ── The history the fetch stub serves ──────────────────────────────────────

const BAR_MS = 5 * 60_000;
const HEAD = [
  { open: 7487, high: 7495, low: 7480, close: 7490 },
  { open: 7490, high: 7502, low: 7488, close: 7500 },
  { open: 7500, high: 7505, low: 7470, close: 7475 },
];
const FLAT = { open: 7475, high: 7476, low: 7474, close: 7475 };
/**
 * The backtest date's session: it opens at 7377.65, the open its replayed rows
 * hold. Through 9:55 ET the high is 7388 and the low 7372; the bar that starts
 * at 10:00 ET reaches 7390.10 and 7370.20, which a row replayed at 9:00 AM CT
 * took, a peek.
 */
const BACKTEST_HEAD = [
  { open: 7377.65, high: 7385, low: 7372, close: 7380 },
  { open: 7380, high: 7388, low: 7375, close: 7386 },
  { open: 7386, high: 7387, low: 7378, close: 7380 },
  { open: 7380, high: 7384, low: 7376, close: 7379 },
  { open: 7379, high: 7383, low: 7377, close: 7381 },
  { open: 7381, high: 7384, low: 7379, close: 7382 },
  { open: 7382, high: 7390.1, low: 7370.2, close: 7385 },
];
const BACKTEST_FLAT = { open: 7385, high: 7386, low: 7384, close: 7385 };

/** A full November session: 9:30 ET is 14:30Z. */
function session(date: string, bars = 78): SlotCandle[] {
  const head = date === BACKTEST_DATE ? BACKTEST_HEAD : HEAD;
  const flat = date === BACKTEST_DATE ? BACKTEST_FLAT : FLAT;
  return Array.from({ length: bars }, (_, i) => ({
    datetime: Date.parse(`${date}T14:30:00Z`) + i * BAR_MS,
    ...(head[i] ?? flat),
  }));
}

/** The close of the session before each target date, where it matters. */
const PRIOR_CLOSE: Record<string, number> = {
  [LIVE_DATE]: 7560.87,
  [BACKTEST_DATE]: 7356.73,
};

function historyJson(
  date: string,
  over: { candles?: unknown; previousDay?: unknown; date?: string } = {},
): string {
  return JSON.stringify({
    date: over.date ?? date,
    spx: {
      candles: over.candles ?? session(date),
      previousClose: 0,
      previousDay:
        over.previousDay === undefined
          ? { date: priorTradingDay(date), close: PRIOR_CLOSE[date] ?? 7500 }
          : over.previousDay,
    },
  });
}

/** What to answer for a date; absent means a good history. */
const answers = new Map<string, () => Response | Promise<Response>>();
const fetchMock = vi.fn<typeof fetch>(async (input) => {
  const url = new URL(String(input));
  const date = url.searchParams.get('date') ?? '';
  const custom = answers.get(date);
  if (custom) return custom();
  return new Response(historyJson(date), { status: 200 });
});

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
      overnight_gap DECIMAL(6,2),
      is_backtest   BOOLEAN DEFAULT FALSE,
      -- The two fields the app leaves empty while it has no current
      -- yesterday; a seed row has both unless it says otherwise.
      cluster_mult  DECIMAL(6,3),
      rv_annualized DECIMAL(8,4),
      -- No default: every seed names its first-save time, so no test reads
      -- the wall clock.
      created_at    TIMESTAMPTZ NOT NULL,
      UNIQUE (date, entry_time)
    )
  `);
  await db.query(`
    CREATE TABLE outcomes (
      id         SERIAL PRIMARY KEY,
      date       DATE NOT NULL UNIQUE,
      settlement DECIMAL(10,2)
    )
  `);
  inner = neonOverPglite(db);
  // Count the statements and fail the ones a test names, then run them.
  const tag = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?');
    statements.push(text);
    if (/UPDATE market_snapshots/.test(text)) {
      updateSizes.push((params[0] as unknown[]).length);
    }
    const error = failWhen?.(text, statements.length) ?? null;
    return error ? Promise.reject(error) : inner(strings, ...params);
  };
  // `sql.query` (the row read) is counted and failed like the tagged template.
  const query = (text: string, params?: unknown[]) => {
    statements.push(text);
    const error = failWhen?.(text, statements.length) ?? null;
    return error ? Promise.reject(error) : inner.query(text, params);
  };
  holder.sql = Object.assign(tag, { query, transaction: inner.transaction });
});

afterAll(async () => {
  await db.close();
});

/**
 * What a seed row says about its save and its spot. By default a row is a live
 * save on its own date at its own slot (a label with no clock time: 8:30 AM),
 * with the spot 7400.00, so build-features trusts it as far as the save goes.
 */
interface SeedOpts {
  /** The stored spot; null stores none. */
  spx?: string | null;
  /** The first save, as CT wall-clock text: `YYYY-MM-DD HH:MM`. */
  savedAtCt?: string;
  /** The first save, as an exact instant: `2026-10-28T05:00:00Z`. */
  createdAt?: string;
  backtest?: boolean;
  /** The stored cluster multiplier; 1.05 by default, null stores none. */
  clusterMult?: string | null;
  /** The stored RV; 0.12 by default, null stores none. */
  rvAnnualized?: string | null;
}

type Seed = [
  date: string,
  entryTime: string,
  open?: string | null,
  high?: string | null,
  low?: string | null,
  prevClose?: string | null,
  gap?: string | null,
  opts?: SeedOpts,
];

const clockText = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

async function seed(rows: readonly Seed[]): Promise<void> {
  for (const [date, time, open, high, low, prev, gap, opts = {}] of rows) {
    const slot = parseEntryTimeMinutes(time);
    const savedAtCt =
      opts.savedAtCt ?? `${date} ${clockText(Number.isNaN(slot) ? 510 : slot)}`;
    await db.query(
      `INSERT INTO market_snapshots
         (date, entry_time, spx, spx_open, spx_high, spx_low, prev_close,
          overnight_gap, is_backtest, cluster_mult, rv_annualized, created_at)
       VALUES ($1::date, $2, $3::numeric, $4::numeric, $5::numeric,
               $6::numeric, $7::numeric, $8::numeric, $9::boolean,
               $12::numeric, $13::numeric,
               COALESCE($10::timestamptz,
                        $11::timestamp AT TIME ZONE 'America/Chicago'))`,
      [
        date,
        time,
        opts.spx === undefined ? '7400.00' : opts.spx,
        open ?? null,
        high ?? null,
        low ?? null,
        prev ?? null,
        gap ?? null,
        opts.backtest ?? false,
        opts.createdAt ?? null,
        savedAtCt,
        opts.clusterMult === undefined ? '1.050' : opts.clusterMult,
        opts.rvAnnualized === undefined ? '0.1200' : opts.rvAnnualized,
      ],
    );
  }
}

/** Ids 1-6 are the seed; id 7 is the 2099 row that must never be read. */
async function seedAll(): Promise<void> {
  await seed([
    [LIVE_DATE, '8:35 AM CT'], // 1: no open
    [LIVE_DATE, '8:40 AM CT', 'NaN'], // 2: a stored NaN open
    [LIVE_DATE, 'pre-market'], // 3: no slot
    // 4: already right, with the high and low as of 9:00 AM CT. -0.977 is
    // stored as -0.98.
    [
      LIVE_DATE,
      '9:00 AM CT',
      '7487.00',
      '7505.00',
      '7470.00',
      '7560.87',
      '-0.98',
    ],
    // 5: a replayed row with the week-early previous close and the peeked
    // high and low.
    [
      BACKTEST_DATE,
      '9:00 AM CT',
      '7377.65',
      '7390.10',
      '7370.20',
      '7720.39',
      '-4.44',
    ],
    [BACKTEST_DATE, '9:30 AM CT', '7377.65'], // 6: open only
    ['2099-01-01', '9:00 AM CT'], // 7: the future
  ]);
  // The stored spot (7400.00, the seed's default) is not part of any plan: it
  // keeps its value.
  await db.query(
    `INSERT INTO outcomes (date, settlement)
     VALUES ('2026-11-04', 7560.87), ('2026-11-05', 7356.73)`,
  );
}

interface Dumped {
  id: number;
  date: string;
  entry_time: string;
  spx: string | null;
  spx_open: string | null;
  spx_high: string | null;
  spx_low: string | null;
  prev_close: string | null;
  overnight_gap: string | null;
}

async function dump(): Promise<Dumped[]> {
  const { rows } = await db.query<Dumped>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, entry_time,
            spx::text AS spx, spx_open::text AS spx_open,
            spx_high::text AS spx_high,
            spx_low::text AS spx_low, prev_close::text AS prev_close,
            overnight_gap::text AS overnight_gap
       FROM market_snapshots ORDER BY id`,
  );
  return rows;
}

const byId = (rows: readonly Dumped[], id: number): Dumped => {
  const found = rows.find((r) => r.id === id);
  if (found == null) throw new Error(`no row ${id}`);
  return found;
};

const dry = (over: { since?: string; until?: string } = {}) =>
  runDryRun({ since: over.since ?? null, until: over.until ?? null, undoDir });
const applyFile = (file: string) => runApply({ file, apply: true, undoDir });
/** A dry run, then an apply of exactly its plan file. */
async function dryThenApply() {
  const planned = await dry();
  const applied = await applyFile(planned.planFile);
  return { planned, applied };
}

const filesIn = (dir: string, prefix: string): string[] =>
  readdirSync(dir).filter((f) => f.startsWith(prefix));

const readJson = (file: string | null) =>
  JSON.parse(readFileSync(file ?? '', 'utf8')) as Record<string, unknown>;

/** The error a run rejects with; a run that does not reject fails the test. */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    return err as Error;
  }
  throw new Error('the run was expected to fail and did not');
}

/**
 * DATABASE_URLs that parse with the user or part of the password where the
 * host should be (`owner:p@ss/34@host/db` gives the host `ss`), which a driver
 * would take and then send the whole connection string to that host. `tokens`
 * are the parts that must not appear in anything printed. A URL with a real
 * host and text after the database name (`.../neondb;password=x`) is not in
 * the table: its host is the host.
 */
const UNUSABLE_BY_SHAPE: Array<[label: string, url: string, tokens: string[]]> =
  [
    [
      'a slash after a numeric password prefix',
      'postgres://owner:12/34@ep-plan.neon.tech/neondb',
      ['owner', '12', '34'],
    ],
    [
      'an @ in the password, then a slash',
      'postgres://owner:p@ss/34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the password, then a question mark',
      'postgres://owner:p@ss?34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the password, then a hash',
      'postgres://owner:p@ss#34@ep-plan.neon.tech/neondb',
      ['owner', 'ss', '34'],
    ],
    [
      'an @ in the user',
      'postgres://ow@ner/34@ep-plan.neon.tech/neondb',
      ['ow', 'ner', '34'],
    ],
    [
      'an @ after the database name',
      'postgres://owner:pw@ep-plan.neon.tech/neondb@x',
      ['owner', 'pw', '@x'],
    ],
    [
      'a line feed inside, which the URL parser drops without a word',
      'postgres://owner:s3\ncret@ep-plan.neon.tech/neondb',
      ['owner', 's3', 'cret'],
    ],
    [
      'a NUL inside',
      'postgres://owner:s3\0cret@ep-plan.neon.tech/neondb',
      ['owner', 's3', 'cret'],
    ],
  ];

const progressLines = (): string[] =>
  progress.mock.calls.map((call) => String(call[0]));

/** A path as the reports print it: forward slashes, whatever the platform. */
const posix = (path: string | null): string =>
  (path ?? '').replaceAll('\\', '/');

const PLAN_DB = 'postgres://owner:pw@ep-plan.neon.tech/neondb';
/** The byte-order mark a Windows editor puts at the start of a file. */
const BOM = String.fromCodePoint(0xfeff);

const env = { ...process.env };

beforeEach(async () => {
  await db.query('TRUNCATE market_snapshots, outcomes RESTART IDENTITY');
  await seedAll();
  undoDir = mkdtempSync(join(tmpdir(), 'price-context-'));
  statements.length = 0;
  updateSizes.length = 0;
  failWhen = null;
  answers.clear();
  fetchMock.mockClear();
  pause.mockClear();
  getDbSpy.mockClear();
  progress = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', fetchMock);
  fsHook.failApplyReport = false;
  process.env.OWNER_SECRET = SECRET;
  process.env.APP_URL = `${ORIGIN}/`;
  process.env.DATABASE_URL = PLAN_DB;
});

afterEach(() => {
  progress.mockRestore();
  vi.unstubAllGlobals();
  process.env = { ...env };
  rmSync(undoDir, { recursive: true, force: true });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('a dry run with no usable DATABASE_URL', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
    ...UNUSABLE_BY_SHAPE.map(([label, url]): [string, string] => [label, url]),
  ])(
    'is refused before getDb() and before any fetch, naming no part of the URL: %s',
    async (_label, url) => {
      if (url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = url;
      getDbSpy.mockClear();

      const failure = await failureOf(dry());

      // The exact fixed text: nothing of the URL can be in it.
      expect(failure.message).toBe(
        'Refusing to run: DATABASE_URL is missing or is not a usable database URL. Nothing was read or written.',
      );
      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(filesIn(undoDir, 'dry-run-')).toEqual([]);
    },
  );

  it('writes no plan file when a read fails: the host is recorded only after the reads succeed', async () => {
    failWhen = (text) =>
      /FROM market_snapshots/.test(text) ? new Error('connection lost') : null;

    const failure = await failureOf(dry());

    expect(failure.message).toMatch(/connection lost/);
    expect(filesIn(undoDir, 'dry-run-')).toEqual([]);
  });
});

describe('a dry run', () => {
  it('plans from the history, writes nothing to the database, and leaves a plan file', async () => {
    const before = await dump();

    const result = await dry();

    expect(await dump()).toEqual(before);
    expect(statements.every((s) => /^\s*SELECT/.test(s))).toBe(true);
    expect(result.dates.map((d) => d.date)).toEqual([LIVE_DATE, BACKTEST_DATE]);
    const planned = result.dates.flatMap((d) =>
      d.results.map((r) => [r.id, r.kind === 'update' ? r.fill : r.reason]),
    );
    expect(planned).toEqual([
      [1, 'all'],
      [2, 'all'],
      [3, 'no-slot'],
      [4, 'unchanged'],
      [5, 'replayed'],
      [6, 'replayed'],
    ]);
    // The NaN row's `before` is the raw text, not NULL.
    const nan = result.dates[0]?.results.find((r) => r.id === 2);
    expect(nan).toMatchObject({
      before: { spx_open: 'NaN', spx_high: null },
      after: { spx_open: '7487.00', overnight_gap: '-0.98' },
    });
    expect(filesIn(undoDir, 'undo-')).toEqual([]);
    const [name] = filesIn(undoDir, 'dry-run-');
    expect(result.planFile).toBe(join(undoDir, name ?? ''));
  });

  it('writes a plan file that carries everything an apply needs, and the range', async () => {
    const result = await dry({ since: LIVE_DATE, until: BACKTEST_DATE });

    const file = readJson(result.planFile);

    expect(file.dbHost).toBe('ep-plan.neon.tech');
    expect(Object.keys(file).sort()).toEqual([
      'createdAt',
      'dbHost',
      'note',
      'report',
      'since',
      'summary',
      'until',
      'updates',
    ]);
    expect(file.since).toBe(LIVE_DATE);
    expect(file.until).toBe(BACKTEST_DATE);
    const updates = file.updates as Array<Record<string, unknown>>;
    expect(updates.map((u) => [u.id, u.fill])).toEqual([
      [1, 'all'],
      [2, 'all'],
      [5, 'replayed'],
      [6, 'replayed'],
    ]);
    expect(updates[1]).toMatchObject({
      date: LIVE_DATE,
      entryTime: '8:40 AM CT',
      before: { spx_open: 'NaN' },
      after: { spx_open: '7487.00' },
    });
    expect(String(file.summary)).toMatch(/^Planned 4 updates\./);
  });

  it('fetches /api/history once per date with the owner cookie, and never follows a redirect', async () => {
    await dry();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/api/history?date=${LIVE_DATE}`,
      `${ORIGIN}/api/history?date=${BACKTEST_DATE}`,
    ]);
    const init = fetchMock.mock.calls[0]?.[1] as {
      headers: { cookie: string };
      redirect: string;
    };
    expect(init.headers.cookie).toBe(`sc-owner=${SECRET}; sc-hint=1`);
    expect(init.redirect).toBe('error');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(FETCH_PAUSE_MS);
  });

  it('never prints or stores the owner secret', async () => {
    const result = await dry();

    expect(formatReport(result)).not.toContain(SECRET);
    expect(readFileSync(result.planFile, 'utf8')).not.toContain(SECRET);
    expect(progressLines().join('\n')).not.toContain(SECRET);
  });

  it('prints a progress line per date to stderr', async () => {
    answers.set(BACKTEST_DATE, () => new Response('nope', { status: 500 }));
    await seed([['2026-11-03', '9:00 AM CT']]); // 8: its history is short
    answers.set(
      '2026-11-03',
      () =>
        new Response(
          historyJson('2026-11-03', { candles: session('2026-11-03', 60) }),
          { status: 200 },
        ),
    );

    await dry();

    expect(progressLines()).toEqual([
      '2026-11-03 skipped short-candles',
      `${LIVE_DATE} fetched`,
      `${BACKTEST_DATE} skipped no-history (HTTP 500)`,
    ]);
  });

  it('names the dates whose feature pick changes', async () => {
    await seed([
      // 8: a live 9:05 save with its open and range, so it is trusted.
      [
        '2026-11-04',
        '9:05 AM CT',
        '7400.00',
        '7410.00',
        '7390.00',
        '7500.00',
        '-1.33',
      ],
      // 9: nearer 10:00, but with no range stored it is not trusted until the
      // plan gives it one that holds its spot.
      [
        '2026-11-04',
        '10:00 AM CT',
        null,
        null,
        null,
        null,
        null,
        { spx: '7490.00' },
      ],
    ]);

    const result = await dry();

    const day = result.dates.find((d) => d.date === '2026-11-04');
    expect(day?.pickChange).toEqual({ from: 8, to: 9 });
    expect(formatReport(result)).toContain('2026-11-04: row 8 -> row 9');
  });

  it('reads each row with its spot and its trust columns', async () => {
    const result = await dry();

    expect(result.dates[0]?.rows[0]).toMatchObject({
      id: 1,
      spx: '7400.00',
      is_backtest: false,
      flag_reliable: true,
      missing_yesterday: false,
      saved_day_offset: 0,
      saved_minutes_ct: 515, // 8:35 AM CT, saved at its own slot
    });
  });

  it('does not let the plan rescue a stale-tab row, read through the real trust SQL', async () => {
    await seed([
      // 8: a trusted live save.
      [
        '2026-11-04',
        '9:05 AM CT',
        '7400.00',
        '7410.00',
        '7390.00',
        '7500.00',
        '-1.33',
      ],
      // 9: says 10:00 AM CT but was saved the next day at 10:01 CT.
      [
        '2026-11-04',
        '10:00 AM CT',
        null,
        null,
        null,
        null,
        null,
        { spx: '7490.00', savedAtCt: '2026-11-05 10:01' },
      ],
    ]);

    const result = await dry();

    const day = result.dates.find((d) => d.date === '2026-11-04');
    expect(day?.results.find((r) => r.id === 9)).toMatchObject({
      kind: 'update',
      fill: 'all',
    });
    expect(day?.rows.find((r) => r.id === 9)).toMatchObject({
      saved_day_offset: 1,
      saved_minutes_ct: 601,
    });
    expect(day?.pickChange).toBeNull();
  });

  // The pick report follows the rule build-features applies: a replayed row
  // with no multiplier is not the date's 10:00 view, even once the plan fills
  // in its range. Without the rule the pick would move from row 8 to the
  // nearer row 9.
  it('does not let the plan rescue a row saved without yesterday’s fields, read through the real trust SQL', async () => {
    await seed([
      // 8: a trusted live save.
      [
        '2026-11-04',
        '9:05 AM CT',
        '7400.00',
        '7410.00',
        '7390.00',
        '7500.00',
        '-1.33',
      ],
      // 9: a replay of the 10:00 slot, first saved on 11-25 after the cutoff,
      // with no multiplier: the app had no current yesterday.
      [
        '2026-11-04',
        '10:00 AM CT',
        null,
        null,
        null,
        null,
        null,
        {
          spx: '7490.00',
          backtest: true,
          savedAtCt: '2026-11-25 14:00',
          clusterMult: null,
        },
      ],
    ]);

    const result = await dry();

    const day = result.dates.find((d) => d.date === '2026-11-04');
    expect(day?.results.find((r) => r.id === 9)).toMatchObject({
      kind: 'update',
      fill: 'all',
    });
    expect(day?.rows.find((r) => r.id === 9)).toMatchObject({
      is_backtest: true,
      flag_reliable: true,
      missing_yesterday: true,
    });
    expect(day?.pickChange).toBeNull();
  });

  it('surfaces a DB error on the row read by name', async () => {
    failWhen = (text) =>
      /FROM market_snapshots/.test(text) && /^\s*SELECT id/.test(text)
        ? new Error('permission denied for table market_snapshots')
        : null;

    await expect(dry()).rejects.toThrow(
      'permission denied for table market_snapshots',
    );
  });

  it('reads only the dates in --since and --until, and never a date after today', async () => {
    await runDryRun({
      since: BACKTEST_DATE,
      until: '2099-12-31',
      undoDir,
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/api/history?date=${BACKTEST_DATE}`,
    ]);
  });

  it('refuses a range with no snapshot rows', async () => {
    await expect(
      runDryRun({ since: '2020-01-01', until: '2020-01-31', undoDir }),
    ).rejects.toThrow(/no market_snapshots rows/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconciles the rows read with the rows planned, left alone and on skipped dates', async () => {
    await seed([['2026-11-03', '9:00 AM CT']]); // 8
    answers.set('2026-11-03', () => new Response('nope', { status: 500 }));

    const result = await dry();

    expect(formatReport(result)).toContain(
      'Reconciliation: 7 rows read = 4 planned + 1 already right + 1 left alone + 1 on skipped dates',
    );
  });

  it('skips a date that is not a trading day before any fetch, and does not call it a failure', async () => {
    await seed([
      ['2026-07-03', '9:00 AM CT'], // Independence Day, observed
      ['2026-11-07', '9:00 AM CT'], // a Saturday
    ]);

    const result = await dry();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/api/history?date=${LIVE_DATE}`,
      `${ORIGIN}/api/history?date=${BACKTEST_DATE}`,
    ]);
    expect(
      result.dates
        .filter((d) => d.skippedDate === 'not-a-trading-day')
        .map((d) => [d.date, d.fetch]),
    ).toEqual([
      ['2026-07-03', 'not-fetched'],
      ['2026-11-07', 'not-fetched'],
    ]);
    // The pause is between fetches only: a date never fetched waits for nothing.
    expect(pause).toHaveBeenCalledTimes(1);
    expect(progressLines()).toEqual([
      '2026-07-03 skipped not-a-trading-day',
      `${LIVE_DATE} fetched`,
      `${BACKTEST_DATE} fetched`,
      '2026-11-07 skipped not-a-trading-day',
    ]);
    expect(exitCodeOfDryRun(result)).toBe(0);
    expect(formatReport(result)).toMatch(
      /not-a-trading-day:\s+2 dates \(2 rows\)/,
    );
  });

  describe('a fetch loop that keeps failing', () => {
    const DAYS = [
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-02',
      '2026-11-03',
    ];
    const failWith = (date: string, status: number) =>
      answers.set(date, () => new Response('nope', { status }));

    beforeEach(async () => {
      await seed(DAYS.map((d): Seed => [d, '9:00 AM CT']));
    });

    it('stops after 5 dates in a row fail with the same detail, and says how many were never tried', async () => {
      for (const d of DAYS) failWith(d, 500);

      const result = await dry();

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(result.dates.map((d) => d.date)).toEqual(DAYS.slice(0, 5));
      expect(result.untried).toEqual([
        '2026-11-02',
        '2026-11-03',
        LIVE_DATE,
        BACKTEST_DATE,
      ]);
      expect(exitCodeOfDryRun(result)).toBe(1);
      const text = formatReport(result);
      expect(text).toContain(
        'WARNING: the fetch loop stopped after 5 dates in a row failed with "HTTP 500"; 4 dates were never tried (their rows were not read): 2026-11-02, 2026-11-03, 2026-11-05, 2026-11-06. The exit code is 1.',
      );
      // The plan of what was tried is still written, with the count in it.
      const file = readJson(result.planFile);
      expect(String(file.summary)).toMatch(/; 4 dates never tried\.$/);
    });

    it('does not stop for failures that differ', async () => {
      [500, 502, 503, 504, 429].forEach((status, i) => {
        failWith(DAYS[i] ?? '', status);
      });

      const result = await dry();

      expect(result.untried).toEqual([]);
      expect(result.dates).toHaveLength(DAYS.length + 2);
    });

    it('does not stop for a success between failures', async () => {
      // Four failures, a success, four failures: never five in a row.
      [0, 1, 2, 3, 5, 6].forEach((i) => {
        failWith(DAYS[i] ?? '', 500);
      });
      failWith(LIVE_DATE, 500);
      failWith(BACKTEST_DATE, 500);

      const result = await dry();

      expect(result.untried).toEqual([]);
      expect(result.dates).toHaveLength(DAYS.length + 2);
    });

    it('lets a date that is not a trading day neither count as a failure nor end the run of them', async () => {
      await seed([['2026-10-31', '9:00 AM CT']]); // a Saturday
      for (const d of [
        '2026-10-28',
        '2026-10-29',
        '2026-10-30',
        '2026-11-02',
        '2026-11-03',
      ]) {
        failWith(d, 500);
      }

      const result = await dry();

      // Three failures, a Saturday that is never fetched, two more: five.
      expect(result.untried).toEqual([LIVE_DATE, BACKTEST_DATE]);
      expect(result.dates.map((d) => d.date)).toContain('2026-10-31');
      expect(exitCodeOfDryRun(result)).toBe(1);
    });

    it('does not stop for an empty history: the old dates of a full run all answer so', async () => {
      for (const d of DAYS) {
        answers.set(
          d,
          () => new Response(historyJson(d, { candles: [] }), { status: 200 }),
        );
      }

      const result = await dry();

      expect(result.untried).toEqual([]);
      expect(result.dates).toHaveLength(DAYS.length + 2);
      expect(exitCodeOfDryRun(result)).toBe(1);
    });
  });
});

// ── The previous close against outcomes.settlement ─────────────────────────

describe('the previous-close cross-check', () => {
  it('reads the settlements of the prior sessions in one read-only query', async () => {
    const result = await dry();

    const reads = statements.filter((s) => /FROM outcomes/.test(s));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^\s*SELECT/);
    expect(
      result.dates.map((d) => [d.date, d.previousClose, d.settlement]),
    ).toEqual([
      [LIVE_DATE, 7560.87, 7560.87],
      [BACKTEST_DATE, 7356.73, 7356.73],
    ]);
    expect(formatReport(result)).toContain(
      'Previous close within 3.00 of outcomes.settlement: 2 dates',
    );
  });

  it('skips a date whose previous close is more than 3.00 from the settlement, and lists both', async () => {
    await db.query(
      "UPDATE outcomes SET settlement = 7550.00 WHERE date = '2026-11-04'",
    );

    const result = await dry();

    expect(result.dates[0]).toMatchObject({
      date: LIVE_DATE,
      skippedDate: 'prev-close-mismatch',
      results: [],
    });
    expect(result.dates[1]?.skippedDate).toBeNull();
    expect(formatReport(result)).toContain(
      `${LIVE_DATE}: previous close 7560.87, settlement 7550.00, difference 10.87`,
    );
    expect(progressLines()).toContain(
      `${LIVE_DATE} skipped prev-close-mismatch`,
    );
    // The planned rows of the other date still reach the plan file.
    const updates = readJson(result.planFile).updates as unknown[];
    expect(updates).toHaveLength(2);
  });

  it('plans a date whose settlement is 0.55 from the previous close, and lists it with the difference', async () => {
    // A fetch-outcomes backfill stores the official close, which is not the
    // 5-minute close /api/history gives as the previous close.
    await db.query(
      "UPDATE outcomes SET settlement = 7561.42 WHERE date = '2026-11-04'",
    );

    const result = await dry();

    expect(result.dates[0]).toMatchObject({
      date: LIVE_DATE,
      skippedDate: null,
      previousClose: 7560.87,
      settlement: 7561.42,
    });
    expect(result.dates[0]?.results.some((r) => r.kind === 'update')).toBe(
      true,
    );
    const text = formatReport(result);
    expect(text).toContain(
      'Previous close within 3.00 of outcomes.settlement: 2 dates',
    );
    expect(text).toContain(`: 1 date: ${LIVE_DATE} (0.55)`);
  });

  it('plans a date with no settlement row, and lists it as not cross-checked', async () => {
    await db.query("DELETE FROM outcomes WHERE date = '2026-11-04'");

    const result = await dry();

    expect(result.dates[0]?.settlement).toBeNull();
    expect(result.dates[0]?.skippedDate).toBeNull();
    expect(formatReport(result)).toMatch(
      /not cross-checked .*planned anyway: 1 date: 2026-11-05/,
    );
  });

  it.each([['NULL'], ["'NaN'"], ['0']])(
    'treats a settlement of %s as missing',
    async (value) => {
      await db.query(
        `UPDATE outcomes SET settlement = ${value} WHERE date = '2026-11-04'`,
      );

      const result = await dry();

      expect(result.dates[0]?.settlement).toBeNull();
      expect(result.dates[0]?.skippedDate).toBeNull();
    },
  );

  it('surfaces a DB error on the settlements read by name', async () => {
    failWhen = (text) =>
      /FROM outcomes/.test(text)
        ? new Error('permission denied for table outcomes')
        : null;

    await expect(dry()).rejects.toThrow('permission denied for table outcomes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── The trust columns: the SQL text build-features shares ───────────────────

describe('SNAPSHOT_TRUST_COLUMNS_SQL', () => {
  interface Trust {
    is_backtest: boolean | null;
    flag_reliable: boolean;
    missing_yesterday: boolean;
    saved_day_offset: number;
    saved_minutes_ct: number;
  }

  /** Seed one row and read the shared text for it, from a real Postgres. */
  async function trustOf(
    date: string,
    opts: SeedOpts,
    entryTime = '10:00 AM CT',
  ): Promise<Trust> {
    await seed([[date, entryTime, null, null, null, null, null, opts]]);
    const { rows } = await db.query<Trust>(
      `SELECT ${SNAPSHOT_TRUST_COLUMNS_SQL}
         FROM market_snapshots
        WHERE date = $1::date AND entry_time = $2`,
      [date, entryTime],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('puts a 23:30 CT save, 05:30Z the next UTC day, on its own CT day at minute 1410', async () => {
    // 2026-11-03 is CST. The UTC date of the instant is the 4th.
    const trust = await trustOf('2026-11-03', {
      createdAt: '2026-11-04T05:30:00Z',
    });

    expect(trust).toMatchObject({
      saved_day_offset: 0,
      saved_minutes_ct: 1410,
    });
  });

  it('reads 15:30Z as 9:30 AM CST (570) after the 2026-11-01 change', async () => {
    const trust = await trustOf('2026-11-02', {
      createdAt: '2026-11-02T15:30:00Z',
    });

    // In CDT the same instant would read 10:30 (630).
    expect(trust).toMatchObject({ saved_day_offset: 0, saved_minutes_ct: 570 });
  });

  it('reads 14:30Z as 9:30 AM CDT (570) before the change', async () => {
    const trust = await trustOf('2026-10-30', {
      createdAt: '2026-10-30T14:30:00Z',
    });

    expect(trust).toMatchObject({ saved_day_offset: 0, saved_minutes_ct: 570 });
  });

  it.each([
    ['04:59Z, the evening of 10-27 CDT, is not reliable', '04:59', false],
    ['05:00Z, 00:00 on 10-28 CDT, is reliable', '05:00', true],
  ])('the flag cutover: %s', async (_label, time, reliable) => {
    const trust = await trustOf('2026-10-28', {
      createdAt: `2026-10-28T${time}:00Z`,
      backtest: true,
    });

    expect(trust).toMatchObject({ is_backtest: true, flag_reliable: reliable });
  });

  // `missing_yesterday`: no multiplier on any date, or no RV on a row first saved
  // at or after MISSING_YESTERDAY_CUTOFF (2026-11-25 00:00 CT, 06:00Z in CST).
  // Every no-multiplier row in production is a pre-market row, which fails the
  // slot test anyway. About 1,300 slot rows, mostly January to August, have no
  // RV from before it was saved on every row, and the rule must not blank their
  // dates: a null RV counts only from the cutoff on.
  it.each<[string, string, SeedOpts, boolean]>([
    [
      'no RV a second before the cutoff',
      '05:59:59',
      { rvAnnualized: null },
      false,
    ],
    ['no RV at the cutoff', '06:00:00', { rvAnnualized: null }, true],
    [
      'no multiplier a second before the cutoff',
      '05:59:59',
      { clusterMult: null },
      true,
    ],
    ['no multiplier at the cutoff', '06:00:00', { clusterMult: null }, true],
    [
      'neither at the cutoff',
      '06:00:00',
      { clusterMult: null, rvAnnualized: null },
      true,
    ],
    ['both present at the cutoff', '06:00:00', {}, false],
  ])(
    'the missing-yesterday rule: %s',
    async (_label, time, fields, missing) => {
      const trust = await trustOf('2026-11-25', {
        createdAt: `2026-11-25T${time}Z`,
        ...fields,
      });

      expect(trust.missing_yesterday).toBe(missing);
    },
  );

  it('keeps a slot row saved before the cutoff with no RV trusted, as it is today', async () => {
    // March: the months of no-RV rows.
    const trust = await trustOf('2026-03-10', {
      createdAt: '2026-03-10T16:00:00Z',
      rvAnnualized: null,
    });

    expect(trust.missing_yesterday).toBe(false);
  });

  it.each([
    ['no multiplier', { clusterMult: null }],
    ['neither', { clusterMult: null, rvAnnualized: null }],
  ])(
    'rejects a row with %s whatever its date: an old row rewritten without yesterday',
    async (_label, fields) => {
      const trust = await trustOf('2026-03-10', {
        createdAt: '2026-03-10T16:00:00Z',
        ...fields,
      });

      expect(trust.missing_yesterday).toBe(true);
    },
  );

  it.each([
    ['a second before the cutoff', '2026-11-25T05:59:59Z', false],
    ['at the cutoff', '2026-11-25T06:00:00Z', true],
  ])(
    'reads the cutoff on the Chicago clock whatever the session time zone is, %s',
    async (_label, createdAt, missing) => {
      await seed([
        [
          '2026-11-25',
          '10:00 AM CT',
          null,
          null,
          null,
          null,
          null,
          { createdAt, rvAnnualized: null },
        ],
      ]);
      await db.query("SET TIME ZONE 'Asia/Tokyo'");
      try {
        const { rows } = await db.query<Trust>(
          `SELECT ${SNAPSHOT_TRUST_COLUMNS_SQL}
             FROM market_snapshots WHERE date = '2026-11-25'`,
        );

        expect(rows[0]?.missing_yesterday).toBe(missing);
      } finally {
        await db.query('RESET TIME ZONE');
      }
    },
  );

  it.each([
    [
      'a save the day before its date',
      '2026-11-03',
      '2026-11-02T20:00:00Z',
      -1,
      840,
    ],
    ['a save three days later', '2026-11-02', '2026-11-05T15:30:00Z', 3, 570],
  ])(
    'counts the CT days between the date and the save: %s',
    async (_l, date, at, days, minutes) => {
      const trust = await trustOf(date, { createdAt: at });

      expect(trust).toMatchObject({
        saved_day_offset: days,
        saved_minutes_ct: minutes,
      });
    },
  );

  it('gives the same answers whatever the session time zone is', async () => {
    await seed([
      [
        '2026-11-03',
        '10:00 AM CT',
        null,
        null,
        null,
        null,
        null,
        { createdAt: '2026-11-04T05:30:00Z' },
      ],
    ]);
    const read = () =>
      db.query<Trust>(
        `SELECT ${SNAPSHOT_TRUST_COLUMNS_SQL}
           FROM market_snapshots WHERE date = '2026-11-03'`,
      );
    await db.query("SET TIME ZONE 'Asia/Tokyo'");
    try {
      const { rows } = await read();

      expect(rows[0]).toMatchObject({
        flag_reliable: true,
        saved_day_offset: 0,
        saved_minutes_ct: 1410,
      });
    } finally {
      await db.query('RESET TIME ZONE');
    }
  });

  it('is false for is_backtest on a live row, and passes a backtest row through', async () => {
    const live = await trustOf('2026-11-03', {
      createdAt: '2026-11-03T16:00:00Z',
    });
    const replayed = await trustOf(
      '2026-11-04',
      { createdAt: '2026-11-05T01:00:00Z', backtest: true },
      '9:55 AM CT',
    );

    expect(live.is_backtest).toBe(false);
    expect(replayed.is_backtest).toBe(true);
  });
});

// ── The history fetch fails (R4) ────────────────────────────────────────────

describe('a history fetch that goes wrong', () => {
  beforeEach(async () => {
    await seed([['2026-11-03', '9:00 AM CT']]); // id 8
  });

  it('a 500 skips that date, is named in the report, and makes the exit code 1', async () => {
    answers.set(
      '2026-11-03',
      () => new Response('{"error":"boom"}', { status: 500 }),
    );

    const result = await dry();

    const day = result.dates.find((d) => d.date === '2026-11-03');
    expect(day).toMatchObject({
      fetch: 'failed',
      fetchDetail: 'HTTP 500',
      skippedDate: 'no-history',
      results: [],
    });
    // The other dates are still planned.
    expect(result.dates.flatMap((d) => d.results).length).toBe(6);
    expect(exitCodeOfDryRun(result)).toBe(1);
    const text = formatReport(result);
    expect(text).toContain('HTTP 500 (1 date): 2026-11-03');
    expect(text).toMatch(/history fetch failed:\s+1 date/);
  });

  it('a body that is not JSON is named, and makes the exit code 1', async () => {
    answers.set(
      '2026-11-03',
      () => new Response('<html>502</html>', { status: 200 }),
    );

    const result = await dry();

    expect(result.dates[0]).toMatchObject({
      date: '2026-11-03',
      fetch: 'failed',
      fetchDetail: expect.stringContaining('not JSON'),
    });
    expect(exitCodeOfDryRun(result)).toBe(1);
    expect(formatReport(result)).toContain('not JSON');
  });

  it('a request that throws is named, and the secret is redacted from it', async () => {
    answers.set('2026-11-03', () => {
      throw new Error(`connect ECONNRESET while sending ${SECRET}`);
    });

    const result = await dry();

    const day = result.dates[0];
    expect(day?.fetch).toBe('failed');
    expect(day?.fetchDetail).toContain('request failed: connect ECONNRESET');
    expect(day?.fetchDetail).not.toContain(SECRET);
    expect(day?.fetchDetail).toContain('[redacted]');
    expect(exitCodeOfDryRun(result)).toBe(1);
  });

  it('an empty answer is a failure, not "no data": it names both causes and exits 1', async () => {
    answers.set(
      '2026-11-03',
      () =>
        new Response(historyJson('2026-11-03', { candles: [] }), {
          status: 200,
        }),
    );

    const result = await dry();

    expect(result.dates[0]).toMatchObject({
      date: '2026-11-03',
      fetch: 'failed',
      fetchDetail: EMPTY_DETAIL,
      skippedDate: 'no-history',
    });
    expect(exitCodeOfDryRun(result)).toBe(1);
    const text = formatReport(result);
    expect(text).toContain(`${EMPTY_DETAIL} (1 date): 2026-11-03`);
    expect(text).toContain(
      "A re-run will not help for a date older than Schwab's 5-minute window",
    );
  });

  it('candles that do not ascend are a named failure', async () => {
    const candles = session('2026-11-03');
    candles.splice(5, 1, candles[4] as SlotCandle);
    answers.set(
      '2026-11-03',
      () =>
        new Response(historyJson('2026-11-03', { candles }), { status: 200 }),
    );

    const result = await dry();

    expect(result.dates[0]?.fetchDetail).toMatch(/strictly ascending/);
    expect(exitCodeOfDryRun(result)).toBe(1);
  });

  it('a response for another date is a failure, not a plan', async () => {
    answers.set(
      '2026-11-03',
      () =>
        new Response(historyJson('2026-11-03', { date: LIVE_DATE }), {
          status: 200,
        }),
    );

    const result = await dry();

    expect(result.dates[0]?.fetchDetail).toContain(
      `for ${LIVE_DATE}, not 2026-11-03`,
    );
    expect(exitCodeOfDryRun(result)).toBe(1);
  });

  it('a refused cookie stops the run before anything is read further or written', async () => {
    answers.set('2026-11-03', () => new Response('{}', { status: 401 }));

    const run = dry();

    await expect(run).rejects.toThrow(/answered 401.*OWNER_SECRET/);
    await expect(run).rejects.not.toThrow(SECRET);
    expect(readdirSync(undoDir)).toEqual([]);
    expect(statements.some((s) => /UPDATE/.test(s))).toBe(false);
  });

  // The Schwab login lapsed on 2026-11-18: /api/history answered 200 with no
  // candles, and a dry run read every date as "empty history". It now answers
  // 503 schwab_logged_out, and every later date would fail the same way.
  describe('when /api/history says Schwab is logged out', () => {
    const LOGGED_OUT = () =>
      new Response(
        JSON.stringify({
          error:
            'Schwab is logged out. The owner needs to log in to Schwab again.',
          code: 'schwab_logged_out',
        }),
        { status: 503 },
      );
    const fetchedDates = () =>
      fetchMock.mock.calls.map((call) =>
        new URL(String(call[0])).searchParams.get('date'),
      );

    it('stops the run at that date, names the cause, and writes nothing', async () => {
      answers.set('2026-11-03', LOGGED_OUT);

      const run = dry();

      await expect(run).rejects.toThrow(
        'Refusing to go on. 2026-11-03: Schwab is logged out (/api/history answered 503). Log in to Schwab, then re-run. Nothing was written.',
      );
      await expect(run).rejects.not.toThrow(SECRET);
      expect(fetchedDates()).toEqual(['2026-11-03']);
      expect(pause).not.toHaveBeenCalled();
      expect(readdirSync(undoDir)).toEqual([]);
      expect(statements.some((s) => /UPDATE/.test(s))).toBe(false);
    });

    it('stops before the dates after it are fetched, whatever came before', async () => {
      answers.set(LIVE_DATE, LOGGED_OUT);

      await expect(dry()).rejects.toThrow(
        `Refusing to go on. ${LIVE_DATE}: Schwab is logged out`,
      );
      expect(fetchedDates()).toEqual(['2026-11-03', LIVE_DATE]);
      expect(readdirSync(undoDir)).toEqual([]);
    });

    it('leaves a 502 a failure of that date alone, with the code in the report', async () => {
      answers.set(
        '2026-11-03',
        () =>
          new Response(
            JSON.stringify({
              error: 'Schwab history fetch failed',
              code: 'schwab_fetch_failed',
            }),
            { status: 502 },
          ),
      );

      const result = await dry();

      expect(result.dates.find((d) => d.date === '2026-11-03')).toMatchObject({
        fetch: 'failed',
        fetchDetail: 'HTTP 502 (schwab_fetch_failed)',
        skippedDate: 'no-history',
      });
      // Every other date was still fetched and planned.
      expect(fetchedDates()).toEqual(['2026-11-03', LIVE_DATE, BACKTEST_DATE]);
      expect(result.dates.flatMap((d) => d.results).length).toBe(6);
      expect(exitCodeOfDryRun(result)).toBe(1);
      expect(formatReport(result)).toContain(
        'HTTP 502 (schwab_fetch_failed) (1 date): 2026-11-03',
      );
    });
  });
});

describe('a redirect from the history endpoint', () => {
  it('is a named per-date failure, and the cookie is not sent on', async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.cookie);
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      // The real fetch, to a loopback server: http is allowed on 127.0.0.1.
      vi.unstubAllGlobals();
      process.env.APP_URL = `http://127.0.0.1:${port}`;

      const result = await dry();

      expect(result.dates.map((d) => d.fetch)).toEqual(['failed', 'failed']);
      expect(result.dates[0]?.fetchDetail).toMatch(/redirect/i);
      expect(exitCodeOfDryRun(result)).toBe(1);
      // One request per date: the redirect was never followed.
      expect(seen).toHaveLength(2);
      expect(`${seen[0]}`).toContain(`sc-owner=${SECRET}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('a date whose candles do not fit', () => {
  it('skips a short date whole and a bad bar per row, and says which', async () => {
    await seed([
      ['2026-11-03', '9:00 AM CT'], // 8: short
      ['2026-11-02', '8:35 AM CT'], // 9: filled
      ['2026-11-02', '9:10 AM CT'], // 10: bad-candles
    ]);
    answers.set(
      '2026-11-03',
      () =>
        new Response(
          historyJson('2026-11-03', { candles: session('2026-11-03', 77) }),
          { status: 200 },
        ),
    );
    answers.set('2026-11-02', () => {
      const candles = session('2026-11-02').map((c, i) =>
        i === 6 ? { ...c, high: null } : c,
      );
      return new Response(historyJson('2026-11-02', { candles }), {
        status: 200,
      });
    });

    const result = await dry();
    const text = formatReport(result);

    expect(result.dates.find((d) => d.date === '2026-11-03')?.skippedDate).toBe(
      'short-candles',
    );
    const split = result.dates.find((d) => d.date === '2026-11-02');
    expect(
      split?.results.map((r) => [
        r.id,
        r.kind === 'update' ? 'update' : r.reason,
      ]),
    ).toEqual([
      [9, 'update'],
      [10, 'bad-candles'],
    ]);
    expect(text).toMatch(/WARNING: 1 row skipped as bad-candles/);
    expect(text).toContain('2026-11-02: 10');
    expect(text).toMatch(/short-candles:\s+1 date/);
    expect(exitCodeOfDryRun(result)).toBe(0);
  });

  it('skips a date whose previous day is two sessions back', async () => {
    answers.set(
      BACKTEST_DATE,
      () =>
        new Response(
          historyJson(BACKTEST_DATE, {
            previousDay: { date: '2026-11-04', close: 7560.87 },
          }),
          { status: 200 },
        ),
    );

    const result = await dry();

    expect(result.dates.find((d) => d.date === BACKTEST_DATE)).toMatchObject({
      skippedDate: 'no-previous-day',
      results: [],
    });
    expect(formatReport(result)).toMatch(/no-previous-day:\s+1 date/);
  });

  it('skips a date whose previous close gives a gap no column holds, and never writes it', async () => {
    answers.set(
      BACKTEST_DATE,
      () =>
        new Response(
          historyJson(BACKTEST_DATE, {
            previousDay: { date: '2026-11-05', close: 0.5 },
          }),
          { status: 200 },
        ),
    );
    await db.query("DELETE FROM outcomes WHERE date = '2026-11-05'");

    const { planned, applied } = await dryThenApply();

    expect(planned.dates[1]?.skippedDate).toBe('bad-previous-close');
    expect(applied.written).toBe(2);
    expect(byId(await dump(), 5).prev_close).toBe('7720.39');
  });
});

// ── A replayed row: the peek, the mismatch, the bad candles ─────────────────

describe('a replayed row', () => {
  it('loses the 5-minute peek: its high and low become the values as of its slot', async () => {
    const { planned, applied } = await dryThenApply();

    const row5 = planned.dates
      .flatMap((d) => d.results)
      .find((r) => r.id === 5);
    expect(row5).toMatchObject({
      kind: 'update',
      fill: 'replayed',
      before: { spx_high: '7390.10', spx_low: '7370.20' },
      after: { spx_high: '7388.00', spx_low: '7372.00' },
      guardOpen: '7377.65',
    });
    expect(applied.written).toBe(4);
    const report = formatReport(planned);
    expect(report).toContain(
      'Replayed rows whose high or low narrowed: 1 (high 1, low 1)',
    );
    expect(report).toMatch(
      /spx_high\s+fill 3, overwrite 1 \(same 0, <=0\.05 0, <=1 0, >1 1\), largest change 2\.10 \(id 5, 2026-11-06\)/,
    );
    expect(report).toContain(
      'id 5 2026-11-06 9:00 AM CT: spx_high 7390.10 -> 7388.00, spx_low 7370.20 -> 7372.00',
    );
  });

  it('is a replayed row at 8:30 AM CT too: its high and low are its open', async () => {
    await seed([
      [
        BACKTEST_DATE,
        '8:30 AM CT',
        '7377.65',
        '7385.00',
        '7372.00',
        '7356.73',
        '0.28',
      ],
    ]); // 8

    const { applied } = await dryThenApply();

    expect(applied.written).toBe(5);
    expect(byId(await dump(), 8)).toMatchObject({
      spx_open: '7377.65',
      spx_high: '7377.65',
      spx_low: '7377.65',
    });
  });

  it('takes a peeked high alone', async () => {
    await seed([
      // The high is the peek; the low is already right.
      [
        BACKTEST_DATE,
        '9:01 AM CT',
        '7377.65',
        '7390.10',
        '7372.00',
        '7356.73',
        '0.28',
      ], // 8
    ]);
    const planned = await dry();

    const row8 = planned.dates
      .flatMap((d) => d.results)
      .find((r) => r.id === 8);
    expect(row8).toMatchObject({
      kind: 'update',
      fill: 'replayed',
      before: { spx_high: '7390.10', spx_low: '7372.00' },
      after: { spx_high: '7388.00', spx_low: '7372.00' },
    });
  });

  it('is skipped as open-mismatch when its stored open is not the open as of its slot: both opens listed, nothing written', async () => {
    await seed([
      [
        LIVE_DATE,
        '9:05 AM CT',
        '7400.00',
        '7405.00',
        '7399.00',
        '7000.00',
        '-1.00',
      ],
    ]); // 8

    const { planned, applied } = await dryThenApply();

    const mismatch = planned.dates
      .flatMap((d) => d.results)
      .find((r) => r.id === 8);
    expect(mismatch).toEqual({
      kind: 'skip',
      id: 8,
      reason: 'open-mismatch',
      detail: 'stored 7400.00, as of the slot 7487.00',
    });
    expect(formatReport(planned)).toContain(
      `${LIVE_DATE}: 8 (stored 7400.00, as of the slot 7487.00)`,
    );
    expect(applied.planned).toBe(4);
    expect(byId(await dump(), 8)).toMatchObject({
      spx_open: '7400.00',
      spx_high: '7405.00',
      spx_low: '7399.00',
      prev_close: '7000.00',
      overnight_gap: '-1.00',
    });
  });

  describe('whose candles are bad', () => {
    const DAY = '2026-11-04';

    beforeEach(async () => {
      // 10:10 ET: the bar that starts at 10:00 ET has ended, and its high is
      // unusable, so this slot's high cannot be known.
      await seed([
        [
          DAY,
          '9:10 AM CT',
          '7487.00',
          '7510.00',
          '7470.00',
          '7001.00',
          '-2.00',
        ],
      ]); // 8
      answers.set(DAY, () => {
        const candles = session(DAY).map((c, i) =>
          i === 6 ? { ...c, high: null } : c,
        );
        return new Response(historyJson(DAY, { candles }), { status: 200 });
      });
    });
    const dayOnly = () => dry({ since: DAY, until: DAY });

    it('plans only its previous close and gap, leaves its high and low, and names it', async () => {
      const planned = await dayOnly();
      const applied = await applyFile(planned.planFile);

      expect(planned.dates[0]?.results).toEqual([
        {
          kind: 'update',
          id: 8,
          fill: 'close-and-gap',
          before: { prev_close: '7001.00', overnight_gap: '-2.00' },
          after: { prev_close: '7500.00', overnight_gap: '-0.17' },
          guardOpen: '7487.00',
        },
      ]);
      expect(applied.written).toBe(1);
      expect(byId(await dump(), 8)).toMatchObject({
        spx_open: '7487.00',
        spx_high: '7510.00',
        spx_low: '7470.00',
        prev_close: '7500.00',
        overnight_gap: '-0.17',
      });
      const report = formatReport(planned);
      expect(report).toContain(
        'WARNING: 1 row with an open: high/low left as stored (bad candles); only the previous close and gap are planned.',
      );
      expect(report).toContain(`${DAY}: 8`);
    });

    it.each(['prev_close', 'overnight_gap', 'spx_open'])(
      'skips the row, and lists it, when %s changed since the dry run',
      async (column) => {
        const planned = await dayOnly();
        const before = byId(await dump(), 8);
        await db.query(
          `UPDATE market_snapshots SET ${column} = 123.45 WHERE id = 8`,
        );

        const applied = await applyFile(planned.planFile);

        expect(applied.unwrittenIds).toEqual([8]);
        expect(byId(await dump(), 8)).toEqual({
          ...before,
          [column]: '123.45',
        });
      },
    );

    it('is not blocked by the high or low it leaves, which no update writes', async () => {
      const planned = await dayOnly();
      await db.query(
        'UPDATE market_snapshots SET spx_high = 7999 WHERE id = 8',
      );

      const applied = await applyFile(planned.planFile);

      expect(applied.written).toBe(1);
      expect(byId(await dump(), 8)).toMatchObject({
        spx_high: '7999.00',
        prev_close: '7500.00',
      });
    });

    it('is already applied on a second run, which writes nothing', async () => {
      const planned = await dayOnly();
      await applyFile(planned.planFile);
      const once = byId(await dump(), 8);

      const again = await applyFile(planned.planFile);

      expect(again).toMatchObject({
        written: 0,
        alreadyAppliedIds: [8],
        unwrittenIds: [],
      });
      expect(exitCodeOfApply(again)).toBe(0);
      expect(byId(await dump(), 8)).toEqual(once);
    });

    it.each(['prev_close', 'overnight_gap'])(
      'is not already applied when its %s is no longer the plan’s, though the other one is',
      async (column) => {
        const planned = await dayOnly();
        await applyFile(planned.planFile);
        await db.query(
          `UPDATE market_snapshots SET ${column} = 123.45 WHERE id = 8`,
        );

        const again = await applyFile(planned.planFile);

        expect(again).toMatchObject({
          written: 0,
          alreadyAppliedIds: [],
          unwrittenIds: [8],
        });
        expect(exitCodeOfApply(again)).toBe(1);
      },
    );

    it('restores its previous close and gap, leaving the high and low it never wrote', async () => {
      const planned = await dayOnly();
      const applied = await applyFile(planned.planFile);
      expect(byId(await dump(), 8)).toMatchObject({
        prev_close: '7500.00',
        overnight_gap: '-0.17',
      });

      const undone = await runUndo({
        file: applied.undoFile ?? '',
        apply: true,
      });

      expect(undone).toMatchObject({ rows: 1, restored: 1, changedIds: [] });
      expect(byId(await dump(), 8)).toMatchObject({
        spx_open: '7487.00',
        spx_high: '7510.00',
        spx_low: '7470.00',
        prev_close: '7001.00',
        overnight_gap: '-2.00',
      });
    });

    it('restores under the reverse guard, the open included', async () => {
      const planned = await dayOnly();
      const applied = await applyFile(planned.planFile);
      await db.query(
        'UPDATE market_snapshots SET spx_open = 7000 WHERE id = 8',
      );

      const undone = await runUndo({
        file: applied.undoFile ?? '',
        apply: true,
      });

      expect(undone).toMatchObject({ rows: 1, restored: 0, changedIds: [8] });
    });
  });
});

// ── The last date the script covers ─────────────────────────────────────────

describe('the last date the script covers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never reads a date after 2026-11-18, whatever today is, or what --until says', async () => {
    // A live row dated 2026-11-19 or later carries the quote's real-time open,
    // high and low: a value built from candles must never overwrite them.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T18:00:00Z'));
    await seed([
      ['2026-11-18', '9:00 AM CT'], // 8
      ['2026-11-19', '9:00 AM CT'], // 9
      ['2026-11-30', '9:00 AM CT'], // 10
    ]);

    const byDefault = await runDryRun({ since: null, until: null, undoDir });
    vi.setSystemTime(new Date('2026-12-01T18:00:01Z'));
    const asked = await runDryRun({
      since: null,
      until: '2026-12-31',
      undoDir,
    });

    for (const result of [byDefault, asked]) {
      expect(result.until).toBe('2026-11-18');
      expect(result.dates.map((d) => d.date)).toEqual([
        LIVE_DATE,
        BACKTEST_DATE,
        '2026-11-18',
      ]);
    }
    expect(
      fetchMock.mock.calls.some(([url]) => /2026-11-(19|30)/.test(String(url))),
    ).toBe(false);
    expect(readJson(byDefault.planFile).until).toBe('2026-11-18');
  });

  it('still stops at today when today is before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T22:00:00Z'));
    await seed([['2026-11-09', '9:00 AM CT']]);

    const result = await runDryRun({ since: null, until: null, undoDir });

    expect(result.until).toBe('2026-11-06');
    expect(result.dates.map((d) => d.date)).toEqual([LIVE_DATE, BACKTEST_DATE]);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('a run that cannot start', () => {
  it.each([
    [
      'OWNER_SECRET is unset',
      () => delete process.env.OWNER_SECRET,
      /OWNER_SECRET is not set/,
    ],
    [
      'APP_URL is unset',
      () => delete process.env.APP_URL,
      /APP_URL is not set/,
    ],
    [
      'APP_URL is not a URL',
      () => {
        process.env.APP_URL = 'not a url';
      },
      /APP_URL is not a URL/,
    ],
    [
      'APP_URL is plain http on another host',
      () => {
        process.env.APP_URL = 'http://app.example.test';
      },
      /APP_URL must be https/,
    ],
  ])(
    'refuses when %s, naming the variable and never the secret',
    async (_name, change, message) => {
      change();

      const run = dry();

      await expect(run).rejects.toThrow(message);
      await expect(run).rejects.not.toThrow(SECRET);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
    },
  );

  it('takes plain http on localhost, for a local dev server', async () => {
    process.env.APP_URL = 'http://localhost:3000';

    await dry();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://localhost:3000/api/history?date=${LIVE_DATE}`,
    );
  });

  it('surfaces a DB error on the read by name', async () => {
    failWhen = (text) =>
      text.includes('SELECT DISTINCT')
        ? new Error('permission denied for table market_snapshots')
        : null;

    await expect(dry()).rejects.toThrow(
      'permission denied for table market_snapshots',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('historyOrigin', () => {
  it('is the hostname only, never the path, the port or the cookie', () => {
    expect(
      historyOrigin({
        OWNER_SECRET: SECRET,
        APP_URL: 'https://app.example.test:8443/some/path',
      }),
    ).toBe('app.example.test');
  });

  it('refuses what the run refuses', () => {
    expect(() => historyOrigin({ APP_URL: ORIGIN })).toThrow(
      /OWNER_SECRET is not set/,
    );
    expect(() =>
      historyOrigin({ OWNER_SECRET: SECRET, APP_URL: 'http://example.test' }),
    ).toThrow(/APP_URL must be https/);
  });
});

// ── Apply: exactly the reviewed plan ────────────────────────────────────────

describe('applying a plan file', () => {
  it('writes the planned values at the column scale, an undo file first, and an apply report', async () => {
    const { planned, applied } = await dryThenApply();

    expect(applied).toMatchObject({
      apply: true,
      file: planned.planFile,
      planned: 4,
      written: 4,
      unwrittenIds: [],
    });
    const rows = await dump();
    expect(byId(rows, 1)).toMatchObject({
      spx_open: '7487.00',
      spx_high: '7495.00',
      spx_low: '7480.00',
      prev_close: '7560.87',
      overnight_gap: '-0.98',
    });
    // The NaN row is filled like a NULL one.
    expect(byId(rows, 2)).toMatchObject({
      spx_open: '7487.00',
      spx_high: '7502.00',
      spx_low: '7480.00',
      prev_close: '7560.87',
    });
    // A replayed row loses the 5-minute peek: its high and low are the values
    // as of 9:00 AM CT, not through the bar that starts then (7390.10 and
    // 7370.20). Its open is the as-of open and is never written.
    expect(byId(rows, 5)).toMatchObject({
      spx_open: '7377.65',
      spx_high: '7388.00',
      spx_low: '7372.00',
      prev_close: '7356.73',
      overnight_gap: '0.28',
    });
    // One with no high or low yet gets them as of its slot, 9:30 AM CT, when
    // the bar that starts at 10:00 ET has ended.
    expect(byId(rows, 6)).toMatchObject({
      spx_open: '7377.65',
      spx_high: '7390.10',
      spx_low: '7370.20',
      prev_close: '7356.73',
      overnight_gap: '0.28',
    });
    // Left alone: no slot, already right, and the future.
    expect(byId(rows, 3).spx_open).toBeNull();
    expect(byId(rows, 7).prev_close).toBeNull();
    // The stored spot is no plan's business: every row keeps it.
    expect(rows.map((r) => r.spx)).toEqual(Array(7).fill('7400.00'));

    const [name] = filesIn(undoDir, 'undo-');
    expect(applied.undoFile).toBe(join(undoDir, name ?? ''));
    const undo = readJson(applied.undoFile);
    const undoRows = undo.rows as Array<{
      id: number;
      before: Record<string, unknown>;
    }>;
    expect(undoRows).toHaveLength(4);
    // The raw NaN is kept as text, not turned into null by JSON.
    expect(undoRows.find((r) => r.id === 2)?.before.spx_open).toBe('NaN');
    expect(undoRows.find((r) => r.id === 1)?.before.spx_open).toBeNull();

    const [reportName] = filesIn(undoDir, 'apply-');
    expect(applied.reportFile).toBe(join(undoDir, reportName ?? ''));
    expect(readJson(applied.reportFile)).toMatchObject({
      planFile: planned.planFile,
      undoFile: applied.undoFile,
      planned: 4,
      written: 4,
      unwrittenIds: [],
      error: null,
    });
    const text = formatApplyReport(applied);
    expect(text).toContain(`Undo file: ${posix(applied.undoFile)}`);
    expect(text).toContain(`Apply report: ${posix(applied.reportFile)}`);
    expect(exitCodeOfApply(applied)).toBe(0);
  });

  it('needs no OWNER_SECRET, fetches nothing, and reads no snapshot table', async () => {
    const planned = await dry();
    fetchMock.mockClear();
    statements.length = 0;
    delete process.env.OWNER_SECRET;
    delete process.env.APP_URL;

    const applied = await applyFile(planned.planFile);

    expect(applied.written).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statements.every((s) => /UPDATE market_snapshots/.test(s))).toBe(
      true,
    );
  });

  it('writes only the rows of the plan, not a row that arrived after the dry run', async () => {
    const planned = await dry();
    await seed([[LIVE_DATE, '9:30 AM CT']]); // 8: a re-plan would fill it

    const applied = await applyFile(planned.planFile);

    expect(applied.planned).toBe(4);
    expect(byId(await dump(), 8)).toMatchObject({
      spx_open: null,
      prev_close: null,
    });
  });

  it('skips a plan row that changed since the dry run, lists it, and exits 1', async () => {
    const planned = await dry();
    await db.query('UPDATE market_snapshots SET spx_open = 7000 WHERE id = 1');

    const applied = await applyFile(planned.planFile);

    expect(applied).toMatchObject({
      planned: 4,
      written: 3,
      unwrittenIds: [1],
    });
    expect(exitCodeOfApply(applied)).toBe(1);
    const rows = await dump();
    // Nothing of the plan reached row 1: its guard failed on spx_open.
    expect(byId(rows, 1)).toMatchObject({
      spx_open: '7000.00',
      spx_high: null,
      prev_close: null,
    });
    expect(byId(rows, 2).spx_open).toBe('7487.00');
    expect(formatApplyReport(applied)).toMatch(
      /1 planned row was not written: it did not match the plan's before values.*Ids: 1\. The exit code is 1\. Run a fresh dry run\./,
    );
    expect(readJson(applied.reportFile)).toMatchObject({
      written: 3,
      unwrittenIds: [1],
    });
  });

  describe('a plan applied twice, or a narrower plan and then the whole one', () => {
    it('counts the rows an earlier apply wrote as already applied, not as changed, and exits 0', async () => {
      const planned = await dry();
      await applyFile(planned.planFile);

      const again = await applyFile(planned.planFile);

      expect(again).toMatchObject({
        planned: 4,
        written: 0,
        alreadyAppliedIds: [1, 2, 5, 6],
        unwrittenIds: [],
        checkError: null,
      });
      expect(exitCodeOfApply(again)).toBe(0);
      const text = formatApplyReport(again);
      expect(text).toContain(
        "Rows already applied (they hold the plan's after values already): 4: 1, 2, 5, 6",
      );
      expect(text).not.toContain('WARNING');
      expect(text.trimEnd().split('\n').at(-1)).toBe(
        'Planned 4 rows; written 0; already applied 4; not written 0.',
      );
      expect(readJson(again.reportFile)).toMatchObject({
        written: 0,
        alreadyAppliedIds: [1, 2, 5, 6],
        unwrittenIds: [],
      });
    });

    it('applies the rest of the whole plan after a one-date plan, and exits 0', async () => {
      const narrow = await dry({ since: LIVE_DATE, until: LIVE_DATE });
      const whole = await dry();
      expect(await applyFile(narrow.planFile)).toMatchObject({ written: 2 });

      const rest = await applyFile(whole.planFile);

      expect(rest).toMatchObject({
        planned: 4,
        written: 2,
        alreadyAppliedIds: [1, 2],
        unwrittenIds: [],
      });
      expect(exitCodeOfApply(rest)).toBe(0);
      expect(byId(await dump(), 5).prev_close).toBe('7356.73');
    });

    it('still lists, and exits 1 for, a row that holds neither the plan before values nor its after values', async () => {
      const planned = await dry();
      await applyFile(planned.planFile);
      await db.query('UPDATE market_snapshots SET prev_close = 1 WHERE id = 5');

      const again = await applyFile(planned.planFile);

      expect(again).toMatchObject({
        written: 0,
        alreadyAppliedIds: [1, 2, 6],
        unwrittenIds: [5],
      });
      expect(exitCodeOfApply(again)).toBe(1);
    });

    it('treats a row that holds only some of the after values as not applied', async () => {
      const planned = await dry();
      await applyFile(planned.planFile);
      // Row 1 keeps the planned open and gap, but its high is not the plan's.
      await db.query(
        'UPDATE market_snapshots SET spx_high = 7000 WHERE id = 1',
      );

      const again = await applyFile(planned.planFile);

      expect(again.alreadyAppliedIds).toEqual([2, 5, 6]);
      expect(again.unwrittenIds).toEqual([1]);
    });

    it('lists the unwritten rows as not written, with the failure named, when the check read fails', async () => {
      const planned = await dry();
      await applyFile(planned.planFile);
      failWhen = (text) =>
        /SELECT id, spx_open::text/.test(text)
          ? new Error('connection lost')
          : null;

      const again = await applyFile(planned.planFile);

      expect(again).toMatchObject({
        written: 0,
        alreadyAppliedIds: [],
        unwrittenIds: [1, 2, 5, 6],
        checkError: 'connection lost',
      });
      expect(exitCodeOfApply(again)).toBe(1);
      expect(formatApplyReport(again)).toContain(
        'WARNING: could not check whether the unwritten rows were already applied: connection lost. They are listed as not written.',
      );
    });
  });

  it('prints the apply report failure, with the rows written and the undo file, and exits 1, when the report cannot be written', async () => {
    const planned = await dry();
    fsHook.failApplyReport = true;

    const result = await applyFile(planned.planFile);

    expect(result).toMatchObject({
      written: 4,
      unwrittenIds: [],
      reportFile: null,
      reportError: 'disk full',
    });
    expect(result.undoFile).not.toBeNull();
    expect(byId(await dump(), 1).spx_open).toBe('7487.00');
    expect(filesIn(undoDir, 'apply-')).toEqual([]);
    expect(exitCodeOfApply(result)).toBe(1);
    const text = formatApplyReport(result);
    expect(text).toContain(`Undo file: ${posix(result.undoFile)}`);
    expect(text).toMatch(/Rows written:\s+4/);
    expect(text).toContain(
      'WARNING: the apply report file could not be written: disk full. The rows above were written and the undo file is complete. The exit code is 1.',
    );
  });

  describe('the database the plan was made against', () => {
    it('refuses an apply when DATABASE_URL points at another host, before any file or statement', async () => {
      const planned = await dry();
      process.env.DATABASE_URL =
        'postgres://owner:pw@ep-other.neon.tech/neondb';
      statements.length = 0;

      getDbSpy.mockClear();

      const failure = await failureOf(applyFile(planned.planFile));

      // The recorded host only: the current one is not echoed.
      expect(failure.message).toBe(
        'Refusing to apply: the plan was made against the database host ep-plan.neon.tech, and DATABASE_URL points elsewhere or is not usable. Nothing was written.',
      );
      expect(failure.message).not.toContain('ep-other');
      expect(failure.message).not.toContain('pw');
      expect(getDbSpy).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(filesIn(undoDir, 'undo-')).toEqual([]);
      expect(filesIn(undoDir, 'apply-')).toEqual([]);
    });

    it('refuses an apply when DATABASE_URL is not set, without a word of it', async () => {
      const planned = await dry();
      delete process.env.DATABASE_URL;
      getDbSpy.mockClear();

      const failure = await failureOf(applyFile(planned.planFile));

      expect(failure.message).toBe(
        'Refusing to apply: the plan was made against the database host ep-plan.neon.tech, and DATABASE_URL points elsewhere or is not usable. Nothing was written.',
      );
      expect(getDbSpy).not.toHaveBeenCalled();
    });

    it.each(UNUSABLE_BY_SHAPE)(
      'refuses an apply with no part of the user or password in the message, before getDb(): %s',
      async (_label, url, tokens) => {
        const planned = await dry();
        process.env.DATABASE_URL = url;
        statements.length = 0;
        getDbSpy.mockClear();

        const failure = await failureOf(applyFile(planned.planFile));

        expect(failure.message).toBe(
          'Refusing to apply: the plan was made against the database host ep-plan.neon.tech, and DATABASE_URL points elsewhere or is not usable. Nothing was written.',
        );
        for (const token of tokens)
          expect(failure.message).not.toContain(token);
        expect(getDbSpy).not.toHaveBeenCalled();
        expect(statements).toEqual([]);
        expect(filesIn(undoDir, 'undo-')).toEqual([]);
        expect(filesIn(undoDir, 'apply-')).toEqual([]);
      },
    );

    it.each([
      ['a usable URL', PLAN_DB],
      ['no usable URL', 'not a url'],
    ])(
      'refuses a plan that records the placeholder, with DATABASE_URL %s: it never matches',
      async (_label, url) => {
        const planned = await dry();
        writeFileSync(
          planned.planFile,
          JSON.stringify({
            ...readJson(planned.planFile),
            dbHost: '(DATABASE_URL not readable)',
          }),
        );
        process.env.DATABASE_URL = url;
        statements.length = 0;
        getDbSpy.mockClear();

        await expect(applyFile(planned.planFile)).rejects.toThrow(
          'Refusing to apply: the plan records no usable database host, so it cannot be matched to DATABASE_URL. Nothing was written.',
        );

        expect(getDbSpy).not.toHaveBeenCalled();
        expect(statements).toEqual([]);
        expect(filesIn(undoDir, 'undo-')).toEqual([]);
      },
    );

    it('applies a plan in the current format: the host alone, under the key dbHost', async () => {
      // As every plan this script wrote before the hardening reads, built by
      // hand so nothing the code writes now can bend the test.
      const file = join(undoDir, 'dry-run-by-hand.json');
      writeFileSync(
        file,
        JSON.stringify({
          note: 'The plan of a dry run of backfill-snapshot-price-context.ts.',
          createdAt: '2026-11-19T22:00:00.000Z',
          dbHost: 'ep-plan.neon.tech',
          since: null,
          until: '2026-11-17',
          summary: 'nothing to write',
          updates: [],
          report: {},
        }),
      );

      await expect(applyFile(file)).resolves.toMatchObject({
        apply: true,
        planned: 0,
        written: 0,
        dbHost: 'ep-plan.neon.tech',
      });
    });

    it('records the plain host under dbHost, and no other key, in a plan it writes', async () => {
      const planned = await dry();

      const file = readJson(planned.planFile);

      expect(file.dbHost).toBe('ep-plan.neon.tech');
      expect(file).not.toHaveProperty('database');
    });

    it('only counts a plan without --apply, whichever host it points at, and says which host the plan has', async () => {
      const planned = await dry();
      process.env.DATABASE_URL =
        'postgres://owner:pw@ep-other.neon.tech/neondb';

      const counted = await runApply({
        file: planned.planFile,
        apply: false,
        undoDir,
      });

      expect(counted).toMatchObject({
        planned: 4,
        dbHost: 'ep-plan.neon.tech',
      });
    });

    it('takes the same host with another user, password or port', async () => {
      const planned = await dry();
      process.env.DATABASE_URL =
        'postgres://other:secret@ep-plan.neon.tech:5432/db2';

      await expect(applyFile(planned.planFile)).resolves.toMatchObject({
        written: 4,
      });
    });
  });

  it('guards a NaN: a row that is still NaN is written, one that changed is not', async () => {
    const planned = await dry();
    await db.query('UPDATE market_snapshots SET spx_open = 7001 WHERE id = 2');

    const applied = await applyFile(planned.planFile);

    expect(applied.unwrittenIds).toEqual([2]);
    expect(byId(await dump(), 2).spx_open).toBe('7001.00');
  });

  describe.each([
    [
      'all',
      1,
      ['spx_open', 'spx_high', 'spx_low', 'prev_close', 'overnight_gap'],
    ],
    [
      'replayed',
      5,
      ['spx_high', 'spx_low', 'prev_close', 'overnight_gap', 'spx_open'],
    ],
  ] as const)('the %s fill, row %i', (_fill, id, columns) => {
    it.each(columns)(
      'skips the row, and lists it, when %s changed since the dry run',
      async (column) => {
        const planned = await dry();
        const before = byId(await dump(), id);
        await db.query(
          `UPDATE market_snapshots SET ${column} = 123.45 WHERE id = ${id}`,
        );

        const applied = await applyFile(planned.planFile);

        expect(applied.unwrittenIds).toEqual([id]);
        expect(applied.written).toBe(3);
        const after = byId(await dump(), id);
        // Only the changed column differs from before: nothing of the plan landed.
        expect(after).toEqual({ ...before, [column]: '123.45' });
      },
    );
  });

  it('is not blocked by a column the update does not touch, and never writes it: the stored spot', async () => {
    const planned = await dry();
    // The spot keeps its 5-minute peek until phase 6: other stored values
    // derive from it. A change to it is not the row changing under the plan.
    await db.query('UPDATE market_snapshots SET spx = 7999 WHERE id = 5');

    const applied = await applyFile(planned.planFile);

    expect(applied.written).toBe(4);
    const rows = await dump();
    expect(byId(rows, 5)).toMatchObject({
      spx: '7999.00',
      spx_high: '7388.00',
      prev_close: '7356.73',
    });
    // No other row's spot was written either.
    expect(
      rows.filter((r) => r.id !== 5 && r.id !== 7).map((r) => r.spx),
    ).toEqual(['7400.00', '7400.00', '7400.00', '7400.00', '7400.00']);
  });

  it('plans nothing on a second plan after the apply, with real DECIMAL rounding', async () => {
    await dryThenApply();
    const afterApply = await dump();

    const again = await dry();

    const kinds = again.dates.flatMap((d) =>
      d.results.map((r) => [r.id, r.kind === 'update' ? 'update' : r.reason]),
    );
    expect(kinds).toEqual([
      [1, 'unchanged'],
      [2, 'unchanged'],
      [3, 'no-slot'],
      [4, 'unchanged'],
      [5, 'unchanged'],
      [6, 'unchanged'],
    ]);
    expect(await dump()).toEqual(afterApply);
    const text = formatReport(again);
    // Something was skipped (the pre-market row), so it must not say nothing
    // would change.
    expect(text).not.toMatch(/Nothing to write|no row would change/);
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      'Planned 0 updates. Not planned: 0 dates with 0 rows; 1 row left alone (no-slot 1); 5 rows already right.',
    );
  });

  it('writes nothing, and no undo file, for a plan with no updates', async () => {
    await dryThenApply();
    const again = await dry();
    statements.length = 0;
    const before = await dump();

    const applied = await applyFile(again.planFile);

    expect(applied).toMatchObject({
      planned: 0,
      written: 0,
      undoFile: null,
      reportFile: null,
    });
    expect(await dump()).toEqual(before);
    expect(filesIn(undoDir, 'undo-')).toHaveLength(1);
    expect(filesIn(undoDir, 'apply-')).toHaveLength(1);
    expect(statements.some((s) => /UPDATE/.test(s))).toBe(false);
    expect(exitCodeOfApply(applied)).toBe(0);
  });

  it('only counts the plan without --apply: no statement, no file', async () => {
    const planned = await dry();
    statements.length = 0;

    const counted = await runApply({
      file: planned.planFile,
      apply: false,
      undoDir,
    });

    expect(counted).toMatchObject({
      apply: false,
      planned: 4,
      written: 0,
      undoFile: null,
      reportFile: null,
    });
    expect(statements).toEqual([]);
    expect(filesIn(undoDir, 'undo-')).toEqual([]);
    expect(exitCodeOfApply(counted)).toBe(0);
  });

  it('writes at most 500 rows to a statement', async () => {
    await db.query('TRUNCATE market_snapshots RESTART IDENTITY');
    const label = (minute: number): string => {
      const hour = Math.floor(minute / 60);
      const clock = `${hour > 12 ? hour - 12 : hour}:${String(minute % 60).padStart(2, '0')}`;
      return `${clock} ${hour >= 12 ? 'PM' : 'AM'} CT`;
    };
    const count = WRITE_CHUNK + 1;
    const first = Array.from(
      { length: 261 },
      (_, i): Seed => [LIVE_DATE, label(510 + i)],
    );
    const second = Array.from(
      { length: count - 261 },
      (_, i): Seed => [BACKTEST_DATE, label(510 + i)],
    );
    await seed([...first, ...second]);

    const { applied } = await dryThenApply();

    expect(applied).toMatchObject({ planned: count, written: count });
    expect(updateSizes).toEqual([WRITE_CHUNK, 1]);
  });
});

// ── Apply fails (R4) ────────────────────────────────────────────────────────

describe('an apply that fails', () => {
  const failSecondStatement = () => {
    // The `all` statement commits; the `replayed` statement then fails.
    failWhen = (text) =>
      /UPDATE market_snapshots AS t\s+SET spx_high/.test(text)
        ? new Error('connection lost')
        : null;
  };

  it('reports a DB error mid-apply by name, with the undo file, the apply report and how far it got', async () => {
    const planned = await dry();
    failSecondStatement();

    const run = applyFile(planned.planFile);

    await expect(run).rejects.toThrow('connection lost');
    await expect(run).rejects.toThrow(
      /did not complete: 2 of 4 planned rows were written/,
    );
    const [name] = filesIn(undoDir, 'undo-');
    expect(name).toBeDefined();
    await expect(run).rejects.toThrow(posix(join(undoDir, name ?? '')));
    const rows = await dump();
    expect(byId(rows, 1).spx_open).toBe('7487.00');
    expect(byId(rows, 5).prev_close).toBe('7720.39');
    // The apply report was written, with the error and the rows left over.
    const [reportName] = filesIn(undoDir, 'apply-');
    expect(readJson(join(undoDir, reportName ?? ''))).toMatchObject({
      planned: 4,
      written: 2,
      unwrittenIds: [5, 6],
      error: expect.stringContaining('connection lost'),
    });
  });

  it('leaves a valid undo file when the very first UPDATE fails, and nothing written', async () => {
    const planned = await dry();
    const before = await dump();
    failWhen = (text) =>
      /UPDATE market_snapshots/.test(text)
        ? new Error('connection lost')
        : null;

    await expect(applyFile(planned.planFile)).rejects.toThrow(
      /did not complete: 0 of 4 planned rows were written/,
    );

    expect(await dump()).toEqual(before);
    const [name] = filesIn(undoDir, 'undo-');
    expect(name).toBeDefined();
    failWhen = null;
    // The file passes the same strict check the undo runs, with all four rows.
    const counted = await runUndo({
      file: join(undoDir, name ?? ''),
      apply: false,
    });
    expect(counted).toMatchObject({ apply: false, rows: 4 });
    // And restoring from it is harmless: no row holds the planned values.
    const undone = await runUndo({
      file: join(undoDir, name ?? ''),
      apply: true,
    });
    expect(undone).toMatchObject({ rows: 4, restored: 0 });
    expect(await dump()).toEqual(before);
  });

  it('restores a half-written apply: only the rows that were written come back', async () => {
    const planned = await dry();
    const seeded = await dump();
    failSecondStatement();
    await expect(applyFile(planned.planFile)).rejects.toThrow(
      'connection lost',
    );
    failWhen = null;
    const [name] = filesIn(undoDir, 'undo-');

    const undone = await runUndo({
      file: join(undoDir, name ?? ''),
      apply: true,
    });

    expect(undone).toMatchObject({ rows: 4, restored: 2, changedIds: [5, 6] });
    expect(exitCodeOfUndo(undone)).toBe(1);
    expect(await dump()).toEqual(seeded);
  });
});

// ── A plan file that is not one (A) ─────────────────────────────────────────

describe('a plan file that is invalid or tampered with', () => {
  const edit = async (change: (file: Record<string, any>) => unknown) => {
    const planned = await dry();
    const file = readJson(planned.planFile) as Record<string, any>;
    const changed = change(file) ?? file;
    const path = join(undoDir, 'tampered.json');
    writeFileSync(path, JSON.stringify(changed));
    statements.length = 0;
    fetchMock.mockClear();
    return path;
  };

  it.each([
    [
      'an unknown top-level key',
      (f: Record<string, any>) => {
        f.extra = 1;
      },
    ],
    [
      'a value that is not a decimal',
      (f: Record<string, any>) => {
        f.updates[0].after.prev_close = '1; DROP TABLE market_snapshots';
      },
    ],
    [
      'a before value that is not a decimal',
      (f: Record<string, any>) => {
        f.updates[0].before.spx_open = 'seven';
      },
    ],
    [
      'columns that do not belong to the fill kind',
      (f: Record<string, any>) => {
        f.updates[2].fill = 'all';
      },
    ],
    [
      'an unknown fill kind',
      (f: Record<string, any>) => {
        f.updates[0].fill = 'everything';
      },
    ],
    [
      'an extra column on an update',
      (f: Record<string, any>) => {
        f.updates[2].after.spx_open = '1.00';
      },
    ],
    [
      'a row id repeated',
      (f: Record<string, any>) => {
        f.updates[1].id = f.updates[0].id;
      },
    ],
    [
      'a row id that is not a positive integer',
      (f: Record<string, any>) => {
        f.updates[0].id = -1;
      },
    ],
    [
      'no range',
      (f: Record<string, any>) => {
        delete f.until;
      },
    ],
    [
      'updates that are not an array',
      (f: Record<string, any>) => {
        f.updates = 'all of them';
      },
    ],
    [
      'an undo file given as a plan',
      () => ({ note: 'x', createdAt: 'x', rows: [] }),
    ],
    [
      'a price with more digits than DECIMAL(10,2) holds',
      (f: Record<string, any>) => {
        f.updates[0].after.prev_close = '123456789.00';
      },
    ],
    [
      'a price without two decimals',
      (f: Record<string, any>) => {
        f.updates[0].after.spx_high = '7495';
      },
    ],
    [
      'a gap with more digits than DECIMAL(6,2) holds',
      (f: Record<string, any>) => {
        f.updates[0].after.overnight_gap = '12345.00';
      },
    ],
    [
      'a gap that is a price-sized number',
      (f: Record<string, any>) => {
        f.updates[2].after.overnight_gap = '10000.00';
      },
    ],
    [
      'a NaN in an after value',
      (f: Record<string, any>) => {
        f.updates[0].after.spx_open = 'NaN';
      },
    ],
    [
      'a row id past the integer column',
      (f: Record<string, any>) => {
        f.updates[0].id = 2147483648;
      },
    ],
    [
      'a guard open that is not a price',
      (f: Record<string, any>) => {
        f.updates[2].guardOpen = '1e3';
      },
    ],
    [
      'a replayed row with no guard open',
      (f: Record<string, any>) => {
        delete f.updates[2].guardOpen;
      },
    ],
    [
      'a replayed row with the open among its before values',
      (f: Record<string, any>) => {
        f.updates[2].before.spx_open = '7377.65';
      },
    ],
    [
      'a replayed row missing its low',
      (f: Record<string, any>) => {
        delete f.updates[2].after.spx_low;
      },
    ],
    [
      'a guard open on a fill-all row',
      (f: Record<string, any>) => {
        f.updates[0].guardOpen = '7487.00';
      },
    ],
    [
      'no database host',
      (f: Record<string, any>) => {
        delete f.dbHost;
      },
    ],
  ])(
    'rejects %s before a statement, an undo file or a fetch',
    async (_name, change) => {
      const path = await edit(change);

      await expect(
        runApply({ file: path, apply: true, undoDir }),
      ).rejects.toThrow(/is not a plan file from this script/);

      expect(statements).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(filesIn(undoDir, 'undo-')).toEqual([]);
      expect(filesIn(undoDir, 'apply-')).toEqual([]);
    },
  );

  describe('the last date the script covers, checked again at the apply', () => {
    // A live row dated 2026-11-19 or later carries the quote's real-time open,
    // high and low. Every other guard matches on a row's id and values, so a
    // plan that names such a row would pass them: the date check is the one
    // that stops it.
    const attempt = (path: string) =>
      runApply({ file: path, apply: true, undoDir });
    /** A refused apply wrote nothing, fetched nothing, left no file. */
    const expectNothingDone = () => {
      expect(statements).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(filesIn(undoDir, 'undo-')).toEqual([]);
      expect(filesIn(undoDir, 'apply-')).toEqual([]);
    };

    it('refuses a plan holding one row dated 2026-11-19, naming the date and why, before an undo file or a statement', async () => {
      const path = await edit((f) => {
        f.updates[2].date = '2026-11-19';
      });

      await expect(attempt(path)).rejects.toThrow(
        /is not a plan file from this script: updates\.2\.date of row 5 is 2026-11-19, which is after 2026-11-18, the last date this script covers: from the next day a live row carries the quote's real-time open, high and low/,
      );
      expectNothingDone();
      expect(byId(await dump(), 5).prev_close).toBe('7720.39');
    });

    it('names the first of several rows dated after the cutoff', async () => {
      const path = await edit((f) => {
        f.updates[3].date = '2026-12-01';
        f.updates[1].date = '2026-11-20';
      });

      await expect(attempt(path)).rejects.toThrow(
        /of row 2 is 2026-11-20, which is after 2026-11-18/,
      );
      expectNothingDone();
    });

    it('refuses a plan whose until is 2026-11-19, with every row on or before 2026-11-18', async () => {
      const path = await edit((f) => {
        f.until = '2026-11-19';
      });

      await expect(attempt(path)).rejects.toThrow(
        /is not a plan file from this script: until is 2026-11-19, which is after 2026-11-18, the last date this script covers/,
      );
      expectNothingDone();
    });

    it('refuses a plan whose since is 2026-11-19, as it does an until', async () => {
      const path = await edit((f) => {
        f.since = '2026-11-19';
      });

      await expect(attempt(path)).rejects.toThrow(
        /is not a plan file from this script: since is 2026-11-19, which is after 2026-11-18, the last date this script covers/,
      );
      expectNothingDone();
    });

    it('takes a plan dated 2026-11-18 itself, the last date', async () => {
      const path = await edit((f) => {
        f.updates[2].date = '2026-11-18';
        f.until = '2026-11-18';
      });

      const counted = await runApply({ file: path, apply: false, undoDir });

      expect(counted.planned).toBe(4);
    });

    it('refuses an update date that is not a date, by its shape and not by the cutoff', async () => {
      // As text "2026-1-5" sorts before 2026-11-18, so only its shape refuses it.
      const path = await edit((f) => {
        f.updates[0].date = '2026-1-5';
      });

      await expect(attempt(path)).rejects.toThrow(
        /is not a plan file from this script: updates\.0\.date Invalid string(?:(?!last date this script covers)[\s\S])*$/,
      );
      expectNothingDone();
    });

    it('does not make an undo file check the date: it restores only what an apply wrote', async () => {
      const { applied } = await dryThenApply();
      const undo = readJson(applied.undoFile) as Record<string, any>;
      undo.rows[0].date = '2026-11-19';
      const path = join(undoDir, 'late-undo.json');
      writeFileSync(path, JSON.stringify(undo));

      const counted = await runUndo({ file: path, apply: false });

      expect(counted.rows).toBe(4);
    });
  });

  it('rejects a file that is not JSON', async () => {
    const path = join(undoDir, 'plan.json');
    writeFileSync(path, 'not json');

    await expect(
      runApply({ file: path, apply: true, undoDir }),
    ).rejects.toThrow(/is not valid JSON/);
    expect(statements).toEqual([]);
  });

  it('rejects a file that is not there', async () => {
    await expect(
      runApply({ file: join(undoDir, 'missing.json'), apply: true, undoDir }),
    ).rejects.toThrow(/ENOENT|no such file/);
    expect(statements).toEqual([]);
  });

  it('takes a plan file with a UTF-8 byte-order mark, which a Windows editor adds', async () => {
    const planned = await dry();
    const path = join(undoDir, 'bom-plan.json');
    writeFileSync(path, BOM + readFileSync(planned.planFile, 'utf8'));

    const counted = await runApply({ file: path, apply: false, undoDir });

    expect(counted.planned).toBe(4);
  });

  it('takes an undo file with a byte-order mark too', async () => {
    const { applied } = await dryThenApply();
    const path = join(undoDir, 'bom-undo.json');
    writeFileSync(path, BOM + readFileSync(applied.undoFile ?? '', 'utf8'));

    const undone = await runUndo({ file: path, apply: true });

    expect(undone).toMatchObject({ rows: 4, restored: 4 });
  });

  it('takes a NaN in a before value, and nowhere else', async () => {
    const path = await edit((f) => {
      f.updates[2].before.overnight_gap = 'NaN';
    });
    await db.query(
      "UPDATE market_snapshots SET overnight_gap = 'NaN' WHERE id = 5",
    );

    const applied = await runApply({ file: path, apply: true, undoDir });

    expect(applied.written).toBe(4);
  });

  it('takes a plan with its report section edited: only the updates are applied', async () => {
    const path = await edit((f) => {
      f.report = { anything: ['at', 'all'] };
    });

    const applied = await runApply({ file: path, apply: true, undoDir });

    expect(applied.written).toBe(4);
  });
});

// ── The plan file writer ────────────────────────────────────────────────────

describe('writePlanFile', () => {
  const run = async () => {
    const planned = await dry();
    const files = () => filesIn(undoDir, 'dry-run-').length;
    return { planned, files };
  };

  it('writes one update per planned row, and the database host', async () => {
    const { planned } = await run();

    const file = readJson(planned.planFile);

    expect(file.dbHost).toBe('ep-plan.neon.tech');
    expect((file.updates as unknown[]).length).toBe(
      planned.dates.flatMap((d) => d.results).filter((r) => r.kind === 'update')
        .length,
    );
  });

  it('refuses dates whose rows do not reconcile, and writes no file', async () => {
    const { planned, files } = await run();
    const broken: DatePlan[] = planned.dates.map((d, i) =>
      i === 0 ? { ...d, results: d.results.slice(1) } : d,
    );

    expect(() =>
      writePlanFile(
        undoDir,
        { since: null, until: planned.until, dates: broken, untried: [] },
        new Date(Date.now() + 5000),
      ),
    ).toThrow(/do not reconcile/);
    expect(files()).toBe(1);
  });

  it('refuses a planned row that has no row to take its date and label from', async () => {
    const { planned, files } = await run();
    const broken: DatePlan[] = planned.dates.map((d, i) =>
      i === 0 ? { ...d, rows: d.rows.filter((r) => r.id !== 1) } : d,
    );

    expect(() =>
      writePlanFile(
        undoDir,
        { since: null, until: planned.until, dates: broken, untried: [] },
        new Date(Date.now() + 5000),
      ),
    ).toThrow(/planned row 1 has no row/);
    expect(files()).toBe(1);
  });
});

// ── Undo ────────────────────────────────────────────────────────────────────

describe('undo', () => {
  it('restores the original values, NULL and NaN included', async () => {
    const seeded = await dump();
    const { applied } = await dryThenApply();
    expect(await dump()).not.toEqual(seeded);

    const undone = await runUndo({ file: applied.undoFile ?? '', apply: true });

    expect(undone).toEqual({
      apply: true,
      file: applied.undoFile,
      rows: 4,
      restored: 4,
      changedIds: [],
    });
    const rows = await dump();
    expect(rows).toEqual(seeded);
    // The NaN is NaN again, not NULL.
    expect(byId(rows, 2).spx_open).toBe('NaN');
    expect(byId(rows, 1).spx_open).toBeNull();
    expect(formatUndoReport(undone)).toContain('Rows restored:    4');
    expect(exitCodeOfUndo(undone)).toBe(0);
  });

  describe.each([
    [
      'all',
      1,
      ['spx_open', 'spx_high', 'spx_low', 'prev_close', 'overnight_gap'],
    ],
    [
      'replayed',
      5,
      ['spx_high', 'spx_low', 'prev_close', 'overnight_gap', 'spx_open'],
    ],
  ] as const)('the %s fill, row %i', (_fill, id, columns) => {
    it.each(columns)(
      'leaves the row, and lists it, when %s changed since the apply',
      async (column) => {
        const { applied } = await dryThenApply();
        const before = byId(await dump(), id);
        await db.query(
          `UPDATE market_snapshots SET ${column} = 321.09 WHERE id = ${id}`,
        );

        const undone = await runUndo({
          file: applied.undoFile ?? '',
          apply: true,
        });

        expect(undone).toMatchObject({
          rows: 4,
          restored: 3,
          changedIds: [id],
        });
        expect(exitCodeOfUndo(undone)).toBe(1);
        expect(byId(await dump(), id)).toEqual({
          ...before,
          [column]: '321.09',
        });
      },
    );
  });

  it('is not blocked by a column the update does not touch: the stored spot', async () => {
    const { applied } = await dryThenApply();
    await db.query('UPDATE market_snapshots SET spx = 7999 WHERE id = 5');

    const undone = await runUndo({ file: applied.undoFile ?? '', apply: true });

    expect(undone.restored).toBe(4);
    expect(byId(await dump(), 5)).toMatchObject({
      spx: '7999.00',
      spx_high: '7390.10',
      prev_close: '7720.39',
    });
  });

  it('only counts the rows without --apply', async () => {
    const { applied } = await dryThenApply();
    const after = await dump();

    const undone = await runUndo({
      file: applied.undoFile ?? '',
      apply: false,
    });

    expect(undone).toMatchObject({ apply: false, rows: 4, restored: 0 });
    expect(await dump()).toEqual(after);
    expect(formatUndoReport(undone)).toContain('DRY RUN');
    expect(exitCodeOfUndo(undone)).toBe(0);
  });

  it('reports a DB error by name, and is safe to repeat', async () => {
    const { applied } = await dryThenApply();
    failWhen = (text) =>
      /UPDATE market_snapshots/.test(text)
        ? new Error('connection lost')
        : null;

    await expect(
      runUndo({ file: applied.undoFile ?? '', apply: true }),
    ).rejects.toThrow(/connection lost.*undo did not complete: 0 of 4 rows/);
  });

  it.each([
    ['not JSON', 'nope', /is not valid JSON/],
    [
      'a plan file, not an undo file',
      JSON.stringify({ dates: [] }),
      /is not an undo file from this script/,
    ],
    [
      'a row with a bad value',
      JSON.stringify({
        note: 'x',
        createdAt: 'x',
        rows: [
          {
            id: 1,
            date: 'd',
            entryTime: 't',
            fill: 'close-and-gap',
            before: {
              prev_close: '1; DROP TABLE market_snapshots',
              overnight_gap: null,
            },
            after: { prev_close: '1.00', overnight_gap: '0.00' },
          },
        ],
      }),
      /is not an undo file from this script/,
    ],
    [
      'a row with the wrong columns for its kind',
      JSON.stringify({
        note: 'x',
        createdAt: 'x',
        rows: [
          {
            id: 1,
            date: 'd',
            entryTime: 't',
            fill: 'all',
            before: { prev_close: null, overnight_gap: null },
            after: { prev_close: '1.00', overnight_gap: '0.00' },
          },
        ],
      }),
      /is not an undo file from this script/,
    ],
    [
      'a row id repeated',
      JSON.stringify({
        note: 'x',
        createdAt: 'x',
        rows: [1, 1].map((id) => ({
          id,
          date: 'd',
          entryTime: 't',
          fill: 'close-and-gap',
          before: { prev_close: null, overnight_gap: null },
          after: { prev_close: '1.00', overnight_gap: '0.00' },
        })),
      }),
      /is not an undo file from this script/,
    ],
  ])('refuses %s', async (_name, text, message) => {
    const file = join(undoDir, 'bad.json');
    writeFileSync(file, text);

    await expect(runUndo({ file, apply: true })).rejects.toThrow(message);
    expect(existsSync(file)).toBe(true);
    expect(statements).toEqual([]);
  });
});

// ── The rounding, against Postgres ──────────────────────────────────────────

describe('toDecimal2 against Postgres numeric', () => {
  /** Exact halves at the third decimal, positive and negative, and some that are not. */
  function samples(): string[] {
    const wholes = ['0', '1', '2', '10', '7487', '7560', '99999999'];
    const cents = [
      '00',
      '01',
      '12',
      '25',
      '37',
      '49',
      '50',
      '62',
      '75',
      '87',
      '99',
    ];
    const out: string[] = [];
    for (const whole of wholes) {
      for (const c of cents) {
        out.push(`${whole}.${c}5`, `-${whole}.${c}5`);
      }
    }
    out.push(
      '0.97700',
      '-0.977',
      '7487.1249',
      '7487.12499',
      '-7487.1251',
      '1234.5678',
      '0.004',
      '-0.004',
      '0.0049999',
      '-0.0049999',
      '0.01',
      '7560.87',
      '100',
      '0',
    );
    // The number's shortest text is what the driver sends: keep the samples
    // that survive the trip through a JS number unchanged.
    return out.filter((t) => String(Number(t)) === t);
  }

  it('rounds the same as round(x::numeric, 2) and a DECIMAL(10,2) column over 100+ values', async () => {
    const texts = samples();
    expect(texts.length).toBeGreaterThanOrEqual(100);

    // The column cast overflows for 99999999.995 (it rounds to 1e8): that is
    // the range the planner refuses, so only round() is compared there.
    const { rows } = await db.query<{ t: string; r: string; c: string | null }>(
      `SELECT t, round(t::numeric, 2)::text AS r,
              CASE WHEN abs(round(t::numeric, 2)) < 100000000
                   THEN t::numeric(10,2)::text END AS c
         FROM unnest($1::text[]) AS u(t)`,
      [texts],
    );

    expect(rows).toHaveLength(texts.length);
    let columnChecks = 0;
    for (const row of rows) {
      const ours = toDecimal2(Number(row.t));
      expect({ text: row.t, ours }).toEqual({ text: row.t, ours: row.r });
      if (row.c != null) {
        columnChecks += 1;
        expect({ text: row.t, ours }).toEqual({ text: row.t, ours: row.c });
      }
    }
    expect(columnChecks).toBeGreaterThanOrEqual(100);
  });

  it('rounds the exponent-form numbers the same way too', async () => {
    const texts = ['1e-7', '-1e-7', '5e-3', '1.5e-3'].map((t) =>
      String(Number(t)),
    );

    const { rows } = await db.query<{ t: string; r: string }>(
      `SELECT t, round(t::numeric, 2)::text AS r FROM unnest($1::text[]) AS u(t)`,
      [texts],
    );

    for (const row of rows) {
      expect(toDecimal2(Number(row.t))).toBe(row.r);
    }
  });
});

// ── The reports read back from the runs ─────────────────────────────────────

describe('the apply report of a run', () => {
  it('says what it planned, and ends with the counts', async () => {
    const { planned, applied } = await dryThenApply();

    const text = formatApplyReport(applied);

    expect(text).toContain(`APPLY of ${posix(planned.planFile)}`);
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      'Planned 4 rows; written 4; already applied 0; not written 0.',
    );
  });
});
