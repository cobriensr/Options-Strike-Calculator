// @vitest-environment node

/**
 * REAL-SQL test for the volume-null step of the Phase 4 recompute
 * (`--stores volume-null --null-volume-ratio`, owner ruling 2026-11-12): the scope
 * read from a 5b apply backup, the read of the rows by id, the full-row backup, the
 * guarded batched UPDATE, the verify and the resume run against pglite (Postgres in
 * WASM), with futures_snapshots built from the real migration (#45).
 *
 * The step runs alone and reads only futures_snapshots: futures_bars does not exist
 * here, so a query of it (or of market_snapshots, or ws_gamma_setup_fires) would
 * reject. getDb() emulates production as in futures-derived-frozen-pglite.test.ts: a
 * plain query is a read-only transaction, a transaction honours `readOnly`, and every
 * write is counted.
 */

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
} from 'vitest';
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';

import type { PgliteQuery } from '../../api/__tests__/pglite-migrations';

const hooks = vi.hoisted(() => ({
  pg: null as PGliteType | null,
  calls: [] as {
    readOnly: boolean;
    texts: string[];
    /** neonConfig.fetchFunction when the transaction was issued. */
    fetchFn: unknown;
  }[],
  /** neonConfig.fetchFunction at each plain query. */
  plainFetch: [] as unknown[],
  beforeWrite: null as null | ((texts: string[]) => Promise<void> | void),
  /** The nth (1-based) write transaction rejects with this error. */
  failWriteAt: null as null | { nth: number; error: Error },
  /** Write transactions resolve with no rows and run nothing. */
  dropWrites: false,
  writes: 0,
  /** The nth (1-based) read-only transaction rejects with this error. */
  failReadAt: null as null | { nth: number; error: Error },
  reads: 0,
  /** The write batch sizes: a test shrinks them so a small step takes several transactions. */
  writeChunk: 500,
  chunksPerTransaction: 10,
}));

