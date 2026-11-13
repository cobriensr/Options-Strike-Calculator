// @vitest-environment node

/**
 * REAL-SQL test for the contract-mix repair: the read, UPDATE and DELETE
 * statements run against pglite (Postgres in WASM) with futures_bars built from
 * the REAL migrations (#42 without its es_bars copy, #193 for the order-flow
 * columns), so a swapped SET column, a wrong delete value check or a timezone
 * slip in a bound timestamp shows up here and not in production.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may depend
 * on the session time zone. The clock is pinned to a Sunday so the
 * market-hours guard stays out of the way.
 */

import {
  existsSync,
  mkdirSync,
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

import type { PgliteQuery } from '../../api/__tests__/pglite-migrations';

const hooks = vi.hoisted(() => ({
  pg: null as PGliteType | null,
  calls: [] as { readOnly: boolean; texts: string[] }[],
  beforeWrite: null as null | ((texts: string[]) => Promise<void> | void),
  /** The nth (1-based) write transaction rejects with this error. */
  failWriteAt: null as null | { nth: number; error: Error },
  /** Every read-only transaction rejects with this error. */
  failRead: null as null | Error,
  /** Runs at the start of every read-only transaction: a test moves the clock mid-plan with it. */
  onRead: null as null | (() => void),
  /** Write transactions resolve with no rows and run nothing. */
  dropWrites: false,
  writes: 0,
}));

// Real withDbRetry; getDb() is a Neon-shaped tagged template over pglite whose
// transaction() records every call and honours `readOnly`.
vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/db.js')>();
  const { neonOverPglite } =
    await import('../../api/__tests__/pglite-migrations');
  return {
    ...actual,
    getDb: () => {
      const pg = hooks.pg;
      if (!pg) throw new Error('pglite not started');
      const tag = neonOverPglite(pg);
      return Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) =>
          tag(strings, ...values),
        {
          transaction: async (
            queries: PgliteQuery[],
            opts?: { readOnly?: boolean },
          ) => {
            const readOnly = opts?.readOnly === true;
            hooks.calls.push({ readOnly, texts: queries.map((q) => q.text) });
            if (readOnly) hooks.onRead?.();
            if (readOnly && hooks.failRead) throw hooks.failRead;
            if (!readOnly) {
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
        },
      );
    },
  };
});

import { neonOverPglite } from '../../api/__tests__/pglite-migrations';
import { MIGRATIONS } from '../../api/_lib/db-migrations.js';
import { parseBackup } from './futures-derived-attribution.js';
import { dayDigest, markerPath, runRepair } from './futures-contract-repair.js';

// ── Schema and seed helpers ─────────────────────────────────────────────────

type MigrationSql = Parameters<
  NonNullable<(typeof MIGRATIONS)[number]['statements']>
>[0];

/** Migration `id`'s statements in one transaction, minus those `keep` rejects. */
async function applyStatements(
  pg: PGliteType,
  id: number,
  keep: (text: string) => boolean,
): Promise<void> {
  const migration = MIGRATIONS.find((m) => m.id === id);
  if (!migration?.statements)
    throw new Error(`migration #${id} has no statements`);
  const queries = migration.statements(
    neonOverPglite(pg) as unknown as MigrationSql,
  ) as unknown as PgliteQuery[];
  await pg.transaction(async (tx) => {
    for (const q of queries.filter((x) => keep(x.text)))
      await tx.query(q.text, q.params);
  });
}

interface SeedRow {
  symbol: string;
  ts: string;
  p: [number, number, number, number];
  v: number;
  flow?: [number, number, number, number];
}

