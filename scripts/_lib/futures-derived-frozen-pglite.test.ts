// @vitest-environment node

/**
 * REAL-SQL test for the opt-in frozen-stale delete of the Phase 4 recompute
 * (`--stores frozen --delete-frozen-stale`, owner OK 2026-11-11): the candidate
 * query, the computeSnapshot confirmation, the full-row backup, the guarded
 * batched DELETE, the verify and the resume run against pglite (Postgres in
 * WASM), with futures_snapshots built from the real migration (#45).
 *
 * The step runs alone, so the only other table is futures_bars: a query of
 * market_snapshots or ws_gamma_setup_fires would reject, because neither exists
 * here. getDb() emulates production as in futures-derived-recompute-pglite.test.ts:
 * a plain query is a read-only transaction, a transaction honours `readOnly`,
 * and every write is counted.
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
  /** The nth (1-based) plain query (what computeSnapshot issues) rejects with this error. */
  failPlainAt: null as null | { nth: number; error: Error },
  plainReads: 0,
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
            hooks.plainReads += 1;
            if (hooks.failPlainAt?.nth === hooks.plainReads) {
              return Promise.reject(hooks.failPlainAt.error).then(
                onFulfilled,
                onRejected,
              );
            }
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
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  markerPath,
  readOnlyFetch,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

vi.setConfig({ testTimeout: 60_000 });

// ── Schema ──────────────────────────────────────────────────────────────────

let pg: PGliteType;
let dir: string;
let workDir: string;

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

async function bar(symbol: string, ts: string, close: number): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, 10)`,
    [symbol, ts, close],
  );
}

async function snap(
  symbol: string,
  ts: string,
  price: number,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO futures_snapshots (trade_date, ts, symbol, price, change_1h_pct, volume_ratio)
     VALUES ($1, $2, $3, $4, 0.5, 1.25) RETURNING id`,
    [getETDateStr(new Date(ts)), ts, symbol, price],
  );
  return rows[0]!.id;
}

interface Ids {
  /** Deleted: ES stale 60 min, price 50 off the bar. */
  frozen: number;
  /** Kept: stale, but the price is the last bar's close. */
  repeat: number;
  /** Kept: a fresh row whose price differs from the bar. */
  fresh: number;
  /** Kept: a thin root, stale, price off the bar. */
  thin: number;
  /** Kept: ES from 2026-10-01 on, stale, price off the bar. */
  after: number;
  /** Deleted: the same shape on NQ. */
  nq: number;
  /** Kept: the bar is exactly 15:00 old, which is not stale. */
  ageEdge: number;
  /** Deleted: the bar is 15:01 old. */
  agePast: number;
  /** Kept: 15:00.0005 old in SQL, but computeSnapshot reads the ms and calls it fresh. */
  micro: number;
  /** Kept: NQ with no bar at or before it. */
  noBar: number;
  /** Deleted: the last millisecond before 2026-10-01. */
  lastMs: number;
  /** Kept: the first instant of 2026-10-01. */
  firstMs: number;
}
let ids: Ids;

async function reset(): Promise<void> {
  await pg.query(`TRUNCATE futures_bars, futures_snapshots RESTART IDENTITY`);
  await bar('ES', '2026-09-14T14:00:00Z', 6000);
  await bar('NQ', '2026-09-14T14:00:00Z', 21000);
  await bar('RTY', '2026-09-14T14:00:00Z', 2500);
  await bar('ES', '2026-09-15T14:00:00Z', 6200);
  await bar('ES', '2026-09-16T14:00:00Z', 6400);
  await bar('ES', '2026-09-17T14:00:00Z', 6500);
  await bar('ES', '2026-09-30T20:00:00Z', 6600);
  await bar('ES', '2026-10-01T14:00:00Z', 6300);
  ids = {
    frozen: await snap('ES', '2026-09-14T15:00:30Z', 6050),
    repeat: await snap('ES', '2026-09-14T15:05:30Z', 6000),
    fresh: await snap('ES', '2026-09-15T14:05:30Z', 6250),
    thin: await snap('RTY', '2026-09-14T15:00:30Z', 2550),
    after: await snap('ES', '2026-10-01T15:00:30Z', 6350),
    nq: await snap('NQ', '2026-09-14T15:00:30Z', 21100),
    ageEdge: await snap('ES', '2026-09-16T14:15:00Z', 6450),
    agePast: await snap('ES', '2026-09-16T14:15:01Z', 6460),
    micro: await snap('ES', '2026-09-17T14:15:00.000500Z', 6550),
    noBar: await snap('NQ', '2026-08-01T15:00:30Z', 20000),
    lastMs: await snap('ES', '2026-09-30T23:59:59.999Z', 6670),
    firstMs: await snap('ES', '2026-10-01T00:00:00Z', 6670),
  };
}

