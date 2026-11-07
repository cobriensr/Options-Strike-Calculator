// @vitest-environment node

/**
 * REAL-SQL test for the Phase 4 recompute: the reads, the shared recompute
 * functions (computeSnapshot, computeEsBasisChange5m, queryGlobex) and the
 * guarded UPDATEs run against pglite (Postgres in WASM), with futures_snapshots
 * and ws_gamma_setup_fires built from the real migrations (#45, #179).
 *
 * getDb() emulates production: a plain query runs in a read-only transaction
 * (what readOnlyFetch makes of it), a transaction honours `readOnly`, and every
 * write is counted. An UPDATE trigger logs each row it touches, so "does not
 * rewrite a row that already holds the value" is observable. The session runs
 * in UTC like Neon, because computeSnapshot groups days with DATE(ts).
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
  /** Every read-only transaction rejects with this error. */
  failRead: null as null | Error,
  /** Write transactions resolve with no rows and run nothing. */
  dropWrites: false,
  /** A plain query runs read-only, as readOnlyFetch makes it; false models a session that can write. */
  plainReadOnly: true,
  writes: 0,
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
                if (hooks.plainReadOnly) {
                  await tx.query('SET TRANSACTION READ ONLY');
                }
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
      });
    },
  };
});

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import {
  markerPath,
  readOnlyFetch,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

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
  await pg.query(`
    CREATE TABLE index_candles_1m (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL DEFAULT 'SPX',
      market_time TEXT NOT NULL DEFAULT 'r',
      timestamp   TIMESTAMPTZ NOT NULL,
      close       NUMERIC(10,2) NOT NULL
    )
  `);
  // market_snapshots is created by initDb, not a migration: the columns the
  // recompute touches, plus two it must leave alone.
  await pg.query(`
    CREATE TABLE market_snapshots (
      id              SERIAL PRIMARY KEY,
      date            DATE NOT NULL,
      entry_time      TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      spx             DECIMAL(10,2),
      notes           TEXT,
      pre_market_data JSONB
    )
  `);
  await applyMigration(pg, 45);
  await applyMigration(pg, 179);
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
  for (const t of [
    'futures_snapshots',
    'market_snapshots',
    'ws_gamma_setup_fires',
  ]) {
    await pg.query(
      `CREATE TRIGGER ${t}_touch AFTER UPDATE ON ${t}
         FOR EACH ROW EXECUTE FUNCTION log_touch()`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pg.close();
});

// ── Fixture ─────────────────────────────────────────────────────────────────

async function bar(
  symbol: string,
  ts: string,
  close: number,
  volume: number,
  hl: [number, number] = [close, close],
): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [symbol, ts, close, hl[0], hl[1], close, volume],
  );
}

/**
 * One trading day of bars (EDT, so the cash open is 13:30Z): a prior-day bar of
 * volume 1000, the open bar, the hour-ago bar and the latest bar, 100 each. A
 * snapshot at 14:31:30 therefore recomputes to price `now`, a 1h and day change
 * of (now - ref) / ref, and a volume ratio of 300 / avg(1000, 300) = 0.4615.
 */
async function snapshotDay(
  symbol: 'ES' | 'NQ',
  date: string,
  prior: string,
  ref: number,
  now: number,
): Promise<void> {
  await bar(
    symbol,
    `${prior}T15:00:00Z`,
    ref - 10,
    symbol === 'ES' ? 1000 : 500,
  );
  const v = symbol === 'ES' ? 100 : 50;
  await bar(symbol, `${date}T13:30:00Z`, ref, v);
  await bar(symbol, `${date}T13:31:00Z`, ref, v);
  await bar(symbol, `${date}T14:31:00Z`, now, v);
}

async function snapshotRow(
  symbol: string,
  ts: string,
  tradeDate: string,
  v: [number, number | null, number | null, number | null],
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO futures_snapshots
       (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tradeDate, ts, symbol, ...v],
  );
  return rows[0]!.id;
}

