// @vitest-environment node

/**
 * REAL-SQL test for `--repair front-month` of the derived-store recompute (Phase 6b
 * of docs/superpowers/specs/2026-11-06-futures-session-front-month.md): the reads, the
 * shared recompute functions (computeSnapshot, computeEsBasisChange5m, queryGlobex),
 * the attribution against a Phase 6 backup (rewrites, deletes, fills, tags) and the
 * guarded writes run against pglite (Postgres in WASM), with futures_snapshots and
 * ws_gamma_setup_fires built from the real migrations (#45, #179).
 *
 * The world is built twice over: first the bars as Phase 6 found them and the rows
 * the writers saved from them, then Phase 6's changes to the bars. The backup file is
 * written from the same list of changes, so the two cannot disagree. The profile
 * module is mocked for its backup pins (a fixture run id and totals); the span and the
 * end of the write run are the real ones.
 *
 * getDb() emulates production as in futures-derived-recompute-pglite.test.ts: a plain
 * query is a read-only transaction, a transaction honours `readOnly`, and every write
 * is counted. An UPDATE trigger logs each row it touches.
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
  calls: [] as { readOnly: boolean; texts: string[]; fetchFn: unknown }[],
  plainFetch: [] as unknown[],
  beforeWrite: null as null | ((texts: string[]) => Promise<void> | void),
  /** The nth (1-based) write transaction rejects with this error. */
  failWriteAt: null as null | { nth: number; error: Error },
  writes: 0,
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
          if (!readOnly) {
            hooks.writes += 1;
            await hooks.beforeWrite?.(queries.map((q) => q.text));
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

// The Phase 6 backup of the fixture is a few dozen lines, not the real 625,717: its
// run id and per-action totals are the fixture's. The span and the end of the write
// run stay the real ones.
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
  readOnlyFetch,
  roundNumeric,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

vi.setConfig({ testTimeout: 120_000 });

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
  await pg.query(`
    CREATE TABLE index_candles_1m (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL DEFAULT 'SPX',
      market_time TEXT NOT NULL DEFAULT 'r',
      timestamp   TIMESTAMPTZ NOT NULL,
      close       NUMERIC(10,2) NOT NULL
    )
  `);
  // market_snapshots is created by initDb, not a migration.
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

// ── The changes Phase 6 made ────────────────────────────────────────────────

interface Vals {
  close: number;
  volume: number;
  high?: number;
  low?: number;
}
type Entry =
  | { action: 'rewrite'; symbol: string; ts: string; old: Vals; now: Vals }
  | { action: 'delete'; symbol: string; ts: string; old: Vals }
  | { action: 'fill'; symbol: string; ts: string; now: Vals }
  | { action: 'tag'; symbol: string; ts: string; vals: Vals };
let entries: Entry[] = [];

const full = (ts: string): string => new Date(ts).toISOString();

/** A stored bar as the Phase 6 backup writes it: `row` pads prices to four decimals, `after` does not. */
function barRow(ts: string, v: Vals, padded: boolean) {
  const p = (n: number): string => (padded ? n.toFixed(4) : String(n));
  return {
    ts: full(ts),
    open: p(v.close),
    high: p(v.high ?? v.close),
    low: p(v.low ?? v.close),
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
  switch (e.action) {
    case 'rewrite':
      return JSON.stringify({
        ...head,
        row: barRow(e.ts, e.old, true),
        after: barRow(e.ts, e.now, false),
      });
    case 'delete':
      return JSON.stringify({ ...head, row: barRow(e.ts, e.old, true) });
    case 'fill':
      return JSON.stringify({ ...head, after: barRow(e.ts, e.now, false) });
    case 'tag':
      return JSON.stringify({
        ...head,
        row: barRow(e.ts, e.vals, true),
        after: { contract: 'ESZ6' },
      });
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────────

async function bar(
  symbol: string,
  ts: string,
  v: Vals,
  /** Phase 6 saw this bar and left it alone, apart from its contract tag. */
  tag = false,
): Promise<void> {
  await pg.query(
    `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $4, $5, $3, $6)`,
    [symbol, ts, v.close, v.high ?? v.close, v.low ?? v.close, v.volume],
  );
  if (tag) entries.push({ action: 'tag', symbol, ts, vals: v });
}

/** A bar Phase 6 rewrote: stored as `old` in the world before it, `now` after. */
async function rewritten(
  symbol: string,
  ts: string,
  old: Vals,
  now: Vals,
): Promise<void> {
  await bar(symbol, ts, old);
  entries.push({ action: 'rewrite', symbol, ts, old, now });
}

/** A bar Phase 6 deleted: stored in the world before it. */
async function deleted(symbol: string, ts: string, old: Vals): Promise<void> {
  await bar(symbol, ts, old);
  entries.push({ action: 'delete', symbol, ts, old });
}

/** A bar Phase 6 added where none was stored. */
function filled(symbol: string, ts: string, now: Vals): void {
  entries.push({ action: 'fill', symbol, ts, now });
}

/** Phase 6's writes to the bars. */
async function applyRepair(): Promise<void> {
  for (const e of entries) {
    if (e.action === 'rewrite') {
      await pg.query(
        `UPDATE futures_bars SET open = $3, high = $4, low = $5, close = $3, volume = $6
          WHERE symbol = $1 AND ts = $2`,
        [
          e.symbol,
          e.ts,
          e.now.close,
          e.now.high ?? e.now.close,
          e.now.low ?? e.now.close,
          e.now.volume,
        ],
      );
    } else if (e.action === 'delete') {
      await pg.query(`DELETE FROM futures_bars WHERE symbol = $1 AND ts = $2`, [
        e.symbol,
        e.ts,
      ]);
    } else if (e.action === 'fill') {
      await pg.query(
        `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
         VALUES ($1, $2, $3, $4, $5, $3, $6)`,
        [
          e.symbol,
          e.ts,
          e.now.close,
          e.now.high ?? e.now.close,
          e.now.low ?? e.now.close,
          e.now.volume,
        ],
      );
    }
  }
}

function writeBackupFile(): void {
  const totals = { rewrite: 0, delete: 0, fill: 0, tag: 0 };
  for (const e of entries) totals[e.action] += 1;
  hooks.totals = totals;
  writeFileSync(backupPath, `${entries.map(lineOf).join('\n')}\n`);
}

/**
 * One trading day of bars: a prior-day bar (volume 1000, 500 for a thin root), the
 * open bar, the hour-ago bar and the last closed bar (volume 100, 50 for a thin
 * root). `openHour` is the UTC hour of the cash open at :30 (13 in EDT, 14 in EST). A
 * snapshot one and a half minutes after the last bar recomputes to price `now` and 1h
 * and day changes of (now - ref) / ref.
 */
async function snapshotDay(
  symbol: string,
  date: string,
  prior: string,
  ref: number,
  now: number,
  openHour = 13,
): Promise<void> {
  const thin = symbol !== 'ES';
  await bar(symbol, `${prior}T15:00:00Z`, {
    close: ref - 10,
    volume: thin ? 500 : 1000,
  });
  const volume = thin ? 50 : 100;
  await bar(symbol, `${date}T${openHour}:30:00Z`, { close: ref, volume });
  await bar(symbol, `${date}T${openHour}:31:00Z`, { close: ref, volume });
  await bar(symbol, `${date}T${openHour + 1}:30:00Z`, { close: now, volume });
}

type SnapshotValuesTuple = [
  number,
  number | null,
  number | null,
  number | null,
];

/** What the cron would have stored: computeSnapshot on the bars as they are now, at the column scale. */
async function savedFromBars(
  symbol: 'ES' | 'CL',
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
  symbol: string,
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

async function premarketRow(date: string, pm: object): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO market_snapshots (date, entry_time, spx, notes, pre_market_data)
     VALUES ($1, 'pre-market', 5800.5, 'keep', $2::jsonb) RETURNING id`,
    [date, JSON.stringify(pm)],
  );
  return rows[0]!.id;
}

const autoFilled = (h: number, l: number, c: number, v: number | null) => ({
  globexHigh: h,
  globexLow: l,
  globexClose: c,
  globexVwap: v,
  savedAt: '2026-08-06T13:30:30.000Z',
  autoFilled: true,
  extra: 7,
});

/** SPX closes for the 6 minutes to `t`: `spx[0]` until t, then `spx[1]` at t. */
async function spxCandles(t: string, spx: [number, number]): Promise<void> {
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
}

async function fireRow(firedAt: string, value: number | null): Promise<number> {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO ws_gamma_setup_fires
       (fired_at, signal_type, dow_label, confidence_tier, spot_at_fire,
        node_strike, node_gex, bar_open, bar_high, bar_low, bar_close,
        bar_range, es_basis_change_5m)
     VALUES ($1, 'e1_long_call', 'Monday', 'HIGH', 5000, 5000, 100, 5000, 5001, 4999, 5000, 2, $2)
     RETURNING id`,
    [firedAt, value],
  );
  return rows[0]!.id;
}

const CONTROL_DAYS = ['2026-11-03', '2026-11-04', '2026-11-05'];
const ROOT_PRICE = { ES: 7000, CL: 70 } as const;
interface ControlRow {
  symbol: 'ES' | 'CL';
  ts: string;
  values: SnapshotValuesTuple;
}
/** What computeSnapshot returns for the clean-era rows on the bars as Phase 6 found them: computed once. */
const controlRows: ControlRow[] = [];

/** Bars 13:00Z to 21:30Z for 11-02 and each control day (EST), ES and CL. */
async function controlBars(): Promise<void> {
  const rows: [string, string, number, number][] = [];
  for (const [d, date] of ['2026-11-02', ...CONTROL_DAYS].entries()) {
    for (const symbol of ['ES', 'CL'] as const) {
      const base = ROOT_PRICE[symbol];
      for (let m = 0; m <= 510; m += 5) {
        const ts = new Date(Date.parse(`${date}T13:00:00Z`) + m * 60_000);
        rows.push([
          symbol,
          ts.toISOString(),
          base + ((m * 7 + d * 3) % 23) - 11,
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
  /** ES 08-06: no bar that day when it was saved, frozen on the 08-05 23:00 bar; Phase 6 filled the day. */
  a: number;
  /** ES 09-14, a roll day: priced from a bar of the other contract; Phase 6 rewrote it and the hour-ago bar's volume. */
  b1: number;
  /** ES 09-18, no bar of its own changed; the 09-14 volume is in its 20-day window. */
  b2: number;
  /** CL 10-16: priced from a junk bar that Phase 6 deleted; the bar before it is 5 minutes older. */
  c: number;
  /** CL 10-16 14:55: stored the junk bar's price, and the recompute is stale. */
  junk: number;
  /** ES 09-01: a wrong price that no repaired bar feeds. */
  d: number;
  /** ES 09-02: priced from a bar 21 minutes old (what the stale-at-write rewrite takes), no repaired bar feeds it. */
  e2: number;
  /** CL 11-12: its 20-day window holds the CL bar of 10-29 whose volume Phase 6 rewrote. */
  cl1112: number;
  /** ES pre-market 08-06: computed from the two overnight bars, Phase 6 filled two more. */
  p1: number;
  /** ES pre-market 08-20: differs from the recompute, no repaired bar in its window. */
  p2: number;
  /** ES pre-market 07-20: outside the span, the control. */
  p3: number;
  /** Fire 09-14 15:00: the ES bar at its minute was rewritten. */
  fA: number;
  /** Fire 09-14 15:30: NULL, and Phase 6 filled its ES bars. */
  fN: number;
  /** Fire 08-20 15:00: in the span, no repaired bar near, exact. */
  fC: number;
  /** Fire 03-02: outside the span, exact. */
  fOut: number;
}
let ids: Ids;

async function reset(): Promise<void> {
  await pg.query(
    `TRUNCATE futures_bars, index_candles_1m, market_snapshots,
              futures_snapshots, ws_gamma_setup_fires, touch_log
     RESTART IDENTITY`,
  );
  entries = [];

  // ── The bars as Phase 6 found them ──

  // A: ES 08-06. The only bars before the gap: 08-05 and two overnight bars.
  await bar('ES', '2026-08-05T15:00:00Z', { close: 6990, volume: 1000 });
  await bar('ES', '2026-08-05T22:00:00Z', {
    close: 6990,
    volume: 100,
    high: 6992,
    low: 6988,
  });
  await bar('ES', '2026-08-05T23:00:00Z', {
    close: 6994,
    volume: 100,
    high: 6995,
    low: 6993,
  });
  filled('ES', '2026-08-06T03:00:00Z', {
    close: 6999,
    volume: 200,
    high: 7002,
    low: 6996,
  });
  filled('ES', '2026-08-06T07:00:00Z', {
    close: 7004,
    volume: 100,
    high: 7006,
    low: 7003,
  });
  filled('ES', '2026-08-06T13:30:00Z', { close: 7000, volume: 100 });
  filled('ES', '2026-08-06T13:31:00Z', { close: 7000, volume: 100 });
  filled('ES', '2026-08-06T14:30:00Z', { close: 7007, volume: 100 });

  // B: ES 09-14 (EDT). The 14:30 bar was the other contract's; the 13:31 bar's volume changed.
  await bar('ES', '2026-09-11T15:00:00Z', { close: 6990, volume: 1000 });
  await bar('ES', '2026-09-14T13:30:00Z', { close: 7000, volume: 100 }, true);
  await rewritten(
    'ES',
    '2026-09-14T13:31:00Z',
    { close: 7000, volume: 100 },
    { close: 7000, volume: 80 },
  );
  await rewritten(
    'ES',
    '2026-09-14T14:30:00Z',
    { close: 7100, volume: 100 },
    { close: 7007, volume: 100 },
  );
  // B2: ES 09-18.
  await snapshotDay('ES', '2026-09-18', '2026-09-17', 7000, 7007);

  // C: CL 10-16 (EDT). A junk bar at 14:29 that Phase 6 deleted; the last real bar is 14:25.
  await bar('CL', '2026-10-15T15:00:00Z', { close: 67.9, volume: 500 });
  await bar('CL', '2026-10-16T13:30:00Z', { close: 68, volume: 50 }, true);
  await bar('CL', '2026-10-16T13:31:00Z', { close: 68, volume: 50 });
  await bar('CL', '2026-10-16T14:25:00Z', { close: 68.1, volume: 50 });
  await deleted('CL', '2026-10-16T14:29:00Z', { close: 85.33, volume: 1 });

  // D and E2: ES 09-01 and 09-02, far from any repaired bar (08-06 is more than 20 days before).
  await snapshotDay('ES', '2026-09-01', '2026-08-31', 7000, 7007);
  await snapshotDay('ES', '2026-09-02', '2026-09-01', 7000, 7007);
  await bar('ES', '2026-09-02T14:10:00Z', { close: 7003, volume: 100 });

  // The CL bar of 10-29 whose volume Phase 6 rewrote: in the 20-day window of every control row.
  await rewritten(
    'CL',
    '2026-10-29T14:30:00Z',
    { close: 70, volume: 100 },
    { close: 70, volume: 5000 },
  );
  // CL 11-12 (EST): a day after the control days, before the end of the write run.
  await snapshotDay('CL', '2026-11-12', '2026-11-11', 70, 70.1, 14);
  await controlBars();

  // Pre-market: ES overnight bars of the dates below (06-ish and 08-20), outside and inside.
  await bar('ES', '2026-07-20T03:00:00Z', {
    close: 7400,
    volume: 100,
    high: 7410,
    low: 7390,
  });
  await bar('ES', '2026-08-20T03:00:00Z', {
    close: 7010,
    volume: 100,
    high: 7020,
    low: 7000,
  });

  // Fires: ES at the SPX minutes. fA's ES bar at 15:00 was rewritten (7001.5, then 7002).
  await spxCandles('2026-09-14T15:00:00Z', [5000, 5001]);
  await bar('ES', '2026-09-14T14:55:00Z', { close: 7000, volume: 1 });
  await rewritten(
    'ES',
    '2026-09-14T15:00:00Z',
    { close: 7001.5, volume: 1 },
    { close: 7002, volume: 1 },
  );
  // fN: SPX candles, and ES bars that were missing then (Phase 6 filled them).
  await spxCandles('2026-09-14T15:30:00Z', [5000, 5001]);
  filled('ES', '2026-09-14T15:25:00Z', { close: 7000, volume: 1 });
  filled('ES', '2026-09-14T15:30:00Z', { close: 7001.5, volume: 1 });
  // fC and fOut: untouched.
  await spxCandles('2026-08-20T15:00:00Z', [5000, 5001]);
  await bar('ES', '2026-08-20T14:55:00Z', { close: 7000, volume: 1 });
  await bar('ES', '2026-08-20T15:00:00Z', { close: 7001.5, volume: 1 });
  await spxCandles('2026-03-02T15:00:00Z', [5000, 5000.5]);
  await bar('ES', '2026-03-02T14:55:00Z', { close: 7000, volume: 1 });
  await bar('ES', '2026-03-02T15:00:00Z', { close: 7001.25, volume: 1 });

  // ── What the writers saved from them ──
  const a = await snapshotRow('ES', '2026-08-06T14:31:30Z', [
    6994,
    null,
    null,
    null,
  ]);
  const b1 = await snapshotRow(
    'ES',
    '2026-09-14T14:31:30Z',
    await savedFromBars('ES', '2026-09-14T14:31:30Z'),
  );
  const b2 = await snapshotRow(
    'ES',
    '2026-09-18T14:31:30Z',
    await savedFromBars('ES', '2026-09-18T14:31:30Z'),
  );
  const c = await snapshotRow(
    'CL',
    '2026-10-16T14:30:30Z',
    await savedFromBars('CL', '2026-10-16T14:30:30Z'),
  );
  const junk = await snapshotRow(
    'CL',
    '2026-10-16T14:55:00Z',
    [85.33, 0, 0, 1],
  );
  const savedD = await savedFromBars('ES', '2026-09-01T14:31:30Z');
  const d = await snapshotRow('ES', '2026-09-01T14:31:30Z', [
    7099,
    savedD[1],
    savedD[2],
    savedD[3],
  ]);
  const savedE2 = await savedFromBars('ES', '2026-09-02T14:31:30Z');
  const e2 = await snapshotRow('ES', '2026-09-02T14:31:30Z', [
    7003,
    0.0429,
    0.0429,
    savedE2[3],
  ]);
  const cl1112 = await snapshotRow(
    'CL',
    '2026-11-12T15:31:30Z',
    await savedFromBars('CL', '2026-11-12T15:31:30Z'),
  );

  // The clean era: the rows the cron wrote on 11-03 to 11-05, from the bars as Phase 6 found them.
  if (controlRows.length === 0) {
    for (const symbol of ['ES', 'CL'] as const) {
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

  const p1 = await premarketRow(
    '2026-08-06',
    autoFilled(6995, 6988, 6994, 6992),
  );
  const p2 = await premarketRow(
    '2026-08-20',
    autoFilled(7000, 6900, 6950, 6950),
  );
  const p3 = await premarketRow(
    '2026-07-20',
    autoFilled(7410, 7390, 7400, 7400),
  );
  const fA = await fireRow('2026-09-14T15:00:00Z', 0.5);
  const fN = await fireRow('2026-09-14T15:30:00Z', null);
  const fC = await fireRow('2026-08-20T15:00:00Z', 0.5);
  const fOut = await fireRow('2026-03-02T15:00:00Z', 0.75);

  // ── Phase 6 ──
  await applyRepair();
  writeBackupFile();

  ids = { a, b1, b2, c, junk, d, e2, cl1112, p1, p2, p3, fA, fN, fC, fOut };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function options(over: Partial<RecomputeOptions> = {}): RecomputeOptions {
  return {
    workDir,
    apply: true,
    force: false,
    stores: ['snapshots', 'premarket', 'fires'],
    roots: ['ES', 'CL'],
    repair: 'front-month',
    frozen: false,
    volumeNull: false,
    backup: backupPath,
    expectSnapshots: 221,
    expectPremarket: 1,
    expectFires: 1,
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
/** The report the last run wrote: the last "report:" line a run printed. */
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
  to: Record<string, unknown> | number | null;
}[] =>
  readFileSync(join(workDir, backups()[0]!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const pointer = (): {
  command: { repair?: string; roots?: string[] };
  expect: Record<string, number | null>;
  frontMonth?: unknown;
} => JSON.parse(readFileSync(join(workDir, 'plan.json'), 'utf8'));

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
  symbol: 'ES' | 'CL',
  ts: string,
): Promise<(string | null)[]> {
  const v = await savedFromBars(symbol, ts);
  return v.map((x) => (x == null ? null : x.toFixed(4)));
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
    `SELECT id::text AS id FROM touch_log WHERE tbl = $1 ORDER BY touch_log.id`,
    [table],
  );
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

async function snapshotExists(id: number): Promise<boolean> {
  const { rows } = await pg.query(
    `SELECT 1 FROM futures_snapshots WHERE id = $1`,
    [id],
  );
  return rows.length > 0;
}

async function idsWhere(where: string): Promise<number[]> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM futures_snapshots WHERE ${where} ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

beforeEach(async () => {
  // A Saturday, so the --apply market-hours guard does not depend on when the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'front-month-pglite-'));
  workDir = join(dir, 'work');
  backupPath = join(dir, 'phase6-backup.jsonl');
  hooks.calls = [];
  hooks.plainFetch = [];
  hooks.beforeWrite = null;
  hooks.failWriteAt = null;
  hooks.writes = 0;
  hooks.runId = 'fixture-run';
  await reset();
  hooks.calls = [];
  hooks.plainFetch = [];
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('the front-month dry run on real SQL (pglite)', () => {
  it('plans what Phase 6 changed, writes nothing, and says so in its report', async () => {
    const before = await dump();
    expect(await dry()).toBe(0);

    expect(await dump()).toBe(before);
    expect(hooks.writes).toBe(0);
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
    expect(hooks.calls.every((c) => c.fetchFn === readOnlyFetch)).toBe(true);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();
    expect(backups()).toEqual([]);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(false);

    const text = report();
    // The header: the profile's span, its scope cut at the end of the write run, the backup by action.
    expect(text).toContain(
      'front-month repair: the bars Phase 6 changed in 2026-07-28T00:00:00Z .. 2026-11-12T00:00:00Z (end exclusive)',
    );
    expect(text).toContain(
      'snapshot scope 2026-07-28T00:00:00Z .. 2026-11-13T05:16:00Z',
    );
    expect(text).toContain(
      `bar backup ${backupPath}: 14 lines (rewrites 4, deletes 1, fills 7, tags 2 skipped: a tag changes no value)`,
    );
    expect(text).toContain(
      'rewritten by root: ES 3, CL 1; deleted by root: ES 0, CL 1; filled by root: ES 7, CL 0',
    );
    // No D1 lift, no stale-at-write plan: the profile has neither step.
    expect(text).not.toMatch(
      /D1 lift of ruling 9|stale-at-write rows \(opt-in/,
    );
    expect(text).not.toMatch(/stale-at-write test reaches/);
    expect(text).toContain('no D1 lift');
    // Nor the merge-state rule, which is about the Databento-era merged bars of April to June.
    expect(text).not.toMatch(/merge-state/);
    expect(existsSync(join(workDir, 'merge-state.txt'))).toBe(false);

    // What it would write: the fill-day row, the rewritten day, the day that only shares its volume, the CL rows.
    expect(text).toContain('rows in range: 440, rows to write: 221');
    // The 221 apart: rows on a repaired day (a UTC date with a rewrite, delete or fill of the root's
    // bar) and rows reached only through the 20-day volume window. The owner's approved bound counts
    // the first kind.
    expect(text).toContain(
      '    ES  repaired days: 2 to write of 2 (price 2, 1h 2, day 2, ratio 2) | window-only: 1 to write of 219 (price 0, 1h 0, day 0, ratio 1)',
    );
    expect(text).toContain(
      '    CL  repaired days: 1 to write of 2 (price 1, 1h 1, day 1, ratio 1) | window-only: 217 to write of 217 (price 0, 1h 0, day 0, ratio 217)',
    );
    expect(text).toContain(
      '    all roots  repaired days: 3 to write of 4 (price 3, 1h 3, day 3, ratio 3) | window-only: 218 to write of 436 (price 0, 1h 0, day 0, ratio 218)',
    );
    expect(text).toContain('rows in scope on repaired days, all roots: 4');
    // The control cannot vouch for the thin roots' volume ratio, and the report says so.
    expect(text).toContain(
      'the control cannot vouch for the volume ratio of RTY, CL, GC and ZN',
    );
    expect(text).toContain(
      'ES: rows in range 221, rows to write 3 (price=2 change1hPct=2 changeDayPct=2 volumeRatio=3)',
    );
    expect(text).toContain(
      'CL: rows in range 219, rows to write 218 (price=1 change1hPct=1 changeDayPct=1 volumeRatio=218)',
    );
    // The control passes on the fields no repaired bar feeds, and says what it set aside.
    expect(text).toContain(
      "control fields set aside (a repaired bar feeds them, so the stored value is the repair's to change; the other fields of the row still had to match): 217 rows (price=0 change1hPct=0 changeDayPct=0 volumeRatio=217)",
    );
    expect(text).toMatch(/control set matches[^\n]*: 433 of 433 \(100\.0%\)/);
    // The rows the repair did not feed are drift: not written, classified. ES keeps two of them
    // (09-01 off in the price, 09-02 priced from a bar 21 minutes old).
    const lines = text.split('\n');
    const esAt = lines.findIndex((l) => l.startsWith('  ES: rows in range'));
    const driftLine = lines
      .slice(esAt)
      .find((l) => l.includes('information, unaffected fields'));
    expect(driftLine).toMatch(
      /: price=2 change1hPct=1 changeDayPct=1 volumeRatio=0$/,
    );
    // All 221 ES rows of the scope are classified (the information window is not used): 219 match
    // once the repaired fields are left out, the two drift rows are neither a late bar nor the September outage.
    const driftAt = lines.findIndex((l) => l.startsWith('  drift, ES, '));
    expect(lines[driftAt]).toMatch(/: 221 rows, 219 match, 2 do not$/);
    expect(lines[driftAt + 1]).toBe(
      '    mismatches by class: september-window 0, late-bar 0, unexplained 2',
    );
    // The junk row the deleted bar priced, listed for the opt-in delete.
    expect(text).toContain(
      'stale rows priced from a deleted junk bar (not recomputable; --delete-junk-stale deletes them, off by default): 1',
    );
    // Pre-market: the filled day is written and reproduces from the bars as they were before.
    expect(text).toContain(
      'rows in scope: 2, rows to write: 1, equal to the recompute: 0',
    );
    expect(text).toContain('[pre-repair bars reproduce the stored values]');
    expect(text).toContain(
      'differ from the recompute with no repaired bar in the window (not written): 1',
    );
    // Fires: the rewritten minute is in scope; the NULL fire is read by nothing.
    expect(text).toContain('rows in scope: 1, rows to change: 1');
    expect(text).toContain('Apply gate: every check passes.');
    // The one command that applies it: the repair, the work dir, the totals and the junk delete; no stale rewrite.
    expect(text).toContain(
      `npx tsx scripts/recompute-futures-derived.ts --apply --work-dir ${workDir} --repair front-month --backup ${backupPath} --roots ES CL --expect-snapshots 221 --expect-premarket 1 --expect-fires 1 --delete-junk-stale --expect-junk-deletes 1`,
    );
  });

  it('is cut off at the end of the write run: a row from there on is a control row, checked on all four fields', async () => {
    // CL 11-12 is before the end of the write run: its volume ratio, saved before the
    // repair, is the repair's to change, and the control sets it aside (it is in the
    // 433 rows). A CL row of 11-13 15:31 is after the end of the write run: it read the
    // repaired bars, so a volume ratio that is off is a miss, like any other.
    await snapshotDay('CL', '2026-11-13', '2026-11-12', 70, 70.1, 14);
    const [price, hour, day, ratio] = await savedFromBars(
      'CL',
      '2026-11-13T15:31:30Z',
    );
    await snapshotRow('CL', '2026-11-13T15:31:30Z', [
      price,
      hour,
      day,
      (ratio ?? 0) + 0.05,
    ]);

    expect(await dry()).toBe(0);
    const text = report();
    expect(text).toContain('APPLY WOULD REFUSE:');
    expect(text).toMatch(
      /snapshots: control set matches [^\n]* 433 of 434 \(99\.8%\), not 100%/,
    );
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply\. Nothing was written\./);
    expect(hooks.writes).toBe(0);
  });
});

// ── Control ─────────────────────────────────────────────────────────────────

describe('the front-month control still refuses what no repair explains', () => {
  async function esControlRow(): Promise<number> {
    const [id] = await idsWhere(
      `symbol = 'ES' AND ts >= '2026-11-04T00:00:00Z' AND ts < '2026-11-05T00:00:00Z'`,
    );
    return id!;
  }

  it('an ES control row whose volume ratio is off: ES has no repaired bar in its window, so nothing is set aside', async () => {
    const id = await esControlRow();
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = volume_ratio + 1 WHERE id = $1`,
      [id],
    );
    expect(await dry()).toBe(0);
    expect(report()).toMatch(/control set matches [^\n]*: 432 of 433/);
    expect(report()).toContain('APPLY WOULD REFUSE:');
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/Refusing to --apply\. Nothing was written\./);
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
  });

  it("a CL control row whose price is off and no older bar explains it: only the volume ratio is the repair's", async () => {
    const [id] = await idsWhere(
      `symbol = 'CL' AND ts >= '2026-11-04T00:00:00Z' AND ts < '2026-11-05T00:00:00Z'`,
    );
    await pg.query(`UPDATE futures_snapshots SET price = 999 WHERE id = $1`, [
      id,
    ]);
    expect(await dry()).toBe(0);
    expect(report()).toContain('APPLY WOULD REFUSE:');
    expect(report()).toMatch(/other 1\b/);
    expect(await run()).toBe(1);
    expect(hooks.writes).toBe(0);
  });

  it('a fire inside the span that no repaired bar feeds is control: a wrong one refuses', async () => {
    await pg.query(
      `UPDATE ws_gamma_setup_fires SET es_basis_change_5m = 0.9 WHERE id = $1`,
      [ids.fC],
    );
    expect(await dry()).toBe(0);
    expect(report()).toContain('APPLY WOULD REFUSE:');
    expect(report()).toMatch(/fires: control set matches 1 of 2 \(50\.0%\)/);
    expect(await run()).toBe(1);
    expect(hooks.writes).toBe(0);
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────

describe('applying the front-month recompute on real SQL (pglite)', () => {
  it('writes the backup first, then only the fields a repaired bar feeds, and a second dry run plans nothing', async () => {
    const untouched = {
      d: await snapshotValues(ids.d),
      e2: await snapshotValues(ids.e2),
      p2: JSON.stringify(await premarketData(ids.p2)),
      p3: JSON.stringify(await premarketData(ids.p3)),
    };
    const before = {
      b2: await snapshotValues(ids.b2),
      cl: await snapshotValues(ids.cl1112),
    };
    let backupAtFirstWrite = -1;
    hooks.beforeWrite = () => {
      if (backupAtFirstWrite < 0) backupAtFirstWrite = backups().length;
    };

    expect(await run({ deleteJunkStale: true, expectJunkDeletes: 1 })).toBe(0);
    expect(backupAtFirstWrite).toBe(1);
    expect(neonConfig.fetchFunction).toBeUndefined();
    expect(
      hooks.calls
        .filter((c) => !c.readOnly)
        .every((c) => c.fetchFn === undefined),
    ).toBe(true);

    // The profile is recorded: a resume has to repeat it, and the old plans do not carry one.
    expect(pointer().command.repair).toBe('front-month');
    expect(pointer().command.roots).toEqual(['ES', 'CL']);
    expect(pointer().expect).toMatchObject({
      snapshots: 221,
      premarket: 1,
      fires: 1,
      junk: 1,
    });
    // And how the 221 planned snapshot rows split: on the days Phase 6 changed a bar (A, B1 and C,
    // out of the 4 rows there) and reached only through the 20-day window (B2, CL 11-12 and its
    // control rows, which change only their volume ratio).
    const group = (
      inScope: number,
      toWrite: number,
      price: number,
      change1h: number,
      changeDay: number,
      volumeRatio: number,
    ) => ({ inScope, toWrite, price, change1h, changeDay, volumeRatio });
    expect(pointer().frontMonth).toEqual({
      snapshotRows: {
        byRoot: {
          ES: {
            repairedDays: group(2, 2, 2, 2, 2, 2),
            windowOnly: group(219, 1, 0, 0, 0, 1),
          },
          CL: {
            repairedDays: group(2, 1, 1, 1, 1, 1),
            windowOnly: group(217, 217, 0, 0, 0, 217),
          },
        },
        all: {
          repairedDays: group(4, 3, 3, 3, 3, 3),
          windowOnly: group(436, 218, 0, 0, 0, 218),
        },
      },
    });

    // A: the fill-day row, frozen on the 08-05 bar, follows the filled bars in all four fields.
    const [aPrice, a1h, aDay, aVr] = await snapshotValues(ids.a);
    expect([aPrice, a1h, aDay]).toEqual(['7007.0000', '0.1000', '0.1000']);
    expect(aVr).toBe((await recomputed('ES', '2026-08-06T14:31:30Z'))[3]);
    // B1: price, 1h and day follow the rewritten 14:30 bar, and the ratio the rewritten volume.
    expect(await snapshotValues(ids.b1)).toEqual(
      await recomputed('ES', '2026-09-14T14:31:30Z'),
    );
    expect((await snapshotValues(ids.b1)).slice(0, 3)).toEqual([
      '7007.0000',
      '0.1000',
      '0.1000',
    ]);
    // B2: no bar of its own changed, a row 5 days later takes only the volume ratio.
    const after2 = await snapshotValues(ids.b2);
    expect(after2.slice(0, 3)).toEqual(before.b2.slice(0, 3));
    expect(after2[3]).not.toBe(before.b2[3]);
    expect(after2).toEqual(await recomputed('ES', '2026-09-18T14:31:30Z'));
    // C: the latest closed bar was the deleted one, the price now is the bar before it.
    expect((await snapshotValues(ids.c)).slice(0, 3)).toEqual([
      '68.1000',
      '0.1471',
      '0.1471',
    ]);
    // CL 11-12 and the control rows of 11-03 to 11-05: the volume ratio only, price untouched.
    const cl = await snapshotValues(ids.cl1112);
    expect(cl.slice(0, 3)).toEqual(before.cl.slice(0, 3));
    expect(cl).toEqual(await recomputed('CL', '2026-11-12T15:31:30Z'));
    expect(cl[3]).not.toBe(before.cl[3]);
    // The rows no repaired bar feeds keep their stored values, however far they are from today's.
    expect(await snapshotValues(ids.d)).toEqual(untouched.d);
    expect(await snapshotValues(ids.e2)).toEqual(untouched.e2);
    expect(await snapshotValues(ids.d)).toContain('7099.0000');

    // Exactly 221 rows were touched: three ES, the CL row of 10-16, CL 11-12 and its 216 control rows.
    const written = await touches('futures_snapshots');
    expect(written).toHaveLength(221);
    expect(written).toEqual(
      expect.arrayContaining([ids.a, ids.b1, ids.b2, ids.c, ids.cl1112]),
    );
    expect(written).not.toContain(ids.d);
    expect(written).not.toContain(ids.e2);
    expect(written).not.toContain(ids.junk);
    const esWritten = await idsWhere(`symbol = 'ES'`);
    expect(written.filter((w) => esWritten.includes(w))).toEqual(
      [ids.a, ids.b1, ids.b2].sort((x, y) => x - y),
    );

    // The plan file names the fields per row.
    const lines = planLines();
    const fieldsOf = (id: number) =>
      lines.find((l) => l.step === 'snapshots' && l.id === id)?.fields;
    expect(fieldsOf(ids.a)).toEqual([
      'price',
      'change1hPct',
      'changeDayPct',
      'volumeRatio',
    ]);
    expect(fieldsOf(ids.b2)).toEqual(['volumeRatio']);
    expect(fieldsOf(ids.cl1112)).toEqual(['volumeRatio']);
    expect(fieldsOf(ids.c)).toEqual([
      'price',
      'change1hPct',
      'changeDayPct',
      'volumeRatio',
    ]);
    expect(lines.filter((l) => l.step === 'stale')).toHaveLength(0);

    // The junk row, priced from the deleted bar and not recomputable, was deleted after the backup.
    expect(await snapshotExists(ids.junk)).toBe(false);
    expect(lines.filter((l) => l.step === 'junk').map((l) => l.id)).toEqual([
      ids.junk,
    ]);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);

    // Pre-market: the filled 08-06 window, every other key kept; the row with no repaired bar and the control stay.
    expect(await premarketData(ids.p1)).toEqual({
      globexHigh: 7006,
      globexLow: 6988,
      globexClose: 7004,
      globexVwap: expect.closeTo(6997.2, 6),
      savedAt: '2026-08-06T13:30:30.000Z',
      autoFilled: true,
      extra: 7,
    });
    expect(JSON.stringify(await premarketData(ids.p2))).toBe(untouched.p2);
    expect(JSON.stringify(await premarketData(ids.p3))).toBe(untouched.p3);
    expect(await touches('market_snapshots')).toEqual([ids.p1]);

    // Fires: the rewritten minute is written; the NULL fire stays NULL though its bars exist now.
    expect(Number(await fireValue(ids.fA))).toBe(1);
    expect(await fireValue(ids.fN)).toBeNull();
    expect(await fireValue(ids.fC)).toBe('0.5');
    expect(await fireValue(ids.fOut)).toBe('0.75');
    expect(await touches('ws_gamma_setup_fires')).toEqual([ids.fA]);

    for (const step of ['snapshots', 'premarket', 'fires', 'junk'] as const)
      expect(existsSync(markerPath(workDir, step))).toBe(true);

    // A second dry run in the same work dir plans nothing for the three stores.
    hooks.calls = [];
    expect(await dry()).toBe(0);
    const again = report();
    expect(again).toContain('rows in range: 439, rows to write: 0');
    // Nothing is left to write on either kind of day; the junk row is gone from the repaired ones.
    expect(again).toContain(
      '    ES  repaired days: 0 to write of 2 (price 0, 1h 0, day 0, ratio 0) | window-only: 0 to write of 219 (price 0, 1h 0, day 0, ratio 0)',
    );
    expect(again).toContain(
      '    CL  repaired days: 0 to write of 1 (price 0, 1h 0, day 0, ratio 0) | window-only: 0 to write of 217 (price 0, 1h 0, day 0, ratio 0)',
    );
    expect(again).toContain('rows in scope on repaired days, all roots: 3');
    expect(again).toContain('rows in scope: 2, rows to write: 0');
    expect(again).toContain('rows in scope: 1, rows to change: 0');
    expect(again).toContain('Apply gate: every check passes.');
    expect(again).toContain(
      '--expect-snapshots 0 --expect-premarket 0 --expect-fires 0',
    );
    expect(hooks.calls.every((c) => c.readOnly)).toBe(true);
  });
});

// ── Resume and the other repair ─────────────────────────────────────────────

describe('a plan of one repair is not resumed or replaced by the other', () => {
  it('refuses to resume a front-month plan without --repair, and finishes it with it', async () => {
    hooks.failWriteAt = { nth: 1, error: new Error('connection lost') };
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/apply failed: snapshots: connection lost/);
    expect(existsSync(join(workDir, 'snapshots.started'))).toBe(true);
    expect(pointer().command.repair).toBe('front-month');

    hooks.failWriteAt = null;
    const writes = hooks.writes;
    expect(await run({ repair: undefined })).toBe(1);
    expect(errored()).toMatch(/Refusing to resume\. Nothing was written\./);
    expect(errored()).toMatch(
      /--repair contract-mix was given, the saved plan was made for the front-month repair/,
    );
    expect(hooks.writes).toBe(writes);

    expect(await run()).toBe(0);
    expect(await snapshotValues(ids.a)).toEqual(
      await recomputed('ES', '2026-08-06T14:31:30Z'),
    );
  });

  it('refuses a fresh run of the other repair in the work dir of a finished plan, before it reads the backup', async () => {
    expect(await run()).toBe(0);
    const writes = hooks.writes;
    hooks.calls = [];
    expect(
      await run({ repair: undefined, backup: join(dir, 'missing.jsonl') }),
    ).toBe(1);
    expect(errored()).toMatch(
      /is the plan of the front-month repair, this run is contract-mix/,
    );
    expect(hooks.writes).toBe(writes);
    expect(hooks.calls).toEqual([]);
  });
});

// ── A backup that is not the one pinned ─────────────────────────────────────

describe('a backup that is not the pinned one', () => {
  it('another run id exits 1 before any read, naming the line', async () => {
    // The file was written for "fixture-run"; the profile now pins another run.
    hooks.runId = 'another-run';
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(
      /phase6-backup\.jsonl:1: runId "fixture-run" is not "another-run"/,
    );
    expect(hooks.calls).toEqual([]);
    expect(hooks.plainFetch).toEqual([]);
  });

  it('a file cut short exits 1 before any read, naming the totals', async () => {
    const text = readFileSync(backupPath, 'utf8').split('\n').slice(0, 5);
    writeFileSync(backupPath, `${text.join('\n')}\n`);
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/the totals are not the pinned ones/);
    expect(hooks.calls).toEqual([]);
  });

  it('a span-edge change outside the span exits 1 before any read', async () => {
    const lines = readFileSync(backupPath, 'utf8').split('\n').filter(Boolean);
    lines.push(
      JSON.stringify({
        runId: 'fixture-run',
        action: 'fill',
        symbol: 'ES',
        after: barRow(
          '2026-11-12T00:00:00Z',
          { close: 7000, volume: 1 },
          false,
        ),
      }),
    );
    writeFileSync(backupPath, `${lines.join('\n')}\n`);
    expect(await dry()).toBe(1);
    expect(errored()).toMatch(/is outside the span/);
    expect(hooks.calls).toEqual([]);
  });
});
