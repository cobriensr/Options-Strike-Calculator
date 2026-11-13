// @vitest-environment node

/**
 * REAL-SQL test for Phase 5b of the contract-mix repair (owner decision D1,
 * 2026-11-11): the Phase 4 recompute, run with the Phase 5a backup (whole days of
 * RTY, CL, GC and ZN bars deleted) and `--roots`, against pglite (Postgres in
 * WASM) with futures_snapshots built from the real migration (#45).
 *
 * `--roots RTY CL` plans no premarket and no fires (ES-only), so the only tables
 * are futures_bars and futures_snapshots: a query of market_snapshots or
 * ws_gamma_setup_fires would reject, because neither exists here. getDb()
 * emulates production as in futures-derived-frozen-pglite.test.ts.
 *
 * The world is the one 5a leaves, built the way it happened: the bars exist, the
 * old writer's rows are computed from them with computeSnapshot, then 5a's bars
 * are deleted and written to a backup in 5a's format.
 */

import {
  appendFileSync,
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
} from 'vitest';
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';

import type { PgliteQuery } from '../../api/__tests__/pglite-migrations';

const hooks = vi.hoisted(() => ({
  pg: null as PGliteType | null,
  /** The nth (1-based) write transaction rejects with this error. */
  failWriteAt: null as null | { nth: number; error: Error },
  writes: 0,
  /** Tables a transaction or plain query named, so a test can say what was never read. */
  texts: [] as string[],
  /** A read-only transaction whose queries this all returns rows for gets those rows and is not run. */
  answer: null as null | ((text: string) => unknown[] | null),
}));

vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/db.js')>();
  return {
    ...actual,
    getDb: () => {
      const pg = hooks.pg;
      if (!pg) throw new Error('pglite not started');
      // A plain query is a read-only transaction, as readOnlyFetch makes it.
      const tag = (
        strings: TemplateStringsArray,
        ...params: unknown[]
      ): PgliteQuery => {
        const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
        return {
          text,
          params,
          then: (onFulfilled, onRejected) => {
            hooks.texts.push(text);
            return pg
              .transaction(async (tx) => {
                await tx.query('SET TRANSACTION READ ONLY');
                return (await tx.query(text, params)).rows;
              })
              .then(onFulfilled, onRejected);
          },
        };
      };
      return Object.assign(tag, {
        transaction: async (
          queries: PgliteQuery[],
          opts?: { readOnly?: boolean },
        ) => {
          const readOnly = opts?.readOnly === true;
          hooks.texts.push(...queries.map((q) => q.text));
          if (readOnly && hooks.answer != null) {
            const answers = queries.map((q) => hooks.answer?.(q.text) ?? null);
            if (answers.every((a) => a != null)) return answers as unknown[][];
          }
          if (!readOnly) {
            hooks.writes += 1;
            if (hooks.failWriteAt?.nth === hooks.writes)
              throw hooks.failWriteAt.error;
          }
          return pg.transaction(async (tx) => {
            if (readOnly) await tx.query('SET TRANSACTION READ ONLY');
            const results: unknown[][] = [];
            for (const q of queries) {
              results.push((await tx.query(q.text, q.params)).rows);
            }
            return results;
          });
        },
      });
    },
  };
});

