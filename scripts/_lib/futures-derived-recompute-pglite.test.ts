// @vitest-environment node

/**
 * REAL-SQL test for the Phase 4 recompute: the reads, the shared recompute
 * functions (computeSnapshot, computeEsBasisChange5m, queryGlobex), the
 * attribution against a Phase 2 backup and the guarded UPDATEs run against
 * pglite (Postgres in WASM), with futures_snapshots and ws_gamma_setup_fires
 * built from the real migrations (#45, #179).
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
  /** Every read-only transaction rejects with this error. */
  failRead: null as null | Error,
  /** Write transactions resolve with no rows and run nothing. */
  dropWrites: false,
  /** A plain query runs read-only, as readOnlyFetch makes it; false models a session that can write. */
  plainReadOnly: true,
  writes: 0,
  /** The trade date the mocked cronGuard hands the pre-market cron. */
  cronToday: '2026-05-28',
  /** The tool's backup file keeps only its first line, as a short disk write would. */
  shortBackup: false,
}));

// Only the tool's own backup-<stamp>.jsonl write is cut short.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [path, data, ...rest] = args;
      if (hooks.shortBackup && String(path).includes('backup-')) {
        return actual.writeFileSync(
          path,
          `${String(data).split('\n')[0]}\n`,
          ...rest,
        );
      }
      return actual.writeFileSync(path, data, ...rest);
    },
  };
});

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