async function premarketRow(
  date: string,
  entryTime: string,
  pm: object | null,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO market_snapshots (date, entry_time, spx, notes, pre_market_data)
     VALUES ($1, $2, 5800.5, 'keep', $3::jsonb) RETURNING id`,
    [date, entryTime, pm === null ? null : JSON.stringify(pm)],
  );
  return rows[0]!.id;
}

/** SPX closes for the 6 minutes to `t` (spxThen until t, then spxNow) and ES at t-5 and t. */
async function basisBars(
  t: string,
  spx: [number, number],
  es: [number, number] | null,
): Promise<void> {
  const at = Date.parse(t);
  for (let back = 5; back >= 0; back -= 1) {
    await pg.query(
      `INSERT INTO index_candles_1m (timestamp, close) VALUES ($1, $2)`,
      [
        new Date(at - back * 60_000).toISOString(),
        back === 0 ? spx[1] : spx[0],
      ],
    );
  }
  if (es != null) {
    await bar('ES', new Date(at - 5 * 60_000).toISOString(), es[0], 1);
    await bar('ES', t, es[1], 1);
  }
}

async function fireRow(
  firedAt: string,
  type: string,
  value: number | null,
): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO ws_gamma_setup_fires
       (fired_at, signal_type, dow_label, confidence_tier, spot_at_fire,
        node_strike, node_gex, bar_open, bar_high, bar_low, bar_close,
        bar_range, es_basis_change_5m)
     VALUES ($1, $2, 'Monday', 'HIGH', 5000, 5000, 100, 5000, 5001, 4999, 5000, 2, $3)
     RETURNING id`,
    [firedAt, type, value],
  );
  return rows[0]!.id;
}

/** The AUTO-FILLED JSON the cron stores, with one extra key a merge must keep. */
const autoFilled = (h: number, l: number, c: number, v: number | null) => ({
  globexHigh: h,
  globexLow: l,
  globexClose: c,
  globexVwap: v,
  savedAt: '2026-05-13T13:30:30.000Z',
  autoFilled: true,
  extra: 7,
});

interface Ids {
  s1: number; // ES 04-14, bad, changes
  s2: number; // ES 05-12, already right
  s3: number; // NQ 04-14, bad, changes
  s4: number; // ES 05-20, no fresh bar: left alone
  c1: number; // ES 03-31 control before
  c2: number; // ES 07-07 control after
  c3: number; // NQ 07-07 control after
  p1: number; // 05-13 auto-filled, bad high and vwap
  p1hand: number; // 05-13 hand-saved
  p2: number; // 05-14 auto-filled, already right
  p3: number; // 05-15 auto-filled, no bars
  pc: number; // 06-17 control after
  f1: number; // pcs, 0.2 -> 0.5 (gate flips to passes)
  f2: number; // e1, 0.9 -> 0.25 (gate flips to blocked)
  f3: number; // e1, 0.6 -> 0.75
  f4: number; // NULL, stays NULL
  f5: number; // no ES bars, left alone
  f6: number; // already right
  fc1: number; // control before
  fc2: number; // control after
}
let ids: Ids;

