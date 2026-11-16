// @vitest-environment node

/**
 * REAL-SQL test for the two rules `--repair front-month` applies to the rows before the
 * snapshot scope (Phase 6b of docs/superpowers/specs/2026-11-06-futures-session-front-month.md,
 * owner decision 2026-11-15, "fix the clearly wrong"):
 *
 *  1. A GC row of the before-scope band whose price bar (the latest bar at or before the row
 *     less 60 s) is older than MAX_BAR_AGE_MS is deleted, through the junk-delete step.
 *  2. A CL row whose day change reads the cash-open bar of the old contract (CLQ6) for a price
 *     bar of the new one (CLU6) has its day change set to NULL, nothing else; the rows whose
 *     1h change spans the switch are counted and not written.
 *
 * The world has GC and CL only, so premarket and fires (ES only) plan nothing. The profile
 * module is mocked for its backup pins (a fixture run id and totals); the span, the end of the
 * write run, the contaminated ranges and the two rules are the real ones. getDb() emulates
 * production as in futures-derived-front-month-blank-pglite.test.ts.
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

// ── The changes Phase 6 made: one deleted bar, behind the in-scope junk row ──

const full = (ts: string): string => new Date(ts).toISOString();

function barRow(ts: string, close: number, volume: number) {
  return {
    ts: full(ts),
    open: close.toFixed(4),
    high: close.toFixed(4),
    low: close.toFixed(4),
    close: close.toFixed(4),
    volume,
    buyVolume: null,
    sellVolume: null,
    buyPrints: null,
    sellPrints: null,
    contract: null,
  };
}

async function bar(
  symbol: Root,
  ts: string,
  close: number,
  volume = 50,
): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, $4)`,
    [symbol, ts, close, volume],
  );
}

const JUNK_BAR = { ts: '2026-08-06T14:55:00Z', close: 85.33 };

function writeBackupFile(): void {
  hooks.totals = { rewrite: 0, delete: 1, fill: 0, tag: 0 };
  writeFileSync(
    backupPath,
    `${JSON.stringify({
      runId: hooks.runId,
      action: 'delete',
      symbol: 'CL',
      row: barRow(JUNK_BAR.ts, JUNK_BAR.close, 1),
    })}\n`,
  );
}

// ── Fixture ─────────────────────────────────────────────────────────────────

type Values = [number, number | null, number | null, number | null];

async function savedFromBars(symbol: Root, ts: string): Promise<Values> {
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
  v: Values,
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
  values: Values;
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
  /** GC 06-15 14:12:00, the first minute of the band: no bar of the root before it. */
  ga: number;
  /** GC 06-20 14:05:30: the bar of 14:00 is 5.5 min old. */
  gb: number;
  /** GC 06-20 16:00:00: the same bar, 120 min old, and the stored price is its close. */
  gc: number;
  /** GC 07-10 15:15:00.000: the bar of 15:00 is exactly 15 min old. */
  gd: number;
  /** GC 07-10 15:15:00.001: 15 min and 1 ms old; the stored price is not the bar's close. */
  ge: number;
  /** CL 07-20 15:00:30: a bar 180 min old, and CL is not a root the delete applies to. */
  cg: number;
  /** CL 07-21 21:59:00: priced from the last CLQ6 bar. */
  ca: number;
  /** CL 07-21 22:00:30: after the switch, but the first CLU6 bar (22:00) has not closed: priced from the last CLQ6 bar. */
  cx: number;
  /** CL 07-21 22:01:30: priced from the first CLU6 bar, its day open and its 1h base are CLQ6. */
  cb: number;
  /** CL 07-22 02:00:30: the evening of ET date 07-21, no stored ratio. */
  cc: number;
  /** CL 07-21 22:03:30: the same bars as cb, but its day change, 1h change and ratio are NULL already. */
  cd: number;
  /** CL 07-22 14:00:30: ET date 07-22, whose cash open is CLU6. */
  ce: number;
  /** CL 08-06 15:00: in scope, stale, priced from the bar Phase 6 deleted: the junk delete's own row. */
  j1: number;
}
let ids: Ids;

