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
}

async function table(pg: PGliteType): Promise<Map<string, TableRow>> {
  const { rows } = await pg.query<TableRow>(
    `SELECT id::text AS id, symbol,
            to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
            open::text, high::text, low::text, close::text, volume::text,
            buy_volume::text, sell_volume::text, buy_prints::text, sell_prints::text
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
    dates: [],
    expectUpdates: apply ? 5 : null,
    expectDeletes: apply ? 18 : null,
    ...over,
  });
};

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
    expect(marker.ndjsonSha256).toBe(dayDigest(inDir, '2026-04-21'));
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
