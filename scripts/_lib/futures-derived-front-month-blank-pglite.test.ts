// @vitest-environment node

/**
 * REAL-SQL test for the volume ratios `--repair front-month` sets to NULL (Phase 6b of
 * docs/superpowers/specs/2026-11-06-futures-session-front-month.md, owner decision
 * 2026-11-13): a GC row before 2026-08-17 and a CL row before 2026-08-11 have a 20-day
 * base that holds bars no repair can rebuild, so their volume ratio is wrong however the
 * rest of the plan goes. The rule, the guarded UPDATE that writes a NULL, the plan file,
 * the report and plan.json counts and the second dry run run against pglite.
 *
 * The world has two roots, GC and CL, so premarket and fires (ES only) plan nothing and
 * the only tables are futures_bars and futures_snapshots. The profile module is mocked for
 * its backup pins (a fixture run id and totals); the span, the end of the write run and the
 * contaminated ranges are the real ones. getDb() emulates production as in
 * futures-derived-front-month-pglite.test.ts.
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
  writes: 0,
  beforeWrite: null as null | (() => void),
  /** The nth (1-based) write transaction rejects with this error. */
  failWriteAt: null as null | { nth: number; error: Error },
  /** The pinned backup of the fixture: what the profile module is mocked to. */
  runId: 'fixture-run',
  totals: { rewrite: 0, delete: 0, fill: 0, tag: 0 },
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
          then: (onFulfilled, onRejected) =>
            pg
              .transaction(async (tx) => {
                await tx.query('SET TRANSACTION READ ONLY');
                return (await tx.query(text, params)).rows;
              })
              .then(onFulfilled, onRejected),
        };
      };
      return Object.assign(tag, {
        transaction: async (
          queries: PgliteQuery[],
          opts?: { readOnly?: boolean },
        ) => {
          const readOnly = opts?.readOnly === true;
          if (!readOnly) {
            hooks.writes += 1;
            hooks.beforeWrite?.();
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

vi.mock('./futures-derived-front-month.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./futures-derived-front-month.js')>();
  return {
    ...actual,
    FRONT_MONTH: {
      ...actual.FRONT_MONTH,
      backup: {
        get runId() {
          return hooks.runId;
        },
        get totals() {
          return hooks.totals;
        },
      },
    },
  };
});

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import { computeSnapshot } from '../../api/_lib/futures-derive.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  markerPath,
  roundNumeric,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

vi.setConfig({ testTimeout: 120_000 });

type Root = 'GC' | 'CL';

// ── Schema ──────────────────────────────────────────────────────────────────

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
  await pg.query(
    `CREATE TABLE touch_log (tbl TEXT NOT NULL, id BIGINT NOT NULL)`,
  );
  await pg.query(`
    CREATE FUNCTION log_touch() RETURNS trigger AS $$
    BEGIN
      INSERT INTO touch_log (tbl, id) VALUES (TG_TABLE_NAME, NEW.id);
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await pg.query(
    `CREATE TRIGGER futures_snapshots_touch AFTER UPDATE ON futures_snapshots
       FOR EACH ROW EXECUTE FUNCTION log_touch()`,
  );
}, 120_000);

afterAll(async () => {
  await pg.close();
});

// ── The changes Phase 6 made ────────────────────────────────────────────────

interface Vals {
  close: number;
  volume: number;
}
type Entry =
  | { action: 'rewrite'; symbol: Root; ts: string; old: Vals; now: Vals }
  | { action: 'delete'; symbol: Root; ts: string; old: Vals }
  | { action: 'fill'; symbol: Root; ts: string; now: Vals };
let entries: Entry[] = [];

const full = (ts: string): string => new Date(ts).toISOString();

function barRow(ts: string, v: Vals, padded: boolean) {
  const p = (n: number): string => (padded ? n.toFixed(4) : String(n));
  return {
    ts: full(ts),
    open: p(v.close),
    high: p(v.close),
    low: p(v.close),
    close: p(v.close),
    volume: v.volume,
    buyVolume: null,
    sellVolume: null,
    buyPrints: null,
    sellPrints: null,
    contract: null,
  };
}

function lineOf(e: Entry): string {
  const head = { runId: hooks.runId, action: e.action, symbol: e.symbol };
  if (e.action === 'rewrite') {
    return JSON.stringify({
      ...head,
      row: barRow(e.ts, e.old, true),
      after: barRow(e.ts, e.now, false),
    });
  }
  if (e.action === 'delete') {
    return JSON.stringify({ ...head, row: barRow(e.ts, e.old, true) });
  }
  return JSON.stringify({ ...head, after: barRow(e.ts, e.now, false) });
}

async function bar(symbol: Root, ts: string, v: Vals): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, $4)`,
    [symbol, ts, v.close, v.volume],
  );
}

async function rewritten(
  symbol: Root,
  ts: string,
  old: Vals,
  now: Vals,
): Promise<void> {
  await bar(symbol, ts, old);
  entries.push({ action: 'rewrite', symbol, ts, old, now });
}

function filled(symbol: Root, ts: string, now: Vals): void {
  entries.push({ action: 'fill', symbol, ts, now });
}

/** A bar Phase 6 deleted: stored in the world before it. */
async function deleted(symbol: Root, ts: string, old: Vals): Promise<void> {
  await bar(symbol, ts, old);
  entries.push({ action: 'delete', symbol, ts, old });
}

async function applyRepair(): Promise<void> {
  for (const e of entries) {
    if (e.action === 'delete') {
      await pg.query(`DELETE FROM futures_bars WHERE symbol = $1 AND ts = $2`, [
        e.symbol,
        e.ts,
      ]);
    } else if (e.action === 'rewrite') {
      await pg.query(
        `UPDATE futures_bars SET open = $3, high = $3, low = $3, close = $3, volume = $4
          WHERE symbol = $1 AND ts = $2`,
        [e.symbol, e.ts, e.now.close, e.now.volume],
      );
    } else {
      await bar(e.symbol, e.ts, e.now);
    }
  }
}

function writeBackupFile(): void {
  const totals = { rewrite: 0, delete: 0, fill: 0, tag: 0 };
  for (const e of entries) totals[e.action] += 1;
  hooks.totals = totals;
  writeFileSync(backupPath, `${entries.map(lineOf).join('\n')}\n`);
}

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * One trading day of bars (EDT, the cash open at 13:30Z): a prior-day bar (volume 500),
 * the open bar, the hour-ago bar and the last closed bar (volume 50). A snapshot at
 * 14:31:30 recomputes to `now` and the 1h and day changes (now - ref) / ref.
 */
async function snapshotDay(
  symbol: Root,
  date: string,
  prior: string,
  ref: number,
  now: number,
): Promise<void> {
  await bar(symbol, `${prior}T15:00:00Z`, { close: ref - 10, volume: 500 });
  await bar(symbol, `${date}T13:30:00Z`, { close: ref, volume: 50 });
  await bar(symbol, `${date}T13:31:00Z`, { close: ref, volume: 50 });
  await bar(symbol, `${date}T14:30:00Z`, { close: now, volume: 50 });
}

type SnapshotValuesTuple = [
  number,
  number | null,
  number | null,
  number | null,
];

/** What the cron would have stored: computeSnapshot on the bars as they are now, at the column scale. */
async function savedFromBars(
  symbol: Root,
  ts: string,
): Promise<SnapshotValuesTuple> {
  const at = new Date(ts);
  const result = await computeSnapshot(symbol, getETDateStr(at), at);
  if (result.kind !== 'fresh') throw new Error(`${symbol} ${ts} is not fresh`);
  const s = result.snapshot;
  const r4 = (x: number | null) => (x == null ? null : roundNumeric(x, 4));
  return [s.price, r4(s.change1hPct), r4(s.changeDayPct), r4(s.volumeRatio)];
}

async function snapshotRow(
  symbol: Root,
  ts: string,
  v: SnapshotValuesTuple,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO futures_snapshots
       (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [getETDateStr(new Date(ts)), ts, symbol, ...v],
  );
  return rows[0]!.id;
}

const CONTROL_DAYS = ['2026-11-03', '2026-11-04', '2026-11-05'];
const ROOT_PRICE: Record<Root, number> = { GC: 3000, CL: 70 };
interface ControlRow {
  symbol: Root;
  ts: string;
  values: SnapshotValuesTuple;
}
const controlRows: ControlRow[] = [];

/** Bars 13:00Z to 21:30Z for 11-02 and each control day (EST). */
async function controlBars(): Promise<void> {
  const rows: [string, string, number, number][] = [];
  for (const [d, date] of ['2026-11-02', ...CONTROL_DAYS].entries()) {
    for (const symbol of ['GC', 'CL'] as const) {
      for (let m = 0; m <= 510; m += 5) {
        const ts = new Date(Date.parse(`${date}T13:00:00Z`) + m * 60_000);
        rows.push([
          symbol,
          ts.toISOString(),
          ROOT_PRICE[symbol] + ((m * 7 + d * 3) % 23) - 11,
          50 + (m % 17),
        ]);
      }
    }
  }
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     SELECT s, t, c, c, c, c, v FROM unnest($1::text[], $2::timestamptz[], $3::numeric[], $4::bigint[]) AS x(s, t, c, v)`,
    [
      rows.map((r) => r[0]),
      rows.map((r) => r[1]),
      rows.map((r) => r[2]),
      rows.map((r) => r[3]),
    ],
  );
}

interface Ids {
  /** GC 07-29: before the cutoff, a stored ratio, nothing else wrong. */
  g1: number;
  /** GC 07-30: a fill day, frozen on the 07-29 bar; stored ratio. */
  g1b: number;
  /** GC 07-31: before the cutoff, no stored ratio, and a fill in its window that would change it. */
  g2: number;
  /** GC 07-31 20:00: before the cutoff, stored ratio, no recompute (stale), only its ratio is affected. */
  g4: number;
  /** GC 08-03: a fill day with its own change (price, 1h, day) and no stored ratio, before the cutoff. */
  g5: number;
  /** GC 08-18: after the cutoff; a fill in its window changes its ratio. */
  g3: number;
  /** CL 08-03: before the cutoff, a stored ratio. */
  c1: number;
  /** CL 08-04: before the cutoff, no stored ratio. */
  c2: number;
  /** CL 08-12: after the cutoff; a rewritten volume in its window changes its ratio. */
  c3: number;
  /** CL 08-06 15:00: stale, priced from a bar Phase 6 deleted (a junk-delete candidate), before the cutoff, with a stored ratio. */
  j1: number;
  /** CL 08-07 15:00: stale, a deleted bar after its latest bar (price, 1h and day affected, not junk), with a stored ratio. */
  s5: number;
}
let ids: Ids;

async function reset(): Promise<void> {
  await pg.query(
    `TRUNCATE futures_bars, futures_snapshots, touch_log RESTART IDENTITY`,
  );
  entries = [];

  // ── The bars as Phase 6 found them ──
  await snapshotDay('GC', '2026-07-29', '2026-07-28', 3000, 3003);
  // 07-30: the day has no bar of its own; Phase 6 fills it. The 07-29 close is the last bar before.
  await bar('GC', '2026-07-29T15:00:00Z', { close: 2990, volume: 500 });
  filled('GC', '2026-07-30T13:30:00Z', { close: 3000, volume: 50 });
  filled('GC', '2026-07-30T13:31:00Z', { close: 3000, volume: 50 });
  filled('GC', '2026-07-30T14:30:00Z', { close: 3010, volume: 50 });
  await snapshotDay('GC', '2026-07-31', '2026-07-30', 3000, 3003);
  // 08-03: another fill day, so a row there has its own change and (below) no stored ratio.
  await bar('GC', '2026-08-02T15:00:00Z', { close: 2990, volume: 500 });
  filled('GC', '2026-08-03T13:30:00Z', { close: 3000, volume: 50 });
  filled('GC', '2026-08-03T13:31:00Z', { close: 3000, volume: 50 });
  filled('GC', '2026-08-03T14:30:00Z', { close: 3010, volume: 50 });
  await snapshotDay('GC', '2026-08-18', '2026-08-17', 3000, 3003);
  await snapshotDay('CL', '2026-08-03', '2026-07-31', 70, 70.1);
  await snapshotDay('CL', '2026-08-04', '2026-08-03', 70, 70.1);
  // CL 08-12: the 13:31 bar's volume was 50 and Phase 6 rewrote it to 40.
  await bar('CL', '2026-08-11T15:00:00Z', { close: 60, volume: 500 });
  await bar('CL', '2026-08-12T13:30:00Z', { close: 70, volume: 50 });
  await rewritten(
    'CL',
    '2026-08-12T13:31:00Z',
    { close: 70, volume: 50 },
    { close: 70, volume: 40 },
  );
  await bar('CL', '2026-08-12T14:30:00Z', { close: 70.1, volume: 50 });
  // Two bars Phase 6 deleted, 08-06 14:55 (a junk bar, 85.33) and 08-07 14:57 (a bar at 90).
  // No bar of the root is within 15 minutes of the rows below, so their recompute is stale.
  await deleted('CL', '2026-08-06T14:55:00Z', { close: 85.33, volume: 1 });
  await deleted('CL', '2026-08-07T14:57:00Z', { close: 90, volume: 1 });
  await controlBars();

  // ── What the writers saved from them ──
  const withRatio = (v: SnapshotValuesTuple, ratio: number | null) =>
    [v[0], v[1], v[2], ratio] as SnapshotValuesTuple;
  const g1 = await snapshotRow(
    'GC',
    '2026-07-29T14:31:30Z',
    withRatio(await savedFromBars('GC', '2026-07-29T14:31:30Z'), 9.99),
  );
  const g1b = await snapshotRow('GC', '2026-07-30T14:31:30Z', [
    2990,
    null,
    null,
    9.99,
  ]);
  const g2 = await snapshotRow(
    'GC',
    '2026-07-31T14:31:30Z',
    withRatio(await savedFromBars('GC', '2026-07-31T14:31:30Z'), null),
  );
  const g4 = await snapshotRow(
    'GC',
    '2026-07-31T20:00:00Z',
    [3003, 0.1, 0.1, 5],
  );
  const g5 = await snapshotRow('GC', '2026-08-03T14:31:30Z', [
    2990,
    null,
    null,
    null,
  ]);
  const g3 = await snapshotRow(
    'GC',
    '2026-08-18T14:31:30Z',
    await savedFromBars('GC', '2026-08-18T14:31:30Z'),
  );
  const c1 = await snapshotRow(
    'CL',
    '2026-08-03T14:31:30Z',
    withRatio(await savedFromBars('CL', '2026-08-03T14:31:30Z'), 8.88),
  );
  const c2 = await snapshotRow(
    'CL',
    '2026-08-04T14:31:30Z',
    withRatio(await savedFromBars('CL', '2026-08-04T14:31:30Z'), null),
  );
  const c3 = await snapshotRow(
    'CL',
    '2026-08-12T14:31:30Z',
    await savedFromBars('CL', '2026-08-12T14:31:30Z'),
  );
  const j1 = await snapshotRow(
    'CL',
    '2026-08-06T15:00:00Z',
    [85.33, 0.5, 0.5, 6.66],
  );
  const s5 = await snapshotRow(
    'CL',
    '2026-08-07T15:00:00Z',
    [70.5, 0.1, 0.1, 4.44],
  );

  // The clean era: the rows the cron wrote on 11-03 to 11-05, long after the cutoffs.
  if (controlRows.length === 0) {
    for (const symbol of ['GC', 'CL'] as const) {
      for (const date of CONTROL_DAYS) {
        for (let m = 15 * 60 + 31; m <= 21 * 60 + 26; m += 5) {
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(m % 60).padStart(2, '0');
          const ts = `${date}T${hh}:${mm}:21.500Z`;
          controlRows.push({
            symbol,
            ts,
            values: await savedFromBars(symbol, ts),
          });
        }
      }
    }
  }
  await pg.query(
    `INSERT INTO futures_snapshots (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     SELECT d, t, s, p, a, b, c FROM unnest($1::date[], $2::timestamptz[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[]) AS x(d, t, s, p, a, b, c)`,
    [
      controlRows.map((r) => getETDateStr(new Date(r.ts))),
      controlRows.map((r) => r.ts),
      controlRows.map((r) => r.symbol),
      controlRows.map((r) => r.values[0]),
      controlRows.map((r) => r.values[1]),
      controlRows.map((r) => r.values[2]),
      controlRows.map((r) => r.values[3]),
    ],
  );

  // ── Phase 6 ──
  await applyRepair();
  writeBackupFile();

  ids = { g1, g1b, g2, g4, g5, g3, c1, c2, c3, j1, s5 };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: true,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'],
    roots: ['GC', 'CL'],
    repair: 'front-month',
    frozen: false,
    volumeNull: false,
    backup: backupPath,
    expectSnapshots: 9,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    nullVolumeRatio: false,
    expectVolumeNulls: null,
    detectorDays: null,
    ...over,
  };
}
const run = (over: Partial<RecomputeOptions> = {}) =>
  runRecompute(options(over));
const dry = (over: Partial<RecomputeOptions> = {}) =>
  run({ apply: false, expectSnapshots: null, ...over });

const errored = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
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
const planLines = (): {
  step: string;
  id: number;
  fields?: string[];
  to: Record<string, unknown>;
}[] =>
  readFileSync(join(workDir, backups()[0]!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const pointer = (): { frontMonth?: unknown } =>
  JSON.parse(readFileSync(join(workDir, 'plan.json'), 'utf8'));

async function snapshotValues(id: number): Promise<(string | null)[]> {
  const { rows } = await pg.query<Record<string, string | null>>(
    `SELECT price::text, change_1h_pct::text AS c1, change_day_pct::text AS cd,
            volume_ratio::text AS vr FROM futures_snapshots WHERE id = $1`,
    [id],
  );
  const r = rows[0]!;
  return [r.price ?? null, r.c1 ?? null, r.cd ?? null, r.vr ?? null];
}

/** What computeSnapshot says now, at the column scale, as the text the column holds. */
async function recomputed(
  symbol: Root,
  ts: string,
): Promise<(string | null)[]> {
  const v = await savedFromBars(symbol, ts);
  return v.map((x) => (x == null ? null : x.toFixed(4)));
}

async function touches(): Promise<number[]> {
  const { rows } = await pg.query<{ id: string }>(
    `SELECT id::text AS id FROM touch_log WHERE tbl = 'futures_snapshots'`,
  );
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

beforeEach(async () => {
  // A Saturday, so the --apply market-hours guard does not depend on when the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'front-month-blank-pglite-'));
  workDir = join(dir, 'work');
  backupPath = join(dir, 'phase6-backup.jsonl');
  hooks.writes = 0;
  hooks.beforeWrite = null;
  hooks.failWriteAt = null;
  hooks.runId = 'fixture-run';
  await reset();
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const PREFIX =
  'volume ratio set to NULL (20-day base holds unrebuildable July bars):';

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('the GC and CL volume ratios set to NULL, in the dry run', () => {
  it('counts the rows per root and says what the rule is, and plans the other fields as before', async () => {
    expect(await dry()).toBe(0);
    expect(hooks.writes).toBe(0);
    expect(neonConfig.fetchFunction).toBeUndefined();
    const text = report();

    // The rule, named once in the header.
    expect(text).toContain(
      'volume ratio is set to NULL where its 20-day base holds bars that cannot be rebuilt (owner decision 2026-11-13): GC bars before 2026-07-28T00:00:00Z, so rows before 2026-08-17T00:00:00Z; CL bars 2026-07-17T00:00:00Z to 2026-07-22T00:00:00Z (end exclusive), so rows before 2026-08-11T00:00:00Z',
    );
    // Per root: rows with a stored ratio of the rows in scope before the cutoff, and the total.
    expect(text).toContain(`${PREFIX} GC 3 of 5 rows before 2026-08-17`);
    expect(text).toContain(`${PREFIX} CL 3 of 4 rows before 2026-08-11`);
    expect(text).toContain(`${PREFIX} all roots 6 of 9 rows`);
    // They are rows to write, one UPDATE each. GC 5: the fill day, the fill day with no stored ratio
    // (its price, 1h and day only), the two that only lose their ratio and the row after the cutoff
    // that takes its new one. CL 4: three that only lose their ratio and the row after the cutoff.
    expect(text).toContain('rows in range: 443, rows to write: 9');
    expect(text).toContain(
      'GC: rows in range 222, rows to write 5 (price=2 change1hPct=2 changeDayPct=2 volumeRatio=4)',
    );
    expect(text).toContain(
      'CL: rows in range 221, rows to write 4 (price=0 change1hPct=0 changeDayPct=0 volumeRatio=4)',
    );
    // The day split stays a partition, with the ratios that go to NULL shown inside it.
    expect(text).toContain(
      '    GC  repaired days: 2 to write of 2 (price 2, 1h 2, day 2, ratio 1 (to NULL 1)) | window-only: 3 to write of 220 (price 0, 1h 0, day 0, ratio 3 (to NULL 2))',
    );
    expect(text).toContain(
      '    CL  repaired days: 3 to write of 3 (price 0, 1h 0, day 0, ratio 3 (to NULL 2)) | window-only: 1 to write of 218 (price 0, 1h 0, day 0, ratio 1 (to NULL 1))',
    );
    expect(text).toContain(
      '    all roots  repaired days: 5 to write of 5 (price 2, 1h 2, day 2, ratio 4 (to NULL 3)) | window-only: 4 to write of 438 (price 0, 1h 0, day 0, ratio 4 (to NULL 3))',
    );
    // A row that is both written (its ratio goes to NULL) and in the junk-delete plan is one row,
    // not two: the line subtracts the overlap and says so. The apply runs 9 UPDATEs, and
    // --expect-snapshots 9 counts every one, the junk row's included.
    expect(text).toContain(
      '  rows touched, GC: normal step only 5, stale step only 0, both 0, junk delete 0; distinct rows 5 (5 + 0 + 0 - 0)',
    );
    expect(text).toContain(
      '  rows touched, CL: normal step only 4, stale step only 0, both 0, junk delete 1 (1 also written by the normal step); distinct rows 4 (4 + 0 + 1 - 0 - 1 junk overlap)',
    );
    expect(text).toContain(
      '  rows touched, all roots: normal step only 9, stale step only 0, both 0, junk delete 1 (1 also written by the normal step); distinct rows 9 (9 + 0 + 1 - 0 - 1 junk overlap)',
    );
    // A stale row whose ratio is written is not left alone for the ratio. GC 07-31 20:00 has nothing else
    // affected, so it is counted where its write is. CL 08-07 keeps the fields it does not write.
    expect(text).toContain(
      '    left alone, stale or missing recompute (the rows in the junk plan are not counted here): 0 with an affected field, 0 with none',
    );
    expect(text).toContain(
      '      stale or missing recompute whose only write is the NULL ratio (counted in rows to write, not left alone): 1',
    );
    expect(text).toContain(
      '      the 1 with an affected field (kept as stored): stale 1, missing 0; by affected field price=1 change1hPct=1 changeDayPct=1 volumeRatio=0;',
    );
    expect(text).toContain('rows left alone (cannot be recomputed): 1');
    expect(text).toContain('[affected: change1hPct, changeDayPct, price]');
    expect(text).not.toContain('[affected: volumeRatio]');
    expect(text).not.toMatch(/\[affected: [^\]]*volumeRatio/);
    // A row blanked for its ratio is not drift: nothing is reported twice, in either root.
    const lines = text.split('\n');
    for (const root of ['GC', 'CL']) {
      const at = lines.findIndex((l) =>
        l.startsWith(`  ${root}: rows in range`),
      );
      const drift = lines
        .slice(at)
        .find((l) => l.includes('information, unaffected fields'));
      expect(drift).toMatch(
        /: price=0 change1hPct=0 changeDayPct=0 volumeRatio=0$/,
      );
    }
    expect(text).toContain('drift, GC, every row in the snapshot scope');
    // The control is the clean era, long after the cutoffs: it is as it was.
    expect(text).toMatch(/control set matches[^\n]*: 432 of 432 \(100\.0%\)/);
    expect(text).toContain('Apply gate: every check passes.');
    expect(text).toContain(
      '--expect-snapshots 9 --delete-junk-stale --expect-junk-deletes 1',
    );
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('the GC and CL volume ratios set to NULL, on real SQL (pglite)', () => {
  it('writes NULL where the ratio is stored, leaves the others, backs it up first, and a second dry run plans nothing', async () => {
    const before = {
      g2: await snapshotValues(ids.g2),
      c2: await snapshotValues(ids.c2),
      g1: await snapshotValues(ids.g1),
      c1: await snapshotValues(ids.c1),
      g4: await snapshotValues(ids.g4),
      g5: await snapshotValues(ids.g5),
      s5: await snapshotValues(ids.s5),
    };
    let backupAtFirstWrite = -1;
    hooks.beforeWrite = () => {
      if (backupAtFirstWrite < 0) backupAtFirstWrite = backups().length;
    };
    expect(await run({ deleteJunkStale: true, expectJunkDeletes: 1 })).toBe(0);
    // The backup, with the rows to blank as they are now, is on disk before the first write.
    expect(backupAtFirstWrite).toBe(1);

    // GC 07-29: only the ratio changes, to NULL, though the repair never touched the row.
    expect(await snapshotValues(ids.g1)).toEqual([
      ...before.g1.slice(0, 3),
      null,
    ]);
    // GC 07-30, the fill day: price, 1h and day follow the filled bars as before, the ratio is NULL
    // and not the number the recompute gives.
    expect(await snapshotValues(ids.g1b)).toEqual([
      '3010.0000',
      '0.3333',
      '0.3333',
      null,
    ]);
    expect((await recomputed('GC', '2026-07-30T14:31:30Z'))[3]).not.toBeNull();
    // GC 07-31: no stored ratio, and a fill in its window would have given it one: it stays NULL, unwritten.
    expect(await snapshotValues(ids.g2)).toEqual(before.g2);
    expect(before.g2[3]).toBeNull();
    // GC 07-31 20:00, no recompute (stale): the ratio still goes to NULL.
    expect(await snapshotValues(ids.g4)).toEqual([
      ...before.g4.slice(0, 3),
      null,
    ]);
    // GC 08-03, a fill day with its own change and no stored ratio: price, 1h and day are written,
    // the ratio stays NULL (the number the recompute gives is not written), and it is one row.
    expect(await snapshotValues(ids.g5)).toEqual([
      '3010.0000',
      '0.3333',
      '0.3333',
      null,
    ]);
    expect(before.g5).toEqual(['2990.0000', null, null, null]);
    expect((await recomputed('GC', '2026-08-03T14:31:30Z'))[3]).not.toBeNull();
    // GC 08-18, after the cutoff: the normal plan, a new ratio.
    const g3 = await snapshotValues(ids.g3);
    expect(g3[3]).not.toBeNull();
    expect(g3).toEqual(await recomputed('GC', '2026-08-18T14:31:30Z'));
    // CL: the same, before and after its cutoff.
    expect(await snapshotValues(ids.c1)).toEqual([
      ...before.c1.slice(0, 3),
      null,
    ]);
    expect(await snapshotValues(ids.c2)).toEqual(before.c2);
    const c3 = await snapshotValues(ids.c3);
    expect(c3[3]).not.toBeNull();
    expect(c3).toEqual(await recomputed('CL', '2026-08-12T14:31:30Z'));
    // CL 08-07: stale, with a deleted bar after its latest one: its ratio goes to NULL, the fields it
    // cannot recompute stay as stored.
    expect(await snapshotValues(ids.s5)).toEqual([
      ...before.s5.slice(0, 3),
      null,
    ]);
    // CL 08-06: priced from the deleted junk bar. Its ratio went to NULL (one UPDATE, counted in the
    // 9) and the opt-in junk delete then removed the row.
    const { rows: j1Left } = await pg.query(
      `SELECT 1 FROM futures_snapshots WHERE id = $1`,
      [ids.j1],
    );
    expect(j1Left).toHaveLength(0);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);

    // Exactly the nine planned rows were written, and no control row.
    expect(await touches()).toEqual(
      [
        ids.g1,
        ids.g1b,
        ids.g5,
        ids.g4,
        ids.g3,
        ids.c1,
        ids.j1,
        ids.s5,
        ids.c3,
      ].sort((a, b) => a - b),
    );

    // The plan file, which the apply read back: the NULL is a planned value like any other.
    const lines = planLines();
    const line = (id: number) =>
      lines.find((l) => l.id === id && l.step === 'snapshots');
    expect(line(ids.g5)?.fields).toEqual([
      'price',
      'change1hPct',
      'changeDayPct',
    ]);
    expect(line(ids.g5)?.to).not.toHaveProperty('volumeRatio');
    expect(line(ids.s5)?.fields).toEqual(['volumeRatio']);
    expect(line(ids.s5)?.to).toEqual({ volumeRatio: null });
    expect(line(ids.j1)?.to).toEqual({ volumeRatio: null });
    expect(lines.filter((l) => l.step === 'junk').map((l) => l.id)).toEqual([
      ids.j1,
    ]);
    expect(line(ids.g1)?.fields).toEqual(['volumeRatio']);
    expect(line(ids.g1)?.to).toEqual({ volumeRatio: null });
    expect(line(ids.g4)?.to).toEqual({ volumeRatio: null });
    expect(line(ids.g1b)?.fields).toEqual([
      'price',
      'change1hPct',
      'changeDayPct',
      'volumeRatio',
    ]);
    expect(line(ids.g1b)?.to).toMatchObject({
      price: 3010,
      volumeRatio: null,
    });
    expect(line(ids.g2)).toBeUndefined();
    expect(line(ids.c2)).toBeUndefined();
    expect(line(ids.g3)?.to.volumeRatio).not.toBeNull();
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);

    // plan.json: the counts per root and kind of day, and the rows set to NULL.
    const group = (
      inScope: number,
      toWrite: number,
      price: number,
      change1h: number,
      changeDay: number,
      volumeRatio: number,
      volumeRatioToNull: number,
    ) => ({
      inScope,
      toWrite,
      price,
      change1h,
      changeDay,
      volumeRatio,
      volumeRatioToNull,
    });
    expect(pointer().frontMonth).toEqual({
      snapshotRows: {
        byRoot: {
          GC: {
            repairedDays: group(2, 2, 2, 2, 2, 1, 1),
            windowOnly: group(220, 3, 0, 0, 0, 3, 2),
          },
          CL: {
            repairedDays: group(3, 3, 0, 0, 0, 3, 2),
            windowOnly: group(218, 1, 0, 0, 0, 1, 1),
          },
        },
        all: {
          repairedDays: group(5, 5, 2, 2, 2, 4, 3),
          windowOnly: group(438, 4, 0, 0, 0, 4, 3),
        },
      },
      volumeRatioNull: {
        byRoot: {
          GC: { inScope: 5, toNull: 3, before: '2026-08-17T00:00:00.000Z' },
          CL: { inScope: 4, toNull: 3, before: '2026-08-11T00:00:00.000Z' },
        },
        all: { inScope: 9, toNull: 6 },
      },
    });

    // A second dry run: every ratio that goes to NULL is NULL, so no row is left to write for it,
    // and the junk row is gone.
    expect(await dry()).toBe(0);
    const again = report();
    expect(again).toContain('rows in range: 442, rows to write: 0');
    expect(again).toContain(`${PREFIX} GC 0 of 5 rows before 2026-08-17`);
    expect(again).toContain(`${PREFIX} CL 0 of 3 rows before 2026-08-11`);
    expect(again).toContain('--expect-snapshots 0');
  });

  it('compares the stored ratio before it writes a NULL: a row changed since the plan stops the step, a row already NULL is done', async () => {
    hooks.failWriteAt = { nth: 1, error: new Error('connection lost') };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: snapshots: connection lost/);
    expect(existsSync(join(workDir, 'snapshots.started'))).toBe(true);
    hooks.failWriteAt = null;
    const writes = hooks.writes;

    // The planned old value was 9.99 and the new one is NULL: 7.77 is neither.
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 7.77 WHERE id = $1`,
      [ids.g1],
    );
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /1 of 9 row\(s\) hold neither the planned old value nor the new one, so snapshots is not written/,
    );
    expect(errored()).toMatch(
      /volume_ratio holds 7\.77, planned 9\.99 to null/,
    );
    expect(hooks.writes).toBe(writes);
    expect((await snapshotValues(ids.g1))[3]).toBe('7.7700');

    // A row that already holds the new value, NULL, is a row an earlier run finished.
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = NULL WHERE id = $1`,
      [ids.g1],
    );
    expect(await run()).toBe(0);
    expect((await snapshotValues(ids.g1))[3]).toBeNull();
    expect((await snapshotValues(ids.g1b))[3]).toBeNull();
    expect((await snapshotValues(ids.c1))[3]).toBeNull();
  });
});