async function reset(): Promise<void> {
  await pg.query(
    `TRUNCATE futures_bars, futures_snapshots, touch_log RESTART IDENTITY`,
  );

  // GC: the old series held a bar at 06-20 14:00 and one at 07-10 15:00 and little else.
  await bar('GC', '2026-06-20T14:00:00Z', 2000);
  await bar('GC', '2026-07-10T15:00:00Z', 2100);
  // CL: the last CLQ6 bar before the switch (20:59, 70.2) and the first CLU6 bar (22:00, 71).
  await bar('CL', '2026-07-20T12:00:00Z', 69.5);
  await bar('CL', '2026-07-21T13:30:00Z', 70);
  await bar('CL', '2026-07-21T20:59:00Z', 70.2);
  await bar('CL', '2026-07-21T22:00:00Z', 71);
  await bar('CL', '2026-07-22T01:00:00Z', 71.1);
  await bar('CL', '2026-07-22T01:59:00Z', 71.3);
  await bar('CL', '2026-07-22T13:30:00Z', 71.4);
  await bar('CL', '2026-07-22T13:59:00Z', 71.45);
  // The bar Phase 6 deleted (stored before it, gone after).
  await bar('CL', JUNK_BAR.ts, JUNK_BAR.close, 1);
  await controlBars();

  const band = {
    ga: await snapshotRow('GC', '2026-06-15T14:12:00Z', [2000, 0.1, 0.1, 9.1]),
    gb: await snapshotRow('GC', '2026-06-20T14:05:30Z', [2000, 0.1, 0.1, 9.2]),
    gc: await snapshotRow('GC', '2026-06-20T16:00:00Z', [2000, 0.1, 0.1, 9.3]),
    gd: await snapshotRow(
      'GC',
      '2026-07-10T15:15:00.000Z',
      [2100, 0.1, 0.1, 9.4],
    ),
    ge: await snapshotRow(
      'GC',
      '2026-07-10T15:15:00.001Z',
      [2099, 0.1, 0.1, 9.5],
    ),
    cg: await snapshotRow('CL', '2026-07-20T15:00:30Z', [69.5, 0.2, 0.2, 8.1]),
    ca: await snapshotRow('CL', '2026-07-21T21:59:00Z', [70.2, 0.3, 0.3, 8.2]),
    cx: await snapshotRow('CL', '2026-07-21T22:00:30Z', [70.2, 0.3, 0.9, 8.6]),
    cb: await snapshotRow('CL', '2026-07-21T22:01:30Z', [71, 0.4, 1.43, 8.3]),
    cc: await snapshotRow('CL', '2026-07-22T02:00:30Z', [71.3, 0.5, 1.7, null]),
    cd: await snapshotRow('CL', '2026-07-21T22:03:30Z', [71, null, null, null]),
    ce: await snapshotRow('CL', '2026-07-22T14:00:30Z', [71.45, 0.1, 0.5, 8.5]),
  };
  const j1 = await snapshotRow('CL', '2026-08-06T15:00:00Z', [
    JUNK_BAR.close,
    0.5,
    0.5,
    null,
  ]);

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

  // Phase 6: it deleted the bar behind j1.
  await pg.query(`DELETE FROM futures_bars WHERE symbol = 'CL' AND ts = $1`, [
    JUNK_BAR.ts,
  ]);
  writeBackupFile();

  ids = { ...band, j1 };
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
    deleteJunkStale: true,
    expectJunkDeletes: 3,
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
  run({
    apply: false,
    expectSnapshots: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    ...over,
  });

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
interface PlanLine {
  step: string;
  id: number;
  fields?: string[];
  to: Record<string, unknown> | null;
  op?: string;
  row: Record<string, unknown>;
}
const planLines = (): PlanLine[] =>
  readFileSync(join(workDir, backups()[0]!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const pointer = (): { frontMonth?: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(workDir, 'plan.json'), 'utf8'));

async function snapshotValues(id: number): Promise<(string | null)[]> {
  const { rows } = await pg.query<Record<string, string | null>>(
    `SELECT price::text, change_1h_pct::text AS c1, change_day_pct::text AS cd,
            volume_ratio::text AS vr FROM futures_snapshots WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r == null
    ? []
    : [r.price ?? null, r.c1 ?? null, r.cd ?? null, r.vr ?? null];
}

const exists = async (id: number): Promise<boolean> =>
  (await snapshotValues(id)).length > 0;

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
  dir = mkdtempSync(join(tmpdir(), 'front-month-july-pglite-'));
  workDir = join(dir, 'work');
  backupPath = join(dir, 'phase6-backup.jsonl');
  hooks.writes = 0;
  hooks.failWriteAt = null;
  hooks.runId = 'fixture-run';
  await reset();
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const STALE =
  'deleted before the snapshot scope (price bar older than 15 min):';
const SWITCH =
  'day change set to NULL across the CLQ6/CLU6 switch (rows priced from a bar at or after 2026-07-21T22:00:00Z whose cash open is before it):';
const BAND =
  'volume ratio set to NULL before the snapshot scope (blank only, 20-day base holds unrebuildable bars):';

// ── The world is what the tests say it is ───────────────────────────────────

describe('the fixture agrees with computeSnapshot on the freshness edge', () => {
  it('a bar exactly 15 min old is fresh and 1 ms older is stale', async () => {
    const at = (ts: string) => new Date(ts);
    const fresh = await computeSnapshot(
      'GC',
      '2026-07-10',
      at('2026-07-10T15:15:00.000Z'),
    );
    const stale = await computeSnapshot(
      'GC',
      '2026-07-10',
      at('2026-07-10T15:15:00.001Z'),
    );
    expect(fresh.kind).toBe('fresh');
    expect(stale.kind).toBe('stale');
  });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('the rules for the wrong July values, in the dry run', () => {
  it('names both rules in the header and counts the deletes and the NULL day changes per root', async () => {
    expect(await dry()).toBe(0);
    expect(hooks.writes).toBe(0);
    expect(neonConfig.fetchFunction).toBeUndefined();
    const text = report();

    expect(text).toContain(
      'before-scope rules (owner decision 2026-11-15): GC rows of the before-scope band priced from a bar older than 15 min are deleted by the junk-delete step (--delete-junk-stale); CL day change is set to NULL where the cash-open bar it reads is before the CLQ6/CLU6 switch at 2026-07-21T22:00:00Z and the price bar is from it',
    );

    // The ratio line counts the rows that stay: N can never include a deleted row, so M does not
    // either. GC has 5 band rows and 2 are deleted: 3 of 3, with the deleted count named. CL deletes
    // none: its line, and the line of a band with no deletes anywhere, keep their old shape.
    expect(text).toContain(
      `${BAND} GC 3 of 3 rows from 2026-06-15T14:12:00Z to 2026-07-28T00:00:00Z; 2 more are deleted, see below`,
    );
    expect(text).toContain(
      `${BAND} CL 5 of 7 rows from 2026-07-17T00:01:00Z to 2026-07-28T00:00:00Z\n`,
    );
    expect(text).toContain(
      `${BAND} all roots 8 of 10 rows; 2 more are deleted, see below`,
    );

    // Rule 1: gc (120 min) and ge (15 min and 1 ms) of the five GC band rows; ga has no bar before it.
    expect(text).toContain(
      `${STALE} GC 2 of 5 rows from 2026-06-15T14:12:00Z to 2026-07-28T00:00:00Z`,
    );
    expect(text).toContain(
      '    GC: of the 2 rows, 1 repeat the close of their price bar (the frozen-stale delete of 2026-11-12 keeps those) and 1 differ; 1 are over 60 min old',
    );
    expect(text).toContain(
      '    GC: 1 row has no bar before it and stays; price-bar age of the 4 rows with one: median 15 min, oldest 120 min',
    );
    // CL is not a root the delete applies to: its stale row (cg) is not in the line.
    expect(text).not.toContain(`${STALE} CL`);

    // Rule 2: cb, cc and cd read an open before the switch for a price bar from it; cd has no day change.
    expect(text).toContain(`${SWITCH} CL 2 of 3 rows`);
    expect(text).toContain(
      '    CL: 1h change across the switch (counted, not written): 1 rows',
    );
    expect(text).toContain(
      '    CL: the largest jump between consecutive bars within a day of the switch: 70.2 at 2026-07-21T20:59:00Z to 71 at 2026-07-21T22:00:00Z (+0.8, 61 min apart); FRONT_MONTH.contractSwitch is where to move the switch if that jump is elsewhere',
    );

    // Rows to write: GC ga, gb, gd (ratio) and CL cg, ca, cx, ce (ratio), cb (day and ratio), cc (day).
    expect(text).toContain('rows in range: 433, rows to write: 9');
    // The day split is a partition: a deleted row is in the rows of its kind and is not a write.
    expect(text).toContain(
      '    GC  repaired days: 0 to write of 0 (price 0, 1h 0, day 0, ratio 0) | window-only: 0 to write of 216 (price 0, 1h 0, day 0, ratio 0) | before scope, blank only: 3 to write and 2 deleted of 5 (price 0, 1h 0, day 0, ratio 3 (to NULL 3))',
    );
    expect(text).toContain(
      '    CL  repaired days: 0 to write of 1 (price 0, 1h 0, day 0, ratio 0) | window-only: 0 to write of 216 (price 0, 1h 0, day 0, ratio 0) | before scope, blank only: 6 to write of 7 (price 0, 1h 0, day 2, ratio 5 (to NULL 5))',
    );
    // The deleted rows are junk-delete rows: gc, ge and j1, with the apply command's own total.
    expect(text).toContain(
      '  rows planned, GC: normal step 3 rows, stale-at-write 0 rows (0 added by the D1 lift), junk delete 2 rows',
    );
    expect(text).toContain(
      '--expect-snapshots 9 --delete-junk-stale --expect-junk-deletes 3',
    );
    expect(text).toContain('Apply gate: every check passes.');
    // The deleted-bar junk section lists only the row priced from a deleted bar.
    expect(text).toContain(
      'stale rows priced from a deleted junk bar (not recomputable; --delete-junk-stale deletes them, off by default): 1',
    );
  });

  it('writes no plan file and no backup in a dry run, and deletes nothing', async () => {
    expect(await dry()).toBe(0);
    expect(existsSync(join(workDir, 'plan.json'))).toBe(false);
    expect(backups()).toEqual([]);
    expect(await exists(ids.gc)).toBe(true);
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('the rules for the wrong July values, on real SQL (pglite)', () => {
  it('deletes the stale GC rows with a full-row backup, NULLs the CL day change across the switch and nothing else, and a second dry run plans nothing', async () => {
    const before = {
      ga: await snapshotValues(ids.ga),
      gb: await snapshotValues(ids.gb),
      gc: await snapshotValues(ids.gc),
      gd: await snapshotValues(ids.gd),
      cg: await snapshotValues(ids.cg),
      ca: await snapshotValues(ids.ca),
      cx: await snapshotValues(ids.cx),
      cb: await snapshotValues(ids.cb),
      cc: await snapshotValues(ids.cc),
      cd: await snapshotValues(ids.cd),
      ce: await snapshotValues(ids.ce),
    };
    expect(await run()).toBe(0);

    // Rule 1: the two stale GC rows are gone, the fresh ones, the exact edge and the no-bar row are not.
    expect(await exists(ids.gc)).toBe(false);
    expect(await exists(ids.ge)).toBe(false);
    for (const id of [ids.ga, ids.gb, ids.gd])
      expect(await exists(id)).toBe(true);
    // A kept GC row: only its ratio goes to NULL (the round-5 rule), price, 1h and day stay.
    for (const [id, key] of [
      [ids.ga, 'ga'],
      [ids.gb, 'gb'],
      [ids.gd, 'gd'],
    ] as const) {
      expect(await snapshotValues(id)).toEqual([
        ...before[key].slice(0, 3),
        null,
      ]);
    }
    // CL is not a root of the delete: its stale row stays, its ratio goes to NULL.
    expect(await snapshotValues(ids.cg)).toEqual([
      ...before.cg.slice(0, 3),
      null,
    ]);
    // The in-scope junk row went through the same step.
    expect(await exists(ids.j1)).toBe(false);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);

    // Rule 2: the day change across the switch is NULL, price and 1h stay, the ratio follows its own rule.
    expect(await snapshotValues(ids.cb)).toEqual([
      '71.0000',
      '0.4000',
      null,
      null,
    ]);
    expect(await snapshotValues(ids.cc)).toEqual([
      '71.3000',
      '0.5000',
      null,
      null,
    ]);
    // Nothing is written to a row whose day change is NULL already.
    expect(await snapshotValues(ids.cd)).toEqual(before.cd);
    // The last CLQ6 print (before the switch), a row after the switch that still reads it (the first
    // CLU6 bar has not closed) and ET date 07-22 (whose open is CLU6) keep their day change.
    expect(await snapshotValues(ids.ca)).toEqual([
      ...before.ca.slice(0, 3),
      null,
    ]);
    expect(await snapshotValues(ids.cx)).toEqual([
      ...before.cx.slice(0, 3),
      null,
    ]);
    expect(await snapshotValues(ids.ce)).toEqual([
      ...before.ce.slice(0, 3),
      null,
    ]);
    expect(before.ca[2]).toBe('0.3000');
    expect(before.cx[2]).toBe('0.9000');
    expect(before.ce[2]).toBe('0.5000');

    // Exactly the nine planned rows were updated, and no control row.
    expect(await touches()).toEqual(
      [
        ids.ga,
        ids.gb,
        ids.gd,
        ids.cg,
        ids.ca,
        ids.cx,
        ids.cb,
        ids.cc,
        ids.ce,
      ].sort((a, b) => a - b),
    );

    // The plan file: the deleted GC rows are junk lines with the whole row, and have no snapshot line.
    const lines = planLines();
    const junk = lines.filter((l) => l.step === 'junk');
    expect(junk.map((l) => l.id).sort((a, b) => a - b)).toEqual(
      [ids.gc, ids.ge, ids.j1].sort((a, b) => a - b),
    );
    for (const l of junk) {
      expect(l.op).toBe('delete');
      expect(l.to).toBeNull();
    }
    const gcLine = junk.find((l) => l.id === ids.gc);
    expect(gcLine?.row).toMatchObject({
      id: ids.gc,
      symbol: 'GC',
      trade_date: '2026-06-20',
      ts: '2026-06-20T16:00:00+00:00',
      price: 2000,
      change_1h_pct: 0.1,
      change_day_pct: 0.1,
      volume_ratio: 9.3,
    });
    expect(
      lines.filter(
        (l) => l.step === 'snapshots' && (l.id === ids.gc || l.id === ids.ge),
      ),
    ).toEqual([]);
    const snapshotLine = (id: number) =>
      lines.find((l) => l.step === 'snapshots' && l.id === id);
    expect(snapshotLine(ids.cb)?.fields).toEqual([
      'changeDayPct',
      'volumeRatio',
    ]);
    expect(snapshotLine(ids.cb)?.to).toEqual({
      changeDayPct: null,
      volumeRatio: null,
    });
    expect(snapshotLine(ids.cc)?.fields).toEqual(['changeDayPct']);
    expect(snapshotLine(ids.cc)?.to).toEqual({ changeDayPct: null });
    expect(snapshotLine(ids.ce)?.fields).toEqual(['volumeRatio']);
    expect(snapshotLine(ids.cd)).toBeUndefined();
    expect(snapshotLine(ids.ge)).toBeUndefined();

    // plan.json: the counts of both rules, and the deleted rows in the day split.
    // The band's row count is the rows that stay (GC 5 less the 2 deleted), as N is: the deleted count
    // is in beforeScopeRules below.
    expect(
      (
        pointer().frontMonth?.volumeRatioNull as {
          beforeScope: { byRoot: Record<string, { rows: number }> };
        }
      ).beforeScope.byRoot,
    ).toMatchObject({ GC: { rows: 3, toNull: 3 }, CL: { rows: 7, toNull: 5 } });
    expect(pointer().frontMonth?.beforeScopeRules).toEqual({
      staleDelete: {
        byRoot: {
          GC: {
            rows: 5,
            deleted: 2,
            repeatsClose: 1,
            over60Min: 1,
            noBar: 1,
            olderThanMin: 15,
          },
        },
        all: { rows: 5, deleted: 2 },
      },
      contractSwitch: {
        byRoot: {
          CL: {
            at: '2026-07-21T22:00:00.000Z',
            rows: 3,
            dayChangeToNull: 2,
            change1hAcross: 1,
          },
        },
        all: { rows: 3, dayChangeToNull: 2 },
      },
    });
    const split = pointer().frontMonth?.snapshotRows as {
      byRoot: Record<string, { beforeScope: Record<string, number> }>;
    };
    expect(split.byRoot.GC?.beforeScope).toMatchObject({
      inScope: 5,
      toWrite: 3,
      deleted: 2,
    });
    expect(split.byRoot.CL?.beforeScope).toMatchObject({
      inScope: 7,
      toWrite: 6,
      deleted: 0,
      changeDay: 2,
      volumeRatio: 5,
    });

    // A second dry run: the deleted rows are gone and every day change across the switch is NULL.
    expect(await dry()).toBe(0);
    const again = report();
    expect(again).toContain('rows in range: 432, rows to write: 0');
    expect(again).toContain(
      `${STALE} GC 0 of 3 rows from 2026-06-15T14:12:00Z to 2026-07-28T00:00:00Z`,
    );
    expect(again).toContain(`${SWITCH} CL 0 of 3 rows`);
    // The deleted rows are gone, so the ratio line has the old shape again: 3 rows stay, none left to blank.
    expect(again).toContain(
      `${BAND} GC 0 of 3 rows from 2026-06-15T14:12:00Z to 2026-07-28T00:00:00Z\n`,
    );
    expect(again).toContain(`${BAND} all roots 0 of 10 rows\n`);
    expect(again).toContain('--expect-snapshots 0');
    // Nothing to delete, so the apply command carries no delete flag.
    expect(again).not.toContain('--expect-junk-deletes');
  });

  it('refuses a junk delete whose count is not the approved one, before any write', async () => {
    expect(await run({ expectJunkDeletes: 2 })).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply\. Nothing was written\./);
    expect(errored()).toContain(
      'the fresh plan deletes 3 junk-priced rows, --expect-junk-deletes 2 was given',
    );
    expect(hooks.writes).toBe(0);
    expect(await exists(ids.gc)).toBe(true);
  });

  it('does not delete a stale row without --delete-junk-stale, and NULLs the day change all the same', async () => {
    expect(await run({ deleteJunkStale: false, expectJunkDeletes: null })).toBe(
      0,
    );
    expect(await exists(ids.gc)).toBe(true);
    expect(await exists(ids.ge)).toBe(true);
    expect(await exists(ids.j1)).toBe(true);
    // The deleted-row candidates got no ratio write either: they wait for the delete.
    expect((await snapshotValues(ids.gc))[3]).toBe('9.3000');
    expect((await snapshotValues(ids.cb))[2]).toBeNull();
  });

  it('refuses a deleted row that changed since the plan, and finishes once it is back', async () => {
    // The snapshot step is written (write 1); the delete step's transaction (write 2) fails.
    hooks.failWriteAt = { nth: 2, error: new Error('connection lost') };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: junk: connection lost/);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    expect(existsSync(join(workDir, 'junk.started'))).toBe(true);
    expect(await exists(ids.gc)).toBe(true);
    hooks.failWriteAt = null;
    const writes = hooks.writes;

    // A hand fix of the price after the plan: the row holds neither the planned price nor is it gone.
    await pg.query(`UPDATE futures_snapshots SET price = 2111 WHERE id = $1`, [
      ids.gc,
    ]);
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /1 of 3 row\(s\) hold neither the planned old value nor the new one, so junk is not written/,
    );
    expect(errored()).toContain(`id ${ids.gc}: price holds 2111, planned 2000`);
    expect(hooks.writes).toBe(writes);
    expect(await exists(ids.gc)).toBe(true);
    expect(await exists(ids.ge)).toBe(true);

    await pg.query(`UPDATE futures_snapshots SET price = 2000 WHERE id = $1`, [
      ids.gc,
    ]);
    expect(await run()).toBe(0);
    expect(await exists(ids.gc)).toBe(false);
    expect(await exists(ids.ge)).toBe(false);
    expect(await exists(ids.j1)).toBe(false);
  });
});