/** The three ES rows and the NQ row the fixture deletes. */
const doomed = (): number[] => [ids.frozen, ids.nq, ids.agePast, ids.lastMs];
const kept = (): number[] => [
  ids.repeat,
  ids.fresh,
  ids.thin,
  ids.after,
  ids.ageEdge,
  ids.micro,
  ids.noBar,
  ids.firstMs,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: true,
    force: false,
    stores: [],
    frozen: true,
    backup: null,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    detectorDays: null,
    deleteFrozenStale: true,
    expectFrozenDeletes: 4,
    ...over,
  };
}
const run = (over: Partial<RecomputeOptions> = {}) =>
  runRecompute(options(over));
const dry = (over: Partial<RecomputeOptions> = {}) =>
  run({
    apply: false,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
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
const report = (): string => readFileSync(join(workDir, 'report.txt'), 'utf8');
const backups = (): string[] =>
  existsSync(workDir)
    ? readdirSync(workDir).filter((f) => f.startsWith('backup-'))
    : [];

async function surviving(candidates: number[]): Promise<number[]> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM futures_snapshots WHERE id = ANY($1::int[]) ORDER BY id`,
    [candidates],
  );
  return rows.map((r) => r.id);
}
async function countRows(): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM futures_snapshots`,
  );
  return rows[0]!.n;
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
  dir = mkdtempSync(join(tmpdir(), 'frozen-pglite-'));
  workDir = join(dir, 'work');
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
  hooks.failPlainAt = null;
  hooks.plainReads = 0;
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('the frozen-stale dry run on real SQL (pglite)', () => {
  it('lists the rows per root and writes nothing', async () => {
    const before = await dump();
    expect(await dry()).toBe(0);

    expect(await dump()).toBe(before);
    expect(hooks.writes).toBe(0);
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
    expect(hooks.calls.every((c) => c.fetchFn === readOnlyFetch)).toBe(true);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();
    expect(backups()).toEqual([]);
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);

    const text = report();
    expect(text).toContain('rows to delete: 4');
    // ES: the 60-minute row, the 15:01 row and the last millisecond of September.
    expect(text).toMatch(
      /ES: 3, first 2026-09-14T15:00:30Z, last 2026-09-30T23:59:59\.999Z; 16:15-17:00 CT break 0, weekend or holiday 0, elsewhere 3/,
    );
    expect(text).toMatch(
      /NQ: 1, first 2026-09-14T15:00:30Z, last 2026-09-14T15:00:30Z; 16:15-17:00 CT break 0, weekend or holiday 0, elsewhere 1/,
    );
    // What stays, and why: the candidates in SQL that computeSnapshot calls fresh,
    // the stale rows that repeat the last bar's close, and the rows with no bar.
    expect(text).toMatch(
      /ES:[^\n]*\n\s+candidates 4, computeSnapshot calls fresh \(kept\) 1/,
    );
    expect(text).toMatch(/kept, stale and equal to the last bar's close: 1/);
    expect(text).toMatch(/kept, no bar at all: 1/);
    expect(text).toContain('RTY, CL, GC and ZN stay');
    // The printed apply command, with the count and the work dir.
    expect(text).toContain(
      `npx tsx scripts/recompute-futures-derived.ts --apply --work-dir ${workDir} --stores frozen --delete-frozen-stale --expect-frozen-deletes 4`,
    );
  });

  it('plans only the frozen rows: no other store, no Phase 2 backup, no bars of other roots', async () => {
    expect(await dry()).toBe(0);
    const texts = hooks.calls.flatMap((c) => c.texts).join('\n');
    expect(texts).not.toMatch(/market_snapshots|ws_gamma_setup_fires/);
    expect(logged()).not.toMatch(/rows in range|bars ES/);
    expect(report()).not.toContain('control set');
  });

  it('counts a row by where it falls: the daily break, a weekend or a holiday, elsewhere', async () => {
    await pg.query(`TRUNCATE futures_bars, futures_snapshots RESTART IDENTITY`);
    await bar('ES', '2026-09-01T14:00:00Z', 6000);
    // All stale (the one bar is days old) and off the bar's close.
    await snap('ES', '2026-09-14T15:00:30Z', 6001); // Mon 10:00 CT
    await snap('ES', '2026-09-15T21:30:30Z', 6002); // Tue 16:30 CT: the break
    await snap('ES', '2026-09-18T21:30:30Z', 6003); // Fri 16:30 CT: the break
    await snap('ES', '2026-09-18T22:30:30Z', 6004); // Fri 17:30 CT: weekend
    await snap('ES', '2026-09-19T15:00:30Z', 6005); // Sat
    await snap('ES', '2026-09-20T21:30:30Z', 6006); // Sun 16:30 CT: weekend, not the break
    await snap('ES', '2026-09-07T15:00:30Z', 6007); // Mon, Labor Day
    expect(await dry()).toBe(0);
    expect(report()).toMatch(
      /ES: 7, first 2026-09-07T15:00:30Z, last 2026-09-20T21:30:30Z; 16:15-17:00 CT break 2, weekend or holiday 4, elsewhere 1/,
    );
  });

  it('lists the 10 largest differences with both prices and the age of the bar', async () => {
    await pg.query(`TRUNCATE futures_bars, futures_snapshots RESTART IDENTITY`);
    await bar('ES', '2026-09-01T14:00:00Z', 6000);
    for (let k = 1; k <= 12; k += 1) {
      await snap(
        'ES',
        `2026-09-14T${String(9 + k).padStart(2, '0')}:00:30Z`,
        6000 + k * 2,
      );
    }
    expect(await dry()).toBe(0);
    const lines = report()
      .split('\n')
      .filter((l) => /stored \d+, the bar of/.test(l));
    expect(lines).toHaveLength(10);
    // Largest first: 6024 down to 6006; 6004 and 6002 are not listed.
    expect(lines[0]).toMatch(
      /ES 2026-09-14T21:00:30Z id 12: stored 6024, the bar of 2026-09-01T14:00:00Z closed at 6000 \(\d+ min old\), difference 24\.00/,
    );
    expect(lines.at(-1)).toMatch(/stored 6006,/);
    expect(report()).not.toMatch(/stored 6004,/);
  });

  it('finds nothing on a table with no frozen rows, and prints no apply command', async () => {
    await pg.query(`DELETE FROM futures_snapshots WHERE id = ANY($1::int[])`, [
      doomed(),
    ]);
    expect(await dry()).toBe(0);
    expect(report()).toContain('rows to delete: 0');
    expect(report()).not.toContain('To apply');
  });

  it('exits non-zero with the reason when the candidate read rejects', async () => {
    await pg.query(`ALTER TABLE futures_bars RENAME TO futures_bars_gone`);
    try {
      expect(await dry()).toBe(1);
      expect(errored()).toMatch(/futures_bars/);
    } finally {
      await pg.query(`ALTER TABLE futures_bars_gone RENAME TO futures_bars`);
    }
    expect(existsSync(join(workDir, 'report.txt'))).toBe(false);
  });
});

// ── Reads that reject ───────────────────────────────────────────────────────

describe('a read that rejects while the frozen rows are planned (pglite)', () => {
  /** Exit 1, the error named, and under --apply nothing written: no backup, no plan.json, no marker. */
  async function expectNothingWritten(message: RegExp): Promise<void> {
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(message);
    expect(existsSync(join(workDir, 'report.txt'))).toBe(false);
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(existsSync(join(workDir, 'plan.json'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
    expect(await dump()).toBe(before);
    expect(neonConfig.fetchFunction).toBeUndefined();
  }

  it('stops when the computeSnapshot confirmation of a candidate rejects', async () => {
    // Plain query 1 is the session check; 2 is the first computeSnapshot read.
    hooks.failPlainAt = {
      nth: 2,
      error: new Error('permission denied for table futures_bars'),
    };
    await expectNothingWritten(/permission denied for table futures_bars/);
    expect(hooks.plainReads).toBeGreaterThanOrEqual(2);
  });

  it('stops when the count of the rows that stay rejects', async () => {
    // Read-only transactions: 1 session check, 2 the ES candidates, 3 the ES kept count.
    hooks.failReadAt = {
      nth: 3,
      error: new Error('permission denied for table futures_snapshots'),
    };
    await expectNothingWritten(/permission denied for table futures_snapshots/);
    expect(hooks.reads).toBe(3);
  });
});

// ── The closed-bar lag ──────────────────────────────────────────────────────

describe('the 60 second closed-bar lag of the candidate query (pglite)', () => {
  // Bars at 13:00 (close 6000) and 14:00 (close 6050). A bar stamped T covers
  // [T, T + 1 min), so it counts for a row only from T + 60 s on.
  let lag: { open: number; repeat: number; closed: number; later: number };
  beforeEach(async () => {
    await pg.query(`TRUNCATE futures_bars, futures_snapshots RESTART IDENTITY`);
    await bar('ES', '2026-09-18T13:00:00Z', 6000);
    await bar('ES', '2026-09-18T14:00:00Z', 6050);
    lag = {
      // 14:00 is still open: the latest closed bar is 13:00's, 60 min old, and 6050 is not 6000.
      open: await snap('ES', '2026-09-18T14:00:30Z', 6050),
      // The same stale state, but the price is the last closed bar's close: it stays.
      repeat: await snap('ES', '2026-09-18T14:00:45Z', 6000),
      // 14:00 has closed (ts <= at - 60 s): the latest closed bar is 1 min old. Fresh, it stays.
      closed: await snap('ES', '2026-09-18T14:01:00Z', 6100),
      // Fresh too, and priced 6000 like the 13:00 bar: only a longer lag would count it as a repeat.
      later: await snap('ES', '2026-09-18T14:01:30Z', 6000),
    };
  });

  it('deletes a row priced from a bar that was still open when it was written, and keeps the rows after the bar closed', async () => {
    expect(await dry()).toBe(0);
    const text = report();
    expect(text).toContain('rows to delete: 1');
    expect(text).toMatch(
      /ES: 1, first 2026-09-18T14:00:30Z, last 2026-09-18T14:00:30Z;/,
    );
    // The 14:01:00 row (stale if the lag were longer) is not even a candidate, and the
    // one stale row that repeats 13:00's close is the 14:00:45 row alone.
    expect(text).toMatch(
      /ES: 1,[^\n]*\n\s+candidates 1, computeSnapshot calls fresh \(kept\) 0\n\s+kept, stale and equal to the last bar's close: 1; kept, no bar at all: 0/,
    );

    expect(await run({ expectFrozenDeletes: 1 })).toBe(0);
    expect(await surviving([lag.open])).toEqual([]);
    expect(await surviving([lag.repeat, lag.closed, lag.later])).toHaveLength(
      3,
    );
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('--delete-frozen-stale on real SQL (pglite)', () => {
  it('deletes exactly the frozen stale ES and NQ rows and keeps every other row', async () => {
    const rowsBefore = await countRows();
    expect(await run()).toBe(0);

    expect(await surviving(doomed())).toEqual([]);
    expect(await surviving(kept())).toEqual(kept().sort((a, b) => a - b));
    expect(await countRows()).toBe(rowsBefore - 4);
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(true);
    expect(logged()).toContain('frozen: 4 row(s) deleted and verified');
  });

  it('backs the rows up whole before the first DELETE, and records the plan', async () => {
    let backedUp: string[] = [];
    hooks.beforeWrite = (texts) => {
      if (backedUp.length === 0 && texts.some((t) => /DELETE/.test(t))) {
        backedUp = backups();
      }
    };
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
            op?: string;
            to: unknown;
            row: Record<string, unknown>;
          },
      );
    expect(lines.map((l) => l.id).sort((a, b) => a - b)).toEqual(
      doomed().sort((a, b) => a - b),
    );
    for (const l of lines) {
      expect(l).toMatchObject({
        step: 'frozen',
        store: 'snapshots',
        op: 'delete',
        to: null,
      });
      expect(l.row).toMatchObject({ id: l.id, symbol: l.symbol });
      expect(l.row).toHaveProperty('price');
      expect(l.row).toHaveProperty('change_1h_pct');
      expect(l.row).toHaveProperty('volume_ratio');
    }
    const pointer = JSON.parse(
      readFileSync(join(workDir, 'plan.json'), 'utf8'),
    ) as {
      steps: string[];
      rows: Record<string, number>;
      expect: Record<string, number | null>;
      command: { stores: string[] };
    };
    expect(pointer.steps).toEqual(['frozen']);
    expect(pointer.rows).toEqual({ frozen: 4 });
    expect(pointer.expect.frozen).toBe(4);
    expect(pointer.command.stores).toEqual([]);
    expect(existsSync(join(workDir, 'frozen.started'))).toBe(true);
  });

  it('keeps a stale row that repeats the last close, a fresh row, a thin root and the day 2026-10-01', async () => {
    expect(await run()).toBe(0);
    expect(await surviving([ids.repeat])).toEqual([ids.repeat]);
    expect(await surviving([ids.fresh])).toEqual([ids.fresh]);
    expect(await surviving([ids.thin])).toEqual([ids.thin]);
    expect(await surviving([ids.after, ids.firstMs])).toEqual(
      [ids.after, ids.firstMs].sort((a, b) => a - b),
    );
  });

  it('keeps the rows computeSnapshot calls fresh: a bar exactly 15:00 old, and one over by a microsecond', async () => {
    expect(await run()).toBe(0);
    expect(await surviving([ids.ageEdge, ids.micro])).toEqual(
      [ids.ageEdge, ids.micro].sort((a, b) => a - b),
    );
    expect(await surviving([ids.agePast])).toEqual([]);
  });

  it('does not plan the other stores or read the Phase 2 backup', async () => {
    expect(await run()).toBe(0);
    const texts = hooks.calls.flatMap((c) => c.texts).join('\n');
    expect(texts).not.toMatch(/market_snapshots|ws_gamma_setup_fires/);
    expect(logged()).not.toMatch(/rows in range|bars ES/);
  });

  it('refuses the flag without a count, before any write', async () => {
    const before = await dump();
    expect(await run({ expectFrozenDeletes: null })).toBe(1);
    expect(errored()).toMatch(
      /--delete-frozen-stale needs --expect-frozen-deletes N: the count of the dry run you approved/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
  });

  it('refuses a count that is not the fresh plan, before any write', async () => {
    const before = await dump();
    expect(await run({ expectFrozenDeletes: 5 })).toBe(1);
    expect(errored()).toMatch(
      /the fresh plan deletes 4 frozen-stale rows, --expect-frozen-deletes 5 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    expect(existsSync(join(workDir, 'plan.json'))).toBe(false);
  });

  it('refuses --apply during market hours, before it reads anything', async () => {
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply during market hours/);
    expect(hooks.calls).toEqual([]);
  });

  it('fails the step, unmarked, when the delete is silently dropped', async () => {
    hooks.dropWrites = true;
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /apply failed: frozen: verify failed for frozen: 4 of 4 row\(s\) are still there/,
    );
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
    expect(await surviving(doomed())).toHaveLength(4);
  });

  it('never deletes a row whose price changed after the plan was read, and says so', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /DELETE FROM futures_snapshots/.test(t))) {
        await pg.query(
          `UPDATE futures_snapshots SET price = 6051 WHERE id = $1`,
          [ids.frozen],
        );
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/verify failed for frozen: 1 of 4 row\(s\)/);
    expect(await surviving(doomed())).toEqual([ids.frozen]);
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
  });

  it('fails the step, unmarked, when another row left the table during the delete', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /DELETE FROM futures_snapshots/.test(t))) {
        // A thin root's stale row: not in the plan, and before 2026-10-01.
        await pg.query(`DELETE FROM futures_snapshots WHERE id = $1`, [
          ids.thin,
        ]);
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /verify failed for frozen: \d+ rows in scope before, \d+ after, \d+ expected/,
    );
    expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
  });

  it('is done once: the marker skips a second run, and the fresh plan then lists no row', async () => {
    expect(await run()).toBe(0);
    vi.mocked(console.log).mockClear();
    expect(await run({ expectFrozenDeletes: 0 })).toBe(0);
    expect(logged()).toContain(
      'the frozen-stale delete is marked done and has nothing left to delete',
    );
    expect(backups()).toHaveLength(1);
  });

  describe('a DELETE that rejects part way', () => {
    beforeEach(() => {
      // One row per statement and per transaction: the second DELETE is the second write.
      hooks.writeChunk = 1;
      hooks.chunksPerTransaction = 1;
    });

    it('leaves the backup and the plan on disk, with the step started and unmarked', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      expect(errored()).toMatch(/apply failed: frozen: deadlock detected/);
      expect(existsSync(join(workDir, 'frozen.started'))).toBe(true);
      expect(existsSync(markerPath(workDir, 'frozen'))).toBe(false);
      expect(backups()).toHaveLength(1);
      expect(await surviving(doomed())).toHaveLength(3);
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
      expect(await surviving(doomed())).toEqual([]);
      expect(await surviving(kept())).toHaveLength(kept().length);
      expect(existsSync(markerPath(workDir, 'frozen'))).toBe(true);
      expect(logged()).toContain('Resuming from');
      expect(logged()).not.toContain('Futures derived-store recompute');
      // Planning would have read futures_bars; the resume reads only the rows it checks.
      const texts = hooks.calls.flatMap((c) => c.texts).join('\n');
      expect(texts).not.toMatch(/FROM futures_bars/);
      expect(backups()).toHaveLength(1);
    });

    it('refuses to finish when a planned row holds another price, and writes nothing', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      const left = await surviving(doomed());
      await pg.query(`UPDATE futures_snapshots SET price = 1 WHERE id = $1`, [
        left[0],
      ]);
      hooks.failWriteAt = null;
      hooks.writes = 0;
      vi.mocked(console.error).mockClear();

      expect(await run()).toBe(1);
      expect(errored()).toMatch(
        /apply failed: frozen: 1 of 4 row\(s\) hold neither the planned old value nor the new one, so frozen is not written/,
      );
      expect(hooks.writes).toBe(0);
      expect(await surviving(doomed())).toEqual(left);
    });

    it('refuses to finish with another count than the plan was made with', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      hooks.failWriteAt = null;
      hooks.writes = 0;
      vi.mocked(console.error).mockClear();

      expect(await run({ expectFrozenDeletes: 3 })).toBe(1);
      expect(errored()).toMatch(
        /Refusing to resume[\s\S]*--expect-frozen-deletes 3 was given, the saved plan has 4/,
      );
      expect(hooks.writes).toBe(0);
    });

    it('refuses to finish without the flag the plan was made with', async () => {
      hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
      expect(await run()).toBe(1);
      hooks.failWriteAt = null;
      vi.mocked(console.error).mockClear();

      // The plan carries a frozen delete; a command without it is not that plan.
      expect(
        await run({ deleteFrozenStale: false, expectFrozenDeletes: null }),
      ).toBe(1);
      expect(errored()).toMatch(
        /the saved plan has a frozen delete, --delete-frozen-stale was not given/,
      );
    });
  });
});