vi.mock('../../api/_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { computeSnapshot } from '../../api/_lib/futures-derive.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { JUNK_WINDOW } from './futures-contract-repair.js';
import {
  markerPath,
  roundNumeric,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

vi.setConfig({ testTimeout: 120_000 });

type Sym = 'ES' | 'NQ' | 'RTY' | 'CL';
const THIN: Sym[] = ['RTY', 'CL'];
const BASE: Record<Sym, number> = { ES: 7000, NQ: 24000, RTY: 2000, CL: 70 };

let pg: PGliteType;
let dir: string;
let workDir: string;
let backupPath: string;

beforeAll(async () => {
  pg = await PGlite.create();
  hooks.pg = pg;
  await pg.query(`SET TIME ZONE 'UTC'`);
  await pg.query(`
    CREATE TABLE futures_bars (
      id      BIGSERIAL PRIMARY KEY,
      symbol  TEXT NOT NULL,
      ts      TIMESTAMPTZ NOT NULL,
      open    NUMERIC(12,4) NOT NULL,
      high    NUMERIC(12,4) NOT NULL,
      low     NUMERIC(12,4) NOT NULL,
      close   NUMERIC(12,4) NOT NULL,
      volume  BIGINT NOT NULL DEFAULT 0,
      UNIQUE(symbol, ts)
    )
  `);
  await applyMigration(pg, 45);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

// ── Fixture ─────────────────────────────────────────────────────────────────

const hhmm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

async function bar(
  symbol: string,
  ts: string,
  close: number,
  volume = 100,
): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, $4)`,
    [symbol, ts, close, volume],
  );
}

/**
 * A bar every 5 minutes from `from` to `to` (minutes after 00:00Z) on `date`. The
 * price moves with the day of the month, so two days never store the same price
 * (consecutive rows with one price would read as a frozen run).
 */
async function day(
  symbol: Sym,
  date: string,
  from: number,
  to: number,
  volume = 100,
): Promise<void> {
  const dd = Number.parseInt(date.slice(8, 10), 10);
  for (let m = from; m <= to; m += 5) {
    await bar(
      symbol,
      `${date}T${hhmm(m)}:00Z`,
      BASE[symbol] + dd + (m % 7),
      volume,
    );
  }
}

type Values = [number, number | null, number | null, number | null];

const r4 = (x: number | null): number | null =>
  x == null ? null : roundNumeric(x, 4);

/** What the cron wrote at `at`: computeSnapshot on the bars as they are now. */
async function written(symbol: Sym, at: string): Promise<Values> {
  const result = await computeSnapshot(
    symbol,
    getETDateStr(new Date(at)),
    new Date(at),
  );
  if (result.kind !== 'fresh') throw new Error(`${symbol} ${at} is not fresh`);
  const s = result.snapshot;
  return [s.price, r4(s.change1hPct), r4(s.changeDayPct), r4(s.volumeRatio)];
}

async function snap(symbol: Sym, at: string, v: Values): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO futures_snapshots
       (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [getETDateStr(new Date(at)), at, symbol, ...v],
  );
  return rows[0]!.id;
}

interface Ids {
  /** On clean day 04-14: its inputs are clean-day bars, its 20-day window held 04-09. */
  clean: Record<string, number>;
  /** Inside deleted day 04-09: priced from a deleted bar. */
  win: Record<string, number>;
  /** 06-22, in the 20 days after the span end: its window held deleted 06-10. */
  after: Record<string, number>;
  /** 04-15, clean day: priced from a bar 41 minutes old, the 14:40 bar has landed since. */
  stale: Record<string, number>;
  /** 05-12, inside the deleted window: frozen on an older bar. */
  frozen: Record<string, number>;
}
let ids: Ids;

/** The deleted days: 04-09 (span, non-clean) and 06-10 (span, non-clean). */
const DELETED_DAYS: [string, number, number][] = [
  ['2026-04-09', 14 * 60, 15 * 60 + 30],
  ['2026-06-10', 14 * 60, 15 * 60],
];

const CONTROL_DAYS = ['2026-11-03', '2026-11-04', '2026-11-05'];
interface ControlRow {
  symbol: Sym;
  ts: string;
  values: Values;
}
const controlRows: ControlRow[] = [];

async function controlWorld(symbols: Sym[]): Promise<void> {
  for (const symbol of symbols) {
    for (const [d, date] of ['2026-11-02', ...CONTROL_DAYS].entries()) {
      for (let m = 13 * 60; m <= 21 * 60 + 30; m += 5) {
        await bar(
          symbol,
          `${date}T${hhmm(m)}:00Z`,
          BASE[symbol] + ((m * 7 + d * 3) % 23) - 11,
          50 + (m % 17),
        );
      }
    }
  }
  if (controlRows.length === 0) {
    for (const symbol of symbols) {
      for (const date of CONTROL_DAYS) {
        for (let m = 15 * 60 + 31; m <= 21 * 60 + 26; m += 5) {
          const ts = `${date}T${hhmm(m)}:21.500Z`;
          controlRows.push({ symbol, ts, values: await written(symbol, ts) });
        }
      }
    }
  }
  for (const c of controlRows.filter((r) => symbols.includes(r.symbol))) {
    await snap(c.symbol, c.ts, c.values);
  }
}

interface World {
  /** A thin-root bar is left in the span on a day that is not clean (the world before 5a). */
  leftBar: boolean;
}

/**
 * RTY and CL (thin), ES and NQ (repaired by Phase 2, so never in this backup).
 * The bars exist while the old rows are computed; then 5a's bars go, and the
 * backup names them.
 */
async function reset(world: World = { leftBar: false }): Promise<void> {
  await pg.query(`TRUNCATE futures_bars, futures_snapshots RESTART IDENTITY`);
  const clean: Record<string, number> = {};
  const win: Record<string, number> = {};
  const after: Record<string, number> = {};
  const stale: Record<string, number> = {};
  const frozen: Record<string, number> = {};

  for (const symbol of [...THIN, 'ES', 'NQ'] as Sym[]) {
    // The deleted days trade three times the volume of the days that stay, so
    // dropping them moves a 20-day volume ratio.
    for (const [date, from, to] of DELETED_DAYS) {
      await day(symbol, date, from, to, 300);
    }
    await day(symbol, '2026-04-14', 13 * 60 + 30, 15 * 60 + 30); // clean day
    await day(symbol, '2026-06-22', 13 * 60 + 30, 15 * 60);
  }
  for (const symbol of THIN) {
    clean[symbol] = await snap(
      symbol,
      '2026-04-14T15:01:30Z',
      await written(symbol, '2026-04-14T15:01:30Z'),
    );
    win[symbol] = await snap(
      symbol,
      '2026-04-09T15:01:30Z',
      await written(symbol, '2026-04-09T15:01:30Z'),
    );
    after[symbol] = await snap(
      symbol,
      '2026-06-22T14:46:30Z',
      await written(symbol, '2026-06-22T14:46:30Z'),
    );
  }

  // ES: a stale-at-write row (priced from the 14:00 bar; the 14:40 bar landed since)
  // and a frozen row, both of which a run over ES would plan.
  await bar('ES', '2026-04-20T14:00:00Z', 7000);
  await bar('ES', '2026-04-20T14:40:00Z', 7010);
  const esStale = await snap('ES', '2026-04-20T14:41:30Z', [7000, 0.1, 0.1, 1]);
  const esFrozen = await snap(
    'ES',
    '2026-05-12T15:00:30Z',
    [6900, 0.1, 0.1, 1],
  );

  // The thin roots' stale-at-write row on a clean day, and a frozen row inside
  // the deleted window.
  for (const symbol of THIN) {
    await bar(symbol, '2026-04-15T14:00:00Z', BASE[symbol]);
    await bar(symbol, '2026-04-15T14:40:00Z', BASE[symbol] + 10);
    stale[symbol] = await snap(symbol, '2026-04-15T14:41:30Z', [
      BASE[symbol],
      0.1,
      0.1,
      1,
    ]);
    frozen[symbol] = await snap(symbol, '2026-05-12T15:00:30Z', [
      BASE[symbol] * 0.95,
      0.1,
      0.1,
      1,
    ]);
  }
  await controlWorld([...THIN, 'ES']);

  // 5a: the deleted days go, and the backup names them in 5a's format.
  const lines: string[] = [];
  for (const symbol of THIN) {
    const { rows } = await pg.query<Record<string, string>>(
      `SELECT id::text AS id, symbol,
              to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
              open::text, high::text, low::text, close::text, volume::text
         FROM futures_bars
        WHERE symbol = $1 AND ts::date = ANY($2::date[])
        ORDER BY ts`,
      [symbol, DELETED_DAYS.map(([d]) => d)],
    );
    for (const row of rows) {
      lines.push(JSON.stringify({ op: 'delete', reason: 'thin_root', row }));
    }
  }
  writeFileSync(backupPath, `${lines.join('\n')}\n`);
  await pg.query(
    `DELETE FROM futures_bars
      WHERE symbol = ANY($1::text[]) AND ts::date = ANY($2::date[])`,
    [THIN, DELETED_DAYS.map(([d]) => d)],
  );
  if (world.leftBar) {
    await bar('RTY', '2026-05-04T14:00:00Z', 2005); // a month-mixed bar 5a did not take
  }

  ids = { clean, win, after, stale, frozen };
  Object.assign(ids, { esStale, esFrozen });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: false,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'],
    roots: [...THIN],
    frozen: false,
    backup: backupPath,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    detectorDays: null,
    ...over,
  };
}
const run = (over: Partial<RecomputeOptions> = {}) =>
  runRecompute(options(over));

const errored = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
const logged = (): string =>
  vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
/**
 * The report the last run wrote: its path is the last "report:" line a run
 * printed. A dry run writes report.txt; an --apply leaves that file alone and
 * writes apply-<time>-report.txt.
 */
const report = (): string => {
  const line = vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .reverse()
    .find((l) => /^\s*report: /.test(l));
  const path =
    line == null
      ? join(workDir, 'report.txt')
      : line.replace(/^\s*report: /, '').trim();
  return readFileSync(path, 'utf8');
};

interface Snapshot {
  id: number;
  symbol: string;
  price: string;
  change_1h_pct: string | null;
  change_day_pct: string | null;
  volume_ratio: string | null;
}
async function snapshots(): Promise<Map<number, Snapshot>> {
  const { rows } = await pg.query<Snapshot>(
    `SELECT id, symbol, price::text, change_1h_pct::text, change_day_pct::text,
            volume_ratio::text
       FROM futures_snapshots ORDER BY id`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); // Sunday: not market hours
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'thin-roots-pglite-'));
  workDir = join(dir, 'work');
  backupPath = join(dir, 'backup.jsonl');
  hooks.failWriteAt = null;
  hooks.writes = 0;
  hooks.texts = [];
  hooks.answer = null;
  neonConfig.fetchFunction = undefined;
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('5b: the snapshots after 5a deleted whole days of thin-root bars', () => {
  it('recomputes the volume ratio of a clean-day row whose 20-day window held deleted bars, and nothing else of it', async () => {
    expect(await run()).toBe(0);
    const text = report();

    // Per root, three rows have a volume ratio the deleted days fed: the clean-day
    // row (04-14), the stale-at-write row (04-15, also a clean day) and the row 20
    // days after the span end (06-22). Only that field is written; the stale row's
    // other fields are the stale step's, and the junk row is deleted.
    expect(text).toContain(
      'rows planned, RTY: normal step 3 rows, stale-at-write 1 rows (1 added by the D1 lift), junk delete 1 rows',
    );
    expect(text).toContain(
      'rows planned, CL: normal step 3 rows, stale-at-write 1 rows (1 added by the D1 lift), junk delete 1 rows',
    );
    expect(text).toMatch(
      /RTY: rows in range \d+, rows to write 3 \(price=0 change1hPct=0 changeDayPct=0 volumeRatio=3\)/,
    );
    // The command to apply it carries the roots, and --stores narrowed to what plans.
    expect(text).toMatch(
      /--apply --work-dir \S+ --backup \S+ --roots RTY CL --stores snapshots --expect-snapshots 6 --delete-junk-stale --expect-junk-deletes 2 --rewrite-stale-at-write --expect-stale-rewrites 2/,
    );
  });

  it('says what the backup holds, with the deleted rows per root, so the 5a total can be checked against it', async () => {
    expect(await run()).toBe(0);
    expect(report()).toContain(
      `bar backup ${backupPath}: 64 rows (0 updated, 64 deleted; deleted by root: RTY 32, CL 32)`,
    );
  });

  describe('the read that counts the bars left in the span', () => {
    it.each([
      [
        'no row',
        [] as unknown[],
        'the thin-root bar count for RTY returned no row',
      ],
      [
        'a count that is not a whole number',
        [{ bars: 'many' }],
        'the thin-root bar count for RTY is "many", not a whole number',
      ],
      [
        'a negative count',
        [{ bars: '-3' }],
        'the thin-root bar count for RTY is "-3", not a whole number',
      ],
    ])(
      'stops the run, and lifts nothing, when it returns %s',
      async (_name, rows, message) => {
        hooks.answer = (text) =>
          text.includes('count(*)::text AS bars') ? rows : null;
        expect(await run()).toBe(1);
        expect(errored()).toContain(message);
        expect(existsSync(join(workDir, 'report.txt'))).toBe(false);
      },
    );
  });

  it('plans a row priced from a deleted bar for the junk delete, not for a rewrite', async () => {
    expect(await run()).toBe(0);
    expect(report()).toContain(
      'stale rows priced from a deleted junk bar (not recomputable; --delete-junk-stale deletes them, off by default): 2',
    );
    expect(report()).toContain(`RTY 2026-04-09T15:01:30Z id ${ids.win.RTY}`);
  });

  it('plans nothing for ES and NQ, and reads no ES-only table, with --roots RTY CL', async () => {
    expect(await run()).toBe(0);
    const text = report();
    expect(text).not.toMatch(/\bES: rows in range/);
    expect(text).not.toMatch(/\bNQ: rows in range/);
    expect(text).toContain('roots RTY, CL');
    expect(text).not.toContain('market_snapshots.pre_market_data');
    expect(text).not.toContain('ws_gamma_setup_fires');
    expect(hooks.texts.join('\n')).not.toMatch(
      /market_snapshots|ws_gamma_setup_fires|index_candles_1m/,
    );
  });

  it('would plan ES without --roots: the contrast that makes the test above mean something', async () => {
    expect(
      await run({ roots: ['ES', 'NQ', 'RTY', 'CL'], stores: ['snapshots'] }),
    ).toBe(0);
    expect(report()).toMatch(/\bES: rows in range/);
    expect(report()).toContain(
      'rows planned, ES: normal step 0 rows, stale-at-write 1 rows (0 added by the D1 lift), junk delete 0 rows',
    );
  });

  it('applies the normal step and the junk delete, and leaves ES, NQ and the unaffected rows as they were', async () => {
    const before = await snapshots();
    const code = await run({
      apply: true,
      expectSnapshots: 6,
      deleteJunkStale: true,
      expectJunkDeletes: 2,
    });
    expect(errored()).toBe('');
    expect(code).toBe(0);

    const after = await snapshots();
    for (const symbol of THIN) {
      // The volume ratio changed; price and the two changes did not.
      for (const id of [ids.clean[symbol], ids.after[symbol]] as number[]) {
        const was = before.get(id);
        const now = after.get(id);
        expect(now?.volume_ratio).not.toBe(was?.volume_ratio);
        expect(now?.price).toBe(was?.price);
        expect(now?.change_1h_pct).toBe(was?.change_1h_pct);
        expect(now?.change_day_pct).toBe(was?.change_day_pct);
      }
      // The junk row is gone.
      expect(after.has(ids.win[symbol] as number)).toBe(false);
    }
    // ES rows, and every row the plan did not name, are byte for byte as they were.
    const esIds = [...before.values()]
      .filter((r) => r.symbol === 'ES')
      .map((r) => r.id);
    expect(esIds.length).toBeGreaterThan(0);
    for (const id of esIds) expect(after.get(id)).toEqual(before.get(id));
    expect(after.size).toBe(before.size - 2);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'premarket'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'fires'))).toBe(false);
  });

  it('refuses a resume that names other roots, and finishes it with the same roots', async () => {
    hooks.failWriteAt = { nth: 2, error: new Error('connection lost') };
    const apply = {
      apply: true,
      expectSnapshots: 6,
      deleteJunkStale: true,
      expectJunkDeletes: 2,
    };
    expect(await run(apply)).toBe(1);
    expect(errored()).toMatch(/apply failed: junk: connection lost/);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);

    hooks.failWriteAt = null;
    expect(await run({ ...apply, roots: ['RTY'] })).toBe(1);
    expect(errored()).toContain(
      '--roots RTY was given, the saved plan was made with --roots RTY CL',
    );
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);

    expect(await run(apply)).toBe(0);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);
  });
});

describe('5b: ruling 9 is lifted per root once no thin-root bar is left in the span', () => {
  it('keeps both steps away from a thin root that still has a bar in the span, and takes in the one that has none', async () => {
    await reset({ leftBar: true });
    expect(await run()).toBe(0);
    const text = report();

    expect(text).toContain('RTY 1 (kept), CL 0 (lifted)');
    // RTY keeps today's behaviour: its clean-day stale row is left and counted.
    expect(text).toContain(
      'rows planned, RTY: normal step 3 rows, stale-at-write 0 rows (0 added by the D1 lift), junk delete 1 rows',
    );
    expect(text).toMatch(
      /RTY: rows in range[\s\S]*1 more before the span end are left/,
    );
    // CL has no bar left in the span: its stale-at-write rows from the span start are in.
    expect(text).toContain(
      'rows planned, CL: normal step 3 rows, stale-at-write 1 rows (1 added by the D1 lift), junk delete 1 rows',
    );
  });

  it('takes in every thin root once none has a bar left', async () => {
    expect(await run()).toBe(0);
    expect(report()).toContain('RTY 0 (lifted), CL 0 (lifted)');
  });

  it('counts the bars of a thin root outside the clean days only: a bar on a clean day does not block the lift', async () => {
    await bar('RTY', '2026-04-16T14:00:00Z', 2001); // trading day 04-16: clean
    expect(await run()).toBe(0);
    expect(report()).toContain('RTY 0 (lifted)');
  });

  it.each([
    // [root, ts of a lone bar, left in the span?]: each root's last bad bar is in, the minute after is out.
    ['CL', '2026-06-15T14:10:00Z', true],
    ['CL', '2026-06-15T14:11:00Z', false],
    ['ZN', '2026-06-15T14:11:00Z', true],
    ['ZN', '2026-06-15T14:12:00Z', false],
    ['ZN', '2026-04-05T21:59:00Z', false],
    ['ZN', '2026-04-05T22:00:00Z', true],
  ] as const)(
    'counts a lone %s bar at %s as left in the span: %s',
    async (root, ts, left) => {
      await bar(root, ts, 100);
      // A lifted root needs a 5a delete in the backup; the fixture's has RTY's and CL's only.
      if (root === 'ZN' && !left) {
        appendFileSync(
          backupPath,
          `${JSON.stringify({
            op: 'delete',
            reason: 'thin_root',
            row: {
              id: '1',
              symbol: 'ZN',
              ts: '2026-06-10T14:00:00Z',
              high: '110.0000',
              low: '110.0000',
              close: '110.0000',
              volume: '1',
            },
          })}
`,
        );
      }
      expect(
        await run({
          roots: [root],
          stores: ['snapshots'],
        }),
      ).toBe(0);
      expect(report()).toContain(`${root} ${left ? '1 (kept)' : '0 (lifted)'}`);
    },
  );

  it("keeps the detector-days rule for a lifted root's rows after the span end", async () => {
    // A stale-at-write row 9 days after the span end: inside the 20 days ruling 9
    // used to leave, so the lift would take it in, but it is after the span end.
    for (const symbol of THIN) {
      await bar(symbol, '2026-06-24T14:00:00Z', BASE[symbol]);
      await bar(symbol, '2026-06-24T14:40:00Z', BASE[symbol] + 10);
      await snap(symbol, '2026-06-24T14:41:30Z', [BASE[symbol], 0.1, 0.1, 1]);
    }
    expect(await run()).toBe(0);
    const without = report();
    expect(without).toContain(
      'rows planned, RTY: normal step 4 rows, stale-at-write 1 rows (1 added by the D1 lift), junk delete 1 rows',
    );
    expect(without).toContain(
      '1 more after it are left (no --detector-days file: the source is unchecked)',
    );

    const detectorPath = join(dir, 'detector_days.json');
    const days = { contaminated: [], flagged: [] };
    writeFileSync(
      detectorPath,
      JSON.stringify({ RTY: days, CL: days, GC: days, ZN: days }),
    );
    expect(await run({ detectorDays: detectorPath })).toBe(0);
    expect(report()).toContain(
      'rows planned, RTY: normal step 4 rows, stale-at-write 2 rows (2 added by the D1 lift), junk delete 1 rows',
    );
  });

  it("rewrites a lifted thin root's stale-at-write row before the span end, and nothing else, on apply", async () => {
    const before = await snapshots();
    const code = await run({
      apply: true,
      expectSnapshots: 6,
      rewriteStaleAtWrite: true,
      expectStaleRewrites: 2,
    });
    expect([code, errored()]).toEqual([0, '']);

    const after = await snapshots();
    for (const symbol of THIN) {
      const row = after.get(ids.stale[symbol] as number);
      // The 14:40 bar that landed after the row was written is what it says now.
      expect(row?.price).toBe(`${BASE[symbol] + 10}.0000`);
      expect(row?.change_1h_pct).toBeNull();
      expect(row?.change_day_pct).toBeNull();
      expect(row?.volume_ratio).not.toBe('1.0000');
      // A row the stale step does not name keeps its price.
      expect(after.get(ids.clean[symbol] as number)?.price).toBe(
        before.get(ids.clean[symbol] as number)?.price,
      );
      expect(after.get(ids.frozen[symbol] as number)).toEqual(
        before.get(ids.frozen[symbol] as number),
      );
    }
    expect(existsSync(markerPath(workDir, 'stale'))).toBe(true);
  });

  it("deletes a lifted thin root's frozen row on apply, and only that", async () => {
    const before = await snapshots();
    const code = await run({
      apply: true,
      frozen: true,
      stores: [],
      backup: null,
      deleteFrozenStale: true,
      expectFrozenDeletes: 2,
    });
    expect([code, errored()]).toEqual([0, '']);

    const after = await snapshots();
    expect(after.size).toBe(before.size - 2);
    for (const symbol of THIN) {
      expect(after.has(ids.frozen[symbol] as number)).toBe(false);
      expect(after.get(ids.stale[symbol] as number)).toEqual(
        before.get(ids.stale[symbol] as number),
      );
    }
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(true);
  });

  it('leaves the frozen row of a thin root with a bar left in the span, on apply', async () => {
    await reset({ leftBar: true });
    const code = await run({
      apply: true,
      frozen: true,
      stores: [],
      backup: null,
      deleteFrozenStale: true,
      expectFrozenDeletes: 1,
    });
    expect([code, errored()]).toEqual([0, '']);

    const after = await snapshots();
    expect(after.has(ids.frozen.RTY as number)).toBe(true); // kept: RTY has a bar left
    expect(after.has(ids.frozen.CL as number)).toBe(false);
  });

  it('prints the frozen apply command with the roots', async () => {
    expect(await run({ frozen: true, stores: [], roots: ['RTY', 'CL'] })).toBe(
      0,
    );
    expect(report()).toMatch(
      /--apply --work-dir \S+ --stores frozen --roots RTY CL --delete-frozen-stale --expect-frozen-deletes 2/,
    );
  });

  it('runs the frozen step over a lifted thin root, and over none that still has a bar in the span', async () => {
    await reset({ leftBar: true });
    expect(await run({ frozen: true, stores: [], roots: ['RTY', 'CL'] })).toBe(
      0,
    );
    const left = report();
    expect(left).toContain('rows to delete: 1');
    expect(left).toMatch(/\n {4}CL: 1,/);
    expect(left).not.toMatch(/\n {4}RTY: \d/);
    expect(left).toContain('(added by the D1 lift)');

    await reset();
    expect(await run({ frozen: true, stores: [], roots: ['RTY', 'CL'] })).toBe(
      0,
    );
    const gone = report();
    expect(gone).toContain('rows to delete: 2');
    expect(gone).toMatch(/\n {4}RTY: 1,/);
    expect(gone).toMatch(/\n {4}CL: 1,/);
  });

  it('keeps ES and NQ out of the frozen step with --roots, and in it without', async () => {
    expect(await run({ frozen: true, stores: [], roots: ['RTY', 'CL'] })).toBe(
      0,
    );
    expect(report()).not.toMatch(/\n {4}ES: \d/);

    expect(
      await run({
        frozen: true,
        stores: [],
        roots: ['ES', 'NQ', 'RTY', 'CL'],
      }),
    ).toBe(0);
    expect(report()).toMatch(/\n {4}ES: 1,/);
  });

  it('splits the frozen rows of a lifted root at the span and by month, and gives ES none of it', async () => {
    // More frozen rows of RTY: the last second of the span, its end (06-15 14:11:00), a
    // row after it in June (06-22) and one in July.
    await snap('RTY', '2026-06-15T14:10:59Z', [1900, 0.1, 0.1, 1]);
    await snap('RTY', '2026-06-15T14:11:00Z', [1900, 0.1, 0.1, 1]);
    await snap('RTY', '2026-06-22T16:00:30Z', [1900, 0.1, 0.1, 1]);
    await snap('RTY', '2026-07-02T15:00:30Z', [1900, 0.1, 0.1, 1]);

    expect(
      await run({
        frozen: true,
        stores: [],
        roots: ['ES', 'RTY', 'CL'],
      }),
    ).toBe(0);

    const text = report();
    expect(text).toMatch(/\n {4}RTY: 5,/);
    // RTY: the 05-12 row and the last second of the span are in it; the span end
    // itself, 06-22 and 07-02 are after it.
    expect(text).toMatch(
      /\n {4}RTY: 5,[^\n]*\n {6}in the span 2, after it 3 \(the span is 2026-04-05T22:00:00Z \.\. 2026-06-15T14:11:00Z\)\n {6}by UTC month: 2026-05 1, 2026-06 3, 2026-07 1\n/,
    );
    expect(text).toMatch(/\n {4}CL: 1,[^\n]*\n {6}in the span 1, after it 0 /);
    // ES is not a lifted root: its line has no such split.
    const es = /\n {4}ES: \d+,[^\n]*\n([^\n]*)\n/.exec(text);
    expect(es?.[1]).not.toMatch(/in the span/);
  });
});

// ── L2: the lift needs the 5a backup ─────────────────────────────────────────

describe('5b: a lifted root needs the 5a backup', () => {
  type Line = [symbol: string, ts: string];

  /** A bar backup of deletes only, in 5a's format. */
  function backupOf(lines: Line[]): void {
    writeFileSync(
      backupPath,
      `${lines
        .map(([symbol, ts]) =>
          JSON.stringify({
            op: 'delete',
            reason: 'thin_root',
            row: {
              id: '1',
              symbol,
              ts,
              open: '100.0000',
              high: '100.0000',
              low: '100.0000',
              close: '100.0000',
              volume: '1',
            },
          }),
        )
        .join('\n')}\n`,
    );
  }
  // Phase 2 deleted the junk window of every root; a trading day 5a deletes, outside it, is 5a's.
  const PHASE2: Line[] = [
    ['RTY', '2026-04-11T15:00:00Z'],
    ['CL', '2026-04-11T15:00:00Z'],
  ];
  const FIVE_A: Line = ['CL', '2026-06-10T14:00:00Z'];
  const FIX =
    'is lifted but the backup holds no 5a delete for it: pass thin-roots/backup-thin-roots.jsonl or --roots ES NQ';

  it('refuses a Phase 2 backup, naming each lifted root and the fix, before it writes anything', async () => {
    backupOf(PHASE2);

    expect(await run()).toBe(1);

    expect(errored()).toContain(`RTY ${FIX}`);
    expect(errored()).toContain(`CL ${FIX}`);
    expect(existsSync(join(workDir, 'report.txt'))).toBe(false);
    expect(hooks.writes).toBe(0);
  });

  it('refuses under --apply too, before any marker, backup or plan.json', async () => {
    backupOf(PHASE2);

    expect(await run({ apply: true, expectSnapshots: 6 })).toBe(1);

    expect(errored()).toContain(`RTY ${FIX}`);
    expect(hooks.writes).toBe(0);
    expect(existsSync(join(workDir, 'plan.json'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(false);
  });

  it('names only the root whose 5a deletes are missing', async () => {
    backupOf([...PHASE2, FIVE_A]);

    expect(await run()).toBe(1);

    expect(errored()).toContain(`RTY ${FIX}`);
    expect(errored()).not.toContain(`CL ${FIX}`);
  });

  it('takes a Phase 2 backup for --roots ES NQ: no thin root is in the run, so none is lifted', async () => {
    backupOf(PHASE2);

    expect(await run({ roots: ['ES', 'NQ'], stores: ['snapshots'] })).toBe(0);

    expect(errored()).toBe('');
    expect(report()).toMatch(/\bES: rows in range/);
  });

  it('does not ask for it from a thin root that still has a bar in the span: that root is not lifted', async () => {
    await reset({ leftBar: true });
    backupOf([FIVE_A]); // RTY has none, and RTY is kept

    expect(await run()).toBe(0);

    expect(report()).toContain('RTY 1 (kept), CL 0 (lifted)');
  });

  it('does not ask for it from --stores frozen, which takes no 5a backup', async () => {
    expect(
      await run({
        frozen: true,
        stores: [],
        backup: null,
        roots: ['RTY', 'CL'],
      }),
    ).toBe(0);
    expect(report()).toContain('rows to delete: 2');
  });

  // The backup is judged by what 5a deletes: a bar of the root, inside its window, on
  // a trading day that is not clean, and outside Phase 2's junk window (which the
  // fixture reads from the repair tool, so the two cannot drift apart).
  it.each([
    ['the minute before the junk window', JUNK_WINDOW.startMs - 60_000, true],
    ['the first minute of the junk window', JUNK_WINDOW.startMs, false],
    ['the last minute of the junk window', JUNK_WINDOW.endMs - 60_000, false],
    ['the first minute of a clean day', JUNK_WINDOW.endMs, false],
    [
      'the first bar after the clean days',
      Date.parse('2026-04-17T22:00:00Z'),
      true,
    ],
    ['the last bad bar', Date.parse('2026-06-15T14:10:00Z'), true],
    [
      'the minute after the last bad bar',
      Date.parse('2026-06-15T14:11:00Z'),
      false,
    ],
    ['a bar before the window', Date.parse('2026-04-05T21:59:00Z'), false],
  ])('RTY with only a bar at %s: %s', async (_name, tsMs, accepted) => {
    backupOf([FIVE_A, ['RTY', new Date(tsMs).toISOString()]]);

    expect(await run()).toBe(accepted ? 0 : 1);

    if (!accepted) expect(errored()).toContain(`RTY ${FIX}`);
  });

  it('does not count a 5a delete of another root as the root’s own', async () => {
    backupOf([FIVE_A, ['ZN', '2026-06-10T14:00:00Z']]);

    expect(await run()).toBe(1);

    expect(errored()).toContain(`RTY ${FIX}`);
  });
});

// ── L3: a dry run after an apply ─────────────────────────────────────────────

describe('5b: a dry run after an apply leaves the approved files alone', () => {
  const dryRuns = (): string[] =>
    readdirSync(workDir).filter((f) => /^dryrun-.*-report\.txt$/.test(f));

  it('writes report.txt from a dry run in a clean work dir, and dryrun-<time>- files once a step is marked done', async () => {
    expect(await run()).toBe(0);
    const approved = readFileSync(join(workDir, 'report.txt'));
    expect(dryRuns()).toEqual([]);

    expect([await run({ apply: true, expectSnapshots: 6 }), errored()]).toEqual(
      [0, ''],
    );
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);

    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await run()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(approved);
    expect(dryRuns()).toHaveLength(1);
    expect(report()).toContain('rows planned, RTY: normal step 0 rows');
    expect(readFileSync(join(workDir, dryRuns()[0] ?? ''), 'utf8')).toContain(
      'rows planned, RTY: normal step 0 rows',
    );
    expect(logged()).toContain(`report: ${join(workDir, dryRuns()[0] ?? '')}`);
  });

  it('does so after a failed apply that marked only some steps', async () => {
    expect(await run()).toBe(0);
    const approved = readFileSync(join(workDir, 'report.txt'));
    hooks.failWriteAt = { nth: 2, error: new Error('connection lost') };
    expect(
      await run({
        apply: true,
        expectSnapshots: 6,
        deleteJunkStale: true,
        expectJunkDeletes: 2,
      }),
    ).toBe(1);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    hooks.failWriteAt = null;

    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await run()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(approved);
    expect(dryRuns()).toHaveLength(1);
  });
});
