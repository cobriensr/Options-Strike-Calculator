/**
 * Phase 4 of docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 * Phase 2 rewrote the ES/NQ `futures_bars` for [2026-04-05 22:00Z, 06-15
 * 14:11Z). Three stores saved values computed from the old bars at the time,
 * and their writers only ever compute "now", so the old rows stay wrong until
 * recomputed:
 *
 * - `futures_snapshots` (ES, NQ): price, 1h change, day change, volume ratio,
 *   recomputed with `computeSnapshot` exactly as fetch-futures-snapshot calls it.
 * - `market_snapshots.pre_market_data` (auto-filled rows only): the four Globex
 *   numbers, recomputed with the cron's own window and aggregate (`queryGlobex`).
 * - `ws_gamma_setup_fires.es_basis_change_5m`: recomputed with
 *   `computeEsBasisChange5m` at the fire's own minute.
 *
 * A row is updated only when its recomputed value differs. A row the bars can
 * no longer support (a stale or missing snapshot, a window with no bars, a
 * NULL basis) is reported and left alone; a NULL basis is never set, and no
 * fire is added or deleted.
 *
 * Before trusting any in-span difference, each store recomputes a control set
 * of rows outside the repaired span, where the bars were never bad. It must
 * reproduce what is stored; `--apply` refuses unless every store's does, at
 * 100%. A method that cannot reproduce clean rows would mix its own error into
 * the repair.
 *
 * The dry run (the default) reads the database through read-only transactions
 * and writes only report.txt. `--apply` backs up every row it will change, then
 * writes in guarded batches and re-reads them. The entry script is
 * scripts/recompute-futures-derived.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { neonConfig } from '@neondatabase/serverless';
import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  computeSnapshot,
  type FuturesSymbol,
  type SnapshotResult,
} from '../../api/_lib/futures-derive.js';
import {
  PCS_ES_BASIS_MIN_CHANGE,
  computeEsBasisChange5m,
} from '../../api/_lib/gamma-detector.js';
import {
  getOvernightEndCT,
  getOvernightStartCT,
  queryGlobex,
  type Globex,
} from '../../api/cron/auto-prefill-premarket.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const STORES = ['snapshots', 'premarket', 'fires'] as const;
export type Store = (typeof STORES)[number];

const SYMBOLS = ['ES', 'NQ'] as const satisfies readonly FuturesSymbol[];
type Sym = (typeof SYMBOLS)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The repaired span, half-open: Phase 2's archive start to the last tick minute. */
export const SPAN = {
  startMs: Date.UTC(2026, 3, 5, 22, 0),
  endMs: Date.UTC(2026, 5, 15, 14, 11),
} as const;

/** computeSnapshot reads back 20 days for its volume baseline (futures-derive.ts). */
export const SNAPSHOT_LOOKBACK_MS = 20 * DAY_MS;
/** computeEsBasisChange5m reads a 6-minute SPX window (gamma-detector.ts). */
export const BASIS_LOOKBACK_MS = 6 * MINUTE_MS;

/** Concurrent computeSnapshot / basis / Globex recomputes. */
const CONCURRENCY = 8;
/** Control set: every row within this many days of an edge, but at least this many rows. */
const CONTROL_DAYS = 7;
const CONTROL_MIN_ROWS = 200;
/** Rows per UPDATE statement (R5), statements per write transaction. */
const WRITE_CHUNK = 500;
const CHUNKS_PER_TRANSACTION = 10;
/** UTC days per snapshot read page: keeps a response well under Neon's 64 MiB cap. */
const READ_PAGE_DAYS = 7;
/** A transient Neon failure is retried this many times per recompute. */
const COMPUTE_RETRIES = 5;
const TOP_N = 5;
const SAMPLE_N = 10;
const PROGRESS_EVERY = 2000;

/** futures_snapshots pct and ratio columns are NUMERIC(8,4); price is NUMERIC(12,4). */
const SNAPSHOT_SCALE = 4;

// ── Small helpers ───────────────────────────────────────────────────────────

type Sql = ReturnType<typeof getDb>;
type Query = ReturnType<Sql>;
type Row = Record<string, unknown>;

interface Range {
  fromMs: number;
  /** Exclusive. */
  toMs: number;
}

const iso = (tsMs: number): string => new Date(tsMs).toISOString();
const isoSecond = (tsMs: number): string => iso(tsMs).replace('.000Z', 'Z');

const numOrNull = (text: string | null | undefined): number | null =>
  text == null ? null : Number(text);

const fmt = (x: number | null): string => (x == null ? 'null' : String(x));

/** `x` as a NUMERIC column of `scale` decimals stores it: half away from zero on the decimal text. */
export function roundNumeric(x: number, scale: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (m == null) throw new Error(`cannot round ${x}`);
  const [, sign = '', whole = '0', fraction = '', exponent = '0'] = m;
  const digits = BigInt(whole + fraction);
  // x * 10^scale == digits * 10^shift
  const shift = Number(exponent) - fraction.length + scale;
  let scaled: bigint;
  if (shift >= 0) {
    scaled = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    scaled = digits / divisor;
    if ((digits % divisor) * 2n >= divisor) scaled += 1n;
  }
  const out = Number(scaled) / 10 ** scale;
  return out === 0 ? 0 : sign === '-' ? -out : out;
}

const roundNullable = (x: number | null, scale: number): number | null =>
  x == null ? null : roundNumeric(x, scale);

/** JSON with sorted keys, for comparing two rows read from jsonb. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.entries(value as Row)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** `fn` over `items`, at most `limit` at once; results in input order. The first failure stops the rest. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  label: string,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const startedAt = Date.now();
  let next = 0;
  let done = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i] as T);
      } catch (err) {
        failed = true;
        throw err;
      }
      done += 1;
      if (done % PROGRESS_EVERY === 0) {
        console.log(
          `  ${label}: ${done}/${items.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * The rows whose inputs reach into the repaired span. A snapshot at `at` reads
 * bars back to `at - 20 days`, a fire reads ES at its minute and the 5 before
 * (the 6-minute SPX window), so each range runs from the span start to the
 * span end plus that lookback.
 */
export function scopeRanges(): { snapshots: Range; fires: Range } {
  return {
    snapshots: {
      fromMs: SPAN.startMs,
      toMs: SPAN.endMs + SNAPSHOT_LOOKBACK_MS,
    },
    fires: { fromMs: SPAN.startMs, toMs: SPAN.endMs + BASIS_LOOKBACK_MS },
  };
}