vi.mock('./futures-derived-batch.js', () => ({
  get WRITE_CHUNK() {
    return hooks.writeChunk;
  },
  get CHUNKS_PER_TRANSACTION() {
    return hooks.chunksPerTransaction;
  },
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
            hooks.plainFetch.push(neonConfig.fetchFunction);
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
          hooks.calls.push({
            readOnly,
            texts: queries.map((q) => q.text),
            fetchFn: neonConfig.fetchFunction,
          });
          if (readOnly) {
            hooks.reads += 1;
            if (hooks.failReadAt?.nth === hooks.reads)
              throw hooks.failReadAt.error;
          } else {
            hooks.writes += 1;
            await hooks.beforeWrite?.(queries.map((q) => q.text));
            if (hooks.failWriteAt?.nth === hooks.writes)
              throw hooks.failWriteAt.error;
            if (hooks.dropWrites) return queries.map(() => []);
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
import {
  markerPath,
  readOnlyFetch,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';
import {
  checkVolumeNullGate,
  parseVolumeNullScope,
  regionOf,
} from './futures-volume-null.js';

vi.setConfig({ testTimeout: 60_000 });

// ── Schema ──────────────────────────────────────────────────────────────────

let pg: PGliteType;
let dir: string;
let workDir: string;
let scopePath: string;

beforeAll(async () => {
  pg = await PGlite.create();
  hooks.pg = pg;
  await pg.query(`SET TIME ZONE 'UTC'`);
  await applyMigration(pg, 45);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

// ── Fixture: the world 5b leaves, and the backup it wrote ───────────────────

interface Seed {
  symbol: 'RTY' | 'CL' | 'GC' | 'ZN';
  ts: string;
  /** What 5b wrote, and what the row holds now. */
  guard: number;
  /** The step whose line names it (a row in both steps has two lines). */
  step: 'snapshots' | 'stale';
}

/** The 9 rows the ruling blanks and the 3 it keeps, by key. */
const BLANK: Record<string, Seed> = {
  juneRty: {
    symbol: 'RTY',
    ts: '2026-06-01T15:00:30Z',
    guard: 0.1234,
    step: 'snapshots',
  },
  juneCl: {
    symbol: 'CL',
    ts: '2026-06-08T15:00:30Z',
    guard: 0.2345,
    step: 'stale',
  },
  june15Rty: {
    symbol: 'RTY',
    ts: '2026-06-15T14:11:00Z',
    guard: 0.3,
    step: 'snapshots',
  },
  june15Gc: {
    symbol: 'GC',
    ts: '2026-06-16T03:59:59Z',
    guard: 0.4,
    step: 'snapshots',
  },
  j16Cl: {
    symbol: 'CL',
    ts: '2026-06-16T04:00:00Z',
    guard: 0.5,
    step: 'snapshots',
  },
  j16Zn: {
    symbol: 'ZN',
    ts: '2026-07-05T14:10:59Z',
    guard: 0.6,
    step: 'stale',
  },
  gcApril: {
    symbol: 'GC',
    ts: '2026-04-14T15:00:30Z',
    guard: 67.5,
    step: 'snapshots',
  },
  both: { symbol: 'ZN', ts: '2026-06-17T15:00:30Z', guard: 0.3, step: 'stale' },
  elsewhere: {
    symbol: 'ZN',
    ts: '2026-06-02T15:00:30Z',
    guard: 0.8,
    step: 'stale',
  },
};
const KEPT: Record<string, Seed> = {
  rtyApril: {
    symbol: 'RTY',
    ts: '2026-04-14T15:00:30Z',
    guard: 0.5,
    step: 'snapshots',
  },
  clApril: {
    symbol: 'CL',
    ts: '2026-04-15T15:00:30Z',
    guard: 0.51,
    step: 'snapshots',
  },
  znApril: {
    symbol: 'ZN',
    ts: '2026-04-17T15:00:30Z',
    guard: 0.52,
    step: 'stale',
  },
};
const TARGETS = Object.keys(BLANK).length; // 9

const ids: Record<string, number> = {};

async function insertRow(
  symbol: string,
  ts: string,
  volumeRatio: number | null,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO futures_snapshots
       (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     VALUES ($1, $2, $3, 100.5, 0.5, -0.25, $4) RETURNING id`,
    [ts.slice(0, 10), ts.replace('Z', '.394Z'), symbol, volumeRatio],
  );
  return rows[0]!.id;
}

/** One line of a 5b apply backup: the old row and the fields the step wrote. */
function backupLine(
  step: string,
  id: number,
  symbol: string,
  ts: string,
  to: unknown,
  old: number | null = null,
): string {
  return JSON.stringify({
    step,
    store: 'snapshots',
    id,
    symbol,
    fields: ['volumeRatio'],
    row: {
      id,
      ts: ts.replace('Z', '.394+00:00'),
      price: 100.5,
      symbol,
      trade_date: ts.slice(0, 10),
      volume_ratio: old,
      change_1h_pct: 0.5,
      change_day_pct: -0.25,
    },
    to,
  });
}

async function reset(): Promise<void> {
  await pg.query(`TRUNCATE futures_snapshots RESTART IDENTITY`);
  const lines: string[] = [];
  for (const [key, s] of Object.entries({ ...BLANK, ...KEPT })) {
    ids[key] = await insertRow(s.symbol, s.ts, s.guard);
    if (key === 'both') {
      // The snapshots line is the earlier write; the stale line's value is the guard.
      lines.push(
        backupLine('snapshots', ids[key], s.symbol, s.ts, { volumeRatio: 0.2 }),
      );
    }
    lines.push(
      backupLine(s.step, ids[key], s.symbol, s.ts, { volumeRatio: s.guard }),
    );
  }
  // A write of NULL: nothing to blank.
  ids.nullWrite = await insertRow('RTY', '2026-06-18T15:00:30Z', null);
  lines.push(
    backupLine('snapshots', ids.nullWrite, 'RTY', '2026-06-18T15:00:30Z', {
      volumeRatio: null,
    }),
  );
  // A line that wrote another field: not a writer of volume_ratio.
  ids.priceOnly = await insertRow('CL', '2026-06-18T15:00:30Z', 0.9);
  lines.push(
    backupLine('snapshots', ids.priceOnly, 'CL', '2026-06-18T15:00:30Z', {
      price: 70,
    }),
  );
  // A deleted row (junk step): ignored.
  lines.push(
    JSON.stringify({
      step: 'junk',
      store: 'snapshots',
      id: 999999,
      symbol: 'RTY',
      row: { id: 999999, ts: '2026-06-03T15:00:00.1+00:00', symbol: 'RTY' },
      to: null,
      op: 'delete',
    }),
  );
  // A row the backup never names.
  ids.outsider = await insertRow('RTY', '2026-06-19T15:00:30Z', 0.7);
  writeFileSync(scopePath, `${lines.join('\n')}\n`);
}

const blanked = (): number[] => Object.keys(BLANK).map((k) => ids[k]!);
const kept = (): number[] => [
  ...Object.keys(KEPT).map((k) => ids[k]!),
  ids.nullWrite!,
  ids.priceOnly!,
  ids.outsider!,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: true,
    force: false,
    stores: [],
    roots: ['ES', 'NQ', 'ZN', 'RTY', 'CL', 'GC'],
    frozen: false,
    volumeNull: true,
    backup: scopePath,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    nullVolumeRatio: true,
    expectVolumeNulls: TARGETS,
    detectorDays: null,
    ...over,
  };
}
const run = (over: Partial<RecomputeOptions> = {}) =>
  runRecompute(options(over));
const dry = (over: Partial<RecomputeOptions> = {}) =>
  run({
    apply: false,
    nullVolumeRatio: false,
    expectVolumeNulls: null,
    ...over,
  });

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
/** The report the last run wrote: the last "report:" line a run printed names it. */
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
const backups = (): string[] =>
  existsSync(workDir)
    ? readdirSync(workDir).filter((f) => f.startsWith('backup-'))
    : [];

type Row = Record<string, unknown>;
async function rowsOf(idList: number[]): Promise<Map<number, Row>> {
  const { rows } = await pg.query<{ id: number; r: Row }>(
    `SELECT id, to_jsonb(f) AS r FROM futures_snapshots f
      WHERE id = ANY($1::int[]) ORDER BY id`,
    [idList],
  );
  return new Map(rows.map((x) => [x.id, x.r]));
}
async function ratio(id: number): Promise<string | null> {
  const { rows } = await pg.query<{ v: string | null }>(
    `SELECT volume_ratio::text AS v FROM futures_snapshots WHERE id = $1`,
    [id],
  );
  return rows[0]?.v ?? null;
}
async function dump(): Promise<string> {
  const { rows } = await pg.query(
    `SELECT to_jsonb(x) AS r FROM futures_snapshots x ORDER BY id`,
  );
  return JSON.stringify(rows);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); // Sunday: not market hours
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'volume-null-pglite-'));
  workDir = join(dir, 'work');
  scopePath = join(dir, 'backup-5b.jsonl');
  hooks.calls = [];
  hooks.plainFetch = [];
  hooks.beforeWrite = null;
  hooks.failWriteAt = null;
  hooks.dropWrites = false;
  hooks.writeChunk = 500;
  hooks.chunksPerTransaction = 10;
  hooks.writes = 0;
  hooks.failReadAt = null;
  hooks.reads = 0;
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── The scope ───────────────────────────────────────────────────────────────

describe('parseVolumeNullScope', () => {
  const line = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      step: 'snapshots',
      store: 'snapshots',
      id: 1,
      symbol: 'RTY',
      fields: ['volumeRatio'],
      row: { id: 1, ts: '2026-06-01T15:00:30.394+00:00', symbol: 'RTY' },
      to: { volumeRatio: 0.5 },
      ...over,
    });

  it('takes the ids that write a volume ratio, minus the April rows of RTY, CL and ZN', () => {
    const scope = parseVolumeNullScope(
      readFileSync(scopePath, 'utf8'),
      'backup-5b.jsonl',
    );
    expect(scope.targets.map((t) => t.id).sort((a, b) => a - b)).toEqual(
      blanked().sort((a, b) => a - b),
    );
    expect(scope).toMatchObject({
      writers: 13, // 9 targets, 3 kept April rows, 1 NULL write
      keptApril: 3,
      wroteNull: 1,
      inBothSteps: 1,
    });
    // One line per writer (13), the extra snapshots line of `both`, the price-only line and the junk line.
    expect(scope.lines).toBe(13 + 1 + 1 + 1);
  });

  it('takes the later step’s value as the guard when an id has one in both', () => {
    const text = [
      line({ step: 'stale', to: { volumeRatio: 0.3 } }),
      line({ step: 'snapshots', to: { volumeRatio: 0.2 } }), // file order must not decide
    ].join('\n');
    expect(parseVolumeNullScope(text, 'f').targets[0]?.guard).toBe(0.3);
    expect(
      parseVolumeNullScope([...text.split('\n')].reverse().join('\n'), 'f')
        .targets[0]?.guard,
    ).toBe(0.3);
  });

  it('keeps GC on the April clean days out of the kept rows, and the other three in', () => {
    const april = (symbol: string, id: number) =>
      line({
        id,
        symbol,
        row: { id, ts: '2026-04-14T15:00:30.394+00:00', symbol },
      });
    const scope = parseVolumeNullScope(
      ['RTY', 'CL', 'ZN', 'GC'].map((s, i) => april(s, i + 1)).join('\n'),
      'f',
    );
    expect(scope.targets.map((t) => [t.symbol, t.region])).toEqual([
      ['GC', 'gcAprilClean'],
    ]);
    expect(scope.keptApril).toBe(3);
  });

  it.each([
    ['2026-04-12T22:00:00Z', 'RTY', true], // trading day 04-13: first clean April day
    ['2026-04-17T21:59:00Z', 'RTY', true], // trading day 04-17: the last
    ['2026-04-12T21:59:00Z', 'RTY', false], // trading day 04-12
    ['2026-04-17T22:00:00Z', 'RTY', false], // trading day 04-18
  ])('keeps the April row at %s for %s: %s', (ts, symbol, isKept) => {
    const scope = parseVolumeNullScope(
      line({ symbol, row: { id: 1, ts, symbol } }),
      'f',
    );
    expect(scope.keptApril).toBe(isKept ? 1 : 0);
    expect(scope.targets).toHaveLength(isKept ? 0 : 1);
  });

  it.each([
    ['2026-06-15T14:10:59Z', 'elsewhere'],
    ['2026-06-15T14:11:00Z', 'june15'],
    ['2026-06-16T03:59:59Z', 'june15'],
    ['2026-06-16T04:00:00Z', 'june16ToJuly5'],
    ['2026-07-05T14:10:59Z', 'june16ToJuly5'],
    ['2026-07-05T14:11:00Z', 'elsewhere'],
    ['2026-06-01T22:00:00Z', 'elsewhere'], // trading day 06-02
    ['2026-05-31T22:00:00Z', 'juneClean'], // trading day 06-01 opens
    ['2026-06-08T21:59:00Z', 'juneClean'],
  ])('puts a RTY row at %s in %s', (ts, region) => {
    expect(regionOf('RTY', Date.parse(ts))).toBe(region);
  });

  it.each([
    ['a line that is not JSON', '{"step":', /f:1: not JSON/],
    ['a line without a step', '{"id":1}', /f:1: not a plan line/],
    ['a snapshots line without an id', line({ id: undefined }), /f:1: id /],
    [
      'a volume ratio that is not a number',
      line({ to: { volumeRatio: 'high' } }),
      /f:1: to\.volumeRatio /,
    ],
    [
      'a symbol that differs from its row',
      line({
        row: { id: 1, ts: '2026-06-01T15:00:30.394+00:00', symbol: 'CL' },
      }),
      /f:1: symbol RTY but its row says CL/,
    ],
    [
      'an ES row',
      line({
        symbol: 'ES',
        row: { id: 1, ts: '2026-06-01T15:00:30.394+00:00', symbol: 'ES' },
      }),
      /f:1: ES is not a thin root/,
    ],
    [
      'a ts that is not a date',
      line({ row: { id: 1, ts: 'soon', symbol: 'RTY' } }),
      /f:1: row ts "soon" is not a date/,
    ],
    [
      'the same id twice in one step',
      `${line()}\n${line()}`,
      /f:2: id 1 twice in step snapshots/,
    ],
  ])('throws on %s, naming the line', (_name, text, message) => {
    expect(() => parseVolumeNullScope(text, 'f')).toThrow(message);
  });

  it('ignores a snapshots line that wrote no volume ratio, and every line of another step', () => {
    const scope = parseVolumeNullScope(
      [
        line({ to: { price: 70 } }),
        JSON.stringify({ step: 'junk', id: 2, to: null }),
        JSON.stringify({ step: 'premarket', id: 3, to: { globexHigh: 1 } }),
      ].join('\n'),
      'f',
    );
    expect(scope).toMatchObject({ writers: 0, lines: 3 });
    expect(scope.targets).toEqual([]);
  });
});

describe('checkVolumeNullGate', () => {
  it('is empty without the flag, and otherwise needs the count of the dry run', () => {
    expect(
      checkVolumeNullGate({ nullVolumeRatio: false, expectVolumeNulls: 3 }, 7),
    ).toEqual([]);
    expect(
      checkVolumeNullGate(
        { nullVolumeRatio: true, expectVolumeNulls: null },
        7,
      ),
    ).toEqual([
      '--null-volume-ratio needs --expect-volume-nulls N: the count of the dry run you approved',
    ]);
    expect(
      checkVolumeNullGate({ nullVolumeRatio: true, expectVolumeNulls: 6 }, 7),
    ).toEqual([
      'the fresh plan blanks 7 volume_ratio values, --expect-volume-nulls 6 was given',
    ]);
    expect(
      checkVolumeNullGate({ nullVolumeRatio: true, expectVolumeNulls: 7 }, 7),
    ).toEqual([]);
  });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('the volume-null dry run on real SQL (pglite)', () => {
  it('plans the 9 rows, lists the regions and roots and the apply command, and writes nothing', async () => {
    const before = await dump();
    expect(await dry()).toBe(0);

    expect(await dump()).toBe(before);
    expect(hooks.writes).toBe(0);
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
    expect(hooks.calls.every((c) => c.fetchFn === readOnlyFetch)).toBe(true);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();
    expect(backups()).toEqual([]);
    expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(false);

    const text = report();
    expect(text).toContain(
      'rows to blank (still there and holding the value 5b wrote): 9',
    );
    expect(text).toContain('already NULL: 0');
    expect(text).toContain('gone: 0');
    expect(text).toContain('changed since 5b: 0');
    expect(text).toContain('kept, RTY, CL and ZN on the April clean days: 3');
    expect(text).toContain(
      '13 ids write a volume_ratio in the snapshots or stale step (1 in both',
    );
    expect(text).toContain(
      'June clean days (06-01, 06-08): 2 (RTY 1, CL 1, GC 0, ZN 0)',
    );
    expect(text).toContain(
      '06-15 14:11Z to 06-16 04:00Z: 2 (RTY 1, CL 0, GC 1, ZN 0)',
    );
    expect(text).toContain(
      '06-16 04:00Z to 07-05 14:11Z: 3 (RTY 0, CL 1, GC 0, ZN 2)',
    );
    expect(text).toContain(
      'GC on the April clean days: 1 (RTY 0, CL 0, GC 1, ZN 0)',
    );
    expect(text).toContain(
      'anywhere else (the ruling names none): 1 (RTY 0, CL 0, GC 0, ZN 1)',
    );
    expect(text).toContain('rows to blank, by root: RTY 2, CL 2, GC 2, ZN 3');
    expect(text).toContain(
      `npx tsx scripts/recompute-futures-derived.ts --apply --work-dir ${workDir} --stores volume-null --backup ${scopePath} --null-volume-ratio --expect-volume-nulls 9`,
    );
    expect(text).not.toContain('Apply gate');
  });

  it('reads only futures_snapshots: no bars, no other store, no Phase 2 backup', async () => {
    expect(await dry()).toBe(0);
    const texts = hooks.calls.flatMap((c) => c.texts).join('\n');
    expect(texts).not.toMatch(
      /futures_bars|market_snapshots|ws_gamma_setup_fires|index_candles_1m/,
    );
    expect(logged()).not.toMatch(/rows in range|bars ES|bar backup/);
  });

  it('names every target that is gone or changed since 5b, with a count, and plans the rest', async () => {
    await pg.query(`DELETE FROM futures_snapshots WHERE id = $1`, [
      ids.juneRty,
    ]);
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.9999 WHERE id = $1`,
      [ids.j16Cl],
    );
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = NULL WHERE id = $1`,
      [ids.gcApril],
    );
    // The same id under another symbol is not that row.
    await pg.query(`UPDATE futures_snapshots SET symbol = 'ZN' WHERE id = $1`, [
      ids.juneCl,
    ]);

    expect(await dry()).toBe(0);

    const text = report();
    expect(text).toContain(
      'rows to blank (still there and holding the value 5b wrote): 5',
    );
    expect(text).toContain('already NULL: 1');
    expect(text).toMatch(/gone: 2 \(no row with that id and symbol\):/);
    expect(text).toContain(
      `RTY 2026-06-01T15:00:30.394Z id ${ids.juneRty}: 5b wrote 0.1234`,
    );
    expect(text).toContain(
      `CL 2026-06-08T15:00:30.394Z id ${ids.juneCl}: 5b wrote 0.2345`,
    );
    expect(text).toMatch(
      /changed since 5b: 1 \(the row holds another value, so it is left alone\):/,
    );
    expect(text).toContain(
      `CL 2026-06-16T04:00:00.394Z id ${ids.j16Cl}: 5b wrote 0.5, now 0.9999`,
    );
    expect(text).toContain('--expect-volume-nulls 5');
  });

  it('prints no apply command when nothing is left to blank', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = NULL WHERE id = ANY($1::int[])`,
      [blanked()],
    );
    expect(await dry()).toBe(0);
    expect(report()).toContain(
      'rows to blank (still there and holding the value 5b wrote): 0',
    );
    expect(report()).toContain('already NULL: 9');
    expect(report()).not.toContain('To apply');
  });

  it('exits non-zero with the reason when the read of the rows rejects', async () => {
    // Read-only transactions: 1 is the session check, 2 the first read of the rows.
    hooks.failReadAt = {
      nth: 2,
      error: new Error('permission denied for table futures_snapshots'),
    };
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/permission denied for table futures_snapshots/);
    expect(existsSync(join(workDir, 'report.txt'))).toBe(false);
    expect(neonConfig.fetchFunction).toBeUndefined();
  });

  it('exits non-zero, naming the line, when the scope file is not a plan', async () => {
    writeFileSync(scopePath, '{"step":"snapshots"\n');
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/backup-5b\.jsonl:1: not JSON/);
    expect(hooks.calls).toEqual([]);
  });

  it('needs the scope file', async () => {
    expect(await dry({ backup: null })).toBe(1);
    expect(errored()).toMatch(
      /--backup <file> is required with --stores volume-null/,
    );
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('--null-volume-ratio on real SQL (pglite)', () => {
  it('sets the 9 values to NULL and changes nothing else of those rows', async () => {
    const before = await rowsOf([...blanked(), ...kept()]);
    expect([await run(), errored()]).toEqual([0, '']);

    const after = await rowsOf([...blanked(), ...kept()]);
    for (const id of blanked()) {
      expect(await ratio(id)).toBeNull();
      expect({ ...after.get(id), volume_ratio: null }).toEqual({
        ...before.get(id),
        volume_ratio: null,
      });
    }
    expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(true);
    expect(existsSync(join(workDir, 'volume-null.started'))).toBe(true);
    expect(logged()).toContain('volume-null: 9 row(s) changed and verified');
  });

  it('leaves the April rows of RTY, CL and ZN, the NULL write, the price-only row and the outsider as they were', async () => {
    const before = await rowsOf(kept());
    expect(await run()).toBe(0);
    expect(await rowsOf(kept())).toEqual(before);
    expect(await ratio(ids.rtyApril!)).toBe('0.5000');
    expect(await ratio(ids.outsider!)).toBe('0.7000');
  });

  it('backs the rows up whole before the first UPDATE, and records the plan', async () => {
    let backedUp: string[] = [];
    hooks.beforeWrite = (texts) => {
      if (
        backedUp.length === 0 &&
        texts.some((t) => /UPDATE futures_snapshots/.test(t))
      ) {
        backedUp = backups();
      }
    };
    const before = await rowsOf(blanked());
    expect(await run()).toBe(0);

    expect(backedUp).toHaveLength(1);
    const lines = readFileSync(join(workDir, backedUp[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            step: string;
            store: string;
            id: number;
            symbol: string;
            fields: string[];
            to: unknown;
            row: Row;
          },
      );
    expect(lines.map((l) => l.id).sort((a, b) => a - b)).toEqual(
      blanked().sort((a, b) => a - b),
    );
    for (const l of lines) {
      expect(l).toMatchObject({
        step: 'volume-null',
        store: 'snapshots',
        fields: ['volumeRatio'],
        to: { volumeRatio: null },
      });
      // The row as it was, the value 5b wrote included.
      expect(l.row).toEqual(before.get(l.id));
    }
    const pointer = JSON.parse(
      readFileSync(join(workDir, 'plan.json'), 'utf8'),
    ) as {
      steps: string[];
      rows: Record<string, number>;
      expect: Record<string, number | null>;
      command: { stores: string[]; backup: string };
    };
    expect(pointer.steps).toEqual(['volume-null']);
    expect(pointer.rows).toEqual({ 'volume-null': 9 });
    expect(pointer.expect['volume-null']).toBe(9);
    expect(pointer.command).toMatchObject({ stores: [], backup: scopePath });
  });

  it('writes in batches of the chunk size, the guard on every one', async () => {
    hooks.writeChunk = 4;
    hooks.chunksPerTransaction = 1;
    expect(await run()).toBe(0);
    expect(hooks.writes).toBe(3); // 4 + 4 + 1 rows
    const updates = hooks.calls
      .filter((c) => !c.readOnly)
      .flatMap((c) => c.texts);
    expect(
      updates.every((t) => /f\.volume_ratio = r\.volume_ratio/.test(t)),
    ).toBe(true);
    expect(updates.every((t) => /f\.symbol = r\.symbol/.test(t))).toBe(true);
  });

  it('refuses a count that is not the fresh plan, before any marker, backup or write', async () => {
    const before = await dump();
    expect(await run({ expectVolumeNulls: 8 })).toBe(1);
    expect(errored()).toMatch(
      /the fresh plan blanks 9 volume_ratio values, --expect-volume-nulls 8 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    expect(existsSync(join(workDir, 'plan.json'))).toBe(false);
    expect(existsSync(join(workDir, 'volume-null.started'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(false);
  });

  it('refuses the flag without a count, before any write', async () => {
    const before = await dump();
    expect(await run({ expectVolumeNulls: null })).toBe(1);
    expect(errored()).toMatch(
      /--null-volume-ratio needs --expect-volume-nulls N: the count of the dry run you approved/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
  });

  it('refuses when a target changed since the dry run, because the fresh plan is one short', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.9999 WHERE id = $1`,
      [ids.j16Cl],
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /the fresh plan blanks 8 volume_ratio values, --expect-volume-nulls 9 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(await dump()).toBe(before);
  });

  it('blanks the rest and leaves the changed row alone when the count is the fresh one', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.9999 WHERE id = $1`,
      [ids.j16Cl],
    );
    expect(await run({ expectVolumeNulls: 8 })).toBe(0);
    expect(await ratio(ids.j16Cl!)).toBe('0.9999');
    for (const id of blanked().filter((i) => i !== ids.j16Cl)) {
      expect(await ratio(id)).toBeNull();
    }
  });

  it('refuses --apply during market hours, before it reads anything or writes a backup', async () => {
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply during market hours/);
    expect(hooks.calls).toEqual([]);
    expect(backups()).toEqual([]);
    expect(existsSync(workDir)).toBe(false);
  });

  it('is done once: the marker skips a second run, and the fresh plan then lists no row', async () => {
    expect(await run()).toBe(0);
    vi.mocked(console.log).mockClear();
    const after = await dump();
    expect(await run({ expectVolumeNulls: 0 })).toBe(0);
    expect(logged()).toContain(
      'the volume-null step is marked done and has nothing left to blank',
    );
    expect(backups()).toHaveLength(1);
    expect(await dump()).toBe(after);
  });

  // The usage text says so: a rerun takes --expect-volume-nulls 0 (above), and one
  // with the count of the first apply is refused.
  it('refuses a rerun with the count of the first apply, and writes nothing: every row is NULL now', async () => {
    expect(await run()).toBe(0);
    const after = await dump();
    hooks.writes = 0;
    vi.mocked(console.error).mockClear();

    expect(await run()).toBe(1);

    expect(errored()).toMatch(
      /Refusing to --apply\. Nothing was written\.[\s\S]*the fresh plan blanks 0 volume_ratio values, --expect-volume-nulls 9 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toHaveLength(1);
    expect(await dump()).toBe(after);
  });

  it('skips on the marker even when the fresh plan still lists rows, and says so', async () => {
    expect(await run()).toBe(0);
    // Two rows get their 5b values back, as if something wrote them again.
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.1234 WHERE id = $1`,
      [ids.juneRty],
    );
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.2345 WHERE id = $1`,
      [ids.juneCl],
    );
    vi.mocked(console.log).mockClear();

    expect(await run({ expectVolumeNulls: 2 })).toBe(0);

    expect(logged()).toContain(
      'WARNING: the volume-null step is marked done but the fresh plan still lists 2 row(s); it is skipped. Use --force to redo it.',
    );
    expect(await ratio(ids.juneRty!)).toBe('0.1234');
    expect(backups()).toHaveLength(1);
  });

  it('fails the step, unmarked, when the UPDATE is silently dropped', async () => {
    hooks.dropWrites = true;
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /apply failed: volume-null: verify failed for volume-null: 9 of 9 row\(s\) differ from the plan/,
    );
    expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(false);
    expect(await ratio(ids.juneRty!)).toBe('0.1234');
  });

  it('never blanks a row that changed after the plan was read, and fails the step', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /UPDATE futures_snapshots/.test(t))) {
        await pg.query(
          `UPDATE futures_snapshots SET volume_ratio = 0.9999 WHERE id = $1`,
          [ids.june15Rty],
        );
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /verify failed for volume-null: 1 of 9 row\(s\) differ from the plan/,
    );
    expect(await ratio(ids.june15Rty!)).toBe('0.9999');
    expect(await ratio(ids.juneRty!)).toBeNull();
    expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(false);
  });

  it('fails the step when a column other than the ratio changes during the write', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /UPDATE futures_snapshots/.test(t))) {
        await pg.query(`UPDATE futures_snapshots SET price = 1 WHERE id = $1`, [
          ids.juneRty,
        ]);
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /verify failed for volume-null: 1 of 9 row\(s\) differ from the plan/,
    );
  });

  it('never blanks a row whose symbol changed after the plan was read', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /UPDATE futures_snapshots/.test(t))) {
        await pg.query(
          `UPDATE futures_snapshots SET symbol = 'GC' WHERE id = $1`,
          [ids.juneRty],
        );
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/verify failed for volume-null: 1 of 9 row\(s\)/);
    expect(await ratio(ids.juneRty!)).toBe('0.1234'); // the id guard alone would have blanked it
  });

  describe('an UPDATE that rejects part way', () => {
    beforeEach(() => {
      // Four rows per statement and per transaction: the second UPDATE is the second write.
      hooks.writeChunk = 4;
      hooks.chunksPerTransaction = 1;
    });

    it('leaves the backup and the plan on disk, with the step started and unmarked', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      expect(errored()).toMatch(/apply failed: volume-null: deadlock detected/);
      expect(existsSync(join(workDir, 'volume-null.started'))).toBe(true);
      expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(false);
      expect(backups()).toHaveLength(1);
      const nulls = (await Promise.all(blanked().map((i) => ratio(i)))).filter(
        (v) => v == null,
      );
      expect(nulls).toHaveLength(4); // the first batch committed
    });

    it('finishes from the saved plan on the same command, with no planning', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      hooks.failWriteAt = null;
      hooks.writes = 0;
      hooks.calls = [];
      vi.mocked(console.log).mockClear();
      vi.mocked(console.error).mockClear();

      expect(await run()).toBe(0);

      expect(errored()).toBe('');
      for (const id of blanked()) expect(await ratio(id)).toBeNull();
      expect(existsSync(markerPath(workDir, 'volume-null'))).toBe(true);
      expect(logged()).toContain('Resuming from');
      expect(logged()).not.toContain('Futures derived-store recompute');
      // Only the rows of the saved plan are read, by id: no scope file, no planning.
      expect(backups()).toHaveLength(1);
    });

    it('refuses to finish when a planned row holds neither the 5b value nor NULL, and writes nothing', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      const left = (
        await Promise.all(
          blanked().map(async (i) => [i, await ratio(i)] as const),
        )
      )
        .filter(([, v]) => v != null)
        .map(([i]) => i);
      await pg.query(
        `UPDATE futures_snapshots SET volume_ratio = 42 WHERE id = $1`,
        [left[0]],
      );
      hooks.failWriteAt = null;
      hooks.writes = 0;
      vi.mocked(console.error).mockClear();

      expect(await run()).toBe(1);

      expect(errored()).toMatch(
        /apply failed: volume-null: 1 of 9 row\(s\) hold neither the planned old value nor the new one, so volume-null is not written/,
      );
      expect(hooks.writes).toBe(0);
      expect(await ratio(left[0]!)).toBe('42.0000');
    });

    it('refuses to finish with another count than the plan was made with', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      hooks.failWriteAt = null;
      hooks.writes = 0;
      vi.mocked(console.error).mockClear();

      expect(await run({ expectVolumeNulls: 5 })).toBe(1);
      expect(errored()).toMatch(
        /Refusing to resume[\s\S]*--expect-volume-nulls 5 was given, the saved plan has 9/,
      );
      expect(hooks.writes).toBe(0);
    });

    it('refuses to finish without the flag the plan was made with', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      hooks.failWriteAt = null;
      vi.mocked(console.error).mockClear();

      expect(
        await run({ nullVolumeRatio: false, expectVolumeNulls: null }),
      ).toBe(1);
      expect(errored()).toMatch(
        /the saved plan has a volume-null step, --null-volume-ratio was not given/,
      );
    });
  });

  it('writes a dry run after the apply under a dryrun-<time>- name and keeps the approved report.txt', async () => {
    expect(await dry()).toBe(0);
    const approved = readFileSync(join(workDir, 'report.txt'));
    expect(await run()).toBe(0);

    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await dry()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(approved);
    const later = readdirSync(workDir).filter((f) =>
      /^dryrun-.*-report\.txt$/.test(f),
    );
    expect(later).toHaveLength(1);
    expect(readFileSync(join(workDir, later[0]!), 'utf8')).toContain(
      'already NULL: 9',
    );
  });
});