async function seed(pg: PGliteType, rows: SeedRow[]): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume,
                               buy_volume, sell_volume, buy_prints, sell_prints)
     SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::numeric[],
                          $4::numeric[], $5::numeric[], $6::numeric[], $7::bigint[],
                          $8::bigint[], $9::bigint[], $10::int[], $11::int[])`,
    [
      rows.map((r) => r.symbol),
      rows.map((r) => r.ts),
      rows.map((r) => r.p[0]),
      rows.map((r) => r.p[1]),
      rows.map((r) => r.p[2]),
      rows.map((r) => r.p[3]),
      rows.map((r) => r.v),
      rows.map((r) => r.flow?.[0] ?? null),
      rows.map((r) => r.flow?.[1] ?? null),
      rows.map((r) => r.flow?.[2] ?? null),
      rows.map((r) => r.flow?.[3] ?? null),
    ],
  );
}

interface TableRow {
  id: string;
  symbol: string;
  ts: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  buy_volume: string | null;
  sell_volume: string | null;
  buy_prints: string | null;
  sell_prints: string | null;
  contract: string | null;
}

async function table(pg: PGliteType): Promise<Map<string, TableRow>> {
  const { rows } = await pg.query<TableRow>(
    `SELECT id::text AS id, symbol,
            to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
            open::text, high::text, low::text, close::text, volume::text,
            buy_volume::text, sell_volume::text, buy_prints::text, sell_prints::text,
            contract
       FROM futures_bars ORDER BY symbol, ts`,
  );
  return new Map(rows.map((r) => [`${r.symbol} ${r.ts}`, r]));
}

/** `open/high/low/close/volume` of one row, or undefined when it is gone. */
const ohlcv = (t: Map<string, TableRow>, key: string): string | undefined => {
  const r = t.get(key);
  return r && `${r.open}/${r.high}/${r.low}/${r.close}/${r.volume}`;
};

// ── The fixture ─────────────────────────────────────────────────────────────

interface RebuiltSeed {
  symbol: 'ES' | 'NQ';
  ts: string;
  p: [number, number, number, number];
  v: number;
  source?: 'archive' | 'ticks';
  clusters?: number;
  partial?: boolean;
}

const minute = (base: string, plus: number): string =>
  new Date(Date.parse(base) + plus * 60_000)
    .toISOString()
    .replace('.000Z', 'Z');

const FLAT: [number, number, number, number] = [7000, 7001, 6999, 7000];
const NQ_FLAT: [number, number, number, number] = [24000, 24001, 23999, 24000];

function baseFixture(): { pgRows: SeedRow[]; rebuilt: RebuiltSeed[] } {
  const pgRows: SeedRow[] = [];
  const rebuilt: RebuiltSeed[] = [];
  const both = (
    symbol: 'ES' | 'NQ',
    ts: string,
    pgP: [number, number, number, number],
    rbP: [number, number, number, number] | null,
    v = 300,
    rbV = v,
    extra: Partial<RebuiltSeed> = {},
  ) => {
    pgRows.push({ symbol, ts, p: pgP, v });
    if (rbP) {
      rebuilt.push({ symbol, ts, p: rbP, v: rbV, source: 'ticks', ...extra });
    }
  };

  // Archive span, ES 2026-04-07: exact, back-month open/high, volume only, no rebuild.
  const a = '2026-04-07T14:30:00Z';
  both(
    'ES',
    a,
    [7000, 7001, 6999, 7000.5],
    [7000, 7001, 6999, 7000.500000001],
    300,
    300,
    { source: 'archive' },
  );
  both(
    'ES',
    minute(a, 1),
    [7060.75, 7062, 6999, 7000.5],
    [7000, 7001.25, 6999, 7000.5],
    300,
    300,
    { source: 'archive' },
  );
  both(
    'ES',
    minute(a, 2),
    [7000, 7001, 6999, 7000.5],
    [7000, 7001, 6999, 7000.5],
    41,
    40,
    { source: 'archive' },
  );
  both('ES', minute(a, 3), [7000, 7001, 6999, 7000.5], null, 300); // no rebuilt minute
  // Archive span, NQ: a spread-priced row whose minute does have a rebuilt bar.
  both('NQ', minute(a, 1), [216, 217, 215.6, 216], NQ_FLAT, 10, 10, {
    source: 'archive',
  });

  // Tick span, ES 2026-04-21 13:00..13:20.
  const t = '2026-04-21T13:00:00Z';
  for (let i = 0; i < 21; i += 1) {
    const ts = minute(t, i);
    if (i === 5)
      both('ES', ts, [7000, 7062, 6999, 7000], [7000, 7001, 6999, 7000]); // back-month high
    else if (i === 6)
      both('ES', ts, [7000, 7003.5, 6999, 7000], [7000, 7001, 6999, 7000]); // boundary print
    else if (i === 15)
      both('ES', ts, FLAT, null); // tick-less, clean
    else if (i === 18)
      both('ES', ts, [7040, 7040, 7000, 7000], null); // tick-less, contaminated
    else both('ES', ts, FLAT, FLAT);
  }

  // Tick span, NQ 2026-04-20 02:00..02:20: no ticks yet, two rows +240.
  const n = '2026-04-20T02:00:00Z';
  for (let i = 0; i < 21; i += 1) {
    both(
      'NQ',
      minute(n, i),
      i === 6 || i === 14 ? [24240, 24240, 24000, 24000] : NQ_FLAT,
      null,
    );
  }

  // Roll week and the day before it.
  const r = '2026-06-10T14:00:00Z';
  pgRows.push({ symbol: 'ES', ts: r, p: FLAT, v: 5000, flow: [10, 20, 3, 4] });
  rebuilt.push({
    symbol: 'ES',
    ts: r,
    p: FLAT,
    v: 4800,
    source: 'ticks',
    clusters: 2,
  });
  both('ES', minute(r, 1), FLAT, FLAT, 5000, 4800, { clusters: 1 }); // single cluster
  both('ES', minute(r, 2), FLAT, FLAT, 5000, 4800, {
    clusters: 2,
    partial: true,
  });
  both('ES', '2026-06-08T14:00:00Z', FLAT, FLAT, 5000, 4800, { clusters: 2 }); // before the roll week

  // Outside both spans: never touched.
  pgRows.push({
    symbol: 'ES',
    ts: '2026-04-05T21:59:00Z',
    p: [1, 1, 1, 1],
    v: 1,
  });
  pgRows.push({
    symbol: 'ES',
    ts: '2026-04-19T23:00:00Z',
    p: [2, 2, 2, 2],
    v: 2,
  });
  pgRows.push({
    symbol: 'ES',
    ts: '2026-06-16T14:00:00Z',
    p: [9, 9, 9, 9],
    v: 9,
  });

  // Off-session junk, all six roots.
  pgRows.push({
    symbol: 'ES',
    ts: '2026-04-11T14:00:00Z',
    p: [8098.75, 8098.75, 8098.75, 8098.75],
    v: 900,
  });
  pgRows.push({
    symbol: 'NQ',
    ts: '2026-04-11T14:00:00Z',
    p: [30000, 30000, 30000, 30000],
    v: 20,
  });
  for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
    for (const ts of [
      '2026-04-10T20:59:00Z', // Friday before the close: stays
      '2026-04-10T21:00:00Z', // first minute of the window
      '2026-04-11T14:00:00Z',
      '2026-04-12T21:59:00Z', // last minute of the window
      '2026-04-12T22:00:00Z', // Sunday open: stays
    ]) {
      pgRows.push({ symbol, ts, p: [100, 101, 99, 100], v: 5 });
    }
  }
  return { pgRows, rebuilt };
}

const manifestFor = (rebuilt: RebuiltSeed[], files: number) => {
  const rows: Record<string, number> = {
    'ES/archive': 0,
    'ES/ticks': 0,
    'NQ/archive': 0,
    'NQ/ticks': 0,
  };
  for (const r of rebuilt) {
    const key = `${r.symbol}/${r.source ?? 'ticks'}`;
    rows[key] = (rows[key] ?? 0) + 1;
  }
  return {
    status: 'passed',
    reason: '',
    git: {
      head: 'fbe7c057154fee85ca59ed5a43ecac1cfa4f720a',
      module_edited: false,
    },
    finished_utc: '2026-11-06T20:00:11.087871+00:00',
    spans: {
      archive: ['2026-04-05 22:00:00+00:00', '2026-04-17 21:00:00+00:00'],
      ticks: ['2026-04-20 01:56:00+00:00', '2026-06-15 14:12:00+00:00'],
    },
    roots: {
      ES: { front: 'ESM6', gap: 17.0, carry: 60.75, carry_half: 30.375 },
      NQ: { front: 'NQM6', gap: 65.0, carry: 279.75, carry_half: 139.875 },
    },
    gate: {
      ts_recv: {
        ES: {
          minutes: 13680,
          exact_ohlc: 13680,
          volume_within_1pct: 13680,
          passed: true,
        },
        NQ: {
          minutes: 13680,
          exact_ohlc: 13680,
          volume_within_1pct: 13680,
          passed: true,
        },
      },
    },
    post_check: { listed: 0, allowlisted: 0, unsplittable: 0 },
    rows,
    ndjson_files: files,
  };
};

/** Phase 1's folder: manifest.json, ndjson/, tickless_windows.csv. */
function writeInputs(dir: string, rebuilt: RebuiltSeed[]): void {
  mkdirSync(join(dir, 'ndjson'), { recursive: true });
  const files = new Map<string, string[]>();
  for (const r of rebuilt) {
    const name = `${r.symbol}-${r.ts.slice(0, 10)}.ndjson`;
    const line = JSON.stringify({
      symbol: r.symbol,
      ts: r.ts,
      open: r.p[0],
      high: r.p[1],
      low: r.p[2],
      close: r.p[3],
      volume: r.v,
      source: r.source ?? 'ticks',
      n_clusters: r.clusters ?? 1,
      partial: r.partial ?? false,
    });
    files.set(name, [...(files.get(name) ?? []), line]);
  }
  for (const [name, lines] of files) {
    writeFileSync(join(dir, 'ndjson', name), `${lines.join('\n')}\n`);
  }
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(manifestFor(rebuilt, files.size)),
  );
  writeFileSync(
    join(dir, 'tickless_windows.csv'),
    'symbol,first_minute,last_minute,minutes,open_minutes\n' +
      'NQ,2026-04-20 02:00:00+00:00,2026-04-20 02:20:00+00:00,21,21\n',
  );
}

// ── Harness ─────────────────────────────────────────────────────────────────

let pg: PGliteType;
let dir: string;
let inDir: string;
let workDir: string;

/** The fixture's plan: 5 rows to update, 18 to delete. An apply must be told so. */
const run = (over: Partial<Parameters<typeof runRepair>[0]> = {}) => {
  const apply = over.apply ?? true;
  return runRepair({
    dir: inDir,
    workDir,
    apply,
    force: false,
    thinRoots: false,
    dates: [],
    expectUpdates: apply ? 5 : null,
    expectDeletes: apply ? 18 : null,
    ...over,
  });
};

/** The digest of a day's rebuilt-bar files as they are on disk right now. */
function digestOnDisk(day: string): string {
  const texts = new Map<string, string>();
  for (const root of ['ES', 'NQ']) {
    const name = `${root}-${day}.ndjson`;
    const path = join(inDir, 'ndjson', name);
    if (existsSync(path)) texts.set(name, readFileSync(path, 'utf8'));
  }
  return dayDigest(texts, day);
}

/** Rewrite one rebuilt-bar file in place, as a Phase 1 re-run would. */
function editNdjson(
  file: string,
  edit: (bar: Record<string, unknown>) => void,
): void {
  const path = join(inDir, 'ndjson', file);
  const bars = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  bars.forEach(edit);
  writeFileSync(path, `${bars.map((b) => JSON.stringify(b)).join('\n')}\n`);
}

const logged = (): string =>
  vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
const errored = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');

beforeAll(async () => {
  pg = await PGlite.create();
  hooks.pg = pg;
  await applyStatements(pg, 42, (text) => !/FROM\s+es_bars/.test(text));
  await applyStatements(pg, 193, () => true);
  await applyStatements(pg, 204, () => true); // the dated contract of a bar
  await pg.query(`SET TIME ZONE 'America/Chicago'`);
});

afterAll(async () => {
  await pg.close();
});

async function reset(fixture = baseFixture()): Promise<void> {
  await pg.query('TRUNCATE futures_bars RESTART IDENTITY');
  await seed(pg, fixture.pgRows);
  rmSync(inDir, { recursive: true, force: true });
  writeInputs(inDir, fixture.rebuilt);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); // Sunday: not market hours
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'repair-pglite-'));
  inDir = join(dir, 'in');
  workDir = join(dir, 'work');
  hooks.calls = [];
  hooks.beforeWrite = null;
  hooks.failRead = null;
  hooks.onRead = null;
  hooks.failWriteAt = null;
  hooks.dropWrites = false;
  hooks.writes = 0;
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('--apply on real SQL (pglite)', () => {
  it('updates only the fields the rule names and deletes only the planned rows', async () => {
    const before = await table(pg);
    expect(await run()).toBe(0);
    const after = await table(pg);

    // Archive span: every field follows the rebuild; an exact row is not touched.
    expect(ohlcv(after, 'ES 2026-04-07T14:30:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.5000/300',
    );
    expect(after.get('ES 2026-04-07T14:30:00Z')).toEqual(
      before.get('ES 2026-04-07T14:30:00Z'),
    );
    expect(ohlcv(after, 'ES 2026-04-07T14:31:00Z')).toBe(
      '7000.0000/7001.2500/6999.0000/7000.5000/300',
    );
    expect(ohlcv(after, 'ES 2026-04-07T14:32:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.5000/40',
    );
    expect(after.has('ES 2026-04-07T14:33:00Z')).toBe(false); // no rebuilt minute
    expect(ohlcv(after, 'NQ 2026-04-07T14:31:00Z')).toBe(
      '24000.0000/24001.0000/23999.0000/24000.0000/10',
    );

    // Tick span: the back-month high is replaced, the boundary print is kept,
    // a clean tick-less row stays, a contaminated one goes.
    expect(ohlcv(after, 'ES 2026-04-21T13:05:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/300',
    );
    expect(ohlcv(after, 'ES 2026-04-21T13:06:00Z')).toBe(
      '7000.0000/7003.5000/6999.0000/7000.0000/300',
    );
    expect(after.has('ES 2026-04-21T13:15:00Z')).toBe(true);
    expect(after.has('ES 2026-04-21T13:18:00Z')).toBe(false);
    expect(after.has('NQ 2026-04-20T02:06:00Z')).toBe(false);
    expect(after.has('NQ 2026-04-20T02:14:00Z')).toBe(false);
    expect(after.has('NQ 2026-04-20T02:07:00Z')).toBe(true);

    // Roll week: volume follows the rebuild only on a mixed, non-partial minute.
    expect(ohlcv(after, 'ES 2026-06-10T14:00:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/4800',
    );
    expect(ohlcv(after, 'ES 2026-06-10T14:01:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/5000',
    );
    expect(ohlcv(after, 'ES 2026-06-10T14:02:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/5000',
    );
    expect(ohlcv(after, 'ES 2026-06-08T14:00:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/5000',
    );

    // The order-flow columns and every id survive an update.
    for (const key of [
      'ES 2026-06-10T14:00:00Z',
      'ES 2026-04-07T14:31:00Z',
      'NQ 2026-04-07T14:31:00Z',
    ]) {
      const was = before.get(key);
      const is = after.get(key);
      expect(is?.id).toBe(was?.id);
      expect([
        is?.buy_volume,
        is?.sell_volume,
        is?.buy_prints,
        is?.sell_prints,
      ]).toEqual([
        was?.buy_volume,
        was?.sell_volume,
        was?.buy_prints,
        was?.sell_prints,
      ]);
    }
    expect(after.get('ES 2026-06-10T14:00:00Z')?.buy_volume).toBe('10');

    // Outside both spans: untouched.
    for (const key of [
      'ES 2026-04-05T21:59:00Z',
      'ES 2026-04-19T23:00:00Z',
      'ES 2026-06-16T14:00:00Z',
    ]) {
      expect(after.get(key)).toEqual(before.get(key));
    }
    expect(logged()).toContain('total updates 5, total deletes 18');
  });

  it("keeps the dry run's report.txt and delete-list.csv through an --apply: the apply writes its own copies", async () => {
    await run({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));

    expect(await run()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const files = readdirSync(workDir);
    const applyReport = files.find((f) => /^apply-.*-report\.txt$/.test(f));
    const applyList = files.find((f) => /^apply-.*-delete-list\.csv$/.test(f));
    expect(applyReport).toBeDefined();
    expect(applyList).toBeDefined();
    expect(readFileSync(join(workDir, applyReport ?? ''), 'utf8')).toContain(
      'total updates 5, total deletes 18',
    );
    expect(
      readFileSync(join(workDir, applyList ?? ''), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1 + 18);
  });

  it('writes a dry run after an --apply under dryrun-<time>- names and leaves the approved report.txt and delete-list.csv', async () => {
    await run({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));
    expect(await run()).toBe(0);

    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await run({ apply: false })).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const files = readdirSync(workDir);
    const dryReport = files.find((f) => /^dryrun-.*-report\.txt$/.test(f));
    expect(dryReport).toBeDefined();
    expect(files.some((f) => /^dryrun-.*-delete-list\.csv$/.test(f))).toBe(
      true,
    );
    expect(readFileSync(join(workDir, dryReport ?? ''), 'utf8')).toContain(
      'total updates 0, total deletes 0',
    );
  });

  // A later dry run over one day plans (and reports) something other than the
  // approved all-days one, so a replaced report.txt would differ byte for byte.
  const laterDryRun = (): Promise<number> => {
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    return run({ apply: false, dates: ['2026-04-07'] });
  };
  const dryRunFiles = (): string[] =>
    readdirSync(workDir).filter((f) => f.startsWith('dryrun-'));

  // An apply that fails on its first day marks no day done: what it leaves is
  // the backup it took before that write (and its apply-<time>- report).
  it('writes a dry run under dryrun-<time>- names after an --apply that failed on its first day', async () => {
    await run({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));
    hooks.failWriteAt = {
      nth: 1,
      error: new Error('connection broken by peer'),
    };
    expect(await run()).toBe(1);
    hooks.failWriteAt = null;
    expect(errored()).toMatch(/apply failed: day 2026-04-07/);
    const files = readdirSync(workDir);
    expect(files.filter((f) => f.endsWith('.applied'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('backup-'))).toHaveLength(1);

    expect(await laterDryRun()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const reports = readdirSync(workDir).filter((f) =>
      /^dryrun-.*-report\.txt$/.test(f),
    );
    expect(reports).toHaveLength(1);
    expect(
      readdirSync(workDir).filter((f) =>
        /^dryrun-.*-delete-list\.csv$/.test(f),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(workDir, reports[0] ?? ''))).not.toEqual(report);
    expect(logged()).toContain(`report: ${join(workDir, reports[0] ?? '')}`);
  });

  // Each sign on its own, in a work dir that holds nothing else of an apply.
  it.each([
    ['a backup', 'backup-2026-11-08T12-00-00-000Z.jsonl'],
    ['a done day', '2026-04-07.applied'],
  ])(
    'writes a dry run under dryrun-<time>- names when the only sign of an --apply is %s (%s)',
    async (_name, file) => {
      await run({ apply: false });
      const report = readFileSync(join(workDir, 'report.txt'));
      const list = readFileSync(join(workDir, 'delete-list.csv'));
      writeFileSync(join(workDir, file), '');

      expect(await laterDryRun()).toBe(0);

      expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
      expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
      expect(dryRunFiles()).toHaveLength(2);
    },
  );

  it('still replaces report.txt after a refused --apply, which writes no backup or marker', async () => {
    await run({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));

    expect(await run({ expectUpdates: 4 })).toBe(1);
    expect(errored()).toMatch(
      /Refusing to --apply: the fresh plan has 5 updates/,
    );
    expect(
      readdirSync(workDir).filter(
        (f) => f.startsWith('backup-') || f.endsWith('.applied'),
      ),
    ).toEqual([]);

    expect(await laterDryRun()).toBe(0);

    expect(dryRunFiles()).toEqual([]);
    expect(readFileSync(join(workDir, 'report.txt'))).not.toEqual(report);
  });

  it('deletes the junk window for all six roots and nothing just outside it', async () => {
    await run();
    const after = await table(pg);
    for (const symbol of ['ES', 'NQ']) {
      expect(after.has(`${symbol} 2026-04-11T14:00:00Z`)).toBe(false);
    }
    for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
      expect(after.has(`${symbol} 2026-04-10T20:59:00Z`)).toBe(true);
      expect(after.has(`${symbol} 2026-04-10T21:00:00Z`)).toBe(false);
      expect(after.has(`${symbol} 2026-04-11T14:00:00Z`)).toBe(false);
      expect(after.has(`${symbol} 2026-04-12T21:59:00Z`)).toBe(false);
      expect(after.has(`${symbol} 2026-04-12T22:00:00Z`)).toBe(true);
    }
  });

  it('writes a backup of every row it will change before the first write', async () => {
    let seenAtFirstWrite: string[] | null = null;
    hooks.beforeWrite = () => {
      seenAtFirstWrite ??= readdirSync(workDir)
        .filter((f) => f.startsWith('backup-'))
        .map((f) => readFileSync(join(workDir, f), 'utf8'));
    };
    const before = await table(pg);
    await run();

    expect(seenAtFirstWrite).not.toBeNull();
    const files = seenAtFirstWrite as unknown as string[];
    expect(files).toHaveLength(1);
    const lines = (files[0] ?? '').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(5 + 18);
    const entries = lines.map(
      (l) =>
        JSON.parse(l) as {
          op: string;
          reason: string;
          row: Record<string, string | null>;
        },
    );
    expect(entries.filter((e) => e.op === 'update')).toHaveLength(5);
    expect(entries.filter((e) => e.op === 'delete')).toHaveLength(18);
    // The full pre-change row, id and order-flow columns included.
    const roll = entries.find((e) => e.row.ts === '2026-06-10T14:00:00Z');
    expect(roll).toMatchObject({
      op: 'update',
      row: {
        id: before.get('ES 2026-06-10T14:00:00Z')?.id,
        volume: '5000',
        buy_volume: '10',
        sell_prints: '4',
      },
    });
    expect(
      entries.find((e) => e.row.ts === '2026-04-07T14:33:00Z'),
    ).toMatchObject({
      op: 'delete',
      reason: 'archive_no_rebuild',
    });
  });

  it('a second --apply changes 0 rows', async () => {
    expect(await run()).toBe(0);
    const once = await table(pg);
    const writesAfterFirst = hooks.writes;
    expect(writesAfterFirst).toBe(7);
    for (const day of [
      '2026-04-07',
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-20',
      '2026-04-21',
      '2026-06-10',
    ]) {
      expect(existsSync(markerPath(workDir, day))).toBe(true);
    }

    // Nothing is left to plan, so a rerun, forced or not, writes nothing.
    const none = { expectUpdates: 0, expectDeletes: 0 };
    expect(await run(none)).toBe(0);
    expect(await run({ ...none, force: true })).toBe(0);

    expect(logged()).toContain('total updates 0, total deletes 0');
    expect(hooks.writes).toBe(writesAfterFirst);
    expect(await table(pg)).toEqual(once);
  });

  it('skips a day that has a done marker unless --force', async () => {
    await run();
    // Put one fixed row back as it was, on a day that is already marked.
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );
    const writes = hooks.writes;

    const one = { expectUpdates: 1, expectDeletes: 0 };
    expect(await run(one)).toBe(0);
    expect(logged()).toContain(
      '1 day(s) already applied (done marker), 0 to apply',
    );
    expect(logged()).toContain(
      'WARNING: 2026-04-21 is marked done but the fresh plan still has 1 update(s) and 0 delete(s) for it.',
    );
    expect(hooks.writes).toBe(writes);
    expect((await table(pg)).get('ES 2026-04-21T13:05:00Z')?.high).toBe(
      '7062.0000',
    );

    expect(await run({ ...one, force: true })).toBe(0);
    expect(hooks.writes).toBe(writes + 1);
    expect((await table(pg)).get('ES 2026-04-21T13:05:00Z')?.high).toBe(
      '7001.0000',
    );
  });

  it('warns for each marked day that drifted, with its counts, and says the totals include them', async () => {
    await run();
    // Three marked days drift: two rows change back, one deleted row comes back.
    await pg.query(
      `UPDATE futures_bars SET open = 7060.75
        WHERE symbol = 'ES' AND ts = '2026-04-07T14:31:00Z'`,
    );
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );
    await pg.query(
      `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
       VALUES ('RTY', '2026-04-11T14:00:00Z', 100, 101, 99, 100, 5)`,
    );
    const writes = hooks.writes;

    expect(await run({ expectUpdates: 2, expectDeletes: 1 })).toBe(0);

    const text = logged();
    expect(text).toContain(
      'WARNING: 2026-04-07 is marked done but the fresh plan still has 1 update(s) and 0 delete(s) for it.',
    );
    expect(text).toContain(
      'WARNING: 2026-04-11 is marked done but the fresh plan still has 0 update(s) and 1 delete(s) for it.',
    );
    expect(text).toContain(
      'WARNING: 2026-04-21 is marked done but the fresh plan still has 1 update(s) and 0 delete(s) for it.',
    );
    expect(text).toContain('the --expect totals count them');
    expect(text).toContain(
      '3 day(s) already applied (done marker), 0 to apply',
    );
    expect(hooks.writes).toBe(writes); // skipped, as before
  });

  it('does not warn about a clean marked day, or about a day that --force redoes', async () => {
    await run();
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );
    expect(await run({ expectUpdates: 1, expectDeletes: 0, force: true })).toBe(
      0,
    );
    expect(logged()).not.toContain('WARNING');
  });

  it('does not rewrite a row that already holds its target value', async () => {
    hooks.beforeWrite = async () => {
      await pg.query(
        `UPDATE futures_bars SET volume = 40
          WHERE symbol = 'ES' AND ts = '2026-04-07T14:32:00Z'`,
      );
    };
    expect(await run()).toBe(0);
    // Three updates were planned for the day; the guard let two write.
    expect(logged()).toContain('2026-04-07 updated 2 deleted 1');
  });

  it('keeps a day unmarked and exits non-zero when a write fails', async () => {
    hooks.failWriteAt = {
      nth: 2,
      error: new Error('column "volume" does not exist'),
    };
    const before = await table(pg);

    expect(await run()).toBe(1);

    expect(errored()).toMatch(
      /apply failed: day 2026-04-10: column "volume" does not exist/,
    );
    expect(existsSync(markerPath(workDir, '2026-04-07'))).toBe(true); // finished before the failure
    expect(existsSync(markerPath(workDir, '2026-04-10'))).toBe(false);
    expect(hooks.writes).toBe(2); // no day after the failed one is attempted
    const after = await table(pg);
    // Day 1 landed, day 2 did not.
    expect(after.has('ES 2026-04-07T14:33:00Z')).toBe(false);
    expect(after.has('RTY 2026-04-10T21:00:00Z')).toBe(true);
    expect(after.size).toBeLessThan(before.size);
  });

  it('leaves the day unmarked when the first write fails', async () => {
    hooks.failWriteAt = {
      nth: 1,
      error: new Error('connection broken by peer'),
    };
    const before = await table(pg);
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: day 2026-04-07/);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual(
      [],
    );
    expect(await table(pg)).toEqual(before);
  });

  it('does not delete a row whose values changed since the backup; the day fails and a rerun converges', async () => {
    let fired = false;
    hooks.beforeWrite = async () => {
      if (fired) return;
      fired = true;
      await pg.query(
        `UPDATE futures_bars SET close = close + 1
          WHERE symbol = 'ES' AND ts = '2026-04-07T14:33:00Z'`,
      );
    };

    expect(await run()).toBe(1);

    expect(errored()).toMatch(
      /apply failed: day 2026-04-07: verify failed for ES 2026-04-07.*value check/s,
    );
    // The day's updates committed, its skipped delete did not, and the day is unmarked.
    expect(hooks.writes).toBe(1);
    const mid = await table(pg);
    expect(ohlcv(mid, 'ES 2026-04-07T14:31:00Z')).toBe(
      '7000.0000/7001.2500/6999.0000/7000.5000/300',
    );
    expect(mid.get('ES 2026-04-07T14:33:00Z')?.close).toBe('7001.5000'); // still there, as changed
    expect(existsSync(markerPath(workDir, '2026-04-07'))).toBe(false);

    // The rerun re-plans: the day's updates are done, the changed row is judged
    // again (still no rebuilt minute), and every later day follows.
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await run({ expectUpdates: 2, expectDeletes: 18 })).toBe(0);

    const after = await table(pg);
    expect(after.has('ES 2026-04-07T14:33:00Z')).toBe(false);
    for (const day of [
      '2026-04-07',
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-20',
      '2026-04-21',
      '2026-06-10',
    ]) {
      expect(existsSync(markerPath(workDir, day))).toBe(true);
    }
    const backups = readdirSync(workDir)
      .filter((f) => f.startsWith('backup-'))
      .sort();
    expect(backups).toHaveLength(2);
    const lines = readFileSync(join(workDir, backups[1] ?? ''), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { op: string; row: Record<string, string> });
    expect(
      lines.find((l) => l.row.ts === '2026-04-07T14:33:00Z'),
    ).toMatchObject({ op: 'delete', row: { close: '7001.5000' } });

    // And a third run has nothing to do.
    const writes = hooks.writes;
    expect(await run({ expectUpdates: 0, expectDeletes: 0 })).toBe(0);
    expect(hooks.writes).toBe(writes);
  });

  it('writes only the picked fields: a change to a kept field stays, and the day fails', async () => {
    // ES 13:05 is a high-only update. Something sets its volume after the plan.
    hooks.beforeWrite = async () => {
      await pg.query(
        `UPDATE futures_bars SET volume = 777
          WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
      );
    };

    expect(await run()).toBe(1);

    expect(errored()).toMatch(
      /apply failed: day 2026-04-21: verify failed for ES 2026-04-21/,
    );
    const row = (await table(pg)).get('ES 2026-04-21T13:05:00Z');
    expect(row?.high).toBe('7001.0000'); // the picked field was written
    expect(row?.volume).toBe('777'); // the concurrent change was not undone
    expect(existsSync(markerPath(workDir, '2026-04-21'))).toBe(false);
    expect(existsSync(markerPath(workDir, '2026-04-20'))).toBe(true);
  });

  it('does not update a bar that a writer tied to a contract after the plan was read; the day fails', async () => {
    hooks.beforeWrite = async () => {
      await pg.query(
        `UPDATE futures_bars SET contract = 'ESM6'
          WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
      );
    };

    expect(await run()).toBe(1);

    expect(errored()).toMatch(
      /apply failed: day 2026-04-21: verify failed for ES 2026-04-21/,
    );
    const row = (await table(pg)).get('ES 2026-04-21T13:05:00Z');
    expect(row?.contract).toBe('ESM6');
    expect(row?.high).toBe('7062.0000'); // the picked high was not written over it
    expect(existsSync(markerPath(workDir, '2026-04-21'))).toBe(false);
  });

  it('writes the rebuilt volume with a replaced low, whatever the roll week or partial say', async () => {
    const ts = '2026-05-20T15:18:00Z';
    const fixture = baseFixture();
    fixture.pgRows.push({
      symbol: 'ES',
      ts,
      p: [7060.75, 7062, 7060, 7061],
      v: 33,
    });
    fixture.rebuilt.push({
      symbol: 'ES',
      ts,
      p: [7000, 7001.25, 6999.5, 7000.5],
      v: 8436,
      source: 'ticks',
      partial: true,
    });
    await reset(fixture);

    expect(await run({ expectUpdates: 6, expectDeletes: 18 })).toBe(0);

    expect(ohlcv(await table(pg), `ES ${ts}`)).toBe(
      '7000.0000/7001.2500/6999.5000/7000.5000/8436',
    );
  });

  it('fails the day when a write did not land, instead of marking it done', async () => {
    hooks.dropWrites = true;
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: day 2026-04-07: verify failed/);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual(
      [],
    );
  });

  it('splits a big day into statements of at most 500 rows', async () => {
    const day = '2026-04-08T00:00:00Z';
    const fixture = { pgRows: [] as SeedRow[], rebuilt: [] as RebuiltSeed[] };
    for (let i = 0; i < 1100; i += 1) {
      const ts = minute(day, i);
      fixture.pgRows.push({
        symbol: 'ES',
        ts,
        p: [7060, 7061, 6999, 7000],
        v: 10,
      });
      fixture.rebuilt.push({
        symbol: 'ES',
        ts,
        p: [7000, 7001, 6999, 7000],
        v: 10,
        source: 'archive',
      });
    }
    await reset(fixture);

    expect(await run({ expectUpdates: 1100, expectDeletes: 0 })).toBe(0);

    const writes = hooks.calls.filter((c) => !c.readOnly);
    expect(writes).toHaveLength(1);
    expect(
      writes[0]?.texts.filter((t) => t.includes('UPDATE futures_bars')),
    ).toHaveLength(3);
    const after = await table(pg);
    expect(after.size).toBe(1100);
    expect(ohlcv(after, 'ES 2026-04-08T18:19:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/10',
    );
  });

  it('with --dates writes only those days', async () => {
    const before = await table(pg);
    expect(
      await run({
        dates: ['2026-04-21'],
        expectUpdates: 1,
        expectDeletes: 1,
      }),
    ).toBe(0);
    const after = await table(pg);
    expect(ohlcv(after, 'ES 2026-04-21T13:05:00Z')).toBe(
      '7000.0000/7001.0000/6999.0000/7000.0000/300',
    );
    expect(after.has('ES 2026-04-21T13:18:00Z')).toBe(false);
    // Every other day is as it was.
    expect(after.get('ES 2026-04-07T14:31:00Z')).toEqual(
      before.get('ES 2026-04-07T14:31:00Z'),
    );
    expect(after.has('RTY 2026-04-11T14:00:00Z')).toBe(true);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual([
      '2026-04-21.applied',
    ]);
  });

  it('stops between days when market hours begin: exit 2, finished days marked', async () => {
    // The open arrives while the first day is being written.
    hooks.beforeWrite = () => {
      if (hooks.writes === 1) {
        vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
      }
    };

    expect(await run()).toBe(2);

    expect(hooks.writes).toBe(1);
    expect(errored()).toContain(
      'apply stopped before day 2026-04-10: market hours began (09:25 ET). 1 day(s) done and marked; 6 left (2 updates, 17 deletes).',
    );
    expect(existsSync(markerPath(workDir, '2026-04-07'))).toBe(true);
    expect(existsSync(markerPath(workDir, '2026-04-10'))).toBe(false);
    expect((await table(pg)).has('RTY 2026-04-10T21:00:00Z')).toBe(true);

    // After the close, a fresh dry run's totals finish the job.
    vi.setSystemTime(new Date('2026-11-09T22:30:00Z')); // Monday 17:30 ET
    expect(await run({ expectUpdates: 2, expectDeletes: 17 })).toBe(0);
    expect((await table(pg)).has('RTY 2026-04-10T21:00:00Z')).toBe(false);
    expect(existsSync(markerPath(workDir, '2026-06-10'))).toBe(true);
  });

  it('refuses, before any write, when the fresh plan is not the approved totals', async () => {
    const before = await table(pg);

    expect(await run({ expectUpdates: 5, expectDeletes: 17 })).toBe(1);

    expect(errored()).toContain(
      'the fresh plan has 5 updates and 18 deletes, but --expect-updates 5 and --expect-deletes 17 were given',
    );
    expect(hooks.writes).toBe(0);
    expect(await table(pg)).toEqual(before);
    expect(
      readdirSync(workDir).filter(
        (f) => f.startsWith('backup-') || f.endsWith('.applied'),
      ),
    ).toEqual([]);
  });

  it('refuses when the updates differ, and when no totals were given', async () => {
    expect(await run({ expectUpdates: 6, expectDeletes: 18 })).toBe(1);
    expect(errored()).toContain('--expect-updates 6 and --expect-deletes 18');
    expect(await run({ expectUpdates: null, expectDeletes: null })).toBe(1);
    expect(errored()).toContain(
      '--expect-updates missing and --expect-deletes missing',
    );
    expect(hooks.writes).toBe(0);
  });

  it('writes a marker that names the Phase 1 run and the day bars', async () => {
    await run();
    const marker = JSON.parse(
      readFileSync(markerPath(workDir, '2026-04-21'), 'utf8'),
    ) as Record<string, string>;
    expect(marker.gitHead).toBe('fbe7c057154fee85ca59ed5a43ecac1cfa4f720a');
    expect(marker.ndjsonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(marker.ndjsonSha256).toBe(digestOnDisk('2026-04-21'));
  });

  it('stamps a marker with the bars the plan used, even if the file is rewritten before the marker', async () => {
    const applied = digestOnDisk('2026-04-21');
    // Phase 1 is re-run while the apply is under way: 04-21's file changes
    // after the plan was built and before that day's marker is written.
    hooks.beforeWrite = () => {
      if (hooks.writes !== 1) return;
      editNdjson('ES-2026-04-21.ndjson', (bar) => {
        if (bar.ts === '2026-04-21T13:05:00Z') bar.high = 7001.5;
      });
    };

    expect(await run()).toBe(0);

    const marker = JSON.parse(
      readFileSync(markerPath(workDir, '2026-04-21'), 'utf8'),
    ) as Record<string, string>;
    expect(digestOnDisk('2026-04-21')).not.toBe(applied); // the file did change
    expect(marker.ndjsonSha256).toBe(applied); // the marker names what was applied

    // So the next run sees a marker written for other bars and re-plans the day.
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );
    expect(await run({ expectUpdates: 1, expectDeletes: 0 })).toBe(0);
    expect(logged()).toContain(
      'marker for 2026-04-21 was written for different rebuilt bars; re-planning',
    );
    expect((await table(pg)).get('ES 2026-04-21T13:05:00Z')?.high).toBe(
      '7001.5000',
    );
  });

  it('re-plans a marked day whose rebuilt bars changed, and skips one that did not', async () => {
    await run();
    // Phase 1 is re-run: one rebuilt high on 04-21 changes, counts do not.
    editNdjson('ES-2026-04-21.ndjson', (bar) => {
      if (bar.ts === '2026-04-21T13:05:00Z') bar.high = 7001.5;
    });
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );
    await pg.query(
      `UPDATE futures_bars SET open = 7060.75
        WHERE symbol = 'ES' AND ts = '2026-04-07T14:31:00Z'`,
    );

    expect(await run({ expectUpdates: 2, expectDeletes: 0 })).toBe(0);

    expect(logged()).toContain(
      'marker for 2026-04-21 was written for different rebuilt bars; re-planning',
    );
    expect(logged()).toContain(
      '1 day(s) already applied (done marker), 1 to apply',
    );
    const after = await table(pg);
    expect(after.get('ES 2026-04-21T13:05:00Z')?.high).toBe('7001.5000');
    expect(after.get('ES 2026-04-07T14:31:00Z')?.open).toBe('7060.7500'); // marker still good
  });

  it('re-plans every marked day when Phase 1 was re-run under another git SHA', async () => {
    await run();
    const path = join(inDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      git: { head: string };
    };
    manifest.git.head = '0123456789abcdef0123456789abcdef01234567';
    writeFileSync(path, JSON.stringify(manifest));
    await pg.query(
      `UPDATE futures_bars SET high = 7062
        WHERE symbol = 'ES' AND ts = '2026-04-21T13:05:00Z'`,
    );

    expect(await run({ expectUpdates: 1, expectDeletes: 0 })).toBe(0);

    expect(logged()).toContain(
      'marker for 2026-04-21 is from Phase 1 git fbe7c057, not 01234567; re-planning',
    );
    expect((await table(pg)).get('ES 2026-04-21T13:05:00Z')?.high).toBe(
      '7001.0000',
    );
  });

  it('refuses to apply while Phase 1 lists an unsplittable minute', async () => {
    writeFileSync(
      join(inDir, 'unsplittable.csv'),
      'symbol,ts,rule\nES,2026-04-21 14:00:00+00:00,a\n',
    );
    const before = await table(pg);
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply: 1 unsplittable minute/);
    expect(hooks.writes).toBe(0);
    expect(await table(pg)).toEqual(before);
  });
});

describe('dry run on real SQL (pglite)', () => {
  it('exits non-zero with the reason when a read fails, and writes nothing', async () => {
    hooks.failRead = new Error('relation "futures_bars" does not exist');
    expect(await run({ apply: false })).toBe(1);
    expect(errored()).toContain('relation "futures_bars" does not exist');
    expect(existsSync(workDir)).toBe(false);
    expect(hooks.writes).toBe(0);
  });

  it('writes nothing: every call is a read-only transaction, no marker, no backup', async () => {
    const before = await table(pg);

    expect(await run({ apply: false })).toBe(0);

    expect(await table(pg)).toEqual(before);
    expect(hooks.calls.length).toBeGreaterThan(0);
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
    expect(
      hooks.calls
        .flatMap((c) => c.texts)
        .some((t) => /\b(UPDATE|DELETE|INSERT)\b/.test(t)),
    ).toBe(false);
    const files = readdirSync(workDir).sort();
    expect(files).toEqual(['delete-list.csv', 'report.txt']);
  });

  it('prints the summary and lists every delete in the report and the csv', async () => {
    await run({ apply: false });
    const text = logged();

    expect(text).toContain('DRY RUN');
    expect(text).toContain('fbe7c057154fee85ca59ed5a43ecac1cfa4f720a');
    expect(text).toMatch(/ES front ESM6 G=17 carry=60\.75 carry_half=30\.375/);
    expect(text).toContain('total updates 5, total deletes 18');
    // The two NQ rows the excursion test deletes, with F and E.
    expect(text).toMatch(
      /NQ 2026-04-20T02:06:00Z id \d+ tick_excursion O 24240 H 24240 L 24000 C 24000 V 300 F=24000 E=240/,
    );
    expect(text).toMatch(/NQ 2026-04-20T02:14:00Z .* tick_excursion/);
    // The tick-less window row: PG rows and flags inside it.
    expect(text).toMatch(
      /NQ 2026-04-20T02:00:00Z \.\. 2026-04-20T02:20:00Z minutes 21 open 21 {2}pg_rows 21 {2}flagged 2/,
    );
    expect(text).toMatch(
      /ES close moves greater than G=17: rth 0, overnight 0/,
    );

    const csv = readFileSync(join(workDir, 'delete-list.csv'), 'utf8')
      .trim()
      .split('\n');
    expect(csv[0]).toMatch(/^symbol,ts,reason,/);
    expect(csv).toHaveLength(1 + 18);
    expect(csv.filter((l) => l.includes(',junk_window,'))).toHaveLength(14);
    expect(readFileSync(join(workDir, 'report.txt'), 'utf8')).toContain(
      'Delete list (18 rows):',
    );
  });

  it('is allowed during market hours; --apply is not', async () => {
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await run({ apply: false })).toBe(0);
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply during market hours/);
    expect(hooks.writes).toBe(0);
  });
});

// ── --thin-roots (Phase 5a, D1) ─────────────────────────────────────────────

const THIN_PRICE: Record<string, [number, number, number, number]> = {
  RTY: [2000, 2001, 1999, 2000],
  CL: [70, 70.5, 69.5, 70],
  GC: [3300, 3301, 3299, 3300],
  ZN: [110, 110.1, 109.9, 110],
};

/** [ts, deleted for every thin root]. ZN's last bad bar is one minute later than the rest. */
const THIN_TIMES: [string, boolean][] = [
  ['2026-04-05T21:59:00Z', false], // before the window
  ['2026-04-05T22:00:00Z', true], // first minute of the window
  ['2026-04-06T15:00:00Z', true],
  ['2026-04-12T21:59:00Z', true], // trading day 04-12, one minute before the clean block
  ['2026-04-12T22:00:00Z', false], // trading day 04-13
  ['2026-04-13T14:00:00Z', false],
  ['2026-04-17T21:59:00Z', false], // last minute of trading day 04-17
  ['2026-04-17T22:00:00Z', true], // trading day 04-18
  ['2026-05-31T21:59:00Z', true],
  ['2026-05-31T22:00:00Z', false], // trading day 06-01
  ['2026-06-01T21:59:00Z', false],
  ['2026-06-01T22:00:00Z', true], // trading day 06-02
  ['2026-06-07T22:00:00Z', false], // trading day 06-08
  ['2026-06-08T21:59:00Z', false],
  ['2026-06-08T22:00:00Z', true], // trading day 06-09
  ['2026-06-15T14:10:00Z', true], // last bad bar for RTY, CL, GC
  ['2026-06-15T14:12:00Z', false],
  ['2026-06-16T14:00:00Z', false],
];

/**
 * Deletes in the fixture: the 8 minutes above for each root, plus CL's mid-window
 * row and ZN's 14:11Z bar (RTY 8, CL 9, GC 8, ZN 9).
 */
const THIN_DELETES = 34;

function thinFixture(): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
    const p = THIN_PRICE[symbol] ?? FLAT;
    for (const [ts] of THIN_TIMES) rows.push({ symbol, ts, p, v: 10 });
    rows.push({ symbol, ts: '2026-06-15T14:11:00Z', p, v: 10 }); // ZN's last bad bar; kept for the others
  }
  // ES and NQ in the window, on minutes the thin roots lose.
  for (const symbol of ['ES', 'NQ']) {
    for (const ts of [
      '2026-04-05T22:00:00Z',
      '2026-05-05T15:00:00Z',
      '2026-06-15T14:10:00Z',
    ]) {
      rows.push({ symbol, ts, p: FLAT, v: 10 });
    }
  }
  // Order-flow columns on a row that goes.
  rows.push({
    symbol: 'CL',
    ts: '2026-05-05T15:00:00Z',
    p: THIN_PRICE.CL ?? FLAT,
    v: 10,
    flow: [3, 4, 1, 2],
  });
  return rows;
}

describe('--thin-roots on real SQL (pglite)', () => {
  const runThin = (over: Partial<Parameters<typeof runRepair>[0]> = {}) => {
    const apply = over.apply ?? true;
    return runRepair({
      dir: join(dir, 'no-phase-1-output'),
      workDir,
      apply,
      force: false,
      thinRoots: true,
      dates: [],
      expectUpdates: null,
      expectDeletes: apply ? THIN_DELETES : null,
      ...over,
    });
  };
  const DELETED_DAYS = [
    '2026-04-05',
    '2026-04-06',
    '2026-04-12',
    '2026-04-17',
    '2026-05-05',
    '2026-05-31',
    '2026-06-01',
    '2026-06-08',
    '2026-06-15',
  ];

  beforeEach(async () => {
    await reset({ pgRows: thinFixture(), rebuilt: [] });
  });

  it('deletes a thin-root bar in the window and keeps every bar of the clean days', async () => {
    const before = await table(pg);
    expect(await runThin()).toBe(0);
    const after = await table(pg);

    for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
      for (const [ts, deleted] of THIN_TIMES) {
        expect(after.has(`${symbol} ${ts}`), `${symbol} ${ts}`).toBe(!deleted);
      }
    }
    expect(after.has('CL 2026-05-05T15:00:00Z')).toBe(false); // mid-window
    // A kept row is exactly as it was, id included.
    expect(after.get('GC 2026-04-13T14:00:00Z')).toEqual(
      before.get('GC 2026-04-13T14:00:00Z'),
    );
    expect(logged()).toContain(`total deletes ${THIN_DELETES}`);
  });

  it('lands the boundaries: 21:59Z vs 22:00Z on 04-05, 14:10 vs 14:11 for CL, 14:11 vs 14:12 for ZN', async () => {
    await runThin();
    const after = await table(pg);
    for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
      expect(after.has(`${symbol} 2026-04-05T21:59:00Z`)).toBe(true);
      expect(after.has(`${symbol} 2026-04-05T22:00:00Z`)).toBe(false);
    }
    for (const symbol of ['RTY', 'CL', 'GC']) {
      expect(after.has(`${symbol} 2026-06-15T14:10:00Z`)).toBe(false);
      expect(after.has(`${symbol} 2026-06-15T14:11:00Z`)).toBe(true);
    }
    expect(after.has('ZN 2026-06-15T14:11:00Z')).toBe(false);
    expect(after.has('ZN 2026-06-15T14:12:00Z')).toBe(true);
    // The clean block: the minute either side of each clean day.
    expect(after.has('RTY 2026-04-12T21:59:00Z')).toBe(false);
    expect(after.has('RTY 2026-04-12T22:00:00Z')).toBe(true);
    expect(after.has('RTY 2026-04-17T21:59:00Z')).toBe(true);
    expect(after.has('RTY 2026-04-17T22:00:00Z')).toBe(false);
  });

  it('leaves ES and NQ untouched, in the window or not', async () => {
    const before = await table(pg);
    await runThin();
    const after = await table(pg);
    for (const symbol of ['ES', 'NQ']) {
      for (const ts of [
        '2026-04-05T22:00:00Z',
        '2026-05-05T15:00:00Z',
        '2026-06-15T14:10:00Z',
      ]) {
        expect(after.get(`${symbol} ${ts}`)).toEqual(
          before.get(`${symbol} ${ts}`),
        );
      }
    }
  });

  it('needs no Phase 1 output: the manifest folder does not exist', async () => {
    expect(existsSync(join(dir, 'no-phase-1-output'))).toBe(false);
    expect(await runThin()).toBe(0);
    expect(errored()).not.toMatch(/manifest/);
  });

  it('backs up every row it deletes before the first write, in the format parseBackup reads', async () => {
    let backups: string[] | null = null;
    hooks.beforeWrite = () => {
      backups ??= readdirSync(workDir)
        .filter((f) => f.startsWith('backup-'))
        .map((f) => readFileSync(join(workDir, f), 'utf8'));
    };
    const before = await table(pg);
    await runThin();

    expect(backups).not.toBeNull();
    const files = backups as unknown as string[];
    expect(files).toHaveLength(1);
    expect(readdirSync(workDir).filter((f) => f.startsWith('backup-'))).toEqual(
      ['backup-thin-roots.jsonl'],
    );
    const text = files[0] ?? '';
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(THIN_DELETES);
    const entries = lines.map(
      (l) =>
        JSON.parse(l) as {
          op: string;
          reason: string;
          row: Record<string, string | null>;
        },
    );
    expect(entries.every((e) => e.op === 'delete')).toBe(true);
    expect(entries.every((e) => e.reason === 'thin_root')).toBe(true);
    // The full pre-delete row: id and the order-flow columns included.
    const withFlow = entries.find((e) => e.row.buy_volume != null);
    expect(withFlow).toMatchObject({
      row: {
        id: before.get('CL 2026-05-05T15:00:00Z')?.id,
        symbol: 'CL',
        ts: '2026-05-05T15:00:00Z',
        buy_volume: '3',
        sell_prints: '2',
      },
    });

    // 5b passes this file as --backup, so Phase 4's reader must take every line.
    const parsed = parseBackup(text, 'thin-backup');
    expect(parsed).toHaveLength(THIN_DELETES);
    expect(parsed.every((b) => b.op === 'delete')).toBe(true);
    expect(parsed.filter((b) => b.symbol === 'ZN')).toHaveLength(9);
    expect(
      parsed.find(
        (b) =>
          b.symbol === 'CL' && b.tsMs === Date.parse('2026-06-15T14:10:00Z'),
      ),
    ).toMatchObject({ close: 70, volume: 10 });
  });

  it('refuses, before any write, when --expect-deletes is not the fresh plan', async () => {
    const before = await table(pg);

    expect(await runThin({ expectDeletes: THIN_DELETES - 1 })).toBe(1);

    expect(errored()).toContain(
      `the fresh plan has ${THIN_DELETES} deletes, but --expect-deletes ${THIN_DELETES - 1} was given`,
    );
    expect(hooks.writes).toBe(0);
    expect(await table(pg)).toEqual(before);
    expect(
      readdirSync(workDir).filter(
        (f) => f.startsWith('backup-') || f.endsWith('.applied'),
      ),
    ).toEqual([]);
  });

  it('refuses when no total is given', async () => {
    expect(await runThin({ expectDeletes: null })).toBe(1);
    expect(errored()).toContain('--expect-deletes missing was given');
    expect(hooks.writes).toBe(0);
  });

  it('writes one transaction and one marker per UTC day', async () => {
    expect(await runThin()).toBe(0);
    expect(hooks.writes).toBe(DELETED_DAYS.length);
    for (const day of DELETED_DAYS) {
      expect(existsSync(markerPath(workDir, day)), day).toBe(true);
    }
    const marker = JSON.parse(
      readFileSync(markerPath(workDir, '2026-04-06'), 'utf8'),
    ) as Record<string, string>;
    expect(marker.gitHead).toBe('thin-roots');
    expect(marker.ndjsonSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resumes after a failed day from the markers: finished days stay done, the rest follow', async () => {
    hooks.failWriteAt = { nth: 3, error: new Error('connection lost') };

    expect(await runThin()).toBe(1);

    expect(errored()).toMatch(/apply failed: day 2026-04-12: connection lost/);
    expect(existsSync(markerPath(workDir, '2026-04-05'))).toBe(true);
    expect(existsSync(markerPath(workDir, '2026-04-06'))).toBe(true);
    expect(existsSync(markerPath(workDir, '2026-04-12'))).toBe(false);
    const mid = await table(pg);
    expect(mid.has('RTY 2026-04-05T22:00:00Z')).toBe(false); // day 1 landed
    expect(mid.has('RTY 2026-04-12T21:59:00Z')).toBe(true); // day 3 did not
    expect(hooks.writes).toBe(3);

    // The fresh dry run reports only the days left; its total finishes the job.
    const left = THIN_DELETES - 8; // days 04-05 and 04-06 took 4 rows each
    hooks.failWriteAt = null;
    expect(await runThin({ expectDeletes: left })).toBe(0);
    expect(logged()).toContain(`total deletes ${left}`);

    const after = await table(pg);
    for (const [ts, deleted] of THIN_TIMES) {
      expect(after.has(`CL ${ts}`), ts).toBe(!deleted);
    }
    for (const day of DELETED_DAYS) {
      expect(existsSync(markerPath(workDir, day)), day).toBe(true);
    }
    // One backup file across both runs, every deleted row exactly once, so the
    // file 5b takes as --backup is always complete.
    expect(readdirSync(workDir).filter((f) => f.startsWith('backup-'))).toEqual(
      ['backup-thin-roots.jsonl'],
    );
    const text = readFileSync(join(workDir, 'backup-thin-roots.jsonl'), 'utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(THIN_DELETES);
    const ids = lines.map(
      (l) => (JSON.parse(l) as { row: { id: string } }).row.id,
    );
    expect(new Set(ids).size).toBe(THIN_DELETES);
    expect(parseBackup(text, 'thin-backup')).toHaveLength(THIN_DELETES);
    // The first run wrote all of it before its first write; the resume added nothing.
    expect(logged()).toContain(
      `(+${THIN_DELETES} rows, ${THIN_DELETES} in the file)`,
    );
    expect(logged()).toContain(`(+0 rows, ${THIN_DELETES} in the file)`);
  });

  it('adds to the one backup only the rows it lacks: a bar that appeared after a failed run is appended once', async () => {
    hooks.failWriteAt = { nth: 3, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);
    const file = join(workDir, 'backup-thin-roots.jsonl');
    const first = readFileSync(file, 'utf8');
    expect(first.split('\n').filter((l) => l !== '')).toHaveLength(
      THIN_DELETES,
    );

    // A bar lands in the window after the failure.
    await pg.query(
      `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
       VALUES ('GC', '2026-05-06T15:00:00Z', 3300, 3301, 3299, 3300, 10)`,
    );
    hooks.failWriteAt = null;
    expect(await runThin({ expectDeletes: THIN_DELETES - 8 + 1 })).toBe(0);

    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(THIN_DELETES + 1);
    expect(text.startsWith(first)).toBe(true); // appended; nothing rewritten
    expect(parseBackup(text, 'thin-backup')).toHaveLength(THIN_DELETES + 1);
    expect(logged()).toContain(`(+1 rows, ${THIN_DELETES + 1} in the file)`);
  });

  it('refuses, before any write, when the backup file holds an id with a different row, naming the id and the field', async () => {
    const before = await table(pg);
    const row = before.get('CL 2026-04-06T15:00:00Z');
    expect(row).toBeDefined();
    mkdirSync(workDir, { recursive: true });
    const file = join(workDir, 'backup-thin-roots.jsonl');
    const seeded = `${JSON.stringify({
      op: 'delete',
      reason: 'thin_root',
      row: { ...row, close: '1.0000' },
    })}\n`;
    writeFileSync(file, seeded);

    expect(await runThin()).toBe(1);

    expect(errored()).toMatch(
      new RegExp(
        `backup-thin-roots\\.jsonl already holds id ${row?.id} \\(CL 2026-04-06T15:00:00Z\\) with a different close: file "1\\.0000", database "70\\.0000"`,
      ),
    );
    expect(hooks.writes).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(seeded);
    expect(await table(pg)).toEqual(before);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual(
      [],
    );
  });

  it('refuses a backup file that holds the same id twice, naming the line', async () => {
    const row = (await table(pg)).get('CL 2026-04-06T15:00:00Z');
    mkdirSync(workDir, { recursive: true });
    const line = `${JSON.stringify({ op: 'delete', reason: 'thin_root', row })}\n`;
    writeFileSync(join(workDir, 'backup-thin-roots.jsonl'), line + line);
    expect(await runThin()).toBe(1);
    expect(errored()).toMatch(
      new RegExp(`backup-thin-roots\\.jsonl:2: id ${row?.id} appears twice`),
    );
    expect(hooks.writes).toBe(0);
  });

  it('refuses a backup file with a line that is not a backup entry, naming the line', async () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'backup-thin-roots.jsonl'), '{"op":"delete"\n');
    expect(await runThin()).toBe(1);
    expect(errored()).toMatch(/backup-thin-roots\.jsonl:1: /);
    expect(hooks.writes).toBe(0);
  });

  it("keeps the dry run's report.txt and delete-list.csv through an apply: the apply writes its own copies", async () => {
    await runThin({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));

    // A refused apply, then one that fails on its third day: both used to
    // overwrite the approved list with the fresh plan. The clock moves between
    // them, as it does in production, so each apply has its own copies.
    expect(await runThin({ expectDeletes: THIN_DELETES - 1 })).toBe(1);
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    hooks.failWriteAt = { nth: 3, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const files = readdirSync(workDir);
    const reports = files.filter((f) => /^apply-.*-report\.txt$/.test(f));
    const lists = files.filter((f) => /^apply-.*-delete-list\.csv$/.test(f));
    expect(reports).toHaveLength(2);
    expect(lists).toHaveLength(2);
    // The refused apply planned all 34; the failed one planned the same and
    // each copy holds its own run's plan.
    for (const name of lists) {
      expect(
        readFileSync(join(workDir, name), 'utf8').trim().split('\n'),
      ).toHaveLength(1 + THIN_DELETES);
    }
  });

  it('writes a dry run after an apply under dryrun-<time>- names and leaves the approved report.txt and delete-list.csv', async () => {
    await runThin({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));
    expect(await runThin()).toBe(0);

    // The check that nothing is left, run in the same work dir: it plans no
    // delete and used to replace both approved files with that empty plan.
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    expect(await runThin({ apply: false })).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const files = readdirSync(workDir);
    const reports = files.filter((f) => /^dryrun-.*-report\.txt$/.test(f));
    const lists = files.filter((f) => /^dryrun-.*-delete-list\.csv$/.test(f));
    expect(reports).toHaveLength(1);
    expect(lists).toHaveLength(1);
    expect(readFileSync(join(workDir, reports[0] ?? ''), 'utf8')).toContain(
      'total deletes 0',
    );
    expect(
      readFileSync(join(workDir, lists[0] ?? ''), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(logged()).toContain(`report: ${join(workDir, reports[0] ?? '')}`);
  });

  it('writes a dry run after a partial apply under dryrun-<time>- names too', async () => {
    await runThin({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    hooks.failWriteAt = { nth: 3, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);
    hooks.failWriteAt = null;
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));

    expect(await runThin({ apply: false })).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(
      readdirSync(workDir).filter((f) => /^dryrun-.*-report\.txt$/.test(f)),
    ).toHaveLength(1);
  });

  it('still writes report.txt and delete-list.csv from a dry run when no day is marked done', async () => {
    await runThin({ apply: false });
    expect(existsSync(join(workDir, 'report.txt'))).toBe(true);
    expect(existsSync(join(workDir, 'delete-list.csv'))).toBe(true);
    expect(readdirSync(workDir).filter((f) => f.startsWith('dryrun-'))).toEqual(
      [],
    );
  });

  // A later dry run over one day plans (and reports) something other than the
  // approved all-days one, so a replaced report.txt would differ byte for byte.
  const laterDryRun = (): Promise<number> => {
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    return runThin({ apply: false, dates: ['2026-04-05'] });
  };
  const dryRunFiles = (): string[] =>
    readdirSync(workDir).filter((f) => f.startsWith('dryrun-'));

  // An apply that fails on its first day marks no day done: what it leaves is
  // the one backup file it took before that write (and its apply-<time>- report).
  it('writes a dry run under dryrun-<time>- names after an apply that failed on its first day', async () => {
    await runThin({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));
    const list = readFileSync(join(workDir, 'delete-list.csv'));
    hooks.failWriteAt = { nth: 1, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);
    hooks.failWriteAt = null;
    expect(errored()).toMatch(/apply failed: day 2026-04-05: connection lost/);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual(
      [],
    );
    expect(existsSync(join(workDir, 'backup-thin-roots.jsonl'))).toBe(true);

    expect(await laterDryRun()).toBe(0);

    expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
    expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
    const reports = readdirSync(workDir).filter((f) =>
      /^dryrun-.*-report\.txt$/.test(f),
    );
    expect(reports).toHaveLength(1);
    expect(
      readdirSync(workDir).filter((f) =>
        /^dryrun-.*-delete-list\.csv$/.test(f),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(workDir, reports[0] ?? ''))).not.toEqual(report);
    expect(logged()).toContain(`report: ${join(workDir, reports[0] ?? '')}`);
  });

  // Each sign on its own, in a work dir that holds nothing else of an apply.
  it.each([
    ['the kept backup', 'backup-thin-roots.jsonl'],
    ['a done day', '2026-04-05.applied'],
  ])(
    'writes a dry run under dryrun-<time>- names when the only sign of an apply is %s (%s)',
    async (_name, file) => {
      await runThin({ apply: false });
      const report = readFileSync(join(workDir, 'report.txt'));
      const list = readFileSync(join(workDir, 'delete-list.csv'));
      writeFileSync(join(workDir, file), '');

      expect(await laterDryRun()).toBe(0);

      expect(readFileSync(join(workDir, 'report.txt'))).toEqual(report);
      expect(readFileSync(join(workDir, 'delete-list.csv'))).toEqual(list);
      expect(dryRunFiles()).toHaveLength(2);
    },
  );

  it('still replaces report.txt after a refused apply, which writes no backup or marker', async () => {
    await runThin({ apply: false });
    const report = readFileSync(join(workDir, 'report.txt'));

    expect(await runThin({ expectDeletes: THIN_DELETES - 1 })).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply: the fresh plan has/);
    expect(
      readdirSync(workDir).filter(
        (f) => f.startsWith('backup-') || f.endsWith('.applied'),
      ),
    ).toEqual([]);

    expect(await laterDryRun()).toBe(0);

    expect(dryRunFiles()).toEqual([]);
    expect(readFileSync(join(workDir, 'report.txt'))).not.toEqual(report);
  });

  it('appends nothing to the backup when the open refuses the run before its first day', async () => {
    const file = join(workDir, 'backup-thin-roots.jsonl');
    // The clock passes the start guard, then reaches the open while the plan is read.
    hooks.onRead = () => vi.setSystemTime(new Date('2026-11-09T16:00:00Z'));

    expect(await runThin()).toBe(2);

    expect(errored()).toContain(
      'apply stopped before day 2026-04-05: market hours began (09:25 ET). 0 day(s) done and marked;',
    );
    expect(existsSync(file)).toBe(false);
    expect(hooks.writes).toBe(0);

    // With a backup already there from a run that failed, a refusal at the
    // open leaves it as it was, even when a new row is pending.
    hooks.onRead = null;
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    hooks.failWriteAt = { nth: 2, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);
    const held = readFileSync(file);
    expect(
      held
        .toString('utf8')
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(THIN_DELETES);
    await pg.query(
      `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
       VALUES ('GC', '2026-05-06T15:00:00Z', 3300, 3301, 3299, 3300, 10)`,
    );
    hooks.failWriteAt = null;
    vi.setSystemTime(new Date('2026-11-08T12:10:00Z'));
    hooks.onRead = () => vi.setSystemTime(new Date('2026-11-09T16:00:00Z'));

    expect(await runThin({ expectDeletes: THIN_DELETES - 4 + 1 })).toBe(2);

    expect(readFileSync(file)).toEqual(held);
  });

  it('a second --apply changes 0 rows, forced or not', async () => {
    expect(await runThin()).toBe(0);
    const once = await table(pg);
    const writes = hooks.writes;

    expect(await runThin({ expectDeletes: 0 })).toBe(0);
    expect(await runThin({ expectDeletes: 0, force: true })).toBe(0);

    expect(logged()).toContain('total deletes 0');
    expect(hooks.writes).toBe(writes);
    expect(await table(pg)).toEqual(once);
  });

  it('does not delete a row whose values changed since the backup; the day fails', async () => {
    let fired = false;
    hooks.beforeWrite = async () => {
      if (fired) return;
      fired = true;
      await pg.query(
        `UPDATE futures_bars SET close = close + 1
          WHERE symbol = 'RTY' AND ts = '2026-04-05T22:00:00Z'`,
      );
    };

    expect(await runThin()).toBe(1);

    expect(errored()).toMatch(
      /apply failed: day 2026-04-05: verify failed for RTY 2026-04-05.*value check/s,
    );
    const mid = await table(pg);
    expect(mid.get('RTY 2026-04-05T22:00:00Z')?.close).toBe('2001.0000'); // kept, as changed
    expect(mid.has('CL 2026-04-05T22:00:00Z')).toBe(false); // the others went
    expect(existsSync(markerPath(workDir, '2026-04-05'))).toBe(false);
  });

  describe('the bar contract (#204)', () => {
    const backupFile = (): string => join(workDir, 'backup-thin-roots.jsonl');
    /** A backup row as 5a wrote it before the contract was read: no such key. */
    const beforeContract = (row: TableRow): Partial<TableRow> => {
      const old: Partial<TableRow> = { ...row };
      delete old.contract;
      return old;
    };
    const backupRows = (): Record<string, string | null>[] =>
      readFileSync(backupFile(), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map(
          (l) => (JSON.parse(l) as { row: Record<string, string | null> }).row,
        );

    it('backs up the contract of a bar it deletes, and NULL for a bar without one', async () => {
      await pg.query(
        `UPDATE futures_bars SET contract = 'RTYM6'
          WHERE symbol = 'RTY' AND ts = '2026-04-06T15:00:00Z'`,
      );

      expect(await runThin()).toBe(0);

      const rows = backupRows();
      expect(rows).toHaveLength(THIN_DELETES);
      const withContract = rows.filter((r) => r.contract != null);
      expect(withContract).toHaveLength(1);
      expect(withContract[0]).toMatchObject({
        symbol: 'RTY',
        ts: '2026-04-06T15:00:00Z',
        contract: 'RTYM6',
      });
      // Every other line carries the key, NULL.
      expect(rows.every((r) => 'contract' in r)).toBe(true);
      expect((await table(pg)).has('RTY 2026-04-06T15:00:00Z')).toBe(false);
    });

    it('does not delete a bar that a writer tied to a contract after the plan was read; the day fails', async () => {
      let fired = false;
      hooks.beforeWrite = async () => {
        if (fired) return;
        fired = true;
        await pg.query(
          `UPDATE futures_bars SET contract = 'RTYM6'
            WHERE symbol = 'RTY' AND ts = '2026-04-05T22:00:00Z'`,
        );
      };

      expect(await runThin()).toBe(1);

      expect(errored()).toMatch(
        /apply failed: day 2026-04-05: verify failed for RTY 2026-04-05.*value check/s,
      );
      const mid = await table(pg);
      expect(mid.get('RTY 2026-04-05T22:00:00Z')?.contract).toBe('RTYM6'); // kept
      expect(mid.has('CL 2026-04-05T22:00:00Z')).toBe(false); // the others went
      expect(existsSync(markerPath(workDir, '2026-04-05'))).toBe(false);
    });

    it('takes a backup line written before the contract was read: no key reads as NULL, and the row is not added twice', async () => {
      const row = (await table(pg)).get('CL 2026-04-06T15:00:00Z');
      expect(row).toBeDefined();
      const old = beforeContract(row as TableRow);
      mkdirSync(workDir, { recursive: true });
      const seeded = `${JSON.stringify({ op: 'delete', reason: 'thin_root', row: old })}\n`;
      writeFileSync(backupFile(), seeded);

      expect(await runThin()).toBe(0);

      const text = readFileSync(backupFile(), 'utf8');
      expect(text.startsWith(seeded)).toBe(true); // the old line is kept as it was
      expect(text.split('\n').filter((l) => l !== '')).toHaveLength(
        THIN_DELETES,
      );
      expect(parseBackup(text, 'thin-backup')).toHaveLength(THIN_DELETES);
      expect((await table(pg)).has('CL 2026-04-06T15:00:00Z')).toBe(false);
    });

    it('refuses, before any write, a backup line without a contract for a bar that has one now', async () => {
      await pg.query(
        `UPDATE futures_bars SET contract = 'CLN6'
          WHERE symbol = 'CL' AND ts = '2026-04-06T15:00:00Z'`,
      );
      const before = await table(pg);
      const row = before.get('CL 2026-04-06T15:00:00Z');
      const old = beforeContract(row as TableRow);
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        backupFile(),
        `${JSON.stringify({ op: 'delete', reason: 'thin_root', row: old })}\n`,
      );

      expect(await runThin()).toBe(1);

      expect(errored()).toMatch(
        new RegExp(
          `already holds id ${row?.id} \\(CL 2026-04-06T15:00:00Z\\) with a different contract: file "null", database "CLN6"`,
        ),
      );
      expect(hooks.writes).toBe(0);
      expect(await table(pg)).toEqual(before);
    });
  });

  it('fails the day when a delete did not land, instead of marking it done', async () => {
    hooks.dropWrites = true;
    expect(await runThin()).toBe(1);
    expect(errored()).toMatch(/apply failed: day 2026-04-05: verify failed/);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual(
      [],
    );
  });

  it('re-plans a marked day when other rows than the marked ones are back', async () => {
    await runThin();
    // 05-05 had one planned delete, CL's mid-window bar. It comes back as a
    // different row (new id, same prices), so only the row itself differs.
    await pg.query(
      `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume,
                                 buy_volume, sell_volume, buy_prints, sell_prints)
       VALUES ('CL', '2026-05-05T15:00:00Z', 70, 70.5, 69.5, 70, 10, 3, 4, 1, 2)`,
    );

    expect(await runThin({ expectDeletes: 1 })).toBe(0);

    expect(logged()).toContain(
      'marker for 2026-05-05 was written for different planned deletes; re-planning',
    );
    expect((await table(pg)).has('CL 2026-05-05T15:00:00Z')).toBe(false);
  });

  it('skips a marked day whose rows are back unchanged, with a warning, unless --force', async () => {
    const before = await table(pg);
    await runThin();
    // The four rows of 04-06 come back as they were, ids included.
    for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
      const r = before.get(`${symbol} 2026-04-06T15:00:00Z`);
      await pg.query(
        `INSERT INTO futures_bars (id, symbol, ts, open, high, low, close, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r?.id, symbol, r?.ts, r?.open, r?.high, r?.low, r?.close, r?.volume],
      );
    }
    const writes = hooks.writes;

    expect(await runThin({ expectDeletes: 4 })).toBe(0);

    expect(logged()).toContain(
      'WARNING: 2026-04-06 is marked done but the fresh plan still has 0 update(s) and 4 delete(s) for it.',
    );
    expect(hooks.writes).toBe(writes);
    expect((await table(pg)).has('CL 2026-04-06T15:00:00Z')).toBe(true);

    expect(await runThin({ expectDeletes: 4, force: true })).toBe(0);
    expect(hooks.writes).toBe(writes + 1);
    expect((await table(pg)).has('CL 2026-04-06T15:00:00Z')).toBe(false);
  });

  it('with --dates deletes only those days', async () => {
    expect(await runThin({ dates: ['2026-04-06'], expectDeletes: 4 })).toBe(0);
    const after = await table(pg);
    for (const symbol of ['RTY', 'CL', 'GC', 'ZN']) {
      expect(after.has(`${symbol} 2026-04-06T15:00:00Z`)).toBe(false);
      expect(after.has(`${symbol} 2026-04-05T22:00:00Z`)).toBe(true);
    }
    expect(readdirSync(workDir).filter((f) => f.endsWith('.applied'))).toEqual([
      '2026-04-06.applied',
    ]);
  });

  it('splits a big day into DELETE statements of at most 500 rows', async () => {
    const day = '2026-04-08T00:00:00Z';
    const rows: SeedRow[] = [];
    for (let i = 0; i < 1100; i += 1) {
      rows.push({
        symbol: 'CL',
        ts: minute(day, i),
        p: THIN_PRICE.CL ?? FLAT,
        v: 10,
      });
    }
    await reset({ pgRows: rows, rebuilt: [] });

    expect(await runThin({ expectDeletes: 1100 })).toBe(0);

    const writes = hooks.calls.filter((c) => !c.readOnly);
    expect(writes).toHaveLength(1);
    expect(
      writes[0]?.texts.filter((t) => t.includes('DELETE FROM futures_bars')),
    ).toHaveLength(3);
    expect((await table(pg)).size).toBe(0);
  });

  it('stops between days when market hours begin: exit 2, finished days marked', async () => {
    hooks.beforeWrite = () => {
      if (hooks.writes === 1) {
        vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
      }
    };

    expect(await runThin()).toBe(2);

    expect(hooks.writes).toBe(1);
    expect(errored()).toContain(
      'apply stopped before day 2026-04-06: market hours began (09:25 ET). 1 day(s) done and marked;',
    );
    // The way on names the mode and the one backup, and says when it is complete.
    expect(errored()).toContain(
      'run a fresh dry run and --apply --thin-roots with its total',
    );
    expect(errored()).toContain(join(workDir, 'backup-thin-roots.jsonl'));
    expect(errored()).toContain('complete only after a run prints "done."');
    expect(existsSync(markerPath(workDir, '2026-04-05'))).toBe(true);
    expect(existsSync(markerPath(workDir, '2026-04-06'))).toBe(false);
  });

  it('names the one backup in the error of a failed day, and says it is complete only after "done."', async () => {
    hooks.failWriteAt = { nth: 2, error: new Error('connection lost') };
    expect(await runThin()).toBe(1);
    expect(errored()).toContain(join(workDir, 'backup-thin-roots.jsonl'));
    expect(errored()).toContain('complete only after a run prints "done."');
  });

  it('refuses --apply during market hours; the dry run is allowed', async () => {
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await runThin({ apply: false })).toBe(0);
    expect(await runThin()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply during market hours/);
    expect(hooks.writes).toBe(0);
  });

  describe('dry run', () => {
    it('writes nothing: read-only transactions only, no marker, no backup', async () => {
      const before = await table(pg);

      expect(await runThin({ apply: false })).toBe(0);

      expect(await table(pg)).toEqual(before);
      expect(hooks.calls.length).toBeGreaterThan(0);
      expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
      expect(
        hooks.calls
          .flatMap((c) => c.texts)
          .some((t) => /\b(UPDATE|DELETE|INSERT)\b/.test(t)),
      ).toBe(false);
      expect(readdirSync(workDir).sort()).toEqual([
        'delete-list.csv',
        'report.txt',
      ]);
    });

    it('prints the apply command with --dates when the dry run was narrowed to days', async () => {
      await runThin({ apply: false, dates: ['2026-04-06'] });
      expect(logged()).toContain(
        `npx tsx scripts/repair-futures-contract-mix.ts --thin-roots --apply --expect-deletes 4 --work-dir ${workDir} --dates 2026-04-06`,
      );
    });

    it('lists per root the deletes, the first and last, and the kept rows, and prints the apply command', async () => {
      await runThin({ apply: false });
      const text = logged();

      expect(text).toContain('DRY RUN');
      expect(text).toMatch(
        /RTY {2}window rows 15 {2}delete 8 {2}keep 7 \(clean days\)/,
      );
      expect(text).toMatch(
        /CL {3}window rows 16 {2}delete 9 {2}keep 7 \(clean days\)/,
      );
      expect(text).toMatch(
        /ZN {3}window rows 16 {2}delete 9 {2}keep 7 \(clean days\)/,
      );
      expect(text).toContain(
        'first delete 2026-04-05T22:00:00Z  last delete 2026-06-15T14:10:00Z',
      );
      expect(text).toContain(
        'first delete 2026-04-05T22:00:00Z  last delete 2026-06-15T14:11:00Z',
      );
      expect(text).toContain('RTY 2026-04-13 2');
      expect(text).toContain(`total deletes ${THIN_DELETES}`);
      expect(text).toContain(
        `npx tsx scripts/repair-futures-contract-mix.ts --thin-roots --apply --expect-deletes ${THIN_DELETES} --work-dir ${workDir}`,
      );
      expect(readFileSync(join(workDir, 'report.txt'), 'utf8')).toContain(
        'Apply, after the close',
      );
      const csv = readFileSync(join(workDir, 'delete-list.csv'), 'utf8')
        .trim()
        .split('\n');
      expect(csv).toHaveLength(1 + THIN_DELETES);
      expect(csv.filter((l) => l.includes(',thin_root,'))).toHaveLength(
        THIN_DELETES,
      );
    });

    it('exits non-zero with the reason when a read fails, and writes nothing', async () => {
      hooks.failRead = new Error('relation "futures_bars" does not exist');
      expect(await runThin({ apply: false })).toBe(1);
      expect(errored()).toContain('relation "futures_bars" does not exist');
      expect(existsSync(workDir)).toBe(false);
      expect(hooks.writes).toBe(0);
    });
  });
});