/** The overnight window the cron aggregates for `tradeDate`. */
export function premarketWindow(tradeDate: string): Range {
  return {
    fromMs: Date.parse(getOvernightStartCT(tradeDate)),
    toMs: Date.parse(getOvernightEndCT(tradeDate)),
  };
}

/** True when the trade date's overnight window overlaps the repaired span. */
export function premarketInScope(tradeDate: string): boolean {
  const w = premarketWindow(tradeDate);
  return w.fromMs < SPAN.endMs && w.toMs > SPAN.startMs;
}

/**
 * The control rows on one side of an edge: every row within CONTROL_DAYS of the
 * edge, or the nearest CONTROL_MIN_ROWS, whichever is more. `nearestFirst` is
 * sorted by distance from the edge; `distanceMs` is that distance.
 */
export function pickControl<T>(
  nearestFirst: T[],
  distanceMs: (item: T) => number,
): T[] {
  const within = nearestFirst.filter(
    (t) => distanceMs(t) < CONTROL_DAYS * DAY_MS,
  );
  return nearestFirst.slice(0, Math.max(within.length, CONTROL_MIN_ROWS));
}

// ── Comparison ──────────────────────────────────────────────────────────────

export interface Control {
  rows: number;
  matched: number;
  /** Mismatches by kind (the fields that differ, or why a row could not be recomputed). */
  byKind: Record<string, number>;
  /** Rows and matches by UTC month, to show where in time the method reproduces what is stored. */
  byMonth: Record<string, { rows: number; matched: number }>;
  samples: string[];
}

export interface SnapshotValues {
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
}

const SNAPSHOT_KEYS = [
  'price',
  'change1hPct',
  'changeDayPct',
  'volumeRatio',
] as const;

export type SnapshotOutcome =
  | { kind: 'same' }
  | { kind: 'change'; fields: string[]; to: SnapshotValues }
  | { kind: 'unrecomputable'; why: string };

/** Compare a stored snapshot row with what computeSnapshot returns now, at the column scale. */
export function compareSnapshot(
  stored: SnapshotValues,
  result: SnapshotResult,
): SnapshotOutcome {
  if (result.kind === 'missing') {
    return { kind: 'unrecomputable', why: 'no bar at or before the row' };
  }
  if (result.kind === 'stale') {
    const age =
      result.ageMinutes == null
        ? 'its timestamp is unreadable'
        : `latest bar ${result.ageMinutes} min old`;
    return { kind: 'unrecomputable', why: `stale (${age})` };
  }
  const s = result.snapshot;
  const to: SnapshotValues = {
    price: roundNumeric(s.price, SNAPSHOT_SCALE),
    change1hPct: roundNullable(s.change1hPct, SNAPSHOT_SCALE),
    changeDayPct: roundNullable(s.changeDayPct, SNAPSHOT_SCALE),
    volumeRatio: roundNullable(s.volumeRatio, SNAPSHOT_SCALE),
  };
  const fields = SNAPSHOT_KEYS.filter((k) => stored[k] !== to[k]);
  return fields.length === 0
    ? { kind: 'same' }
    : { kind: 'change', fields, to };
}

export interface GlobexValues {
  globexHigh: number;
  globexLow: number;
  globexClose: number;
  globexVwap: number | null;
}

const GLOBEX_KEYS = [
  'globexHigh',
  'globexLow',
  'globexClose',
  'globexVwap',
] as const;

export type GlobexOutcome =
  | { kind: 'same' }
  | { kind: 'change'; fields: string[]; to: GlobexValues }
  | { kind: 'unrecomputable'; why: string };

/** The stored numbers against a fresh window aggregate. The doubles are compared exactly. */
export function compareGlobex(
  stored: GlobexValues | null,
  now: Globex | null,
): GlobexOutcome {
  if (now == null) return { kind: 'unrecomputable', why: 'no overnight bars' };
  const to: GlobexValues = {
    globexHigh: now.globexHigh,
    globexLow: now.globexLow,
    globexClose: now.globexClose,
    globexVwap: now.globexVwap,
  };
  if (stored == null) return { kind: 'change', fields: ['all'], to };
  const fields = GLOBEX_KEYS.filter((k) => stored[k] !== to[k]);
  return fields.length === 0
    ? { kind: 'same' }
    : { kind: 'change', fields, to };
}

/** The PCS Monday detector blocks a fire whose basis change is below the minimum. */
export const pcsPasses = (basis: number): boolean =>
  basis >= PCS_ES_BASIS_MIN_CHANGE;

export interface FireChange {
  id: number;
  firedAtMs: number;
  signalType: string;
  from: number;
  to: number;
  row: Row;
}

/** Fires whose PCS gate result flips under the new basis. Listed only; a fire is never changed for it. */
export function gateFlips(changes: FireChange[]): FireChange[] {
  return changes.filter((c) => pcsPasses(c.from) !== pcsPasses(c.to));
}

function controlOf(
  results: {
    outcome: { kind: string };
    describe: () => string;
    kindKey: string;
    /** UTC month of the row, YYYY-MM. */
    month: string;
  }[],
): Control {
  const control: Control = {
    rows: results.length,
    matched: 0,
    byKind: {},
    byMonth: {},
    samples: [],
  };
  for (const r of results) {
    const month = (control.byMonth[r.month] ??= { rows: 0, matched: 0 });
    month.rows += 1;
    if (r.outcome.kind === 'same') {
      month.matched += 1;
      control.matched += 1;
      continue;
    }
    control.byKind[r.kindKey] = (control.byKind[r.kindKey] ?? 0) + 1;
    if (control.samples.length < SAMPLE_N) control.samples.push(r.describe());
  }
  return control;
}

// ── Apply gate ──────────────────────────────────────────────────────────────

export interface GateInput {
  store: Store;
  toChange: number;
  control: Control;
}

const pct = (part: number, whole: number): string =>
  `${((part / whole) * 100).toFixed(1)}%`;

/**
 * Why `--apply` must refuse, one line per problem; empty when it may go on. The
 * totals must be the ones the owner approved (skipped when `expects` is null,
 * as in the dry run's report), and every store's control set must reproduce
 * what is stored, at 100%.
 */