async function reset(): Promise<void> {
  await pg.query(
    `TRUNCATE futures_bars, index_candles_1m, market_snapshots,
              futures_snapshots, ws_gamma_setup_fires, touch_log
     RESTART IDENTITY`,
  );
  // Snapshots. The stored value is the right one wherever the row is a control.
  const right: [number, number, number, number] = [7007, 0.1, 0.1, 0.4615];
  const nqRight: [number, number, number, number] = [24024, 0.1, 0.1, 0.4615];
  await snapshotDay('ES', '2026-04-14', '2026-04-13', 7000, 7007);
  await snapshotDay('NQ', '2026-04-14', '2026-04-13', 24000, 24024);
  await snapshotDay('ES', '2026-05-12', '2026-05-11', 7000, 7007);
  await snapshotDay('ES', '2026-03-31', '2026-03-30', 7000, 7007);
  await snapshotDay('ES', '2026-07-07', '2026-07-06', 7000, 7007);
  await snapshotDay('NQ', '2026-07-07', '2026-07-06', 24000, 24024);
  const s1 = await snapshotRow(
    'ES',
    '2026-04-14T14:31:30.250Z',
    '2026-04-14',
    [7067, 0.9, 1, 0.3],
  );
  const s3 = await snapshotRow(
    'NQ',
    '2026-04-14T14:31:30.250Z',
    '2026-04-14',
    [24100, 0.9, 1, 0.3],
  );
  const s2 = await snapshotRow(
    'ES',
    '2026-05-12T14:31:30.250Z',
    '2026-05-12',
    right,
  );
  const s4 = await snapshotRow(
    'ES',
    '2026-05-20T14:31:30.250Z',
    '2026-05-20',
    [7000, 0, 0, 1],
  );
  const c1 = await snapshotRow(
    'ES',
    '2026-03-31T14:31:30.250Z',
    '2026-03-31',
    right,
  );
  const c2 = await snapshotRow(
    'ES',
    '2026-07-07T14:31:30.250Z',
    '2026-07-07',
    right,
  );
  const c3 = await snapshotRow(
    'NQ',
    '2026-07-07T14:31:30.250Z',
    '2026-07-07',
    nqRight,
  );

  // Pre-market: ES overnight bars. 05-13 window: H 7250, L 7100, last close
  // 7205, vwap (7200*100 + 7205*300) / 400 = 7203.75.
  await bar('ES', '2026-05-12T23:00:00Z', 7200, 100, [7250, 7100]);
  await bar('ES', '2026-05-13T03:00:00Z', 7205, 300, [7210, 7190]);
  await bar('ES', '2026-05-14T05:00:00Z', 7290, 200, [7300, 7280]);
  await bar('ES', '2026-06-17T04:00:00Z', 7390, 100, [7400, 7380]);
  const p1 = await premarketRow(
    '2026-05-13',
    '8:30 AM CT',
    autoFilled(7300, 7100, 7205, 7210.5),
  );
  const p1hand = await premarketRow('2026-05-13', 'hand', {
    globexHigh: 1,
    globexLow: 1,
    globexClose: 1,
    globexVwap: 1,
    savedAt: '2026-05-13T13:45:00.000Z',
  });
  const p2 = await premarketRow(
    '2026-05-14',
    'pre-market',
    autoFilled(7300, 7280, 7290, 7290),
  );
  const p3 = await premarketRow(
    '2026-05-15',
    'pre-market',
    autoFilled(1, 1, 1, 1),
  );
  const pc = await premarketRow(
    '2026-06-17',
    'pre-market',
    autoFilled(7400, 7380, 7390, 7390),
  );

  // Fires: SPX moves by `spx`, ES by `es`; basis = es - spx.
  await basisBars('2026-06-01T15:00:00Z', [5000, 5001], [7000, 7001.5]); // 0.5
  await basisBars('2026-06-02T15:00:00Z', [5000, 5001.25], [7000, 7001.5]); // 0.25
  await basisBars('2026-06-03T15:00:00Z', [5000, 5000.5], [7000, 7001.25]); // 0.75
  await basisBars('2026-06-04T15:00:00Z', [5000, 5001], [7000, 7001.5]); // 0.5
  await basisBars('2026-06-05T15:00:00Z', [5000, 5001], null); // no ES
  await basisBars('2026-06-08T15:00:00Z', [5000, 5001], [7000, 7001.5]); // 0.5
  await basisBars('2026-03-02T15:00:00Z', [5000, 5000.5], [7000, 7001.25]); // 0.75
  await basisBars('2026-08-17T15:00:00Z', [5000, 5001.5], [7000, 7001.25]); // -0.25
  const f1 = await fireRow('2026-06-01T15:00:00Z', 'pcs_monday', 0.2);
  const f2 = await fireRow('2026-06-02T15:00:00Z', 'e1_long_call', 0.9);
  const f3 = await fireRow('2026-06-03T15:00:00Z', 'e1_long_call', 0.6);
  const f4 = await fireRow('2026-06-04T15:00:00Z', 'e1_long_call', null);
  const f5 = await fireRow('2026-06-05T15:00:00Z', 'e1_long_call', 0.4);
  const f6 = await fireRow('2026-06-08T15:00:00Z', 'e1_long_call', 0.5);
  const fc1 = await fireRow('2026-03-02T15:00:00Z', 'e1_long_call', 0.75);
  const fc2 = await fireRow('2026-08-17T15:00:00Z', 'e1_long_call', -0.25);

  ids = {
    s1,
    s2,
    s3,
    s4,
    c1,
    c2,
    c3,
    p1,
    p1hand,
    p2,
    p3,
    pc,
    f1,
    f2,
    f3,
    f4,
    f5,
    f6,
    fc1,
    fc2,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ALL = ['snapshots', 'premarket', 'fires'] as const;

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: true,
    force: false,
    stores: [...ALL],
    expectSnapshots: 2,
    expectPremarket: 1,
    expectFires: 3,
    ...over,
  };
}
const run = (over: Partial<RecomputeOptions> = {}) =>
  runRecompute(options(over));