// The pre-market cron, run for the identity test: only the guard that supplies
// `today` and the reporting are replaced.
vi.mock('../../api/_lib/api-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/api-helpers.js')>()),
  cronGuard: () => ({ today: hooks.cronToday, apiKey: '' }),
}));
vi.mock('../../api/_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));
vi.mock('../../api/_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mockRequest, mockResponse } from '../../api/__tests__/helpers';
import { applyMigration } from '../../api/__tests__/pglite-migrations';
import premarketCron from '../../api/cron/auto-prefill-premarket.js';
import snapshotCron from '../../api/cron/fetch-futures-snapshot.js';
import {
  FUTURES_SYMBOLS,
  computeSnapshot,
} from '../../api/_lib/futures-derive.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  compareSnapshot,
  markerPath,
  readOnlyFetch,
  roundNumeric,
  runRecompute,
  type RecomputeOptions,
} from './futures-derived-recompute.js';

// Six roots, a 1,296-row control and the information window make each run take
// seconds, and some tests run the tool three times.
vi.setConfig({ testTimeout: 90_000 });

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
 * One trading day of bars: a prior-day bar of volume 1000 (500 for NQ), the
 * open bar, the hour-ago bar and the last closed bar, 100 each (50 for NQ).
 * `openHour` is the UTC hour of the cash open at :30 (13 in EDT, 14 in EST). A
 * snapshot one minute and a half after the last bar (`openHour + 1`:31:30)
 * recomputes to price `now`, 1h and day changes of (now - ref) / ref, and a
 * volume ratio of 300 / avg(1000, 300) = 0.4615.
 */
async function snapshotDay(
  symbol: string,
  date: string,
  prior: string,
  ref: number,
  now: number,
  openHour = 13,
): Promise<void> {
  await bar(
    symbol,
    `${prior}T15:00:00Z`,
    ref - 10,
    symbol === 'ES' ? 1000 : 500,
  );
  const v = symbol === 'ES' ? 100 : 50;
  await bar(symbol, `${date}T${openHour}:30:00Z`, ref, v);
  await bar(symbol, `${date}T${openHour}:31:00Z`, ref, v);
  await bar(symbol, `${date}T${openHour + 1}:30:00Z`, now, v);
}

type SnapshotValuesTuple = [
  number,
  number | null,
  number | null,
  number | null,
];

async function snapshotRow(
  symbol: string,
  ts: string,
  tradeDate: string,
  v: SnapshotValuesTuple,
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

/** The auto-filled JSON the cron stores, with one extra key a merge must keep. */
const autoFilled = (h: number, l: number, c: number, v: number | null) => ({
  globexHigh: h,
  globexLow: l,
  globexClose: c,
  globexVwap: v,
  savedAt: '2026-05-13T13:30:30.000Z',
  autoFilled: true,
  extra: 7,
});

/** A Phase 2 backup row as the repair tool writes it: the pre-repair values as text. */
function backupLine(
  op: 'update' | 'delete',
  symbol: string,
  ts: string,
  v: { close: number; volume?: number; high?: number; low?: number },
): string {
  return JSON.stringify({
    op,
    reason: 'tick_span',
    row: {
      id: '1',
      symbol,
      ts,
      open: String(v.close),
      high: String(v.high ?? v.close),
      low: String(v.low ?? v.close),
      close: String(v.close),
      volume: String(v.volume ?? 100),
      buy_volume: null,
    },
  });
}

/** What Phase 2 changed, as far as this fixture is concerned. */
const BACKUP = [
  // S1: the ES 14:30 bar's close was 7067 (price, 1h and day change), and the
  // 13:30 bar's volume was 90 (the volume ratio).
  backupLine('update', 'ES', '2026-04-14T14:30:00Z', { close: 7067 }),
  backupLine('update', 'ES', '2026-04-14T13:30:00Z', {
    close: 7000,
    volume: 90,
  }),
  // S3: the NQ close only; its volumes were right, so its volume ratio is not repaired.
  backupLine('update', 'NQ', '2026-04-14T14:30:00Z', {
    close: 24100,
    volume: 50,
  }),
  // S6: a bar that Phase 2 deleted, where the snapshot's latest bar was.
  backupLine('delete', 'ES', '2026-05-14T14:30:00Z', { close: 7500 }),
  // P1: the overnight bar's high was 7300.
  backupLine('update', 'ES', '2026-05-12T23:00:00Z', {
    close: 7200,
    high: 7300,
    low: 7100,
  }),
  // Saturday 04-11 junk bars Phase 2 deleted, which priced the Sunday 04-12 rows.
  backupLine('delete', 'ES', '2026-04-11T19:52:00Z', {
    close: 8283.5,
    volume: 10,
  }),
  backupLine('delete', 'RTY', '2026-04-11T15:40:00Z', {
    close: 2800.1,
    volume: 10,
  }),
].join('\n');

interface Ids {
  s1: number; // ES 04-14, bad everywhere, all four fields repair-affected
  s2: number; // ES 05-12, already right, nothing affected
  s3: number; // NQ 04-14, bad everywhere, volume ratio NOT affected
  s4: number; // ES 06-24, stale recompute, nothing affected
  s6: number; // ES 05-14, stale recompute, price affected (a deleted bar)
  info: number; // ES 10-20, before the control: a late bar (the price is an older bar's close)
  s5: number; // ES 10-06, before the control: only the volume ratio differs, inside the September window
  s7: number; // ES 10-21, before the control: only the volume ratio differs, outside the window
  s8: number; // ES 10-22, before the control: a price miss that is no late bar
  s9: number; // ES 05-15, 16:31 CT: stale, price affected, in the daily break
  s10: number; // ES Sunday 04-12, stores a deleted junk bar's close: found by value
  s11: number; // RTY Sunday 04-12, the same for a root Phase 2 only deleted bars of
  p1: number; // 05-13 auto-filled, bad high, a repaired bar in the window
  p1hand: number; // 05-13 hand-saved
  p2: number; // 05-14 auto-filled, already right
  p3: number; // 05-15 auto-filled, no bars
  p4: number; // 05-27 auto-filled, differs but no repaired bar in the window
  pc: number; // 06-17, outside the span, equal
  pw: number; // 06-18, outside the span, narrower than today's bars
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

const CONTROL_DAYS = ['2026-11-03', '2026-11-04', '2026-11-05'];
interface ControlRow {
  symbol: (typeof FUTURES_SYMBOLS)[number];
  ts: string;
  tradeDate: string;
  values: SnapshotValuesTuple;
}
/** What computeSnapshot returns for the clean-era rows: computed once, reinserted by every reset. */
const controlRows: ControlRow[] = [];

const ROOT_PRICE: Record<(typeof FUTURES_SYMBOLS)[number], number> = {
  ES: 7000,
  NQ: 24000,
  RTY: 2000,
  CL: 70,
  GC: 3000,
  ZN: 110,
};

/** Bars 13:00Z to 21:30Z for each control day (EST), every symbol. */
async function controlBars(): Promise<void> {
  const rows: [string, string, number, number][] = [];
  for (const [d, date] of ['2026-11-02', ...CONTROL_DAYS].entries()) {
    for (const symbol of FUTURES_SYMBOLS) {
      const base = ROOT_PRICE[symbol];
      // A bar every 5 minutes is enough: the snapshots at :31:21, :36:21 ... each see
      // a latest closed bar a minute old, an hour-ago bar and a day-open bar.
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

async function seedControlSnapshots(): Promise<void> {
  await pg.query(
    `INSERT INTO futures_snapshots (trade_date, ts, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     SELECT d, t, s, p, a, b, c FROM unnest($1::date[], $2::timestamptz[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[]) AS x(d, t, s, p, a, b, c)`,
    [
      controlRows.map((r) => r.tradeDate),
      controlRows.map((r) => r.ts),
      controlRows.map((r) => r.symbol),
      controlRows.map((r) => r.values[0]),
      controlRows.map((r) => r.values[1]),
      controlRows.map((r) => r.values[2]),
      controlRows.map((r) => r.values[3]),
    ],
  );
}

async function reset(): Promise<void> {
  await pg.query(
    `TRUNCATE futures_bars, index_candles_1m, market_snapshots,
              futures_snapshots, ws_gamma_setup_fires, touch_log
     RESTART IDENTITY`,
  );
  const right: SnapshotValuesTuple = [7007, 0.1, 0.1, 0.4615];

  // In-range snapshots (EDT: the cash open is 13:30Z).
  await snapshotDay('ES', '2026-04-14', '2026-04-13', 7000, 7007);
  await snapshotDay('NQ', '2026-04-14', '2026-04-13', 24000, 24024);
  await snapshotDay('ES', '2026-05-12', '2026-05-11', 7000, 7007);
  await snapshotDay('ES', '2026-10-20', '2026-10-19', 7000, 7007);
  await bar('ES', '2026-10-20T14:27:00Z', 7001, 10); // a bar that landed late
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
    '2026-06-24T14:31:30.250Z',
    '2026-06-24',
    [7000, 0, 0, 1],
  );
  const s6 = await snapshotRow(
    'ES',
    '2026-05-14T14:31:30.250Z',
    '2026-05-14',
    [7500, 0, 0, 1],
  );
  // Before the control window: the stored price is the close of an older bar.
  const info = await snapshotRow(
    'ES',
    '2026-10-20T14:31:30.250Z',
    '2026-10-20',
    [7001, 0.1, 0.1, 0.4615],
  );
  // Only the volume ratio is off. The 20-day window of 10-06 reaches the
  // September outage; the window of 10-21 does not.
  await snapshotDay('ES', '2026-10-06', '2026-10-05', 7000, 7007);
  const s5 = await snapshotRow(
    'ES',
    '2026-10-06T14:31:30.250Z',
    '2026-10-06',
    [7007, 0.1, 0.1, 0.9999],
  );
  await snapshotDay('ES', '2026-10-21', '2026-10-20', 7000, 7007);
  // An older bar that closed at the stored price too: a late bar is not needed to explain it.
  await bar('ES', '2026-10-21T14:28:00Z', 7007, 1);
  const s7 = await snapshotRow(
    'ES',
    '2026-10-21T14:31:30.250Z',
    '2026-10-21',
    [7007, 0.1, 0.1, 0.1111],
  );

  // Stale, with the deleted 05-14 bar still before it, and inside the 16:15-17:00 CT break.
  const s9 = await snapshotRow(
    'ES',
    '2026-05-15T21:31:30.250Z',
    '2026-05-15',
    [7500, 0, 0, 1],
  );
  // Sunday 04-12 after the reopen: the old writer had no freshness gate, so its
  // price was the Saturday junk bar's close (8283.5, deleted by Phase 2 27 hours
  // earlier) and the real reopen bars landed in the table later. The bars'
  // volumes make 04-12 a day of 650, so the 04-14 average stays 650.
  for (const [symbol, base] of [
    ['ES', 6769.5],
    ['RTY', 2000],
  ] as const) {
    await bar(symbol, '2026-04-12T22:27:00Z', base, 300);
    await bar(symbol, '2026-04-12T22:28:00Z', base + 0.5, 300);
    await bar(symbol, '2026-04-12T22:29:00Z', base + 1.75, 50);
  }
  const s10 = await snapshotRow(
    'ES',
    '2026-04-12T22:30:02.641Z',
    '2026-04-12',
    [8283.5, 0, null, null],
  );
  const s11 = await snapshotRow(
    'RTY',
    '2026-04-12T22:30:02.641Z',
    '2026-04-12',
    [2800.1, 0, null, null],
  );
  // A price that matches no bar near the latest closed one: not a late bar.
  await snapshotDay('ES', '2026-10-22', '2026-10-21', 7000, 7007);
  const s8 = await snapshotRow(
    'ES',
    '2026-10-22T14:31:30.250Z',
    '2026-10-22',
    [7099, 0.1, 0.1, 0.4615],
  );

  // The clean era (EST): bars, and the snapshots the cron would have written.
  await controlBars();
  if (controlRows.length === 0) {
    for (const symbol of FUTURES_SYMBOLS) {
      for (const date of CONTROL_DAYS) {
        for (let m = 15 * 60 + 31; m <= 21 * 60 + 26; m += 5) {
          const ts = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:21.500Z`;
          const result = await computeSnapshot(symbol, date, new Date(ts));
          if (result.kind !== 'fresh')
            throw new Error(`control row ${ts} is not fresh`);
          const s = result.snapshot;
          const r4 = (x: number | null) =>
            x == null ? null : roundNumeric(x, 4);
          controlRows.push({
            symbol,
            ts,
            tradeDate: date,
            values: [
              s.price,
              r4(s.change1hPct),
              r4(s.changeDayPct),
              r4(s.volumeRatio),
            ],
          });
        }
      }
    }
  }
  await seedControlSnapshots();

  // Pre-market: ES overnight bars. 05-13 window: H 7250, L 7100, last close
  // 7205, vwap (7200*100 + 7205*300) / 400 = 7203.75.
  await bar('ES', '2026-05-12T23:00:00Z', 7200, 100, [7250, 7100]);
  await bar('ES', '2026-05-13T03:00:00Z', 7205, 300, [7210, 7190]);
  await bar('ES', '2026-05-14T05:00:00Z', 7290, 200, [7300, 7280]);
  await bar('ES', '2026-05-27T04:00:00Z', 7400, 100, [7410, 7390]);
  await bar('ES', '2026-06-17T04:00:00Z', 7390, 100, [7400, 7380]);
  await bar('ES', '2026-06-18T04:00:00Z', 7490, 100, [7500, 7480]);
  // P1 stored the pre-repair high 7300 and the right vwap, so the bars as they
  // were before Phase 2 reproduce it.
  const p1 = await premarketRow(
    '2026-05-13',
    '8:30 AM CT',
    autoFilled(7300, 7100, 7205, 7203.75),
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
  const p4 = await premarketRow(
    '2026-05-27',
    'pre-market',
    autoFilled(7405, 7390, 7400, 7400),
  );
  const pc = await premarketRow(
    '2026-06-17',
    'pre-market',
    autoFilled(7400, 7380, 7390, 7390),
  );
  const pw = await premarketRow(
    '2026-06-18',
    'pre-market',
    autoFilled(7495, 7485, 7490, 7490),
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
    s6,
    info,
    s5,
    s7,
    s8,
    s9,
    s10,
    s11,
    p1,
    p1hand,
    p2,
    p3,
    p4,
    pc,
    pw,
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
    backup: backupPath,
    expectSnapshots: 4,
    expectPremarket: 1,
    expectFires: 3,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    ...over,
  };
}
/** What the snapshot control line says: a thin root's miss counts when a late bar explains it. */
const CONTROL_LABEL =
  'control set matches (a thin root: or is explained by a late bar)';

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
    `SELECT id::text AS id FROM touch_log WHERE tbl = $1 ORDER BY touch_log.id`,
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
  backupPath = join(dir, 'phase2-backup.jsonl');
  writeFileSync(backupPath, `${BACKUP}\n`);
  hooks.calls = [];
  hooks.plainFetch = [];
  hooks.beforeWrite = null;
  hooks.failRead = null;
  hooks.failWriteAt = null;
  hooks.dropWrites = false;
  hooks.plainReadOnly = true;
  hooks.shortBackup = false;
  hooks.writes = 0;
  await reset();
  // The first reset computes the clean-era snapshots through computeSnapshot.
  hooks.calls = [];
  hooks.plainFetch = [];
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stale rows that are not junk-priced although a repaired bar is behind them:
 * a stale row priced from a real bar (the close of the 05-12 14:30 bar), one
 * priced from a bar whose close Phase 2 changed (04-14 14:30, 7067 then, 7007
 * now), and one whose price is a real bar's but whose 1h change reconstructs the
 * close of the deleted 05-14 bar.
 */
async function staleRowsNotJunk(): Promise<{
  real: number;
  changed: number;
  hourOnly: number;
}> {
  return {
    real: await snapshotRow(
      'ES',
      '2026-05-12T21:31:30.250Z',
      '2026-05-12',
      [7007, 0, 0, 1],
    ),
    changed: await snapshotRow(
      'ES',
      '2026-04-14T20:31:30.250Z',
      '2026-04-14',
      [7067, 0, 0, 1],
    ),
    hourOnly: await snapshotRow(
      'ES',
      '2026-05-14T16:00:30.250Z',
      '2026-05-14',
      [7007, -6.5733, null, 1],
    ),
  };
}

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
    // Session proof: both paths read-only, and the backup that drives the attribution.
    expect(text).toContain('read-only transaction: on');
    expect(text).toContain('plain query during planning: on');
    expect(text).toContain('Phase 2 backup');
    expect(text).toContain('7 rows (4 updated, 3 deleted)');
    // Snapshots: ES has 6 rows in range, NQ 1 (S3) and RTY 1; four are written.
    expect(text).toContain('rows in range: 8, rows to write: 4');
    expect(text).toContain(
      'ES: rows in range 6, rows to write 2 (price=2 change1hPct=2 changeDayPct=1 volumeRatio=2)',
    );
    expect(text).toContain(
      'NQ: rows in range 1, rows to write 1 (price=1 change1hPct=1 changeDayPct=1 volumeRatio=0)',
    );
    // RTY: Phase 2 only deleted its Saturday junk bars, and one priced the Sunday row.
    expect(text).toContain(
      'RTY: rows in range 1, rows to write 1 (price=1 change1hPct=1 changeDayPct=0 volumeRatio=1)',
    );
    // The value rule finds the two Sunday rows that the ruling 1 rule cannot
    // (the junk bar is older than today's latest closed bar).
    expect(
      text.match(
        /newly affected by the value rule \(the stored input found by value, a bar Phase 2 deleted or changed\): 1 rows \(price=1 change1hPct=1 changeDayPct=1 volumeRatio=0\), matched bars deleted 1, close-changed 0/g,
      ),
    ).toHaveLength(2);
    expect(text).toMatch(
      /ES 2026-04-12T22:30:02\.641Z id \d+: stored price matches the deleted bar of 2026-04-11T19:52:00Z \(close 8283\.5 before Phase 2, gone now\), 1598 min older; newly affected: price, change1hPct, changeDayPct/,
    );
    // Each Sunday row matched a bar 27 hours older: over the 15-minute gate and over 60 minutes.
    expect(
      text.match(
        /matched bars older than the 15-minute gate: deleted 1, close-changed 0; older than 60 min: deleted 1, close-changed 0/g,
      ),
    ).toHaveLength(2);
    // The largest written price difference is the ES Sunday row.
    expect(text).toMatch(
      /ES 2026-04-12T22:30:02\.641Z id \d+ price\/1h\/day\/vr 8283\.5\/0\/null\/null -> 6771\.25\/null\/null\/1 \[writes price, change1hPct, volumeRatio\]/,
    );
    // The largest price differences that are not written, with the flag over 0.15%.
    expect(text).toContain('the 3 largest price differences not written');
    expect(text).toMatch(
      /ES 2026-05-14T14:31:30\.250Z id \d+: stored 7500, recomputed 7290, difference 210\.00, left alone, stale \(a field is affected\), against the latest closed bar \[over 0\.15% of the price\]/,
    );
    expect(text).toContain('unmatched (no pre-repair bar matched');
    // The NQ volume ratio is stored 0.3, today's method says 0.4615, and no
    // repaired bar feeds it: information, not written.
    expect(text).toMatch(
      /unaffected fields where today's method differs[^\n]*: price=0 change1hPct=0 changeDayPct=0 volumeRatio=1/,
    );
    // S6 is stale with an affected price (a deleted bar); S4 is stale with nothing affected.
    expect(text).toContain(
      'left alone, stale or missing recompute: 2 with an affected field, 1 with none',
    );
    expect(text).toMatch(
      /id \d+ price\/1h\/day\/vr 7500\/0\/0\/1 -> stale[^\n]*\[affected: /,
    );
    // The method control: every clean-era row, 216 per symbol over 3 days.
    expect(text).toContain(
      'rows from 2026-11-02T00:00:00Z: 216 of 216 match over 3 days',
    );
    expect(text).toContain(`${CONTROL_LABEL}: 1296 of 1296 (100.0%)`);
    expect(text).toContain('matched/rows by month: 2026-11 1296/1296');
    // The largest written price diff is the NQ row: 24100 -> 24024.
    expect(text).toMatch(
      /NQ 2026-04-14T14:31:30\.250Z id \d+ price\/1h\/day\/vr 24100\/0.9\/1\/0.3 -> 24024\/0.1\/0.1\/0.4615 \[writes price, change1hPct, changeDayPct\]/,
    );
    // Information window: every row before the control start, one class each.
    expect(text).toContain(
      'information, ES, rows 2026-10-02T00:00:00Z to 2026-11-02T00:00:00Z (every row, not gated): 4 rows, 0 match, 4 do not',
    );
    expect(text).toContain(
      'mismatches by class: september-window 1, late-bar 1, unexplained 2',
    );
    // The 10-20 row stores the close of the 14:27 bar; the latest closed bar is 14:30.
    expect(text).toContain(
      'late-bar age, minutes older than the latest closed bar: min 3, median 3, p90 3, max 3 (1:0 2:0 3:1 4:0',
    );
    expect(text).toContain(
      'by day, matched/rows (september-window/late-bar/unexplained): 10-06 0/1 (1/0/0), 10-20 0/1 (0/1/0), 10-21 0/1 (0/0/1), 10-22 0/1 (0/0/1)',
    );
    expect(text).toContain(
      'unexplained rows whose stored price equals the latest closed bar and also an older bar (late-bar only under a looser rule): 1',
    );
    expect(text).toContain('UNEXPLAINED rows, first 2 of 2');
    // The one price miss that is not a late bar is named, with every field.
    expect(text).toContain(
      'price misses that are not late bars: 1 (first 1, every field, * where it differs)',
    );
    expect(text).toMatch(
      /ES 2026-10-22T14:31:30\.250Z id \d+: price 7099 -> 7007 \*, change1hPct 0\.1 -> 0\.1, changeDayPct 0\.1 -> 0\.1, volumeRatio 0\.4615 -> [\d.]+/,
    );
    // The volume-ratio writes: ES one (0.3 -> 0.4615), NQ none.
    expect(text).toContain(
      'volume-ratio writes: 2; |relative change| median 53.83%, p90 53.83%, max 53.83%; under 1%: 0; from or to null: 1',
    );
    expect(text).toContain('volume-ratio writes: 1; from or to null: 1');
    expect(text).toContain('volume-ratio writes: 0; from or to null: 0');
    // The stale row with an affected field (S6, a deleted bar), broken down.
    expect(text).toContain(
      'the 2 with an affected field (kept as stored): stale 2, missing 0; by affected field price=2 change1hPct=2 changeDayPct=2 volumeRatio=2; in the 16:15-17:00 CT daily break 1, elsewhere 1; first and last date 2026-05-14 to 2026-05-15',
    );
    expect(text).toMatch(
      /ES 2026-10-21T14:31:30\.250Z id \d+: price 7007 -> 7007, change1hPct 0\.1 -> 0\.1, changeDayPct 0\.1 -> 0\.1, volumeRatio 0\.1111 -> 0\.\d+ \*/,
    );
    expect(text).toContain(
      'information, NQ, rows 2026-10-02T00:00:00Z to 2026-11-02T00:00:00Z (every row, not gated): 0 rows, 0 match, 0 do not',
    );
    // Pre-market: 4 auto-filled rows in scope, 1 written, 1 equal, 1 not affected, 1 with no bars.
    expect(text).toContain(
      'rows in scope: 4, rows to write: 1, equal to the recompute: 1',
    );
    expect(text).toContain(
      'differ from the recompute with no repaired bar in the window (not written): 1',
    );
    expect(text).toContain('2026-05-27');
    expect(text).toContain(
      `2026-05-13 id ${ids.p1} (8:30 AM CT) 7300/7100/7205/7203.75 -> 7250/7100/7205/7203.75 [pre-repair bars reproduce the stored values]`,
    );
    expect(text).toContain('2026-05-15 id');
    expect(text).toContain('no overnight bars');
    // The subset check over the two rows outside the span.
    expect(text).toContain('subset check holds for: 2 of 2 (100.0%)');
    expect(text).toContain('exact four-key match (information): 1 of 2');
    // Fires: 5 with a value in scope (F4 is NULL), 3 change, 2 gate flips.
    expect(text).toMatch(/rows in scope: 5, rows to change: 3/);
    expect(text).toContain(': 2 (1 pcs_monday)');
    expect(text).toContain(
      `fire ${ids.f1} 2026-06-01T15:00:00Z pcs_monday 0.2 -> 0.5: blocked -> passes`,
    );
    expect(text).toContain(
      `fire ${ids.f2} 2026-06-02T15:00:00Z e1_long_call 0.9 -> 0.25: passed -> blocked`,
    );
    expect(text).toContain('Apply gate: every check passes.');
  });

  it('runs only the stores it was given, and needs no backup for fires alone', async () => {
    expect(await dry({ stores: ['fires'], backup: null })).toBe(0);
    const text = report();
    expect(text).toContain('ws_gamma_setup_fires.es_basis_change_5m');
    expect(text).not.toContain('futures_snapshots (ES, NQ)');
    expect(text).not.toContain('market_snapshots.pre_market_data');
    expect(text).not.toContain('Phase 2 backup');
    // The command names only the planned store, and offers no junk delete (it needs snapshots).
    expect(text).toContain(
      `--apply --work-dir ${workDir} --stores fires --expect-fires 3`,
    );
    expect(text).not.toContain('--delete-junk-stale');
  });

  it('reports the stale rows priced from a deleted junk bar, and the command that would delete them', async () => {
    // A bar on 05-15 gives that day's stale row a different latest closed bar
    // (7300, 200 away) from the 05-14 row's (the 05:00 bar, 7290, 210 away).
    await bar('ES', '2026-05-15T20:00:00Z', 7300, 10);
    // Stale rows with a repaired bar behind them that are not priced from a deleted one.
    const { real, changed, hourOnly } = await staleRowsNotJunk();
    const before = await dump();
    expect(await dry()).toBe(0);
    expect(await dump()).toBe(before);
    const lines = report().split('\n');
    const at = lines.findIndex((l) =>
      l.includes('stale rows priced from a deleted junk bar'),
    );
    // The heading and the indented lines under it, up to the next section.
    const under: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith('    ')) break;
      under.push(l);
    }
    const block = under.join('\n');
    expect(lines[at]).toBe(
      '  stale rows priced from a deleted junk bar (not recomputable; --delete-junk-stale deletes them, off by default): 2',
    );
    expect(block).toContain(
      "ES: 2, first 2026-05-14T14:31:30.250Z, last 2026-05-15T21:31:30.250Z; |stored - the latest closed bar's close| min 200.00, median 210.00, max 210.00",
    );
    expect(block).toContain(
      `ES 2026-05-14T14:31:30.250Z id ${ids.s6}: stored price 7500, the deleted bar of 2026-05-14T14:30:00Z closed at 7500; the latest closed bar then closed at 7290`,
    );
    expect(block).toContain(
      `ES 2026-05-15T21:31:30.250Z id ${ids.s9}: stored price 7500, the deleted bar of 2026-05-14T14:30:00Z closed at 7500; the latest closed bar then closed at 7300`,
    );
    // Not the stale row priced from a real bar, the stale row nothing matches, or the fresh Sunday rows.
    for (const id of [real, changed, hourOnly, ids.s4, ids.s10, ids.s11]) {
      expect(block).not.toContain(`id ${id}:`);
    }
    // One command, the delete's count next to the three totals.
    const text = report();
    const apply = `npx tsx scripts/recompute-futures-derived.ts --apply --work-dir ${workDir} --backup ${backupPath} --expect-snapshots 4 --expect-premarket 1 --expect-fires 3`;
    expect(text).toContain(
      `each total is the count above):\n  ${apply} --delete-junk-stale --expect-junk-deletes 2\n`,
    );
    expect(text).not.toContain('without it');
  });

  it("lists every match to a bar whose close Phase 2 changed, with the bar's age and a mark over 60 minutes", async () => {
    // The 14:30 bar of 04-14 closed at 7067 before Phase 2 and 7007 now. A newer,
    // unrepaired bar exists, so only the value rule finds it. The rows are 17, 60,
    // 61 and 91 minutes after it.
    await bar('ES', '2026-04-14T14:45:00Z', 7010, 10);
    const at = async (ts: string) =>
      snapshotRow('ES', ts, '2026-04-14', [7067, 0, 0, 1]);
    const near = await at('2026-04-14T14:46:30.250Z');
    const edge = await at('2026-04-14T15:30:00.000Z');
    const over = await at('2026-04-14T15:31:00.000Z');
    const far = await at('2026-04-14T16:00:30.250Z');
    expect(await dry()).toBe(0);
    const text = report();
    expect(text).toContain(
      "all 4 matches to a bar whose close Phase 2 changed (the matched bar's age; over 60 min is marked a probable coincidence, 2 of them):",
    );
    // Four close-changed matches, all over the 15-minute gate, two over 60 minutes;
    // the Sunday deleted-bar match is counted beside them.
    expect(text).toContain(
      'matched bars older than the 15-minute gate: deleted 1, close-changed 4; older than 60 min: deleted 1, close-changed 2',
    );
    const matched = (id: number, ts: string, age: string) =>
      `ES ${ts} id ${id}: stored price 7067 matches the close-changed bar of 2026-04-14T14:30:00Z (close 7067 before Phase 2, 7007 now), ${age}`;
    expect(text).toContain(
      `${matched(near, '2026-04-14T14:46:30.250Z', '17 min older')}\n`,
    );
    expect(text).toContain(
      `${matched(edge, '2026-04-14T15:30:00Z', '60 min older')}\n`,
    );
    expect(text).toContain(
      `${matched(over, '2026-04-14T15:31:00Z', '61 min older, probable coincidence')}\n`,
    );
    expect(text).toContain(
      matched(
        far,
        '2026-04-14T16:00:30.250Z',
        '91 min older, probable coincidence',
      ),
    );
  });

  it('counts the rows whose stored price matches no pre-repair bar and differs from the recompute by over 0.15%, and writes nothing for them', async () => {
    // The latest closed bar of the 14:3x rows gives 7007. 7100 is no bar's close and
    // 1.3% off: listed. 6990 is a real bar's close (the prior-day bar), 0.24% off: a
    // value match, so not listed. 7005 is no bar's close but 0.03% off: under the
    // mark. 7099 on 04-14 is no bar's close and 1.3% off, but its latest closed bar
    // was repaired, so the price is written, not left alone.
    const id = await snapshotRow(
      'ES',
      '2026-05-12T14:32:00.250Z',
      '2026-05-12',
      [7100, 0.1, 0.1, 0.4615],
    );
    const real = await snapshotRow(
      'ES',
      '2026-05-12T14:33:00.250Z',
      '2026-05-12',
      [6990, 0.1, 0.1, 0.4615],
    );
    const small = await snapshotRow(
      'ES',
      '2026-05-12T14:34:00.250Z',
      '2026-05-12',
      [7005, 0.1, 0.1, 0.4615],
    );
    const written = await snapshotRow(
      'ES',
      '2026-04-14T14:31:50.250Z',
      '2026-04-14',
      [7099, 0.1, 0.1, 0.4615],
    );
    const before = await dump();
    expect(await dry()).toBe(0);
    expect(await dump()).toBe(before);
    const text = report();
    expect(text).toContain(
      'stored price matches no pre-repair bar and differs from the recompute by over 0.15% (not written; the open D1 question): 1 rows',
    );
    expect(text).toContain(
      `ES 2026-05-12T14:32:00.250Z id ${id}: stored 7100, recomputed 7007, difference 93.00`,
    );
    // Neither the other three rows nor any other root is in it.
    const lines = text.split('\n');
    const at = lines.findIndex((l) =>
      l.includes('the open D1 question): 1 rows'),
    );
    const block: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith('      ')) break;
      block.push(l);
    }
    for (const other of [real, small, written]) {
      expect(block.join('\n')).not.toContain(`id ${other}:`);
    }
    expect(text).toContain('the open D1 question): 0 rows');
    // The drift list: the three recomputable rows whose price is not written,
    // the largest first; 7100 and 6990 are over 0.15%, 7005 is not. The stale
    // rows left alone are not in it.
    expect(text).toContain(
      'the 3 largest price drifts on rows that can be recomputed (price not affected, not written; 2 rows over 0.15% of the price):',
    );
    expect(text).toContain(
      `ES 2026-05-12T14:32:00.250Z id ${id}: stored 7100, recomputed 7007, difference 93.00, recomputable, price not affected [over 0.15% of the price]`,
    );
    expect(text).toContain(
      `ES 2026-05-12T14:34:00.250Z id ${small}: stored 7005, recomputed 7007, difference 2.00, recomputable, price not affected\n`,
    );
    expect(text).toContain(
      'the 0 largest price drifts on rows that can be recomputed',
    );
    // The 04-14 row is written (three ES rows now), the others are not.
    expect(text).toContain('ES: rows in range 10, rows to write 3 (');
  });

  it('attributes a row with no value match to the merge state of a repaired bar, leaves a row that matches an unrepaired bar, and writes every bar to merge-state.txt', async () => {
    // A bar Phase 2 changed at 14:25, five minutes before the latest closed bar
    // (14:30): it was 7000..7120 before (a merged range) and 7005 now.
    await snapshotDay('ES', '2026-05-19', '2026-05-18', 7000, 7007);
    await bar('ES', '2026-05-19T14:25:00Z', 7005, 10);
    writeFileSync(
      backupPath,
      `${BACKUP}\n${backupLine('update', 'ES', '2026-05-19T14:25:00Z', {
        close: 7050,
        high: 7120,
        low: 7000,
        volume: 10,
      })}\n`,
    );
    // A: stored 7100 is inside the merged range and no bar's close, 1.3% off.
    const a = await snapshotRow(
      'ES',
      '2026-05-19T14:32:00.250Z',
      '2026-05-19',
      [7100, 0.1, 0.1, 0.4615],
    );
    // B: the same test, only 0.01% off, and no bar's close either.
    const b = await snapshotRow(
      'ES',
      '2026-05-19T14:33:00.250Z',
      '2026-05-19',
      [7008, 0.1, 0.1, 0.4615],
    );
    // D: inside the merged range too, but 7007 is the latest bar's close, a bar
    // Phase 2 did not change: it matches by value, so the range test does not apply.
    const d = await snapshotRow(
      'ES',
      '2026-05-19T14:34:00.250Z',
      '2026-05-19',
      [7007, 0.5, 0.1, 0.4615],
    );
    // C: read the repaired bar itself, so its price is attributed by the close rule already.
    await snapshotRow(
      'ES',
      '2026-05-19T14:26:30.250Z',
      '2026-05-19',
      [7060, 0.1, 0.1, 0.4615],
    );
    expect(await dry()).toBe(0);
    const text = report();
    // A and B are added (price, 1h and day) and both are written because of it.
    expect(text).toContain(
      'the merge-state rule (a row with no value match whose stored price lies in the pre-repair [low, high] of a bar Phase 2 changed within 14 min of the latest closed bar, and not in its current range): 2 rows added (price=2 change1hPct=2 changeDayPct=2 volumeRatio=0), 2 of them in the write set because of it',
    );
    expect(text).toContain(
      `ES 2026-05-19T14:32:00.250Z id ${a}: stored 7100, recomputed 7007, merge-state (newest bar 2026-05-19T14:25:00Z)`,
    );
    expect(text).toContain(
      `ES 2026-05-19T14:33:00.250Z id ${b}: stored 7008, recomputed 7007, merge-state (newest bar 2026-05-19T14:25:00Z)`,
    );
    // D and the fixture's S1 match a bar by value: not attributed by the rule.
    expect(text).toContain(
      'rows that meet the same test but match an unrepaired bar by value (not attributed by the rule; they stay as stored): 2 (price already attributed by another rule 1; not attributed 1, of which a recompute that differs in price 0)',
    );
    expect(text).toContain('every bar of the added rows: merge-state.txt');
    // NQ was repaired too (S3), so it has the rule; the roots Phase 2 only deleted bars of do not.
    expect(text.match(/the merge-state rule \(/g)).toHaveLength(2);
    expect(text).toContain('0 rows added');
    // No ES row is left in the unmatched-large list: A and B are written.
    expect(text.match(/the open D1 question\): 0 rows/g)).toHaveLength(6);

    const detail = readFileSync(join(workDir, 'merge-state.txt'), 'utf8');
    expect(detail).toContain(
      `ES 2026-05-19T14:32:00.250Z id ${a}: stored 7100, recomputed 7007: merge-state (newest bar 2026-05-19T14:25:00Z)\n  L 2026-05-19T14:30:00Z: O/H/L/C before not in the backup, now 7007/7007/7007/7007, Phase 2 did not update it\n  L-5 min 2026-05-19T14:25:00Z: O/H/L/C before 7050/7120/7000/7050, now 7005/7005/7005/7005, Phase 2 changed it\n`,
    );

    // The apply writes A and B and leaves D alone.
    const rows = Number(
      /^ {2}rows in range: \d+, rows to write: (\d+)$/m.exec(text)?.[1],
    );
    expect(await run({ expectSnapshots: rows })).toBe(0);
    expect((await snapshotValues(a))[0]).toBe('7007.0000');
    expect((await snapshotValues(b))[0]).toBe('7007.0000');
    // D keeps its price, 1h and day change (its volume ratio is rewritten: the
    // fixture's deleted 05-14 bar is in its 20-day window).
    expect((await snapshotValues(d)).slice(0, 3)).toEqual([
      '7007.0000',
      '0.5000',
      '0.1000',
    ]);
  });

  it("reports an exact root's control miss, classified, and exits 0", async () => {
    await pg.query(
      `UPDATE futures_snapshots SET price = price + 1 WHERE id = (SELECT max(id) FROM futures_snapshots WHERE symbol = 'ES')`,
    );
    expect(await dry()).toBe(0);
    const text = report();
    expect(text).toContain(`${CONTROL_LABEL}: 1295 of 1296 (99.9%)`);
    expect(text).toContain('mismatch price: 1');
    // The miss is classified like the information window: no older bar closed at
    // the stored price, so it is unexplained.
    expect(text).toContain(
      'control misses, ES, rows from 2026-11-02T00:00:00Z (the control must be 100%): 216 rows, 215 match, 1 do not',
    );
    expect(text).toContain(
      'mismatches by class: september-window 0, late-bar 0, unexplained 1',
    );
    expect(text).toContain('APPLY WOULD REFUSE');
  });

  describe('the method control of a thin root', () => {
    const AT = '2026-11-03T15:31:21.500Z';
    const THIN_LINE = (counts: string, rows = 216) =>
      `GC thin-root control (a miss passes when a late bar explains it): ${rows} rows, ${counts}`;

    /** Sets columns of one root's 11-03 15:31:21.5Z control row. */
    const setRow = (symbol: string, set: string) =>
      pg.query(
        `UPDATE futures_snapshots SET ${set} WHERE symbol = $1 AND ts = $2`,
        [symbol, AT],
      );
    /** The close of the bar at `ts`; the latest closed bar of the row is the one of 15:30. */
    const closeAt = async (symbol: string, ts: string): Promise<string> =>
      (
        await pg.query<{ c: string }>(
          `SELECT close::text AS c FROM futures_bars WHERE symbol = $1 AND ts = $2`,
          [symbol, ts],
        )
      ).rows[0]!.c;

    it("passes a miss explained by a late bar: the stored price is an older bar's close", async () => {
      await setRow(
        'GC',
        `price = ${await closeAt('GC', '2026-11-03T15:25:00Z')}`,
      );
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(`${CONTROL_LABEL}: 1296 of 1296 (100.0%)`);
      expect(text).toContain(
        THIN_LINE('215 exact, late-bar 1, late-volume 0, other 0'),
      );
      expect(text).toContain(
        'late-bar age, minutes older than the latest closed bar: min 5, median 5, p90 5, max 5',
      );
      expect(text).toContain('Apply gate: every check passes.');
    });

    it('passes a miss explained by a late volume: price, 1h and day match and the stored ratio is below', async () => {
      await setRow('GC', 'volume_ratio = volume_ratio - 0.01');
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 1, other 0'),
      );
      expect(text).toContain('Apply gate: every check passes.');
    });

    it('passes a stored volume ratio one unit above the recomputed one: a prior-day fill lowers the ratio', async () => {
      await setRow('GC', 'volume_ratio = volume_ratio + 0.0001');
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 1, other 0'),
      );
      expect(text).toContain('Apply gate: every check passes.');
    });

    it('refuses a stored volume ratio more than one unit above the recomputed one', async () => {
      await setRow('GC', 'volume_ratio = volume_ratio + 0.01');
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 0, other 1'),
      );
      expect(text).toContain('OTHER rows, first 1 of 1');
      expect(text).toMatch(
        /GC 2026-11-03T15:31:21\.500Z id \d+: price [\d.]+ -> [\d.]+, change1hPct [-\d.]+ -> [-\d.]+, changeDayPct [-\d.]+ -> [-\d.]+, volumeRatio [\d.]+ -> [\d.]+ \*/,
      );
      expect(text).toContain(
        `APPLY WOULD REFUSE:\n  snapshots: ${CONTROL_LABEL} 1295 of 1296 (99.9%), not 100%`,
      );
    });

    it('refuses a 1h miss on a row whose price matches', async () => {
      await setRow('GC', 'change_1h_pct = change_1h_pct + 0.5');
      expect(await dry()).toBe(0);
      expect(report()).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 0, other 1'),
      );
      expect(report()).toContain('APPLY WOULD REFUSE');
    });

    it('refuses a price miss that no older bar explains', async () => {
      await setRow('GC', 'price = price + 1');
      expect(await dry()).toBe(0);
      expect(report()).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 0, other 1'),
      );
      expect(report()).toContain('APPLY WOULD REFUSE');
    });

    it('refuses a price that is the close of a bar more than 14 minutes older than the latest closed one', async () => {
      // The bar of 15:15 is 15 minutes older than the latest closed bar (15:30).
      await setRow(
        'GC',
        `price = ${await closeAt('GC', '2026-11-03T15:15:00Z')}`,
      );
      expect(await dry()).toBe(0);
      expect(report()).toContain(
        THIN_LINE('215 exact, late-bar 0, late-volume 0, other 1'),
      );
    });

    it('refuses a thin root row that cannot be recomputed: stale, no bar within 15 minutes', async () => {
      // After the last bar of the day (21:30Z) the latest closed bar is hours old.
      await snapshotRow(
        'GC',
        '2026-11-03T23:50:00.500Z',
        '2026-11-03',
        [3000, 0, 0, 1],
      );
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(`${CONTROL_LABEL}: 1296 of 1297`);
      expect(text).toContain(
        THIN_LINE('216 exact, late-bar 0, late-volume 0, other 1', 217),
      );
      expect(text).toMatch(
        /GC 2026-11-03T23:50:00\.500Z id \d+ price\/1h\/day\/vr 3000\/0\/0\/1 -> stale/,
      );
      expect(text).toContain('APPLY WOULD REFUSE');
    });

    it('still needs an exact match from ES and NQ: the late volume a thin root may have fails there', async () => {
      await setRow('ES', 'volume_ratio = volume_ratio - 0.01');
      expect(await dry()).toBe(0);
      const text = report();
      expect(text).toContain(`${CONTROL_LABEL}: 1295 of 1296 (99.9%)`);
      expect(text).not.toContain('ES thin-root control');
      expect(text).toContain('APPLY WOULD REFUSE');
    });

    it("refuses --apply on a thin root's unexplained miss, before any write", async () => {
      await setRow('GC', 'volume_ratio = volume_ratio + 0.01');
      const before = await dump();
      expect(await run()).toBe(1);
      expect(errored()).toMatch(
        /snapshots: control set matches \(a thin root: or is explained by a late bar\) 1295 of 1296/,
      );
      expect(hooks.writes).toBe(0);
      expect(await dump()).toBe(before);
    });

    it("lets --apply go on when a thin root's misses are all explained", async () => {
      await setRow('GC', 'volume_ratio = volume_ratio - 0.01');
      expect(await run()).toBe(0);
      expect(hooks.writes).toBeGreaterThan(0);
    });
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

  it('when the snapshot method control does not reproduce what is stored', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET volume_ratio = 0.5 WHERE id = (SELECT max(id) FROM futures_snapshots WHERE symbol = 'ES')`,
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /snapshots: control set matches \(a thin root: or is explained by a late bar\) 1295 of 1296 \(99\.9%\), not 100%/,
    );
    await expectNothingWritten(before);
  });

  it('when the method control is too small: under 200 rows or 3 days per symbol', async () => {
    await pg.query(
      `DELETE FROM futures_snapshots WHERE symbol = 'ES' AND ts >= '2026-11-04'`,
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /snapshots: ES: the method control has 72 rows over 1 days, 200 rows over 3 days are needed/,
    );
    await expectNothingWritten(before);
  });

  it("when a stored pre-market high is above what today's bars give", async () => {
    await pg.query(
      `UPDATE market_snapshots SET pre_market_data = jsonb_set(pre_market_data, '{globexHigh}', '7500') WHERE id = $1`,
      [ids.pc],
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /premarket: subset check holds for 1 of 2 \(50\.0%\), not 100%/,
    );
    expect(report()).toContain(
      'mismatch stored high above the recomputed high: 1',
    );
    await expectNothingWritten(before);
  });

  it("when a stored pre-market low is below what today's bars give", async () => {
    await pg.query(
      `UPDATE market_snapshots SET pre_market_data = jsonb_set(pre_market_data, '{globexLow}', '7370') WHERE id = $1`,
      [ids.pc],
    );
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(
      /premarket: subset check holds for 1 of 2 \(50\.0%\), not 100%/,
    );
    expect(report()).toContain(
      'mismatch stored low below the recomputed low: 1',
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

  it('when the backup file comes out short: the count in the file is checked before the first UPDATE', async () => {
    hooks.shortBackup = true;
    const before = await dump();
    expect(await run()).toBe(1);
    expect(errored()).toMatch(/backup .*backup-.* has 1 lines, expected 8/);
    expect(hooks.writes).toBe(0);
    expect(await dump()).toBe(before);
    for (const store of ALL)
      expect(existsSync(markerPath(workDir, store))).toBe(false);
  });

  it('whatever --stores says: --apply --stores fires still refuses on a failing snapshot control', async () => {
    await pg.query(
      `UPDATE futures_snapshots SET price = price + 1 WHERE id = (SELECT max(id) FROM futures_snapshots)`,
    );
    const before = await dump();
    expect(
      await run({
        stores: ['fires'],
        expectSnapshots: null,
        expectPremarket: null,
        expectFires: 3,
      }),
    ).toBe(1);
    expect(errored()).toMatch(
      /snapshots: control set matches \(a thin root: or is explained by a late bar\) 1295 of 1296 \(99\.9%\), not 100%/,
    );
    await expectNothingWritten(before);
  });

  it('whatever --stores says: --apply --stores fires still refuses on a failing pre-market subset check', async () => {
    await pg.query(
      `UPDATE market_snapshots SET pre_market_data = jsonb_set(pre_market_data, '{globexHigh}', '7500') WHERE id = $1`,
      [ids.pc],
    );
    const before = await dump();
    expect(
      await run({
        stores: ['fires'],
        expectSnapshots: null,
        expectPremarket: null,
        expectFires: 3,
      }),
    ).toBe(1);
    expect(errored()).toMatch(/premarket: subset check holds for 1 of 2/);
    await expectNothingWritten(before);
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
  it('writes only the repair-affected fields of the rows that differ, and keeps everything else', async () => {
    const hand = JSON.stringify(await premarketData(ids.p1hand));
    const untouchedP3 = JSON.stringify(await premarketData(ids.p3));
    const untouchedP4 = JSON.stringify(await premarketData(ids.p4));
    expect(await run()).toBe(0);

    // Planning ran through the read-only fetch; the writes did not (it would
    // have turned them into read-only batches).
    const writes = hooks.calls.filter((c) => !c.readOnly);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.fetchFn === undefined)).toBe(true);
    expect(hooks.plainFetch.every((f) => f === readOnlyFetch)).toBe(true);
    expect(neonConfig.fetchFunction).toBeUndefined();

    // futures_snapshots: S1 follows the recompute in all four fields; S3 in three.
    expect(await snapshotValues(ids.s1)).toEqual([
      '7007.0000',
      '0.1000',
      '0.1000',
      '0.4615',
    ]);
    // S3's volume ratio is not repaired: it keeps its stored 0.3 though today's method says 0.4615.
    expect(await snapshotValues(ids.s3)).toEqual([
      '24024.0000',
      '0.1000',
      '0.1000',
      '0.3000',
    ]);
    // The Sunday 04-12 rows stored the close of a junk bar Phase 2 deleted a
    // day earlier: ES and RTY both follow today's bars (no 1h or day change
    // exists that early in the session).
    expect(await snapshotValues(ids.s10)).toEqual([
      '6771.2500',
      null,
      null,
      '1.0000',
    ]);
    expect(await snapshotValues(ids.s11)).toEqual([
      '2001.7500',
      null,
      null,
      '1.0000',
    ]);
    // The right row, the stale rows (one with an affected price), the information row and the controls were not written.
    expect(await touches('futures_snapshots')).toEqual(
      [ids.s1, ids.s3, ids.s10, ids.s11].sort((a, b) => a - b),
    );
    expect(await snapshotValues(ids.s6)).toEqual([
      '7500.0000',
      '0.0000',
      '0.0000',
      '1.0000',
    ]);
    expect(await snapshotValues(ids.s4)).toEqual([
      '7000.0000',
      '0.0000',
      '0.0000',
      '1.0000',
    ]);
    expect(await snapshotValues(ids.info)).toEqual([
      '7001.0000',
      '0.1000',
      '0.1000',
      '0.4615',
    ]);

    // pre_market_data: only the high changes (the vwap already equals the recompute), every other key kept.
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
    // The hand-saved row on the same date, the row with no bars and the row
    // that differs with no repaired bar in its window are untouched.
    expect(JSON.stringify(await premarketData(ids.p1hand))).toBe(hand);
    expect(JSON.stringify(await premarketData(ids.p3))).toBe(untouchedP3);
    expect(JSON.stringify(await premarketData(ids.p4))).toBe(untouchedP4);

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

  it('writes the backup, with every changed row in full and only the written values, before the first write', async () => {
    let seen: string[] = [];
    hooks.beforeWrite = () => {
      if (seen.length > 0) return;
      seen = backups();
      expect(seen).toHaveLength(1);
      const lines = readFileSync(join(workDir, seen[0]!), 'utf8')
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(8); // 4 snapshots + 1 pre-market + 3 fires
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
            to: Record<string, unknown>;
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
    // S3: the recompute of the unaffected volume ratio is not in what is written.
    const s3 = lines.find((l) => l.store === 'snapshots' && l.id === ids.s3)!;
    expect(s3.to).toEqual({
      price: 24024,
      change1hPct: 0.1,
      changeDayPct: 0.1,
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

  it('--stores limits what is written: --apply --stores fires writes the fires and no snapshot or pre-market row', async () => {
    expect(
      await run({
        stores: ['fires'],
        expectSnapshots: null,
        expectPremarket: null,
        expectFires: 3,
      }),
    ).toBe(0);
    expect(await fireValue(ids.f1)).toBe('0.5');
    expect(await touches('futures_snapshots')).toEqual([]);
    expect(await touches('market_snapshots')).toEqual([]);
    expect(existsSync(markerPath(workDir, 'fires'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'premarket'))).toBe(false);
    // The report still shows every store's checks.
    expect(report()).toContain('futures_snapshots (ES, NQ, RTY, CL, GC, ZN)');
    expect(report()).toContain('Apply gate: every check passes.');
  });

  it('is idempotent: a second dry run plans no write, and a forced rerun writes nothing', async () => {
    expect(await run()).toBe(0);
    const after = await dump();
    const touched = (await pg.query(`SELECT count(*)::int AS n FROM touch_log`))
      .rows[0] as { n: number };

    expect(await dry()).toBe(0);
    expect(report()).toContain('rows in range: 8, rows to write: 0');
    expect(report()).toMatch(/rows in scope: 5, rows to change: 0/);
    expect(report()).toContain('rows in scope: 4, rows to write: 0');

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
    expect(await touches('futures_snapshots')).toEqual(
      [ids.s3, ids.s10, ids.s11].sort((a, b) => a - b),
    );
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
      /apply failed: snapshots: verify failed for snapshots: 4 of 4 row\(s\) differ/,
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

// ── Method identity with the cron ───────────────────────────────────────────

describe('--delete-junk-stale on real SQL (pglite)', () => {
  /** Rows of the whole table, by id. */
  const surviving = async (candidates: number[]): Promise<number[]> =>
    (
      await pg.query<{ id: number }>(
        `SELECT id FROM futures_snapshots WHERE id = ANY($1::int[]) ORDER BY id`,
        [candidates],
      )
    ).rows.map((r) => r.id);
  const countRows = async (): Promise<number> =>
    (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM futures_snapshots`,
      )
    ).rows[0]!.n;
  /** The options of the command the report prints: the snapshots store and the delete. */
  const junkRun = (over: Partial<RecomputeOptions> = {}) =>
    run({
      stores: ['snapshots'],
      expectPremarket: null,
      expectFires: null,
      deleteJunkStale: true,
      expectJunkDeletes: 2,
      ...over,
    });

  it('is off by default: a plain apply keeps the stale rows priced from a deleted bar', async () => {
    expect(await run()).toBe(0);
    expect(await surviving([ids.s6, ids.s9])).toEqual([ids.s6, ids.s9]);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
  });

  it('deletes exactly the scoped rows, backs them up whole first, and leaves a stale row priced from a real bar', async () => {
    const { real, changed, hourOnly } = await staleRowsNotJunk();
    const rowsBefore = await countRows();
    let backedUp: string[] = [];
    hooks.beforeWrite = (texts) => {
      // Before the first write, and so before the DELETE, the backup holds the full rows.
      if (backedUp.length > 0 || texts.some((t) => /DELETE/.test(t))) return;
      backedUp = backups();
    };
    expect(await junkRun()).toBe(0);

    expect(await surviving([ids.s6, ids.s9])).toEqual([]);
    expect(await countRows()).toBe(rowsBefore - 2);
    // Kept: the stale row priced from a real bar, the stale row nothing matches,
    // and the fresh rows priced from a deleted bar (updated, not deleted).
    expect(
      await surviving([
        real,
        changed,
        hourOnly,
        ids.s4,
        ids.s1,
        ids.s10,
        ids.s11,
      ]),
    ).toHaveLength(7);
    expect(await snapshotValues(ids.s10)).toEqual([
      '6771.2500',
      null,
      null,
      '1.0000',
    ]);

    expect(backedUp).toHaveLength(1);
    const lines = readFileSync(join(workDir, backedUp[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            store: string;
            id: number;
            op?: string;
            to: unknown;
            row: Record<string, unknown>;
          },
      );
    expect(lines).toHaveLength(6); // 4 snapshot updates + 2 deleted rows
    const deleted = lines.filter((l) => l.op === 'delete');
    expect(deleted.map((l) => l.id).sort()).toEqual([ids.s6, ids.s9].sort());
    for (const l of deleted) {
      expect(l.store).toBe('snapshots');
      expect(l.to).toBeNull();
      expect(l.row).toMatchObject({
        id: l.id,
        symbol: 'ES',
        price: 7500,
        change_1h_pct: 0,
        volume_ratio: 1,
      });
    }
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    // --stores snapshots: the other stores were not written.
    expect(await fireValue(ids.f1)).toBe('0.2');
    expect(existsSync(markerPath(workDir, 'fires'))).toBe(false);
  });

  it('refuses the flag without --expect-junk-deletes, before any write', async () => {
    const before = await dump();
    expect(await junkRun({ expectJunkDeletes: null })).toBe(1);
    expect(errored()).toMatch(
      /--delete-junk-stale needs --expect-junk-deletes J: the count of the dry run you approved/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
  });

  it('refuses a count that is not the fresh plan, before any write', async () => {
    const before = await dump();
    expect(await junkRun({ expectJunkDeletes: 3 })).toBe(1);
    expect(errored()).toMatch(
      /the fresh plan deletes 2 junk-priced rows, --expect-junk-deletes 3 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
  });

  it('fails the step, unmarked, when the delete is silently dropped', async () => {
    hooks.beforeWrite = (texts) => {
      if (texts.some((t) => /DELETE FROM futures_snapshots/.test(t))) {
        hooks.dropWrites = true;
      }
    };
    expect(await junkRun()).toBe(1);
    expect(errored()).toMatch(
      /apply failed: junk: verify failed for junk: 2 of 2 row\(s\) are still there/,
    );
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
    expect(await surviving([ids.s6, ids.s9])).toHaveLength(2);
  });

  it('leaves a row alone that changed since the plan, and says so', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /DELETE FROM futures_snapshots/.test(t))) {
        await pg.query(
          `UPDATE futures_snapshots SET price = 7501 WHERE id = $1`,
          [ids.s6],
        );
      }
    };
    expect(await junkRun()).toBe(1);
    expect(errored()).toMatch(/verify failed for junk: 1 of 2 row\(s\)/);
    expect(await surviving([ids.s6, ids.s9])).toEqual([ids.s6]);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
  });

  it('fails the step, unmarked, when the delete itself rejects: the rows stay and the backup is on disk', async () => {
    // The snapshots update is the first write, the DELETE the second.
    hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
    expect(await junkRun()).toBe(1);
    expect(errored()).toMatch(/apply failed: junk: deadlock detected/);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
    expect(await surviving([ids.s6, ids.s9])).toEqual([ids.s6, ids.s9]);
    // The snapshots store finished before the delete and is marked; the backup
    // holds the two rows that were to go.
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    const files = backups();
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(workDir, files[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { op?: string; id: number });
    expect(
      lines
        .filter((l) => l.op === 'delete')
        .map((l) => l.id)
        .sort(),
    ).toEqual([ids.s6, ids.s9].sort());
  });

  it('fails the step, unmarked, when anything else left the table during the delete', async () => {
    hooks.beforeWrite = async (texts) => {
      if (texts.some((t) => /DELETE FROM futures_snapshots/.test(t))) {
        await pg.query(`DELETE FROM futures_snapshots WHERE id = $1`, [ids.s4]);
      }
    };
    expect(await junkRun()).toBe(1);
    expect(errored()).toMatch(
      /verify failed for junk: \d+ rows in scope before, \d+ after, \d+ expected/,
    );
    expect(await surviving([ids.s6, ids.s9])).toEqual([]);
    expect(existsSync(markerPath(workDir, 'junk'))).toBe(false);
  });

  it('is done once: the marker skips it, and the fresh plan then lists no row', async () => {
    expect(await junkRun()).toBe(0);
    vi.mocked(console.log).mockClear();
    expect(await junkRun({ expectSnapshots: 0, expectJunkDeletes: 0 })).toBe(0);
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(logged).toContain(
      'the junk delete is marked done and has nothing left to delete',
    );
    expect(backups()).toHaveLength(1);
  });
});

describe('--rewrite-stale-at-write on real SQL (pglite)', () => {
  /** What the cron could not see: the table later holds bars at 14:42 and 14:58 that the stale rows missed. */
  async function frozenDay(symbol: string, date: string, prior: string) {
    await snapshotDay(symbol, date, prior, 7000, 7007);
    await bar(symbol, `${date}T14:42:00Z`, 7010, 100);
    await bar(symbol, `${date}T14:58:00Z`, 7012, 100);
  }
  const at = (
    symbol: string,
    date: string,
    time: string,
    price: number,
  ): Promise<number> =>
    snapshotRow(symbol, `${date}T${time}Z`, date, [price, 0.1, 0.1, 0.4615]);

  /**
   * 2026-06-10, a day no repaired bar's 20-day window reaches. The old bar is the
   * 14:30 one (7007); the table now also holds 14:42 (7010) and 14:58 (7012).
   * F1a-c and F1d store 7007 and FX stores 7010, all frozen on a bar over 15
   * minutes old (U2 sits between F1c and F1d, FX comes after F1d); F2 is exactly 15 minutes after the 14:30 bar; U and U2 match no
   * bar. The RTY and 06-22 rows qualify but for the thin root and the span.
   */
  async function seedStale() {
    await frozenDay('ES', '2026-06-10', '2026-06-09');
    await frozenDay('RTY', '2026-06-10', '2026-06-09');
    await frozenDay('ES', '2026-06-22', '2026-06-19');
    const ids = {
      u: await at('ES', '2026-06-10', '14:40:30.250', 7123),
      f2: await at('ES', '2026-06-10', '14:45:00.000', 7007),
      f1a: await at('ES', '2026-06-10', '14:50:00.250', 7007),
      f1b: await at('ES', '2026-06-10', '14:55:00.250', 7007),
      f1c: await at('ES', '2026-06-10', '15:00:00.250', 7007),
      u2: await at('ES', '2026-06-10', '15:02:00.250', 7123),
      f1d: await at('ES', '2026-06-10', '15:05:00.250', 7007),
      fx: await at('ES', '2026-06-10', '15:06:00.250', 7010),
      rty: await at('RTY', '2026-06-10', '14:50:00.250', 7007),
      post: await at('ES', '2026-06-22', '14:50:00.250', 7007),
    };
    return ids;
  }
  const staleRun = (over: Partial<RecomputeOptions> = {}) =>
    run({
      stores: ['snapshots'],
      expectPremarket: null,
      expectFires: null,
      rewriteStaleAtWrite: true,
      expectStaleRewrites: 5,
      ...over,
    });
  const price = async (id: number): Promise<string | null> =>
    (await snapshotValues(id))[0] ?? null;

  it('is off by default: a plain apply leaves the frozen rows, and the dry run lists them', async () => {
    const s = await seedStale();
    expect(await run()).toBe(0);
    for (const id of [s.f1a, s.f1b, s.f1c, s.fx, s.f1d]) {
      expect(['7007.0000', '7010.0000']).toContain(await price(id));
    }
    expect(existsSync(markerPath(workDir, 'stale'))).toBe(false);
  });

  it('reports the count, the largest changes with the bar age, the frozen runs and the printed command, for ES and NQ only', async () => {
    const s = await seedStale();
    const before = await dump();
    expect(await dry()).toBe(0);
    expect(await dump()).toBe(before);
    const text = report();
    expect(text).toContain(
      'stale-at-write rows (opt-in --rewrite-stale-at-write; the stored price is the close of a bar older than 15 min at the row, the recompute is fresh, nothing else writes the row): 5 in the span, 1 more after the span (not planned)',
    );
    // F1c rewrites 7007 to 7012 (the 14:30 bar is 30 minutes older), all four fields.
    expect(text).toContain(
      `ES 2026-06-10T15:00:00.250Z id ${s.f1c}: price 7007 -> 7012 (5.00), the matched bar of 2026-06-10T14:30:00Z is 30 min older; writes price, change1hPct, changeDayPct, volumeRatio`,
    );
    // FX is frozen on the 14:42 bar, 24 minutes older.
    expect(text).toContain(
      `ES 2026-06-10T15:06:00.250Z id ${s.fx}: price 7010 -> 7012 (2.00), the matched bar of 2026-06-10T14:42:00Z is 24 min older`,
    );
    // One run of three rows (F1a-c); F1d is cut off from it by U2, and FX has another price.
    expect(text).toContain(
      'frozen runs (consecutive rows with the same stored price): 1 runs hold 3 of the 5 rows; the 1 longest:',
    );
    expect(text).toContain(
      '2026-06-10T14:50:00.250Z .. 2026-06-10T15:00:00.250Z, 3 rows, price 7007',
    );
    // The thin root is not listed; ES and NQ each have the line.
    expect(text.match(/stale-at-write rows \(/g)).toHaveLength(2);
    expect(text).toContain(
      '--rewrite-stale-at-write --expect-stale-rewrites 5',
    );
    // None of F2, U, U2, the RTY row or the 06-22 row is in the list.
    for (const id of [s.f2, s.u, s.u2, s.rty, s.post]) {
      expect(text).not.toContain(`id ${id}: price`);
    }
  });

  it('rewrites the four fields of the frozen rows, backs them up first, and leaves the rest', async () => {
    const s = await seedStale();
    let backedUp: string[] = [];
    hooks.beforeWrite = () => {
      if (backedUp.length === 0) backedUp = backups();
    };
    expect(await staleRun()).toBe(0);
    // Each frozen row now says what the table's latest closed bar says.
    expect(await price(s.f1a)).toBe('7010.0000');
    expect(await price(s.f1b)).toBe('7010.0000');
    expect(await price(s.f1c)).toBe('7012.0000');
    expect(await price(s.fx)).toBe('7012.0000');
    expect(await price(s.f1d)).toBe('7012.0000');
    // F1a's hour-ago bar is 19 minutes before 13:50: no 1h change now; the day change is from the 13:30 bar.
    const [, c1, cd, vr] = await snapshotValues(s.f1a);
    expect(c1).toBeNull();
    expect(cd).toBe('0.1429');
    expect(vr).not.toBe('0.4615');
    // Not planned: exactly 15 minutes old, no matching bar, a thin root, after the span.
    for (const id of [s.f2, s.rty, s.post]) {
      expect(await price(id)).toBe('7007.0000');
    }
    for (const id of [s.u, s.u2]) {
      expect(await price(id)).toBe('7123.0000');
    }
    // The backup holds the 5 rows with the same lines as a snapshot write, besides the 4 normal ones.
    expect(backedUp).toHaveLength(1);
    const lines = readFileSync(join(workDir, backedUp[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            store: string;
            id: number;
            op?: string;
            to: Record<string, unknown> | null;
          },
      );
    expect(lines).toHaveLength(9);
    const f1c = lines.find((l) => l.id === s.f1c)!;
    expect(f1c.store).toBe('snapshots');
    expect(f1c.op).toBeUndefined();
    expect(Object.keys(f1c.to ?? {}).sort()).toEqual(
      ['changeDayPct', 'change1hPct', 'price', 'volumeRatio'].sort(),
    );
    expect(existsSync(markerPath(workDir, 'stale'))).toBe(true);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
  });

  it('refuses the flag without --expect-stale-rewrites, and a count that is not the fresh plan, before any write', async () => {
    await seedStale();
    const before = await dump();
    expect(await staleRun({ expectStaleRewrites: null })).toBe(1);
    expect(errored()).toMatch(
      /--rewrite-stale-at-write needs --expect-stale-rewrites S: the count of the dry run you approved/,
    );
    expect(await staleRun({ expectStaleRewrites: 4 })).toBe(1);
    expect(errored()).toMatch(
      /the fresh plan rewrites 5 stale-at-write rows, --expect-stale-rewrites 4 was given/,
    );
    expect(hooks.writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(await dump()).toBe(before);
    expect(existsSync(markerPath(workDir, 'stale'))).toBe(false);
  });

  it('fails the step, unmarked, when the write rejects: the rows stay and the backup is on disk', async () => {
    const s = await seedStale();
    // The snapshots update is the first write, the stale rewrite the second.
    hooks.failWriteAt = { nth: 2, error: new Error('deadlock detected') };
    expect(await staleRun()).toBe(1);
    expect(errored()).toMatch(/apply failed: stale: deadlock detected/);
    expect(existsSync(markerPath(workDir, 'stale'))).toBe(false);
    expect(existsSync(markerPath(workDir, 'snapshots'))).toBe(true);
    for (const id of [s.f1a, s.f1b, s.f1c, s.f1d]) {
      expect(await price(id)).toBe('7007.0000');
    }
    expect(backups()).toHaveLength(1);
  });

  it('is done once: the marker skips it, and the fresh plan then lists no row', async () => {
    await seedStale();
    expect(await staleRun()).toBe(0);
    vi.mocked(console.log).mockClear();
    expect(await staleRun({ expectSnapshots: 0, expectStaleRewrites: 0 })).toBe(
      0,
    );
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(logged).toContain(
      'the stale-at-write rewrite is marked done and has nothing left to rewrite',
    );
    expect(backups()).toHaveLength(1);
  });
});

describe("the pre-market recompute is the cron's own method", () => {
  it('reads the same four Globex values the cron handler stores from the same bars', async () => {
    // A fresh trade date in the span: bars for its overnight window (the cash
    // open is 13:30Z in May) and no market_snapshots row but the cron's own.
    await pg.query('TRUNCATE market_snapshots RESTART IDENTITY');
    await bar('ES', '2026-05-27T23:00:00Z', 7500.25, 120, [7512.5, 7490.75]);
    await bar('ES', '2026-05-28T02:00:00Z', 7505.5, 333, [7511, 7501.25]);
    await bar('ES', '2026-05-28T12:59:00Z', 7498.75, 77, [7506, 7497.5]);
    hooks.cronToday = '2026-05-28';
    hooks.plainReadOnly = false; // the cron writes through plain queries
    vi.mocked(console.log).mockClear();
    const res = mockResponse();
    await premarketCron(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    hooks.plainReadOnly = true;
    expect(res._json).toMatchObject({ status: 'success', stored: true });

    const { rows } = await pg.query<{ pm: Record<string, number> }>(
      `SELECT pre_market_data AS pm FROM market_snapshots WHERE date = '2026-05-28'`,
    );
    const stored = rows[0]!.pm;
    expect(stored.globexHigh).toBe(7512.5);
    expect(stored.globexLow).toBe(7490.75);
    expect(stored.globexClose).toBe(7498.75);

    // The tool's recompute finds nothing to say about that row: the same four
    // numbers, to the double (the vwap is a long decimal), whether or not a
    // repaired bar is in its window.
    writeFileSync(
      backupPath,
      `${backupLine('update', 'ES', '2026-05-28T02:00:00Z', { close: 7505.5, volume: 1, high: 7511, low: 7501.25 })}\n`,
    );
    expect(await dry({ stores: ['premarket'] })).toBe(0);
    const text = report();
    expect(text).toContain(
      'rows in scope: 1, rows to write: 0, equal to the recompute: 1',
    );
    expect(text).toContain(
      'differ from the recompute with no repaired bar in the window (not written): 0',
    );
  });
});

// ── Method identity with the snapshot cron, in daylight time ────────────────

describe("the snapshot recompute is the cron's own method in daylight time", () => {
  interface Day {
    /** Wall-clock instant the cron runs at (CDT; the cash open is 13:30Z). */
    at: string;
    /** ES bars [ts, close, volume]; NQ gets the same minutes 17000 higher. */
    bars: [string, number, number][];
    /** The latest closed bar and one volume-touched bar, as Phase 2 would have changed them. */
    changedClose: string;
    changedVolume: string;
    /** What the cron must have stored for ES: price / 1h / day / volume ratio. */
    es: [string, string | null, string | null, string | null];
  }

  /** Runs fetch-futures-snapshot at `at`: the fake clock is the cron's `now`. */
  async function runSnapshotCron(at: string) {
    vi.setSystemTime(new Date(at));
    hooks.plainReadOnly = false; // the cron writes through plain queries
    const res = mockResponse();
    try {
      await snapshotCron(
        mockRequest({
          method: 'GET',
          headers: { authorization: 'Bearer test-secret' },
        }),
        res,
      );
    } finally {
      hooks.plainReadOnly = true;
    }
    return res;
  }

  async function seed(day: Day): Promise<void> {
    // Only the cron's rows may be in range, so the report speaks of them alone.
    await pg.query(`DELETE FROM futures_snapshots WHERE ts < '2026-07-05'`);
    // ... and only this day's bars in the 20-day average.
    await pg.query(`DELETE FROM futures_bars WHERE ts < '2026-07-05'`);
    for (const [ts, close, volume] of day.bars) {
      await bar('ES', ts, close, volume);
      await bar('NQ', ts, close + 17_000, volume);
    }
    const lines = ['ES', 'NQ'].flatMap((symbol) => [
      backupLine('update', symbol, day.changedClose, { close: 1 }),
      backupLine('update', symbol, day.changedVolume, { close: 1, volume: 1 }),
    ]);
    writeFileSync(backupPath, `${lines.join('\n')}\n`);
  }

  async function storedAt(at: string, symbol: string) {
    const { rows } = await pg.query<Record<string, string | null>>(
      `SELECT id, price::text, change_1h_pct::text AS c1,
              change_day_pct::text AS cd, volume_ratio::text AS vr
         FROM futures_snapshots WHERE symbol = $1 AND ts = $2`,
      [symbol, at],
    );
    return rows[0]!;
  }

  /** The tool's method-control comparison for one stored row: exact on all four fields? */
  async function controlComparison(at: string, symbol: 'ES' | 'NQ') {
    const row = await storedAt(at, symbol);
    const num = (x: string | null | undefined) =>
      x == null ? null : Number(x);
    return compareSnapshot(
      {
        price: Number(row.price),
        change1hPct: num(row.c1),
        changeDayPct: num(row.cd),
        volumeRatio: num(row.vr),
      },
      await computeSnapshot(symbol, getETDateStr(new Date(at)), new Date(at)),
    );
  }

  const days: [string, Day][] = [
    [
      'mid-session on a CDT weekday (Wednesday 2026-05-20, 11:00 ET)',
      {
        at: '2026-05-20T16:00:21.300Z',
        bars: [
          ['2026-05-19T15:00:00Z', 6990, 1000],
          ['2026-05-20T13:30:00Z', 7000, 100],
          ['2026-05-20T15:00:00Z', 7010, 100],
          ['2026-05-20T15:59:00Z', 7030, 100],
        ],
        changedClose: '2026-05-20T15:59:00Z',
        changedVolume: '2026-05-20T15:00:00Z',
        // (7030-7010)/7010, (7030-7000)/7000, 300 / avg(1000, 300)
        es: ['7030.0000', '0.2853', '0.4286', '0.4615'],
      },
    ],
    [
      'the first hour after the day open (Thursday 2026-05-21, 09:41 ET)',
      {
        at: '2026-05-21T13:41:21.300Z',
        bars: [
          ['2026-05-20T15:00:00Z', 6990, 1000],
          ['2026-05-21T12:40:00Z', 6998, 50],
          ['2026-05-21T13:30:00Z', 7000, 100],
          ['2026-05-21T13:40:00Z', 7004, 100],
        ],
        changedClose: '2026-05-21T13:40:00Z',
        changedVolume: '2026-05-21T12:40:00Z',
        // (7004-6998)/6998, (7004-7000)/7000, 200 / avg(1000, 250)
        es: ['7004.0000', '0.0857', '0.0571', '0.3200'],
      },
    ],
    [
      'the first hour after the 17:00 CT day open (Wednesday 2026-05-20, 22:30Z, CDT)',
      {
        at: '2026-05-20T22:30:21.300Z',
        bars: [
          ['2026-05-19T15:00:00Z', 6990, 1000],
          ['2026-05-20T13:30:00Z', 7000, 100],
          ['2026-05-20T20:59:00Z', 7040, 100], // the last bar before the 16:00 CT break
          ['2026-05-20T22:00:00Z', 7050, 100], // the reopen
          ['2026-05-20T22:20:00Z', 7055, 100],
        ],
        changedClose: '2026-05-20T22:20:00Z',
        changedVolume: '2026-05-20T20:59:00Z',
        // The hour-ago bar (20:59) is 31 minutes before 21:30: no 1h change.
        // (7055-7000)/7000, 400 / avg(1000, 400)
        es: ['7055.0000', null, '0.7857', '0.5714'],
      },
    ],
  ];

  it.each(days)(
    'gives the cron and the tool the same stored values: %s',
    async (_name, day) => {
      await seed(day);
      const res = await runSnapshotCron(day.at);
      expect(res._json).toMatchObject({ stored: 2 });
      const es = await storedAt(day.at, 'ES');
      expect([es.price, es.c1, es.cd, es.vr]).toEqual(day.es);

      // The tool's method-control comparison counts both written rows as exact
      // matches on all four fields.
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
      expect(await controlComparison(day.at, 'ES')).toEqual({ kind: 'same' });
      expect(await controlComparison(day.at, 'NQ')).toEqual({ kind: 'same' });

      // Every field of both rows is repair-affected here, so any difference
      // between the cron's values and the tool's recompute would be written.
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
      expect(await dry({ stores: ['snapshots'] })).toBe(0);
      expect(report()).toContain(
        'ES: rows in range 1, rows to write 0 (price=0 change1hPct=0 changeDayPct=0 volumeRatio=0)',
      );
      expect(report()).toContain(
        'NQ: rows in range 1, rows to write 0 (price=0 change1hPct=0 changeDayPct=0 volumeRatio=0)',
      );
    },
  );

  it('would see a difference: a stored price one point off is written', async () => {
    const [, day] = days[0]!;
    await seed(day);
    await runSnapshotCron(day.at);
    await pg.query(
      `UPDATE futures_snapshots SET price = price + 1 WHERE symbol = 'ES' AND ts = $1`,
      [day.at],
    );
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    expect(await dry({ stores: ['snapshots'] })).toBe(0);
    expect(report()).toContain(
      'ES: rows in range 1, rows to write 1 (price=1 change1hPct=0 changeDayPct=0 volumeRatio=0)',
    );
  });
});