export function checkApplyGate(
  stores: GateInput[],
  expects: Partial<Record<Store, number | null>> | null = null,
): string[] {
  const problems: string[] = [];
  for (const { store, toChange, control } of stores) {
    const expected = expects?.[store];
    if (expects != null && toChange !== expected) {
      problems.push(
        `${store}: the fresh plan changes ${toChange} rows, --expect-${store} ${expected ?? 'missing'} was given`,
      );
    }
    if (control.rows === 0) {
      problems.push(
        `${store}: the control set is empty, so the method is unproven`,
      );
    } else if (control.matched !== control.rows) {
      problems.push(
        `${store}: control set matches ${control.matched} of ${control.rows} (${pct(control.matched, control.rows)}), not 100%`,
      );
    }
  }
  return problems;
}

// ── Read-only session ───────────────────────────────────────────────────────

const READ_ONLY_HEADER = 'Neon-Batch-Read-Only';

/**
 * Neon's driver runs a plain `sql\`...\`` as a bare statement on a session that
 * can write, and only a transaction can be marked read-only. The recompute calls
 * shared functions (computeSnapshot, computeEsBasisChange5m, queryGlobex) that
 * issue plain queries, so the planning phase installs this as
 * `neonConfig.fetchFunction`: every plain query is resent as a one-statement
 * read-only batch and its answer unwrapped, and a transaction that is not
 * read-only is refused. The database then rejects any write the planning could
 * attempt. The writes of `--apply` run after it is removed.
 */