const dry = (over: Partial<RecomputeOptions> = {}) =>
  run({
    apply: false,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    ...over,
  });

const errored = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
const report = (): string => readFileSync(join(workDir, 'report.txt'), 'utf8');
const backups = (): string[] =>
  existsSync(workDir)
    ? readdirSync(workDir).filter((f) => f.startsWith('backup-'))
    : [];

async function dump(): Promise<string> {
  const out: unknown[] = [];
  for (const t of [
    'futures_snapshots',
    'market_snapshots',
    'ws_gamma_setup_fires',
    'futures_bars',
    'index_candles_1m',
  ]) {
    out.push(
      (await pg.query(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY id`)).rows,
    );
  }
  return JSON.stringify(out);
}

async function snapshotValues(id: number) {
  const { rows } = await pg.query<Record<string, string | null>>(
    `SELECT price::text, change_1h_pct::text AS c1, change_day_pct::text AS cd,
            volume_ratio::text AS vr FROM futures_snapshots WHERE id = $1`,
    [id],
  );
  const r = rows[0]!;
  return [r.price, r.c1, r.cd, r.vr];
}

async function premarketData(id: number): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ pm: Record<string, unknown> }>(
    `SELECT pre_market_data AS pm FROM market_snapshots WHERE id = $1`,
    [id],
  );
  return rows[0]!.pm;
}

async function fireValue(id: number): Promise<string | null> {
  const { rows } = await pg.query<{ v: string | null }>(
    `SELECT es_basis_change_5m::text AS v FROM ws_gamma_setup_fires WHERE id = $1`,
    [id],
  );
  return rows[0]!.v;
}

async function touches(table: string): Promise<number[]> {
  const { rows } = await pg.query<{ id: string }>(
    `SELECT id::text FROM touch_log WHERE tbl = $1 ORDER BY id`,
    [table],
  );
  return rows.map((r) => Number(r.id));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); // Sunday: not market hours
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'recompute-pglite-'));
  workDir = join(dir, 'work');
  hooks.calls = [];
  hooks.plainFetch = [];
  hooks.beforeWrite = null;
  hooks.failRead = null;
  hooks.failWriteAt = null;
  hooks.dropWrites = false;
  hooks.plainReadOnly = true;
  hooks.writes = 0;
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('dry run on real SQL (pglite)', () => {
  it('reports each store and writes nothing', async () => {
    const before = await dump();
    expect(await dry()).toBe(0);

    expect(await dump()).toBe(before);
    expect(hooks.writes).toBe(0);
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
    // Every query of the planning went through the read-only fetch, and it is
    // taken off again when the run ends.
    expect(hooks.calls.every((c) => c.fetchFn === readOnlyFetch)).toBe(true);
    expect(hooks.plainFetch.length).toBeGreaterThan(0);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();
    expect(await touches('futures_snapshots')).toEqual([]);
    expect(backups()).toEqual([]);
    expect(existsSync(markerPath(workDir, 'fires'))).toBe(false);

    const text = report();
    // Session proof: both paths read-only.
    expect(text).toContain('read-only transaction: on');
    expect(text).toContain('plain query during planning: on');
    // futures_snapshots: 4 in scope (ES x3, NQ x1), 2 change, 1 left alone, 3 control.
    expect(text).toMatch(/rows in scope: 4, rows to change: 2 \(price=2 /);
    expect(text).toContain('rows left alone (cannot be recomputed): 1');
    expect(text).toContain('stale (latest bar');
    expect(text).toContain('control set: 3 of 3 match (100.0%)');
    expect(text).toContain('matched/rows by month: 2026-03 1/1, 2026-07 2/2');
    // The largest price diff is the NQ row: 24100 -> 24024.
    expect(text).toMatch(
      /NQ 2026-04-14T14:31:30.250Z id \d+ price\/1h\/day\/vr 24100\/0.9\/1\/0.3 -> 24024\/0.1\/0.1\/0.4615/,
    );
    // pre_market_data: 3 auto-filled rows in scope, 1 changes, the old -> new line.
    expect(text).toMatch(/rows in scope: 3, rows to change: 1/);
    expect(text).toContain(
      `2026-05-13 id ${ids.p1} (8:30 AM CT) 7300/7100/7205/7210.5 -> 7250/7100/7205/7203.75`,
    );
    expect(text).toContain('2026-05-15');
    expect(text).toContain('no overnight bars');
    // Fires: 5 with a value in scope (F4 is NULL), 3 change, 2 gate flips.
    expect(text).toMatch(/rows in scope: 5, rows to change: 3/);
    expect(text).toContain('PCS gate flips');
    expect(text).toContain(': 2 (1 pcs_monday)');
    expect(text).toContain(
      `fire ${ids.f1} 2026-06-01T15:00:00Z pcs_monday 0.2 -> 0.5: blocked -> passes`,
    );
    expect(text).toContain(
      `fire ${ids.f2} 2026-06-02T15:00:00Z e1_long_call 0.9 -> 0.25: passed -> blocked`,
    );
    expect(text).toContain('Control sets: every store matches 100%.');
  });

  it('runs only the stores it was given', async () => {
    expect(await dry({ stores: ['fires'] })).toBe(0);
    const text = report();
    expect(text).toContain('ws_gamma_setup_fires.es_basis_change_5m');
    expect(text).not.toContain('futures_snapshots (ES, NQ)');
    expect(text).not.toContain('market_snapshots.pre_market_data');
  });

  it('reports a control set that does not match, with what differs, and exits 0', async () => {
    await pg.query(`UPDATE futures_snapshots SET price = 7001 WHERE id = $1`, [
      ids.c2,
    ]);
    expect(await dry()).toBe(0);
    const text = report();
    expect(text).toContain('control set: 2 of 3 match (66.7%)');
    expect(text).toContain('mismatch price: 1');
    expect(text).toContain('matched/rows by month: 2026-03 1/1, 2026-07 1/2');
    expect(text).toContain('APPLY WOULD REFUSE');
  });

  it('refuses to plan on a session that could write, naming both answers', async () => {
    hooks.plainReadOnly = false;
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/the planning session is not read-only/);
    expect(errored()).toContain('plain query during planning: off');
    expect(hooks.calls.filter((c) => !c.readOnly)).toEqual([]);
  });

  it('exits non-zero with the reason when a read rejects', async () => {
    hooks.failRead = new Error('relation "futures_snapshots" does not exist');
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/relation "futures_snapshots" does not exist/);
    expect(neonConfig.fetchFunction).toBeUndefined();
  });
});

// ── --apply refusals ────────────────────────────────────────────────────────

describe('--apply refuses before any write', () => {
  const expectNothingWritten = async (before: string) => {
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    for (const store of ALL)
      expect(existsSync(markerPath(workDir, store))).toBe(false);
  };

  it('when a total differs from the approved dry run', async () => {
    const before = await dump();
    expect(await run({ expectFires: 4 })).toBe(1);
    expect(errored()).toMatch(
      /fires: the fresh plan changes 3 rows, --expect-fires 4 was given/,
    );
    await expectNothingWritten(before);
  });

  it('when a control set does not reproduce what is stored', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.5 WHERE id = $1`,
      [ids.c1],
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /snapshots: control set matches 2 of 3 \(66\.7%\), not 100%/,
    );
    await expectNothingWritten(before);
  });

  it('when a store has no control rows at all', async () => {
    await pg.query(
      `DELETE FROM ws_gamma_setup_fires WHERE id = ANY($1::bigint[])`,
      [[ids.fc1, ids.fc2]],
    );
    expect(await run({ expectFires: 3 })).toBe(1);
    expect(errored()).toMatch(/fires: the control set is empty/);
    expect(hooks.writes).toBe(0);
  });

  it('during market hours, before it reads anything', async () => {
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    const calls = hooks.calls.length;
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply during market hours/);
    expect(hooks.calls.length).toBe(calls);
    expect(hooks.writes).toBe(0);
  });
});