export async function readOnlyFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
): Promise<Response> {
  if (typeof init.body !== 'string') {
    throw new Error('read-only fetch: request body is not JSON text');
  }
  const body = JSON.parse(init.body) as Row;
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (Array.isArray(body.queries)) {
    if (headers[READ_ONLY_HEADER] !== 'true') {
      throw new Error(
        'read-only fetch: refusing a transaction that is not read-only',
      );
    }
    return fetch(input, init);
  }
  const res = await fetch(input, {
    ...init,
    body: JSON.stringify({ queries: [body] }),
    headers: { ...headers, [READ_ONLY_HEADER]: 'true' },
  });
  if (!res.ok) return res;
  const answer = (await res.json()) as { results?: unknown[] };
  const first = answer.results?.[0];
  if (first == null) {
    throw new Error('read-only fetch: unexpected answer from Neon');
  }
  return new Response(JSON.stringify(first), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** One read-only transaction of one query; the rows. */
async function readRows<T>(build: (sql: Sql) => Query): Promise<T[]> {
  const sql = getDb();
  const [rows] = await withDbRetry(() =>
    sql.transaction([build(sql)], { readOnly: true }),
  );
  return (rows ?? []) as unknown as T[];
}

/** SHOW transaction_read_only through both paths; throws unless both say on. */
async function assertReadOnlySession(): Promise<string[]> {
  const sql = getDb();
  const [inTxn] = await readRows<{ transaction_read_only: string }>(
    (s) => s`SHOW transaction_read_only`,
  );
  const [plain] = (await sql`SHOW transaction_read_only`) as unknown as {
    transaction_read_only: string;
  }[];
  const lines = [
    `SHOW transaction_read_only, read-only transaction: ${inTxn?.transaction_read_only}`,
    `SHOW transaction_read_only, plain query during planning: ${plain?.transaction_read_only}`,
  ];
  if (
    inTxn?.transaction_read_only !== 'on' ||
    plain?.transaction_read_only !== 'on'
  ) {
    throw new Error(
      `the planning session is not read-only:\n${lines.join('\n')}`,
    );
  }
  return lines;
}

// ── Snapshots ───────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: number;
  symbol: Sym;
  tsMs: number;
  stored: SnapshotValues;
  row: Row;
}

export interface SnapshotChange {
  id: number;
  symbol: Sym;
  tsMs: number;
  fields: string[];
  from: SnapshotValues;
  to: SnapshotValues;
  row: Row;
}

interface RawSnapshot {
  id: string;
  symbol: string;
  ts: string;
  price: string;
  change_1h_pct: string | null;
  change_day_pct: string | null;
  volume_ratio: string | null;
  row: Row;
}

function toSnapshotRow(r: RawSnapshot): SnapshotRow {
  return {
    id: Number(r.id),
    symbol: r.symbol as Sym,
    tsMs: Date.parse(r.ts),
    stored: {
      price: Number(r.price),
      change1hPct: numOrNull(r.change_1h_pct),
      changeDayPct: numOrNull(r.change_day_pct),
      volumeRatio: numOrNull(r.volume_ratio),
    },
    row: r.row,
  };
}

/** One symbol's rows with fromMs <= ts < toMs, paged by UTC days. */
async function readSnapshots(
  symbol: Sym,
  fromMs: number,
  toMs: number,
): Promise<SnapshotRow[]> {
  const out: SnapshotRow[] = [];
  for (let at = fromMs; at < toMs; at += READ_PAGE_DAYS * DAY_MS) {
    const from = iso(at);
    const to = iso(Math.min(toMs, at + READ_PAGE_DAYS * DAY_MS));
    const page = await readRows<RawSnapshot>(
      (sql) => sql`
        SELECT id::text AS id, symbol,
               to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
               price::text AS price, change_1h_pct::text AS change_1h_pct,
               change_day_pct::text AS change_day_pct,
               volume_ratio::text AS volume_ratio, to_jsonb(f) AS row
          FROM futures_snapshots f
         WHERE symbol = ${symbol}
           AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
         ORDER BY ts`,
    );
    out.push(...page.map(toSnapshotRow));
  }
  return out;
}

/**
 * The time range holding one symbol's control rows on one side of the scope: the
 * nearest CONTROL_MIN_ROWS rows, or all rows within CONTROL_DAYS of the edge if
 * that is more. Null when the table has nothing on that side.
 */
async function snapshotControlRange(
  symbol: Sym,
  side: 'before' | 'after',
): Promise<Range | null> {
  const scope = scopeRanges().snapshots;
  const edge = side === 'after' ? scope.toMs : scope.fromMs;
  const near =
    side === 'after'
      ? { fromMs: edge, toMs: edge + CONTROL_DAYS * DAY_MS }
      : { fromMs: edge - CONTROL_DAYS * DAY_MS, toMs: edge };
  const [count] = await readRows<{ n: number }>(
    (sql) => sql`
      SELECT count(*)::int AS n FROM futures_snapshots
       WHERE symbol = ${symbol}
         AND ts >= ${iso(near.fromMs)}::timestamptz
         AND ts < ${iso(near.toMs)}::timestamptz`,
  );
  const limit = Math.max(count?.n ?? 0, CONTROL_MIN_ROWS);
  const edgeIso = iso(edge);
  const [bound] =
    side === 'after'
      ? await readRows<{ ts: string | null }>(
          (sql) => sql`
            SELECT to_char(max(ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
              FROM (SELECT ts FROM futures_snapshots
                     WHERE symbol = ${symbol} AND ts >= ${edgeIso}::timestamptz
                     ORDER BY ts ASC LIMIT ${limit}) nearest`,
        )
      : await readRows<{ ts: string | null }>(
          (sql) => sql`
            SELECT to_char(min(ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
              FROM (SELECT ts FROM futures_snapshots
                     WHERE symbol = ${symbol} AND ts < ${edgeIso}::timestamptz
                     ORDER BY ts DESC LIMIT ${limit}) nearest`,
        );
  if (bound?.ts == null) return null;
  const boundMs = Date.parse(bound.ts);
  return side === 'after'
    ? { fromMs: edge, toMs: boundMs + 1 }
    : { fromMs: boundMs, toMs: edge };
}

interface SnapshotEvaluation {
  row: SnapshotRow;
  outcome: SnapshotOutcome;
}

async function evaluateSnapshots(
  rows: SnapshotRow[],
  label: string,
): Promise<SnapshotEvaluation[]> {
  return mapPool(rows, CONCURRENCY, label, async (row) => {
    const at = new Date(row.tsMs);
    const result = await withDbRetry(
      () => computeSnapshot(row.symbol, getETDateStr(at), at),
      COMPUTE_RETRIES,
    );
    return { row, outcome: compareSnapshot(row.stored, result) };
  });
}

const snapshotLine = (
  r: SnapshotRow,
  to: SnapshotValues | null,
  why = '',
): string => {
  const s = r.stored;
  const old = `${s.price}/${fmt(s.change1hPct)}/${fmt(s.changeDayPct)}/${fmt(s.volumeRatio)}`;
  const now =
    to == null
      ? why
      : `${to.price}/${fmt(to.change1hPct)}/${fmt(to.changeDayPct)}/${fmt(to.volumeRatio)}`;
  return `${r.symbol} ${isoSecond(r.tsMs)} id ${r.id} price/1h/day/vr ${old} -> ${now}`;
};

function controlOfSnapshots(evals: SnapshotEvaluation[]): Control {
  return controlOf(
    evals.map(({ row, outcome }) => ({
      outcome,
      month: iso(row.tsMs).slice(0, 7),
      kindKey:
        outcome.kind === 'change'
          ? outcome.fields.join('+')
          : outcome.kind === 'unrecomputable'
            ? outcome.why.replace(/ \(.*\)$/, '')
            : '',
      describe: () =>
        snapshotLine(
          row,
          outcome.kind === 'change' ? outcome.to : null,
          outcome.kind === 'unrecomputable' ? outcome.why : '',
        ),
    })),
  );
}

// ── Pre-market ──────────────────────────────────────────────────────────────

interface PremarketRow {
  id: number;
  date: string;
  entryTime: string;
  stored: GlobexValues | null;
  row: Row;
}

export interface PremarketChange {
  id: number;
  date: string;
  entryTime: string;
  fields: string[];
  from: GlobexValues | null;
  to: GlobexValues;
  row: Row;
}

interface RawPremarket {
  id: string;
  date: string;
  entry_time: string;
  pm: Row | null;
  row: Row;
}

function storedGlobex(pm: Row | null): GlobexValues | null {
  if (pm == null) return null;
  const { globexHigh, globexLow, globexClose, globexVwap } = pm;
  if (
    typeof globexHigh !== 'number' ||
    typeof globexLow !== 'number' ||
    typeof globexClose !== 'number' ||
    (globexVwap !== null && typeof globexVwap !== 'number')
  ) {
    return null;
  }
  return { globexHigh, globexLow, globexClose, globexVwap };
}

async function readAutoFilled(): Promise<PremarketRow[]> {
  const raw = await readRows<RawPremarket>(
    (sql) => sql`
      SELECT id::text AS id, to_char(date, 'YYYY-MM-DD') AS date, entry_time,
             pre_market_data AS pm, to_jsonb(m) AS row
        FROM market_snapshots m
       WHERE pre_market_data->>'autoFilled' = 'true'
       ORDER BY date, id`,
  );
  return raw.map((r) => ({
    id: Number(r.id),
    date: r.date,
    entryTime: r.entry_time,
    stored: storedGlobex(r.pm),
    row: r.row,
  }));
}

const globexLine = (g: GlobexValues | null): string =>
  g == null
    ? 'unreadable'
    : `${g.globexHigh}/${g.globexLow}/${g.globexClose}/${fmt(g.globexVwap)}`;

// ── Gamma fires ─────────────────────────────────────────────────────────────

interface FireRow {
  id: number;
  firedAtMs: number;
  signalType: string;
  stored: number;
  row: Row;
}

interface RawFire {
  id: string;
  fired_at: string;
  signal_type: string;
  value: string;
  row: Row;
}

async function readFires(): Promise<FireRow[]> {
  const raw = await readRows<RawFire>(
    (sql) => sql`
      SELECT id::text AS id,
             to_char(fired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fired_at,
             signal_type, es_basis_change_5m::text AS value, to_jsonb(f) AS row
        FROM ws_gamma_setup_fires f
       WHERE es_basis_change_5m IS NOT NULL
       ORDER BY fired_at, id`,
  );
  return raw.map((r) => ({
    id: Number(r.id),
    firedAtMs: Date.parse(r.fired_at),
    signalType: r.signal_type,
    stored: Number(r.value),
    row: r.row,
  }));
}

type FireOutcome =
  | { kind: 'same' }
  | { kind: 'change'; to: number }
  | { kind: 'unrecomputable'; why: string };

interface FireEvaluation {
  row: FireRow;
  outcome: FireOutcome;
}

async function evaluateFires(
  rows: FireRow[],
  label: string,
): Promise<FireEvaluation[]> {
  const sql = getDb();
  return mapPool(rows, CONCURRENCY, label, async (row) => {
    const basis = await withDbRetry(
      () => computeEsBasisChange5m(sql, new Date(row.firedAtMs)),
      COMPUTE_RETRIES,
    );
    let outcome: FireOutcome;
    if (basis == null) {
      outcome = {
        kind: 'unrecomputable',
        why: 'no SPX or ES bar for the window',
      };
    } else if (basis === row.stored) {
      outcome = { kind: 'same' };
    } else {
      outcome = { kind: 'change', to: basis };
    }
    return { row, outcome };
  });
}

const fireLine = (r: FireRow, to: string): string =>
  `fire ${r.id} ${isoSecond(r.firedAtMs)} ${r.signalType} ${r.stored} -> ${to}`;

// ── Plans ───────────────────────────────────────────────────────────────────

export interface StoreResult<C> {
  inScope: number;
  changes: C[];
  /** Rows the bars can no longer support: reported, left alone. */
  unrecomputable: string[];
  control: Control;
}

export interface Plans {
  snapshots?: StoreResult<SnapshotChange>;
  premarket?: StoreResult<PremarketChange>;
  fires?: StoreResult<FireChange>;
}

async function planSnapshots(): Promise<StoreResult<SnapshotChange>> {
  const scope = scopeRanges().snapshots;
  const inScope: SnapshotRow[] = [];
  const control: SnapshotRow[] = [];
  for (const symbol of SYMBOLS) {
    inScope.push(...(await readSnapshots(symbol, scope.fromMs, scope.toMs)));
    for (const side of ['before', 'after'] as const) {
      const range = await snapshotControlRange(symbol, side);
      if (range != null) {
        control.push(
          ...(await readSnapshots(symbol, range.fromMs, range.toMs)),
        );
      }
    }
  }
  console.log(
    `snapshots: ${inScope.length} rows in scope, ${control.length} control rows`,
  );
  const scoped = await evaluateSnapshots(inScope, 'snapshots in scope');
  const controls = await evaluateSnapshots(control, 'snapshots control');

  const changes: SnapshotChange[] = [];
  const unrecomputable: string[] = [];
  for (const { row, outcome } of scoped) {
    if (outcome.kind === 'change') {
      changes.push({
        id: row.id,
        symbol: row.symbol,
        tsMs: row.tsMs,
        fields: outcome.fields,
        from: row.stored,
        to: outcome.to,
        row: row.row,
      });
    } else if (outcome.kind === 'unrecomputable') {
      unrecomputable.push(snapshotLine(row, null, outcome.why));
    }
  }
  return {
    inScope: inScope.length,
    changes,
    unrecomputable,
    control: controlOfSnapshots(controls),
  };
}

async function planPremarket(): Promise<StoreResult<PremarketChange>> {
  const all = await readAutoFilled();
  const inScope = all.filter((r) => premarketInScope(r.date));
  const before = all
    .filter((r) => premarketWindow(r.date).toMs <= SPAN.startMs)
    .reverse();
  const after = all.filter((r) => premarketWindow(r.date).fromMs >= SPAN.endMs);
  const control = [
    ...pickControl(before, (r) => SPAN.startMs - premarketWindow(r.date).toMs),
    ...pickControl(after, (r) => premarketWindow(r.date).fromMs - SPAN.endMs),
  ];
  console.log(
    `premarket: ${all.length} auto-filled rows, ${inScope.length} in scope, ${control.length} control rows`,
  );

  const sql = getDb();
  const dates = [...new Set([...inScope, ...control].map((r) => r.date))];
  const globexList = await mapPool(dates, CONCURRENCY, 'premarket', (date) =>
    queryGlobex(sql, date),
  );
  const globexByDate = new Map(dates.map((d, i) => [d, globexList[i] ?? null]));
  const compare = (r: PremarketRow) =>
    compareGlobex(r.stored, globexByDate.get(r.date) ?? null);

  const changes: PremarketChange[] = [];
  const unrecomputable: string[] = [];
  for (const r of inScope) {
    const outcome = compare(r);
    if (outcome.kind === 'change') {
      changes.push({
        id: r.id,
        date: r.date,
        entryTime: r.entryTime,
        fields: outcome.fields,
        from: r.stored,
        to: outcome.to,
        row: r.row,
      });
    } else if (outcome.kind === 'unrecomputable') {
      unrecomputable.push(`${r.date} id ${r.id}: ${outcome.why}`);
    }
  }
  const line = (r: PremarketRow, o: GlobexOutcome): string =>
    `${r.date} id ${r.id} ${globexLine(r.stored)} -> ${o.kind === 'change' ? globexLine(o.to) : o.kind === 'unrecomputable' ? o.why : 'same'}`;
  return {
    inScope: inScope.length,
    changes,
    unrecomputable,
    control: controlOf(
      control.map((r) => {
        const outcome = compare(r);
        return {
          outcome,
          month: r.date.slice(0, 7),
          kindKey:
            outcome.kind === 'change'
              ? outcome.fields.join('+')
              : outcome.kind === 'unrecomputable'
                ? outcome.why
                : '',
          describe: () => line(r, outcome),
        };
      }),
    ),
  };
}

async function planFires(): Promise<StoreResult<FireChange>> {
  const scope = scopeRanges().fires;
  const all = await readFires();
  const inScope = all.filter(
    (f) => f.firedAtMs >= scope.fromMs && f.firedAtMs < scope.toMs,
  );
  const control = all.filter(
    (f) => f.firedAtMs < scope.fromMs || f.firedAtMs >= scope.toMs,
  );
  console.log(
    `fires: ${all.length} fires with a value, ${inScope.length} in scope, ${control.length} control`,
  );
  const scoped = await evaluateFires(inScope, 'fires in scope');
  const controls = await evaluateFires(control, 'fires control');

  const changes: FireChange[] = [];
  const unrecomputable: string[] = [];
  for (const { row, outcome } of scoped) {
    if (outcome.kind === 'change') {
      changes.push({
        id: row.id,
        firedAtMs: row.firedAtMs,
        signalType: row.signalType,
        from: row.stored,
        to: outcome.to,
        row: row.row,
      });
    } else if (outcome.kind === 'unrecomputable') {
      unrecomputable.push(fireLine(row, outcome.why));
    }
  }
  return {
    inScope: inScope.length,
    changes,
    unrecomputable,
    control: controlOf(
      controls.map(({ row, outcome }) => ({
        outcome,
        month: iso(row.firedAtMs).slice(0, 7),
        kindKey: outcome.kind === 'unrecomputable' ? outcome.why : 'value',
        describe: () =>
          fireLine(
            row,
            outcome.kind === 'change' ? String(outcome.to) : 'no value',
          ),
      })),
    ),
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

function controlText(c: Control): string[] {
  const rate = c.rows === 0 ? 'empty' : pct(c.matched, c.rows);
  const out = [`  control set: ${c.matched} of ${c.rows} match (${rate})`];
  const months = Object.entries(c.byMonth)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([m, v]) => `${m} ${v.matched}/${v.rows}`);
  if (months.length > 0)
    out.push(`    matched/rows by month: ${months.join(', ')}`);
  for (const [kind, n] of Object.entries(c.byKind)) {
    out.push(`    mismatch ${kind || '(none)'}: ${n}`);
  }
  for (const s of c.samples) out.push(`    e.g. ${s}`);
  return out;
}

function unrecomputableText(list: string[]): string[] {
  if (list.length === 0) return ['  rows left alone (cannot be recomputed): 0'];
  return [
    `  rows left alone (cannot be recomputed): ${list.length}`,
    ...list.slice(0, SAMPLE_N).map((l) => `    ${l}`),
  ];
}

function snapshotsText(r: StoreResult<SnapshotChange>): string[] {
  const top = [...r.changes]
    .sort(
      (a, b) =>
        Math.abs(b.to.price - b.from.price) -
        Math.abs(a.to.price - a.from.price),
    )
    .slice(0, TOP_N);
  const perField = SNAPSHOT_KEYS.map(
    (k) => `${k}=${r.changes.filter((c) => c.fields.includes(k)).length}`,
  ).join(' ');
  return [
    'futures_snapshots (ES, NQ)',
    `  rows in scope: ${r.inScope}, rows to change: ${r.changes.length} (${perField})`,
    ...unrecomputableText(r.unrecomputable),
    '  largest price diffs:',
    ...top.map(
      (c) =>
        `    ${snapshotLine({ id: c.id, symbol: c.symbol, tsMs: c.tsMs, stored: c.from, row: c.row }, c.to)}`,
    ),
    ...controlText(r.control),
  ];
}

function premarketText(r: StoreResult<PremarketChange>): string[] {
  return [
    'market_snapshots.pre_market_data (auto-filled rows only)',
    `  rows in scope: ${r.inScope}, rows to change: ${r.changes.length}`,
    ...unrecomputableText(r.unrecomputable),
    '  Globex high/low/close/vwap, old -> new, per date:',
    ...r.changes.map(
      (c) =>
        `    ${c.date} id ${c.id} (${c.entryTime}) ${globexLine(c.from)} -> ${globexLine(c.to)}`,
    ),
    ...controlText(r.control),
  ];
}

function firesText(r: StoreResult<FireChange>): string[] {
  const top = [...r.changes]
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
    .slice(0, TOP_N);
  const flips = gateFlips(r.changes);
  const pcsFlips = flips.filter((f) => f.signalType === 'pcs_monday').length;
  return [
    'ws_gamma_setup_fires.es_basis_change_5m',
    `  rows in scope: ${r.inScope}, rows to change: ${r.changes.length}`,
    ...unrecomputableText(r.unrecomputable),
    '  largest diffs:',
    ...top.map(
      (c) =>
        `    fire ${c.id} ${isoSecond(c.firedAtMs)} ${c.signalType} ${c.from} -> ${c.to}`,
    ),
    `  PCS gate flips (basis crosses ${PCS_ES_BASIS_MIN_CHANGE}; listed only, no fire is changed for it): ${flips.length} (${pcsFlips} pcs_monday)`,
    ...flips.map(
      (f) =>
        `    fire ${f.id} ${isoSecond(f.firedAtMs)} ${f.signalType} ${f.from} -> ${f.to}: ${pcsPasses(f.from) ? 'passed' : 'blocked'} -> ${pcsPasses(f.to) ? 'passes' : 'blocked'}`,
    ),
    ...controlText(r.control),
  ];
}

export function formatReport(
  plans: Plans,
  header: string[],
  gateProblems: string[],
): string {
  const out = [...header, ''];
  if (plans.snapshots) out.push(...snapshotsText(plans.snapshots), '');
  if (plans.premarket) out.push(...premarketText(plans.premarket), '');
  if (plans.fires) out.push(...firesText(plans.fires), '');
  out.push(
    gateProblems.length === 0
      ? 'Control sets: every store matches 100%.'
      : 'APPLY WOULD REFUSE on the control sets:',
    ...gateProblems.map((p) => `  ${p}`),
  );
  return out.join('\n');
}

// ── Writes ──────────────────────────────────────────────────────────────────

function updateSnapshots(sql: Sql, rows: SnapshotChange[]) {
  return sql`
    UPDATE futures_snapshots f
       SET price = r.price, change_1h_pct = r.change_1h_pct,
           change_day_pct = r.change_day_pct, volume_ratio = r.volume_ratio
      FROM unnest(${rows.map((c) => c.id)}::int[],
                  ${rows.map((c) => c.symbol)}::text[],
                  ${rows.map((c) => c.to.price)}::numeric[],
                  ${rows.map((c) => c.to.change1hPct)}::numeric[],
                  ${rows.map((c) => c.to.changeDayPct)}::numeric[],
                  ${rows.map((c) => c.to.volumeRatio)}::numeric[])
           AS r(id, symbol, price, change_1h_pct, change_day_pct, volume_ratio)
     WHERE f.id = r.id AND f.symbol = r.symbol
       AND (f.price, f.change_1h_pct, f.change_day_pct, f.volume_ratio)
           IS DISTINCT FROM (r.price, r.change_1h_pct, r.change_day_pct, r.volume_ratio)
    RETURNING f.id`;
}

/**
 * Merges the four Globex keys into the existing JSON, so every other key is
 * kept, and only into a row that still says autoFilled in the UPDATE itself: a
 * hand save made after the plan was read is never written over.
 */
function updatePremarket(sql: Sql, rows: PremarketChange[]) {
  return sql`
    UPDATE market_snapshots m
       SET pre_market_data = m.pre_market_data || r.patch::jsonb
      FROM unnest(${rows.map((c) => c.id)}::int[],
                  ${rows.map((c) => JSON.stringify(c.to))}::text[])
           AS r(id, patch)
     WHERE m.id = r.id
       AND m.pre_market_data->>'autoFilled' = 'true'
       AND (m.pre_market_data->'globexHigh', m.pre_market_data->'globexLow',
            m.pre_market_data->'globexClose', m.pre_market_data->'globexVwap')
           IS DISTINCT FROM (r.patch::jsonb->'globexHigh', r.patch::jsonb->'globexLow',
                             r.patch::jsonb->'globexClose', r.patch::jsonb->'globexVwap')
    RETURNING m.id`;
}

/** A NULL basis is never set: the UPDATE itself requires a value to replace. */
function updateFires(sql: Sql, rows: FireChange[]) {
  return sql`
    UPDATE ws_gamma_setup_fires f
       SET es_basis_change_5m = r.value
      FROM unnest(${rows.map((c) => c.id)}::bigint[],
                  ${rows.map((c) => c.to)}::numeric[]) AS r(id, value)
     WHERE f.id = r.id
       AND f.es_basis_change_5m IS NOT NULL
       AND f.es_basis_change_5m IS DISTINCT FROM r.value
    RETURNING f.id`;
}

async function writeInTransactions<C>(
  changes: C[],
  statement: (sql: Sql, rows: C[]) => Query,
): Promise<void> {
  const sql = getDb();
  const groups = chunks(chunks(changes, WRITE_CHUNK), CHUNKS_PER_TRANSACTION);
  for (const group of groups) {
    await withDbRetry(() =>
      sql.transaction(group.map((rows) => statement(sql, rows))),
    );
  }
}

// ── Backup, marker, verify ──────────────────────────────────────────────────

interface BackupEntry {
  store: Store;
  id: number;
  row: Row;
  to: unknown;
}

/** One JSONL line per row about to change, full row included; the line count is checked back. */
function writeBackup(workDir: string, plans: Plans): string {
  const entries: BackupEntry[] = [];
  for (const store of STORES) {
    const result = plans[store];
    for (const c of result?.changes ?? []) {
      entries.push({ store, id: c.id, row: c.row, to: c.to });
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(workDir, `backup-${stamp}.jsonl`);
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const written = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '').length;
  if (written !== entries.length) {
    throw new Error(
      `backup ${path} has ${written} lines, expected ${entries.length}`,
    );
  }
  return path;
}

export const markerPath = (workDir: string, store: Store): string =>
  join(workDir, `${store}.applied`);

function writeMarker(workDir: string, store: Store, rows: number): void {
  writeFileSync(
    markerPath(workDir, store),
    `${JSON.stringify({ store, rows, appliedAt: new Date().toISOString() })}\n`,
  );
}

/** Re-read `ids` and require each row to equal its backed-up row with the plan applied. */
function compareRows(
  store: Store,
  expected: Map<number, Row>,
  actual: { id: string; row: Row }[],
): void {
  const found = new Map(actual.map((r) => [Number(r.id), r.row]));
  const bad: string[] = [];
  for (const [id, want] of expected) {
    const have = found.get(id);
    if (have == null) bad.push(`id ${id}: row is gone`);
    else if (stable(have) !== stable(want)) {
      bad.push(`id ${id}: expected ${stable(want)}, found ${stable(have)}`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `verify failed for ${store}: ${bad.length} of ${expected.size} row(s) differ from the plan: ${bad.slice(0, 3).join('; ')}`,
    );
  }
}

async function verifySnapshots(changes: SnapshotChange[]): Promise<void> {
  for (const group of chunks(changes, WRITE_CHUNK)) {
    const ids = group.map((c) => c.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(f) AS row
          FROM futures_snapshots f WHERE id = ANY(${ids}::int[])`,
    );
    compareRows(
      'snapshots',
      new Map(
        group.map((c) => [
          c.id,
          {
            ...c.row,
            price: c.to.price,
            change_1h_pct: c.to.change1hPct,
            change_day_pct: c.to.changeDayPct,
            volume_ratio: c.to.volumeRatio,
          },
        ]),
      ),
      actual,
    );
  }
}

async function verifyPremarket(changes: PremarketChange[]): Promise<void> {
  for (const group of chunks(changes, WRITE_CHUNK)) {
    const ids = group.map((c) => c.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(m) AS row
          FROM market_snapshots m WHERE id = ANY(${ids}::int[])`,
    );
    compareRows(
      'premarket',
      new Map(
        group.map((c) => [
          c.id,
          {
            ...c.row,
            pre_market_data: {
              ...(c.row.pre_market_data as Row | null),
              ...c.to,
            },
          },
        ]),
      ),
      actual,
    );
  }
}

async function verifyFires(changes: FireChange[]): Promise<void> {
  for (const group of chunks(changes, WRITE_CHUNK)) {
    const ids = group.map((c) => c.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(f) AS row
          FROM ws_gamma_setup_fires f WHERE id = ANY(${ids}::bigint[])`,
    );
    compareRows(
      'fires',
      new Map(group.map((c) => [c.id, { ...c.row, es_basis_change_5m: c.to }])),
      actual,
    );
  }
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface RecomputeOptions {
  /** report.txt, backups and the per-store done markers. */
  workDir: string;
  apply: boolean;
  force: boolean;
  stores: Store[];
  /** The rows to change in the dry run the owner approved. Null on a dry run. */
  expectSnapshots: number | null;
  expectPremarket: number | null;
  expectFires: number | null;
}

export interface RecomputeArgs extends RecomputeOptions {
  envFile: string | null;
}

const EXPECT_FLAGS: Record<Store, { flag: string; letter: string }> = {
  snapshots: { flag: '--expect-snapshots', letter: 'N' },
  premarket: { flag: '--expect-premarket', letter: 'M' },
  fires: { flag: '--expect-fires', letter: 'K' },
};

function parseCount(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} needs a whole number, got "${value}"`);
  }
  return Number.parseInt(value, 10);
}

export function parseRecomputeArgs(argv: string[]): RecomputeArgs {
  const args: RecomputeArgs = {
    workDir: 'docs/tmp/futures-derived-recompute',
    apply: false,
    force: false,
    stores: [...STORES],
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    envFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value == null || value.startsWith('--'))
        throw new Error(`${flag} needs a value`);
      return value;
    };
    if (flag === '--stores') {
      const values: string[] = [];
      while (argv[i + 1] != null && !argv[i + 1]?.startsWith('--')) {
        i += 1;
        values.push(argv[i] ?? '');
      }
      if (values.length === 0) throw new Error('--stores needs a value');
      const bad = values.find(
        (v) => !(STORES as readonly string[]).includes(v),
      );
      if (bad != null) throw new Error(`unknown store "${bad}"`);
      args.stores = values as Store[];
    } else if (flag === '--expect-snapshots')
      args.expectSnapshots = parseCount(flag, next());
    else if (flag === '--expect-premarket')
      args.expectPremarket = parseCount(flag, next());
    else if (flag === '--expect-fires')
      args.expectFires = parseCount(flag, next());
    else if (flag === '--work-dir') args.workDir = next();
    else if (flag === '--env-file') args.envFile = next();
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--force') args.force = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.force && !args.apply)
    throw new Error('--force only applies with --apply');
  const given = expectations(args);
  if (!args.apply) {
    for (const store of STORES) {
      if (given[store] != null) {
        throw new Error(
          `${EXPECT_FLAGS[store].flag} only applies with --apply`,
        );
      }
    }
  } else {
    const missing = args.stores.filter((s) => given[s] == null);
    if (missing.length > 0) {
      const names = missing.map(
        (s) => `${EXPECT_FLAGS[s].flag} ${EXPECT_FLAGS[s].letter}`,
      );
      throw new Error(
        `--apply needs ${names.join(' and ')}: the totals of the dry run you approved`,
      );
    }
  }
  return args;
}

function expectations(o: RecomputeOptions): Record<Store, number | null> {
  return {
    snapshots: o.expectSnapshots,
    premarket: o.expectPremarket,
    fires: o.expectFires,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** Exit codes: 0 done, 1 failed or refused, 2 stopped between stores (market hours began). */
async function run(opts: RecomputeOptions): Promise<number> {
  if (opts.apply && isMarketHours()) {
    throw new Error(
      'Refusing to --apply during market hours (09:25 to 16:05 ET): run after the close.',
    );
  }
  mkdirSync(opts.workDir, { recursive: true });
  const startedAt = Date.now();
  console.log(
    `Futures derived-store recompute${opts.apply ? '' : ' (DRY RUN: read-only, no writes)'}`,
  );

  const plans: Plans = {};
  let session: string[];
  neonConfig.fetchFunction = readOnlyFetch;
  try {
    session = await assertReadOnlySession();
    for (const line of session) console.log(line);
    if (opts.stores.includes('fires')) plans.fires = await planFires();
    if (opts.stores.includes('premarket'))
      plans.premarket = await planPremarket();
    if (opts.stores.includes('snapshots'))
      plans.snapshots = await planSnapshots();
  } finally {
    neonConfig.fetchFunction = undefined;
  }

  const gateInputs: GateInput[] = opts.stores.flatMap((store) => {
    const r = plans[store];
    return r == null
      ? []
      : [{ store, toChange: r.changes.length, control: r.control }];
  });
  const controlProblems = checkApplyGate(gateInputs);
  const span = `${isoSecond(SPAN.startMs)} .. ${isoSecond(SPAN.endMs)} (end exclusive)`;
  const scope = scopeRanges();
  const report = formatReport(
    plans,
    [
      `repaired span ${span}`,
      `snapshot scope ${isoSecond(scope.snapshots.fromMs)} .. ${isoSecond(scope.snapshots.toMs)} (span end + 20 days)`,
      `fire scope ${isoSecond(scope.fires.fromMs)} .. ${isoSecond(scope.fires.toMs)} (span end + 6 minutes)`,
      ...session,
      `elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`,
    ],
    controlProblems,
  );
  console.log(`\n${report}`);
  writeFileSync(join(opts.workDir, 'report.txt'), `${report}\n`);
  console.log(`\nreport: ${join(opts.workDir, 'report.txt')}`);
  if (!opts.apply) return 0;

  // Refuse before any marker, backup or write: the totals must be the approved
  // ones and every control set must match.
  const problems = checkApplyGate(gateInputs, expectations(opts));
  if (problems.length > 0) {
    const listed = problems.map((p) => `  ${p}`).join('\n');
    throw new Error(`Refusing to --apply. Nothing was written.\n${listed}`);
  }

  const pending: Store[] = [];
  for (const store of opts.stores) {
    const changes = plans[store]?.changes.length ?? 0;
    if (!opts.force && existsSync(markerPath(opts.workDir, store))) {
      console.log(
        changes > 0
          ? `WARNING: ${store} is marked done but the fresh plan still changes ${changes} row(s); it is skipped (the --expect total counts them). Use --force to redo it.`
          : `${store} is marked done and has nothing left to change`,
      );
      continue;
    }
    pending.push(store);
  }
  if (pending.length === 0) return 0;

  const backup = writeBackup(opts.workDir, {
    snapshots: pending.includes('snapshots') ? plans.snapshots : undefined,
    premarket: pending.includes('premarket') ? plans.premarket : undefined,
    fires: pending.includes('fires') ? plans.fires : undefined,
  });
  console.log(`backup: ${backup}`);

  for (const store of pending) {
    // The apply can outlast the close, so the guard is checked before every store.
    if (isMarketHours()) {
      console.error(
        `apply stopped before ${store}: market hours began (09:25 ET). Finished stores are marked; run a fresh dry run after the close.`,
      );
      return 2;
    }
    try {
      const done = await applyStore(store, plans);
      console.log(`${store}: ${done} row(s) changed and verified`);
    } catch (err) {
      throw new Error(
        `apply failed: ${store}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    writeMarker(opts.workDir, store, plans[store]?.changes.length ?? 0);
  }
  return 0;
}

async function applyStore(store: Store, plans: Plans): Promise<number> {
  if (store === 'snapshots') {
    const changes = plans.snapshots?.changes ?? [];
    await writeInTransactions(changes, updateSnapshots);
    await verifySnapshots(changes);
    return changes.length;
  }
  if (store === 'premarket') {
    const changes = plans.premarket?.changes ?? [];
    await writeInTransactions(changes, updatePremarket);
    await verifyPremarket(changes);
    return changes.length;
  }
  const changes = plans.fires?.changes ?? [];
  await writeInTransactions(changes, updateFires);
  await verifyFires(changes);
  return changes.length;
}

/** Runs the recompute and returns the process exit code: 0 done, 1 failed or refused, 2 stopped at the open. */
export async function runRecompute(opts: RecomputeOptions): Promise<number> {
  try {
    return await run(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