// ── --apply ─────────────────────────────────────────────────────────────────

describe('--apply on real SQL (pglite)', () => {
  it('updates only the rows whose value differs, and keeps everything else', async () => {
    const hand = JSON.stringify(await premarketData(ids.p1hand));
    const untouchedP3 = JSON.stringify(await premarketData(ids.p3));
    expect(await run()).toBe(0);

    // Planning ran through the read-only fetch; the writes did not (it would
    // have turned them into read-only batches).
    const writes = hooks.calls.filter((c) => !c.readOnly);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.fetchFn === undefined)).toBe(true);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();

    // futures_snapshots: the two bad rows follow the recompute.
    expect(await snapshotValues(ids.s1)).toEqual([
      '7007.0000',
      '0.1000',
      '0.1000',
      '0.4615',
    ]);
    expect(await snapshotValues(ids.s3)).toEqual([
      '24024.0000',
      '0.1000',
      '0.1000',
      '0.4615',
    ]);
    // A right row, the stale row and the controls were not written.
    expect(await touches('futures_snapshots')).toEqual(
      [ids.s1, ids.s3].sort((a, b) => a - b),
    );
    expect(await snapshotValues(ids.s4)).toEqual([
      '7000.0000',
      '0.0000',
      '0.0000',
      '1.0000',
    ]);

    // pre_market_data: four keys replaced, every other key kept.
    expect(await premarketData(ids.p1)).toEqual({
      globexHigh: 7250,
      globexLow: 7100,
      globexClose: 7205,
      globexVwap: 7203.75,
      savedAt: '2026-05-13T13:30:30.000Z',
      autoFilled: true,
      extra: 7,
    });
    expect(await touches('market_snapshots')).toEqual([ids.p1]);
    const { rows } = await pg.query<{ spx: string; notes: string }>(
      `SELECT spx::text, notes FROM market_snapshots WHERE id = $1`,
      [ids.p1],
    );
    expect(rows[0]).toEqual({ spx: '5800.50', notes: 'keep' });
    // The hand-saved row on the same date, and the row with no bars, are untouched.
    expect(JSON.stringify(await premarketData(ids.p1hand))).toBe(hand);
    expect(JSON.stringify(await premarketData(ids.p3))).toBe(untouchedP3);

    // Fires: three change; the NULL stays NULL; the unrecomputable and right ones stay.
    expect(await fireValue(ids.f1)).toBe('0.5');
    expect(await fireValue(ids.f2)).toBe('0.25');
    expect(await fireValue(ids.f3)).toBe('0.75');
    expect(await fireValue(ids.f4)).toBeNull();
    expect(await fireValue(ids.f5)).toBe('0.4');
    expect(await fireValue(ids.f6)).toBe('0.5');
    expect(await touches('ws_gamma_setup_fires')).toEqual([
      ids.f1,
      ids.f2,
      ids.f3,
    ]);

    for (const store of ALL)
      expect(existsSync(markerPath(workDir, store))).toBe(true);
  });

  it('writes the backup, with every changed row in full, before the first write', async () => {
    let seen: string[] = [];
    hooks.beforeWrite = () => {
      if (seen.length > 0) return;
      seen = backups();
      expect(seen).toHaveLength(1);
      const lines = readFileSync(join(workDir, seen[0]!), 'utf8')
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(6); // 2 snapshots + 1 pre-market + 3 fires
    };
    expect(await run()).toBe(0);
    expect(seen).toHaveLength(1);

    const lines = readFileSync(join(workDir, seen[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            store: string;
            id: number;
            row: Record<string, unknown>;
            to: unknown;
          },
      );
    const s1 = lines.find((l) => l.store === 'snapshots' && l.id === ids.s1)!;
    expect(s1.row).toMatchObject({
      symbol: 'ES',
      price: 7067,
      change_1h_pct: 0.9,
      trade_date: '2026-04-14',
    });
    expect(s1.to).toEqual({
      price: 7007,
      change1hPct: 0.1,
      changeDayPct: 0.1,
      volumeRatio: 0.4615,
    });
    const p1 = lines.find((l) => l.store === 'premarket')!;
    expect(p1.row).toMatchObject({ id: ids.p1, spx: 5800.5, notes: 'keep' });
    expect((p1.row.pre_market_data as Record<string, unknown>).globexHigh).toBe(
      7300,
    );
    expect(
      lines
        .filter((l) => l.store === 'fires')
        .map((l) => l.row.es_basis_change_5m),
    ).toEqual([0.2, 0.9, 0.6]);
  });

  it('is idempotent: a second dry run plans no change, and a forced rerun writes nothing', async () => {
    expect(await run()).toBe(0);
    const after = await dump();
    const touched = (await pg.query(`SELECT count(*)::int AS n FROM touch_log`))
      .rows[0] as { n: number };

    expect(await dry()).toBe(0);
    expect(report()).toMatch(/rows in scope: 4, rows to change: 0/);
    expect(report()).toMatch(/rows in scope: 5, rows to change: 0/);

    hooks.writes = 0;
    expect(
      await run({
        force: true,
        expectSnapshots: 0,
        expectPremarket: 0,
        expectFires: 0,
      }),
    ).toBe(0);
    expect(hooks.writes).toBe(0);
    expect(await dump()).toBe(after);
    expect(
      (await pg.query(`SELECT count(*)::int AS n FROM touch_log`)).rows[0],
    ).toEqual(touched);
  });

  it('skips a store that has a done marker, and says so when it still has changes', async () => {
    expect(await run()).toBe(0);
    await pg.query(
      `UPDATE ws_gamma_setup_fires SET es_basis_change_5m = 0.1 WHERE id = $1`,
      [ids.f3],
    );
    const logged = () =>
      vi
        .mocked(console.log)
        .mock.calls.map((c) => String(c[0]))
        .join('\n');
    expect(
      await run({ expectSnapshots: 0, expectPremarket: 0, expectFires: 1 }),
    ).toBe(0);
    expect(logged()).toMatch(
      /fires is marked done but the fresh plan still changes 1 row\(s\)/,
    );
    expect(await fireValue(ids.f3)).toBe('0.1');
  });

  it('does not rewrite a row that already holds the value when it reaches the UPDATE', async () => {
    // The plan is read, then the database changes (another run, or a replayed
    // transaction): the guard must leave the now-equal rows alone.
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => t.includes('UPDATE futures_snapshots'))) {
        await pg.query(
          `UPDATE futures_snapshots SET price = 7007, change_1h_pct = 0.1, change_day_pct = 0.1, volume_ratio = 0.4615 WHERE id = $1`,
          [ids.s1],
        );
        await pg.query(`DELETE FROM touch_log`);
      }
    };
    expect(await run()).toBe(0);
    expect(await touches('futures_snapshots')).toEqual([ids.s3]);
  });

  it('never overwrites a row that became hand-saved after the plan was read', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => t.includes('UPDATE market_snapshots'))) {
        await pg.query(
          `UPDATE market_snapshots SET pre_market_data = pre_market_data - 'autoFilled' WHERE id = $1`,
          [ids.p1],
        );
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /apply failed: premarket: verify failed for premarket/,
    );
    const pm = await premarketData(ids.p1);
    expect(pm.globexHigh).toBe(7300); // the guard skipped it
    expect(pm.autoFilled).toBeUndefined();
    // The earlier store is done and marked; the failed one and the next are not.
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'premarket'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'fires'))).toBe(false);
    expect(await fireValue(ids.f1)).toBe('0.2');
  });

  it('never sets a NULL basis, and never sets a value onto a row that went NULL', async () => {
    expect(await fireValue(ids.f4)).toBeNull();
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => t.includes('UPDATE ws_gamma_setup_fires'))) {
        await pg.query(
          `UPDATE ws_gamma_setup_fires SET es_basis_change_5m = NULL WHERE id = $1`,
          [ids.f3],
        );
      }
    };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: fires: verify failed for fires/);
    expect(await fireValue(ids.f3)).toBeNull();
    expect(await fireValue(ids.f4)).toBeNull();
  });

  it('fails the store, unmarked, when a write is silently dropped', async () => {
    hooks.dropWrites = true;
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /apply failed: snapshots: verify failed for snapshots: 2 of 2 row\(s\) differ/,
    );
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(false);
  });

  it('exits non-zero with the store and reason when a write rejects', async () => {
    hooks.failWriteAt = { nth: 1, error: new Error('deadlock detected') };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: snapshots: deadlock detected/);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(false);
    expect(await snapshotValues(ids.s1)).toEqual([
      '7067.0000',
      '0.9000',
      '1.0000',
      '0.3000',
    ]);
  });

  it('stops between stores, exit 2, when market hours begin', async () => {
    hooks.beforeWrite = () => {
      vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    };
    expect(await run()).toBe(2);
    expect(errored()).toMatch(
      /apply stopped before premarket: market hours began/,
    );
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'premarket'))).toBe(false);
  });
});
