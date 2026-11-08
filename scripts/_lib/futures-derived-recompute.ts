/**
 * Phase 4 of docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 * Phase 2 rewrote the ES/NQ `futures_bars` for [2026-04-05 22:00Z, 06-15
 * 14:11Z). Three stores saved values computed from the old bars at the time,
 * and their writers only ever compute "now", so the old rows stay wrong until
 * recomputed:
 *
 * - `futures_snapshots` (ES, NQ, RTY, CL, GC, ZN): price, 1h change, day change,
 *   volume ratio, recomputed with `computeSnapshot` exactly as
 *   fetch-futures-snapshot calls it.
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
 * 100%. For the snapshots of RTY, CL, GC and ZN, whose minute bar can land after
 * the cron read it, a miss that a late bar explains also counts (see
 * classifyThinMiss); ES and NQ must match exactly. A method that cannot
 * reproduce clean rows would mix its own error into the repair.
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
  FUTURES_SYMBOLS,
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
import {
  getCTTime,
  getETDateStr,
  getETMarketOpenUtcIso,
} from '../../src/utils/timezone.js';
import {
  LATE_BAR_MAX_AGE_MIN,
  affectedSnapshotFields,
  aggregateWindow,
  attributeByValue,
  buildPreSeries,
  buildRepair,
  classifyMismatch,
  classifyThinMiss,
  inputsMatchSnapshot,
  parseBackup,
  preRepairWindow,
  snapshotInputs,
  windowAffected,
  type BackupBar,
  type Bar,
  type MismatchClass,
  type OlderBar,
  type PreBar,
  type Repair,
  type SnapshotField,
  type ValueField,
  type WindowAggregate,
} from './futures-derived-attribution.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const STORES = ['snapshots', 'premarket', 'fires'] as const;
export type Store = (typeof STORES)[number];

/**
 * Every root futures_snapshots holds. Phase 2 repaired ES and NQ and deleted
 * the Saturday junk bars of RTY, CL, GC and ZN, so only a deleted bar can make
 * one of those four roots' fields repair-affected.
 */
const SYMBOLS = FUTURES_SYMBOLS;
type Sym = FuturesSymbol;

/**
 * ES and NQ print every second, so a minute's bar is out before the cron reads
 * it and their method control must match exactly. The other roots can print
 * nothing between the minute and the read, so the cron saw one bar fewer than the
 * table holds now (`_flush` in uw-stream emits a minute only once a print of a
 * later minute has arrived). Their control also passes a miss that a late bar
 * explains (ruling 4).
 */
const EXACT_CONTROL_ROOTS: readonly Sym[] = ['ES', 'NQ'];
const isThinRoot = (symbol: Sym): boolean =>
  !EXACT_CONTROL_ROOTS.includes(symbol);

/** What the gate counts as a match in the snapshot control. */
const SNAPSHOT_CONTROL_LABEL =
  'control set matches (a thin root: or is explained by a late bar)';

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

/** Concurrent computeSnapshot / basis / Globex recomputes: six roots take about 160,000 of them. */
const CONCURRENCY = 16;
/**
 * The snapshot method control starts here: every futures_snapshots row from
 * this day on, per symbol, must recompute equal to what is stored. Rows before
 * it are not a clean control because they read bars that were filled in after
 * the row was written: the 20-day volume window of 2026-10-02 to 10-19 reaches
 * the 2026-09-03 to 09-29 outage bars that another session backfilled, and on
 * 10-19 to 10-30 bars landed late (a stored price is the close of a bar a few
 * minutes older than the latest closed bar, which has newer neighbours now).
 * 2026-11-02 is the first day with neither. Every mismatch before it is
 * classified in the report (september-window, late-bar or unexplained), as
 * information that backs the choice of the date, not as a gate.
 */
export const SNAPSHOT_CONTROL_FROM_MS = Date.UTC(2026, 10, 2);
/** The information window starts after the freshness gate deployed (2026-09-30). */
export const SNAPSHOT_INFO_FROM_MS = Date.UTC(2026, 9, 2);
/** The method control needs at least this many rows over at least this many days, per symbol. */
export const CONTROL_MIN_ROWS = 200;
export const CONTROL_MIN_DAYS = 3;
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

// ── Comparison ──────────────────────────────────────────────────────────────

export interface Control {
  rows: number;
  matched: number;
  /** Mismatches by kind (the fields that differ, or why a row could not be recomputed). */
  byKind: Record<string, number>;
  /** Rows and matches by UTC month, to show where in time the method reproduces what is stored. */
  byMonth: Record<string, { rows: number; matched: number }>;
  samples: string[];
  /** What a match means, for the report and the gate. Default: "control set matches". */
  label?: string;
  /** Reasons to refuse `--apply` beyond the match rate. */
  problems?: string[];
  /** Information lines under the control set in the report. */
  notes?: string[];
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
  | { kind: 'change'; fields: SnapshotField[]; to: SnapshotValues }
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
    if (expects != null && expected !== undefined && toChange !== expected) {
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
        `${store}: ${control.label ?? 'control set matches'} ${control.matched} of ${control.rows} (${pct(control.matched, control.rows)}), not 100%`,
      );
    }
    for (const extra of control.problems ?? []) {
      problems.push(`${store}: ${extra}`);
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

// ── Bars and the Phase 2 repair ─────────────────────────────────────────────

/** Bars are read from this long before the span, so the pre-market windows and hour-ago bars are covered. */
const BARS_LEAD_MS = 3 * DAY_MS;

interface SymbolData {
  /** Every bar from BARS_LEAD_MS before the span to the end of the snapshot scope, by ts. */
  bars: Bar[];
  repair: Repair;
  backup: BackupBar[];
  /** The same bars as they were before Phase 2, for finding a stored row's inputs by value. */
  series: PreBar[];
}

interface RawBar {
  ts: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** One symbol's bars with fromMs <= ts < toMs, paged by UTC days. */
async function readBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let at = fromMs; at < toMs; at += READ_PAGE_DAYS * DAY_MS) {
    const from = iso(at);
    const to = iso(Math.min(toMs, at + READ_PAGE_DAYS * DAY_MS));
    const page = await readRows<RawBar>(
      (sql) => sql`
        SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
               high::text AS high, low::text AS low,
               close::text AS close, volume::text AS volume
          FROM futures_bars
         WHERE symbol = ${symbol}
           AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
         ORDER BY ts`,
    );
    for (const r of page) {
      out.push({
        tsMs: Date.parse(r.ts),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }
  }
  return out;
}

/** Reads the bars of the symbols a run needs and what Phase 2 changed in each. */
async function loadSymbolData(
  symbols: readonly Sym[],
  backup: BackupBar[],
): Promise<Map<Sym, SymbolData>> {
  const scope = scopeRanges().snapshots;
  const out = new Map<Sym, SymbolData>();
  for (const symbol of symbols) {
    const bars = await readBars(
      symbol,
      scope.fromMs - BARS_LEAD_MS,
      scope.toMs,
    );
    const mine = backup.filter((b) => b.symbol === symbol);
    out.set(symbol, {
      bars,
      backup: mine,
      repair: buildRepair(mine, new Map(bars.map((b) => [b.tsMs, b]))),
      series: buildPreSeries(mine, bars),
    });
    console.log(
      `bars ${symbol}: ${bars.length} read; Phase 2 backup ${mine.length} rows (${mine.filter((b) => b.op === 'delete').length} deleted)`,
    );
  }
  return out;
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
  /** The affected fields whose recomputed value differs: the only ones written. */
  fields: SnapshotField[];
  from: SnapshotValues;
  /** The recompute for all four fields; only `fields` of it are written. */
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

interface SnapshotEvaluation {
  row: SnapshotRow;
  result: SnapshotResult;
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
    return { row, result, outcome: compareSnapshot(row.stored, result) };
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

/**
 * The closed bars 1 to LATE_BAR_MAX_AGE_MIN minutes older than today's latest
 * closed bar, newest first: the candidates for the bar a late-landing cron saw.
 */
async function olderBarsBefore(
  symbol: Sym,
  latestMs: number,
): Promise<OlderBar[]> {
  const from = iso(latestMs - LATE_BAR_MAX_AGE_MIN * MINUTE_MS);
  const to = iso(latestMs - MINUTE_MS);
  const rows = await readRows<{ ts: string; close: string }>(
    (sql) => sql`
      SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
             close::text AS close
        FROM futures_bars
       WHERE symbol = ${symbol}
         AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
       ORDER BY ts DESC`,
  );
  return rows.map((r) => ({
    ageMin: Math.round((latestMs - Date.parse(r.ts)) / MINUTE_MS),
    close: Number(r.close),
  }));
}

/** A mismatching row with every field: stored -> recomputed, `*` on the ones that differ. */
function mismatchLine(row: SnapshotRow, outcome: SnapshotOutcome): string {
  if (outcome.kind !== 'change') {
    return snapshotLine(
      row,
      null,
      outcome.kind === 'unrecomputable' ? outcome.why : '',
    );
  }
  const cells = SNAPSHOT_KEYS.map(
    (k) =>
      `${k} ${fmt(row.stored[k])} -> ${fmt(outcome.to[k])}${outcome.fields.includes(k) ? ' *' : ''}`,
  );
  return `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: ${cells.join(', ')}`;
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
  /** Whether the bars as they were before Phase 2 reproduce the stored values. */
  preRepair: 'reproduces' | 'differs';
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

/** Rows and fields the value rule made affected that the ruling 1 rule did not. */
export interface ValueRuleStats {
  rows: number;
  fields: Record<SnapshotField, number>;
  /** Matched bars by what Phase 2 did to them. */
  byKind: { deleted: number; 'close-changed': number };
  /** The first SAMPLE_N such rows, with the matched bar. */
  samples: string[];
}

/** A price difference between the stored row and the recompute that is not written. */
export interface UnwrittenDiff {
  diff: number;
  line: string;
}

/** Rows with an affected field whose recompute is stale or missing: left as stored. */
export interface LeftAloneStats {
  stale: number;
  missing: number;
  byField: Record<SnapshotField, number>;
  /** In the 16:15 to 17:00 CT daily break, where the old writer had no freshness gate. */
  inBreak: number;
  elsewhere: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface SnapshotSymbolReport {
  symbol: Sym;
  inRange: number;
  rowsToWrite: number;
  byField: Record<SnapshotField, number>;
  /** Fields no repaired bar feeds where today's method differs from the stored value. Not written. */
  drift: Record<SnapshotField, number>;
  /** Stale or missing recompute on a row with an affected field: left alone. */
  affectedLeftAlone: number;
  /** Stale or missing recompute with nothing affected. */
  unaffectedLeftAlone: number;
  /** The rows counted in `affectedLeftAlone`, broken down. */
  leftAlone: LeftAloneStats;
  valueRule: ValueRuleStats;
  /** Stored fields for which no pre-repair bar matched by value. */
  unmatched: Record<ValueField, number>;
  /** The TOP_UNWRITTEN largest |stored - recomputed| price differences that are not written. */
  unwritten: UnwrittenDiff[];
  /** Rows where the mirrored input rule disagrees with computeSnapshot. */
  attributionInconsistent: number;
  controlRows: number;
  controlMatched: number;
  controlDays: number;
  /** A thin root's control, split by explanation; null for ES and NQ, which must match exactly. */
  thin: ThinControl | null;
}

/** A thin root's control rows: exact, or a miss explained by a late bar, or neither. */
export interface ThinControl {
  rows: number;
  exact: number;
  lateBar: number;
  lateVolume: number;
  other: number;
  /** Minutes older than the latest closed bar, for each late-bar row. */
  lateAges: number[];
  /** The first SAMPLE_N other rows, with every field. */
  otherRows: string[];
}

export interface SnapshotInfoDay {
  rows: number;
  matched: number;
  classes: Record<MismatchClass, number>;
}

/** One symbol's rows from SNAPSHOT_INFO_FROM_MS to the control start: classified, not gated. */
export interface SnapshotInfo {
  symbol: Sym;
  rows: number;
  matched: number;
  byClass: Record<MismatchClass, number>;
  byDay: Record<string, SnapshotInfoDay>;
  /** Minutes older than the latest closed bar, for each late-bar row. */
  lateAges: number[];
  /** Rows whose stored price differs and is not a late bar, with every field (first SAMPLE_N). */
  priceNotLate: string[];
  priceNotLateCount: number;
  /** Unexplained rows whose stored price also equals an older bar's close (late-bar under a looser rule). */
  unexplainedOlderMatch: number;
  /** The first SAMPLE_N unexplained rows, with every field. */
  unexplained: string[];
}

export interface SnapshotStore extends StoreResult<SnapshotChange> {
  symbols: SnapshotSymbolReport[];
  info: SnapshotInfo[];
  /** The method control's rows, per symbol, classified like the information window. */
  controlMisses: SnapshotInfo[];
}

export interface PremarketStore extends StoreResult<PremarketChange> {
  /** In-scope rows whose recompute equals what is stored. */
  equalInScope: number;
  /** In-scope rows that differ though no repaired bar is in the window: not written. */
  notAffected: string[];
}

export interface Plans {
  snapshots?: SnapshotStore;
  premarket?: PremarketStore;
  fires?: StoreResult<FireChange>;
}

const emptyFields = (): Record<SnapshotField, number> => ({
  price: 0,
  change1hPct: 0,
  changeDayPct: 0,
  volumeRatio: 0,
});

const utcDay = (tsMs: number): string => iso(tsMs).slice(0, 10);

/** True from 16:15 to 17:00 CT, the daily maintenance break. */
function inDailyBreak(tsMs: number): boolean {
  const { hour, minute } = getCTTime(new Date(tsMs));
  const t = hour * 60 + minute;
  return t >= 16 * 60 + 15 && t < 17 * 60;
}

function noteLeftAlone(
  stats: LeftAloneStats,
  kind: SnapshotResult['kind'],
  affected: ReadonlySet<SnapshotField>,
  tsMs: number,
): void {
  if (kind === 'stale') stats.stale += 1;
  else stats.missing += 1;
  for (const f of affected) stats.byField[f] += 1;
  if (inDailyBreak(tsMs)) stats.inBreak += 1;
  else stats.elsewhere += 1;
  stats.firstMs = Math.min(stats.firstMs ?? tsMs, tsMs);
  stats.lastMs = Math.max(stats.lastMs ?? tsMs, tsMs);
}

/** The cash open of the ET trade date of `at`, as epoch ms; null for a malformed date. */
function dayOpenOf(at: Date): number | null {
  const open = getETMarketOpenUtcIso(getETDateStr(at));
  return open == null ? null : Date.parse(open);
}

const emptyClasses = (): Record<MismatchClass, number> => ({
  'september-window': 0,
  'late-bar': 0,
  unexplained: 0,
});

/** Classifies every mismatch among already evaluated rows: september-window, late-bar or unexplained. */
async function classifyEvals(
  symbol: Sym,
  evals: SnapshotEvaluation[],
): Promise<SnapshotInfo> {
  const info: SnapshotInfo = {
    symbol,
    rows: 0,
    matched: 0,
    byClass: emptyClasses(),
    byDay: {},
    lateAges: [],
    priceNotLate: [],
    priceNotLateCount: 0,
    unexplainedOlderMatch: 0,
    unexplained: [],
  };
  for (const { row, result, outcome } of evals) {
    const day = (info.byDay[utcDay(row.tsMs)] ??= {
      rows: 0,
      matched: 0,
      classes: emptyClasses(),
    });
    info.rows += 1;
    day.rows += 1;
    if (outcome.kind === 'same') {
      info.matched += 1;
      day.matched += 1;
      continue;
    }
    let verdict: ReturnType<typeof classifyMismatch> = {
      cls: 'unexplained',
      ageMin: null,
      olderMatch: false,
    };
    if (outcome.kind === 'change' && result.kind === 'fresh') {
      const base = {
        fields: outcome.fields,
        atMs: row.tsMs,
        storedPrice: row.stored.price,
      };
      verdict = classifyMismatch({ ...base, olderBars: [] });
      if (verdict.cls !== 'september-window') {
        const older = await olderBarsBefore(
          symbol,
          Date.parse(result.snapshot.latestTs),
        );
        verdict = classifyMismatch({ ...base, olderBars: older });
      }
    }
    info.byClass[verdict.cls] += 1;
    day.classes[verdict.cls] += 1;
    if (verdict.ageMin != null) info.lateAges.push(verdict.ageMin);
    if (verdict.cls === 'unexplained' && verdict.olderMatch) {
      info.unexplainedOlderMatch += 1;
    }
    if (
      verdict.cls !== 'late-bar' &&
      outcome.kind === 'change' &&
      outcome.fields.includes('price')
    ) {
      info.priceNotLateCount += 1;
      if (info.priceNotLate.length < SAMPLE_N) {
        info.priceNotLate.push(mismatchLine(row, outcome));
      }
    }
    if (verdict.cls === 'unexplained' && info.unexplained.length < SAMPLE_N) {
      info.unexplained.push(mismatchLine(row, outcome));
    }
  }
  return info;
}

/** Classifies every mismatch of the rows before the control start. */
async function classifyInfoWindow(symbol: Sym): Promise<SnapshotInfo> {
  const rows = await readSnapshots(
    symbol,
    SNAPSHOT_INFO_FROM_MS,
    SNAPSHOT_CONTROL_FROM_MS,
  );
  return classifyEvals(
    symbol,
    await evaluateSnapshots(rows, `${symbol} snapshots info`),
  );
}

/**
 * The method control: rows written by today's code, which must recompute equal
 * to what is stored. Rows before SNAPSHOT_CONTROL_FROM_MS are classified as
 * information (classifyInfoWindow).
 */
async function snapshotControl(
  symbol: Sym,
  report: SnapshotSymbolReport,
): Promise<SnapshotEvaluation[]> {
  const rows = await readSnapshots(
    symbol,
    SNAPSHOT_CONTROL_FROM_MS,
    Date.now() + DAY_MS,
  );
  const evals = await evaluateSnapshots(rows, `${symbol} snapshots control`);
  report.controlRows = rows.length;
  report.controlMatched = evals.filter((e) => e.outcome.kind === 'same').length;
  report.controlDays = new Set(rows.map((r) => utcDay(r.tsMs))).size;
  return evals;
}

/**
 * Splits a thin root's control rows into exact matches, misses that a late bar
 * explains (late-bar, late-volume: see classifyThinMiss) and the rest. The set
 * of explained evaluations counts as a match in the gate.
 */
async function explainThinControl(
  symbol: Sym,
  evals: SnapshotEvaluation[],
): Promise<{ thin: ThinControl; explained: Set<SnapshotEvaluation> }> {
  const thin: ThinControl = {
    rows: evals.length,
    exact: 0,
    lateBar: 0,
    lateVolume: 0,
    other: 0,
    lateAges: [],
    otherRows: [],
  };
  const explained = new Set<SnapshotEvaluation>();
  for (const ev of evals) {
    const { row, result, outcome } = ev;
    if (outcome.kind === 'same') {
      thin.exact += 1;
      continue;
    }
    let verdict: ReturnType<typeof classifyThinMiss> = {
      cls: 'other',
      ageMin: null,
    };
    if (outcome.kind === 'change' && result.kind === 'fresh') {
      const older = outcome.fields.includes('price')
        ? await olderBarsBefore(symbol, Date.parse(result.snapshot.latestTs))
        : [];
      verdict = classifyThinMiss({
        fields: outcome.fields,
        atMs: row.tsMs,
        storedPrice: row.stored.price,
        olderBars: older,
        storedVolumeRatio: row.stored.volumeRatio,
        recomputedVolumeRatio: outcome.to.volumeRatio,
      });
    }
    if (verdict.cls === 'late-bar') {
      thin.lateBar += 1;
      if (verdict.ageMin != null) thin.lateAges.push(verdict.ageMin);
      explained.add(ev);
    } else if (verdict.cls === 'late-volume') {
      thin.lateVolume += 1;
      explained.add(ev);
    } else {
      thin.other += 1;
      if (thin.otherRows.length < SAMPLE_N) {
        thin.otherRows.push(mismatchLine(row, outcome));
      }
    }
  }
  return { thin, explained };
}

/**
 * Reasons a symbol's snapshot checks refuse `--apply` beyond the control match
 * rate: a method control too small to prove anything, and input bars found for
 * attribution that disagree with what computeSnapshot used.
 */
export function snapshotProblems(
  r: Pick<
    SnapshotSymbolReport,
    'symbol' | 'controlRows' | 'controlDays' | 'attributionInconsistent'
  >,
): string[] {
  const out: string[] = [];
  if (r.controlRows < CONTROL_MIN_ROWS || r.controlDays < CONTROL_MIN_DAYS) {
    out.push(
      `${r.symbol}: the method control has ${r.controlRows} rows over ${r.controlDays} days, ${CONTROL_MIN_ROWS} rows over ${CONTROL_MIN_DAYS} days are needed`,
    );
  }
  if (r.attributionInconsistent > 0) {
    out.push(
      `${r.symbol}: the input bars found for attribution disagree with computeSnapshot on ${r.attributionInconsistent} rows`,
    );
  }
  return out;
}

/** The fields a value hit on `field` makes affected: a price hit takes the 1h and day change with it. */
function valueHitFields(field: ValueField): SnapshotField[] {
  return field === 'price' ? ['price', 'change1hPct', 'changeDayPct'] : [field];
}

const TOP_UNWRITTEN = 10;
/** A price difference over this share of the price is named in the report. */
const UNWRITTEN_FLAG_SHARE = 0.0015;

function noteUnwritten(
  list: UnwrittenDiff[],
  row: SnapshotRow,
  recomputed: number,
  why: string,
): void {
  const diff = Math.abs(row.stored.price - recomputed);
  if (list.length >= TOP_UNWRITTEN && diff <= (list.at(-1)?.diff ?? 0)) return;
  const flag = diff > UNWRITTEN_FLAG_SHARE * Math.abs(row.stored.price);
  list.push({
    diff,
    line: `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${row.stored.price}, recomputed ${recomputed}, difference ${diff.toFixed(2)}, ${why}${flag ? ' [over 0.15% of the price]' : ''}`,
  });
  list.sort((a, b) => b.diff - a.diff);
  list.length = Math.min(list.length, TOP_UNWRITTEN);
}

function noteValueRule(
  stats: ValueRuleStats,
  row: SnapshotRow,
  hits: { field: ValueField; bar: PreBar }[],
  newly: SnapshotField[],
): void {
  stats.rows += 1;
  for (const f of newly) stats.fields[f] += 1;
  // A bar that matched two fields (the price and the 1h change) counts once.
  const bars = new Map<number, PreBar>();
  for (const h of hits) {
    if (valueHitFields(h.field).some((f) => newly.includes(f))) {
      bars.set(h.bar.tsMs, h.bar);
    }
  }
  for (const bar of bars.values()) {
    if (bar.repair != null) stats.byKind[bar.repair] += 1;
  }
  if (stats.samples.length < SAMPLE_N) {
    const first = hits[0];
    if (first != null) {
      const now = first.bar.closeNow ?? 'gone';
      stats.samples.push(
        `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${first.field} matches the ${first.bar.repair} bar of ${isoSecond(first.bar.tsMs)} (close ${first.bar.closePre} before Phase 2, ${now} now); newly affected: ${newly.join(', ')}`,
      );
    }
  }
}

async function planSnapshots(
  data: Map<Sym, SymbolData>,
): Promise<SnapshotStore> {
  const scope = scopeRanges().snapshots;
  const changes: SnapshotChange[] = [];
  const unrecomputable: string[] = [];
  const reports: SnapshotSymbolReport[] = [];
  const controlEvals: SnapshotEvaluation[] = [];
  const problems: string[] = [];
  const infos: SnapshotInfo[] = [];
  const controlMisses: SnapshotInfo[] = [];

  for (const symbol of SYMBOLS) {
    const sd = data.get(symbol);
    if (sd == null) throw new Error(`no bars were read for ${symbol}`);
    const rows = await readSnapshots(symbol, scope.fromMs, scope.toMs);
    console.log(`snapshots ${symbol}: ${rows.length} rows in range`);
    const report: SnapshotSymbolReport = {
      symbol,
      inRange: rows.length,
      rowsToWrite: 0,
      byField: emptyFields(),
      drift: emptyFields(),
      affectedLeftAlone: 0,
      unaffectedLeftAlone: 0,
      leftAlone: {
        stale: 0,
        missing: 0,
        byField: emptyFields(),
        inBreak: 0,
        elsewhere: 0,
        firstMs: null,
        lastMs: null,
      },
      valueRule: {
        rows: 0,
        fields: emptyFields(),
        byKind: { deleted: 0, 'close-changed': 0 },
        samples: [],
      },
      unmatched: { price: 0, change1hPct: 0, changeDayPct: 0 },
      unwritten: [],
      attributionInconsistent: 0,
      controlRows: 0,
      controlMatched: 0,
      controlDays: 0,
      thin: null,
    };

    for (const { row, result, outcome } of await evaluateSnapshots(
      rows,
      `${symbol} snapshots in range`,
    )) {
      const dayOpenMs = dayOpenOf(new Date(row.tsMs));
      const byRule = affectedSnapshotFields(
        sd.repair,
        sd.bars,
        row.tsMs,
        dayOpenMs,
      );
      const byValue = attributeByValue(
        sd.series,
        row.tsMs,
        dayOpenMs,
        row.stored,
      );
      for (const f of byValue.unmatched) report.unmatched[f] += 1;
      const affected = new Set<SnapshotField>([...byRule, ...byValue.fields]);
      const newly = [...byValue.fields].filter((f) => !byRule.has(f));
      if (newly.length > 0) {
        noteValueRule(report.valueRule, row, byValue.hits, newly);
      }
      if (
        result.kind === 'fresh' &&
        !inputsMatchSnapshot(
          snapshotInputs(sd.bars, row.tsMs, dayOpenMs),
          result.snapshot,
        )
      ) {
        report.attributionInconsistent += 1;
      }
      if (outcome.kind === 'unrecomputable') {
        if (affected.size > 0) {
          report.affectedLeftAlone += 1;
          noteLeftAlone(report.leftAlone, result.kind, affected, row.tsMs);
          unrecomputable.push(
            `${snapshotLine(row, null, outcome.why)} [affected: ${[...affected].sort().join(', ')}]`,
          );
        } else {
          report.unaffectedLeftAlone += 1;
        }
        const latest = snapshotInputs(sd.bars, row.tsMs, dayOpenMs).latest;
        if (latest != null) {
          noteUnwritten(
            report.unwritten,
            row,
            latest.close,
            `left alone, ${result.kind} (${affected.size > 0 ? 'a field is affected' : 'nothing affected'}), against the latest closed bar`,
          );
        }
        continue;
      }
      if (outcome.kind === 'same') continue;
      const writable = outcome.fields.filter((f) => affected.has(f));
      for (const f of outcome.fields) {
        if (!affected.has(f)) report.drift[f] += 1;
      }
      if (outcome.fields.includes('price') && !writable.includes('price')) {
        noteUnwritten(
          report.unwritten,
          row,
          outcome.to.price,
          'method drift, price not affected',
        );
      }
      if (writable.length === 0) continue;
      report.rowsToWrite += 1;
      for (const f of writable) report.byField[f] += 1;
      changes.push({
        id: row.id,
        symbol,
        tsMs: row.tsMs,
        fields: writable,
        from: row.stored,
        to: outcome.to,
        row: row.row,
      });
    }

    const controlOfSymbol = await snapshotControl(symbol, report);
    if (isThinRoot(symbol)) {
      const { thin, explained } = await explainThinControl(
        symbol,
        controlOfSymbol,
      );
      report.thin = thin;
      // A miss that a late bar explains counts as a match in the gate.
      controlEvals.push(
        ...controlOfSymbol.map(
          (ev): SnapshotEvaluation =>
            explained.has(ev) ? { ...ev, outcome: { kind: 'same' } } : ev,
        ),
      );
    } else {
      controlEvals.push(...controlOfSymbol);
      controlMisses.push(await classifyEvals(symbol, controlOfSymbol));
    }
    infos.push(await classifyInfoWindow(symbol));
    problems.push(...snapshotProblems(report));
    reports.push(report);
  }

  const control = controlOfSnapshots(controlEvals);
  control.label = SNAPSHOT_CONTROL_LABEL;
  control.problems = problems;
  return {
    inScope: reports.reduce((n, r) => n + r.inRange, 0),
    changes,
    unrecomputable,
    control,
    symbols: reports,
    info: infos,
    controlMisses,
  };
}

/** True when two Globex aggregates agree: the doubles exactly on high/low/close, the vwap to 1e-6 relative. */
function reproduces(
  stored: GlobexValues | null,
  agg: WindowAggregate | null,
): boolean {
  if (stored == null || agg == null) return false;
  const vwapOk =
    stored.globexVwap == null || agg.vwap == null
      ? stored.globexVwap === agg.vwap
      : Math.abs(stored.globexVwap - agg.vwap) <=
        1e-6 * Math.abs(stored.globexVwap);
  return (
    stored.globexHigh === agg.high &&
    stored.globexLow === agg.low &&
    stored.globexClose === agg.close &&
    vwapOk
  );
}

async function planPremarket(
  data: Map<Sym, SymbolData>,
): Promise<PremarketStore> {
  const es = data.get('ES');
  if (es == null) throw new Error('no bars were read for ES');
  const all = await readAutoFilled();
  const inScope = all.filter((r) => premarketInScope(r.date));
  const outside = all.filter((r) => !premarketInScope(r.date));
  console.log(
    `premarket: ${all.length} auto-filled rows, ${inScope.length} in scope, ${outside.length} outside the span`,
  );

  const sql = getDb();
  const dates = [...new Set(all.map((r) => r.date))];
  const globexList = await mapPool(dates, CONCURRENCY, 'premarket', (date) =>
    queryGlobex(sql, date),
  );
  const globexByDate = new Map(dates.map((d, i) => [d, globexList[i] ?? null]));
  const compare = (r: PremarketRow) =>
    compareGlobex(r.stored, globexByDate.get(r.date) ?? null);

  const changes: PremarketChange[] = [];
  const unrecomputable: string[] = [];
  const notAffected: string[] = [];
  let equalInScope = 0;
  for (const r of inScope) {
    const outcome = compare(r);
    const w = premarketWindow(r.date);
    if (outcome.kind === 'same') {
      equalInScope += 1;
    } else if (outcome.kind === 'unrecomputable') {
      unrecomputable.push(`${r.date} id ${r.id}: ${outcome.why}`);
    } else if (!windowAffected(es.repair, w.fromMs, w.toMs)) {
      notAffected.push(
        `${r.date} id ${r.id} ${globexLine(r.stored)} -> ${globexLine(outcome.to)}`,
      );
    } else {
      const before = aggregateWindow(
        preRepairWindow(
          es.bars.filter((b) => b.tsMs >= w.fromMs && b.tsMs < w.toMs),
          es.backup,
          w.fromMs,
          w.toMs,
        ),
      );
      changes.push({
        id: r.id,
        date: r.date,
        entryTime: r.entryTime,
        fields: outcome.fields,
        from: r.stored,
        to: outcome.to,
        preRepair: reproduces(r.stored, before) ? 'reproduces' : 'differs',
        row: r.row,
      });
    }
  }

  // Bars added after the auto-fill can only widen a window's range, so a stored
  // row outside the span must sit inside today's range: its high no higher and
  // its low no lower. The exact four-key match is information.
  let exact = 0;
  const control = controlOf(
    outside.map((r) => {
      const outcome = compare(r);
      const now = globexByDate.get(r.date) ?? null;
      if (outcome.kind === 'same') exact += 1;
      const inside =
        r.stored != null &&
        now != null &&
        r.stored.globexHigh <= now.globexHigh &&
        r.stored.globexLow >= now.globexLow;
      let kindKey = '';
      if (!inside) {
        if (r.stored == null) kindKey = 'unreadable stored values';
        else if (now == null) kindKey = 'no overnight bars now';
        else if (r.stored.globexHigh > now.globexHigh) {
          kindKey = 'stored high above the recomputed high';
        } else kindKey = 'stored low below the recomputed low';
      }
      return {
        outcome: { kind: inside ? 'same' : 'change' },
        month: r.date.slice(0, 7),
        kindKey,
        describe: () =>
          `${r.date} id ${r.id} ${globexLine(r.stored)} -> ${globexLine(now)}`,
      };
    }),
  );
  control.label = 'subset check holds for';
  control.notes = [
    `exact four-key match (information): ${exact} of ${outside.length}`,
  ];
  return {
    inScope: inScope.length,
    changes,
    unrecomputable,
    control,
    equalInScope,
    notAffected,
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
  const label = c.label ?? 'control set matches';
  const out = [`  ${label}: ${c.matched} of ${c.rows} (${rate})`];
  const months = Object.entries(c.byMonth)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([m, v]) => `${m} ${v.matched}/${v.rows}`);
  if (months.length > 0)
    out.push(`    matched/rows by month: ${months.join(', ')}`);
  for (const [kind, n] of Object.entries(c.byKind)) {
    out.push(`    mismatch ${kind || '(none)'}: ${n}`);
  }
  for (const s of c.samples) out.push(`    e.g. ${s}`);
  for (const n of c.notes ?? []) out.push(`    ${n}`);
  return out;
}

function unrecomputableText(list: string[]): string[] {
  if (list.length === 0) return ['  rows left alone (cannot be recomputed): 0'];
  return [
    `  rows left alone (cannot be recomputed): ${list.length}`,
    ...list.slice(0, SAMPLE_N).map((l) => `    ${l}`),
  ];
}

const percentOf = (x: number): string => `${(x * 100).toFixed(2)}%`;

/** Count, |relative change| median, p90, max and how many are under 1%, for the volume-ratio writes of one symbol. */
export function volumeRatioWriteText(
  changes: SnapshotChange[],
  symbol: Sym,
): string {
  const writes = changes.filter(
    (c) => c.symbol === symbol && c.fields.includes('volumeRatio'),
  );
  const rel: number[] = [];
  let nullEnds = 0;
  for (const c of writes) {
    const from = c.from.volumeRatio;
    const to = c.to.volumeRatio;
    if (from == null || to == null || from === 0) nullEnds += 1;
    else rel.push(Math.abs(to - from) / Math.abs(from));
  }
  rel.sort((a, b) => a - b);
  const under = rel.filter((x) => x < 0.01).length;
  const spread =
    rel.length === 0
      ? ''
      : `; |relative change| median ${percentOf(percentile(rel, 0.5))}, p90 ${percentOf(percentile(rel, 0.9))}, max ${percentOf(rel.at(-1) ?? 0)}; under 1%: ${under}`;
  return `volume-ratio writes: ${writes.length}${spread}; from or to null: ${nullEnds}`;
}

function leftAloneText(a: LeftAloneStats): string {
  const when =
    a.firstMs == null || a.lastMs == null
      ? 'none'
      : `${utcDay(a.firstMs)} to ${utcDay(a.lastMs)}`;
  return `stale ${a.stale}, missing ${a.missing}; by affected field ${byFieldText(a.byField)}; in the 16:15-17:00 CT daily break ${a.inBreak}, elsewhere ${a.elsewhere}; first and last date ${when}`;
}

const byFieldText = (counts: Record<SnapshotField, number>): string =>
  SNAPSHOT_KEYS.map((k) => `${k}=${counts[k]}`).join(' ');

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

/** The spread of late-bar ages: minutes older than the latest closed bar. */
function lateAgeText(lateAges: number[]): string {
  const ages = [...lateAges].sort((a, b) => a - b);
  const hist = Array.from({ length: LATE_BAR_MAX_AGE_MIN }, (_, i) => i + 1)
    .map((m) => `${m}:${ages.filter((a) => a === m).length}`)
    .join(' ');
  return `    late-bar age, minutes older than the latest closed bar: min ${ages[0]}, median ${percentile(ages, 0.5)}, p90 ${percentile(ages, 0.9)}, max ${ages.at(-1)} (${hist})`;
}

function thinControlText(symbol: Sym, t: ThinControl): string[] {
  const out = [
    `    ${symbol} thin-root control (a miss passes when a late bar explains it): ${t.rows} rows, ${t.exact} exact, late-bar ${t.lateBar}, late-volume ${t.lateVolume}, other ${t.other}`,
  ];
  if (t.lateAges.length > 0) out.push(lateAgeText(t.lateAges));
  if (t.other > 0) {
    out.push(
      `    OTHER rows, first ${t.otherRows.length} of ${t.other} (every field, stored -> recomputed, * where it differs):`,
      ...t.otherRows.map((l) => `      ${l}`),
    );
  }
  return out;
}

function infoText(info: SnapshotInfo, heading: string): string[] {
  const miss = info.rows - info.matched;
  const classes = info.byClass;
  const out = [
    `  ${heading}: ${info.rows} rows, ${info.matched} match, ${miss} do not`,
    `    mismatches by class: september-window ${classes['september-window']}, late-bar ${classes['late-bar']}, unexplained ${classes.unexplained}`,
  ];
  if (info.lateAges.length > 0) out.push(lateAgeText(info.lateAges));
  const days = Object.entries(info.byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([d, v]) =>
        `${d.slice(5)} ${v.matched}/${v.rows} (${v.classes['september-window']}/${v.classes['late-bar']}/${v.classes.unexplained})`,
    );
  if (days.length > 0) {
    out.push(
      `    by day, matched/rows (september-window/late-bar/unexplained): ${days.join(', ')}`,
    );
  }
  const listed =
    info.priceNotLate.length > 0
      ? ` (first ${info.priceNotLate.length}, every field, * where it differs)`
      : '';
  out.push(
    `    price misses that are not late bars: ${info.priceNotLateCount}${listed}`,
    ...info.priceNotLate.map((l) => `      ${l}`),
  );
  if (classes.unexplained > 0) {
    out.push(
      `    unexplained rows whose stored price equals the latest closed bar and also an older bar (late-bar only under a looser rule): ${info.unexplainedOlderMatch}`,
      `    UNEXPLAINED rows, first ${info.unexplained.length} of ${classes.unexplained} (every field, stored -> recomputed, * where it differs):`,
      ...info.unexplained.map((l) => `      ${l}`),
    );
  }
  return out;
}

function snapshotsText(r: SnapshotStore): string[] {
  const top = r.changes
    .filter((c) => c.fields.includes('price'))
    .sort(
      (a, b) =>
        Math.abs(b.to.price - b.from.price) -
        Math.abs(a.to.price - a.from.price),
    )
    .slice(0, TOP_N);
  const out = [
    'futures_snapshots (ES, NQ, RTY, CL, GC, ZN): only the fields a repaired bar feeds are written',
    `  rows in range: ${r.inScope}, rows to write: ${r.changes.length}`,
  ];
  for (const s of r.symbols) {
    out.push(
      `  ${s.symbol}: rows in range ${s.inRange}, rows to write ${s.rowsToWrite} (${byFieldText(s.byField)})`,
      `    left alone, stale or missing recompute: ${s.affectedLeftAlone} with an affected field, ${s.unaffectedLeftAlone} with none`,
      `      the ${s.affectedLeftAlone} with an affected field (kept as stored): ${leftAloneText(s.leftAlone)}`,
      `    ${volumeRatioWriteText(r.changes, s.symbol)}`,
      `    information, unaffected fields where today's method differs from the stored value (not written): ${byFieldText(s.drift)}`,
      `    method control, rows from ${isoSecond(SNAPSHOT_CONTROL_FROM_MS)}: ${s.controlMatched} of ${s.controlRows} match over ${s.controlDays} days`,
      ...(s.thin == null ? [] : thinControlText(s.symbol, s.thin)),
      `    attribution inputs disagreeing with computeSnapshot: ${s.attributionInconsistent}`,
      `    newly affected by the value rule (the stored input found by value, a bar Phase 2 deleted or changed): ${s.valueRule.rows} rows (${byFieldText(s.valueRule.fields)}), matched bars deleted ${s.valueRule.byKind.deleted}, close-changed ${s.valueRule.byKind['close-changed']}`,
      ...s.valueRule.samples.map((l) => `      ${l}`),
      `    unmatched (no pre-repair bar matched the stored value, so the field is left to the other rule): price=${s.unmatched.price} change1hPct=${s.unmatched.change1hPct} changeDayPct=${s.unmatched.changeDayPct}`,
      `    the ${s.unwritten.length} largest price differences not written (stored vs recomputed, or vs the latest closed bar when the recompute is stale):`,
      ...s.unwritten.map((u) => `      ${u.line}`),
    );
  }
  out.push(
    '  largest price diffs written:',
    ...top.map(
      (c) =>
        `    ${snapshotLine({ id: c.id, symbol: c.symbol, tsMs: c.tsMs, stored: c.from, row: c.row }, c.to)} [writes ${c.fields.join(', ')}]`,
    ),
    ...unrecomputableText(r.unrecomputable),
    ...controlText(r.control),
  );
  for (const info of r.controlMisses) {
    if (info.matched === info.rows) continue;
    out.push(
      ...infoText(
        info,
        `control misses, ${info.symbol}, rows from ${isoSecond(SNAPSHOT_CONTROL_FROM_MS)} (the control must be 100%)`,
      ),
    );
  }
  for (const info of r.info) {
    out.push(
      ...infoText(
        info,
        `information, ${info.symbol}, rows ${isoSecond(SNAPSHOT_INFO_FROM_MS)} to ${isoSecond(SNAPSHOT_CONTROL_FROM_MS)} (every row, not gated)`,
      ),
    );
  }
  return out;
}

function premarketText(r: PremarketStore): string[] {
  return [
    'market_snapshots.pre_market_data (auto-filled rows only): written only where a repaired bar is in the window',
    `  rows in scope: ${r.inScope}, rows to write: ${r.changes.length}, equal to the recompute: ${r.equalInScope}`,
    ...unrecomputableText(r.unrecomputable),
    `  differ from the recompute with no repaired bar in the window (not written): ${r.notAffected.length}`,
    ...r.notAffected.slice(0, SAMPLE_N).map((l) => `    ${l}`),
    '  Globex high/low/close/vwap, old -> new, per date (the last flag says whether the bars as they were before Phase 2 reproduce the stored values):',
    ...r.changes.map(
      (c) =>
        `    ${c.date} id ${c.id} (${c.entryTime}) ${globexLine(c.from)} -> ${globexLine(c.to)} [pre-repair bars ${c.preRepair === 'reproduces' ? 'reproduce the stored values' : 'do not reproduce the stored values: also differs outside the repaired bars'}]`,
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
      ? 'Apply gate: every check passes.'
      : 'APPLY WOULD REFUSE:',
    ...gateProblems.map((p) => `  ${p}`),
  );
  return out.join('\n');
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Writes only the fields the plan names for each row: a `set_*` flag per field
 * keeps the stored value of every other field, so an unaffected field is never
 * touched. The guard compares the values the row would hold afterwards, so a
 * row that already holds them is not rewritten.
 */
function updateSnapshots(sql: Sql, rows: SnapshotChange[]) {
  const sets = (field: SnapshotField) =>
    rows.map((c) => c.fields.includes(field));
  return sql`
    UPDATE futures_snapshots f
       SET price = CASE WHEN r.set_price THEN r.price ELSE f.price END,
           change_1h_pct = CASE WHEN r.set_1h THEN r.change_1h_pct ELSE f.change_1h_pct END,
           change_day_pct = CASE WHEN r.set_day THEN r.change_day_pct ELSE f.change_day_pct END,
           volume_ratio = CASE WHEN r.set_vr THEN r.volume_ratio ELSE f.volume_ratio END
      FROM unnest(${rows.map((c) => c.id)}::int[],
                  ${rows.map((c) => c.symbol)}::text[],
                  ${sets('price')}::bool[],
                  ${rows.map((c) => c.to.price)}::numeric[],
                  ${sets('change1hPct')}::bool[],
                  ${rows.map((c) => c.to.change1hPct)}::numeric[],
                  ${sets('changeDayPct')}::bool[],
                  ${rows.map((c) => c.to.changeDayPct)}::numeric[],
                  ${sets('volumeRatio')}::bool[],
                  ${rows.map((c) => c.to.volumeRatio)}::numeric[])
           AS r(id, symbol, set_price, price, set_1h, change_1h_pct,
                set_day, change_day_pct, set_vr, volume_ratio)
     WHERE f.id = r.id AND f.symbol = r.symbol
       AND (f.price, f.change_1h_pct, f.change_day_pct, f.volume_ratio)
           IS DISTINCT FROM (
             CASE WHEN r.set_price THEN r.price ELSE f.price END,
             CASE WHEN r.set_1h THEN r.change_1h_pct ELSE f.change_1h_pct END,
             CASE WHEN r.set_day THEN r.change_day_pct ELSE f.change_day_pct END,
             CASE WHEN r.set_vr THEN r.volume_ratio ELSE f.volume_ratio END)
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

/** The values a change would write: for a snapshot only its affected fields, not the whole recompute. */
function backedUpValues(
  c: SnapshotChange | PremarketChange | FireChange,
): unknown {
  if ('symbol' in c) {
    return Object.fromEntries(c.fields.map((f) => [f, c.to[f]]));
  }
  return c.to;
}

/** One JSONL line per row about to change, full row included; the line count is checked back. */
function writeBackup(workDir: string, plans: Plans): string {
  const entries: BackupEntry[] = [];
  for (const store of STORES) {
    const result = plans[store];
    for (const c of result?.changes ?? []) {
      entries.push({ store, id: c.id, row: c.row, to: backedUpValues(c) });
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
            ...(c.fields.includes('price') && { price: c.to.price }),
            ...(c.fields.includes('change1hPct') && {
              change_1h_pct: c.to.change1hPct,
            }),
            ...(c.fields.includes('changeDayPct') && {
              change_day_pct: c.to.changeDayPct,
            }),
            ...(c.fields.includes('volumeRatio') && {
              volume_ratio: c.to.volumeRatio,
            }),
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
  /** The Phase 2 backup JSONL: required for the snapshots and premarket stores. */
  backup: string | null;
  /** The rows to write in the dry run the owner approved. Null on a dry run. */
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
    backup: null,
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
    else if (flag === '--backup') args.backup = next();
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
  if (needsBackup(args) && args.backup == null) {
    throw new Error(
      '--backup <file> is required with --apply or with the snapshots or premarket store: the Phase 2 backup JSONL',
    );
  }
  return args;
}

/**
 * `--apply` plans all three stores whatever `--stores` says, because its gate
 * needs every check to hold; `--stores` then limits only what is written. So it
 * needs the Phase 2 backup too.
 */
const needsBackup = (o: RecomputeOptions): boolean =>
  o.apply || o.stores.includes('snapshots') || o.stores.includes('premarket');

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
  if (needsBackup(opts) && opts.backup == null) {
    throw new Error(
      '--backup <file> is required with --apply or with the snapshots or premarket store',
    );
  }
  mkdirSync(opts.workDir, { recursive: true });
  const startedAt = Date.now();
  const backupBars =
    needsBackup(opts) && opts.backup != null
      ? parseBackup(readFileSync(opts.backup, 'utf8'), opts.backup)
      : [];
  console.log(
    `Futures derived-store recompute${opts.apply ? '' : ' (DRY RUN: read-only, no writes)'}`,
  );

  const plans: Plans = {};
  // A dry run plans what it was asked for; --apply plans every store, to check it.
  const planned: Store[] = opts.apply ? [...STORES] : opts.stores;
  let session: string[];
  neonConfig.fetchFunction = readOnlyFetch;
  try {
    session = await assertReadOnlySession();
    for (const line of session) console.log(line);
    const data = needsBackup(opts)
      ? await loadSymbolData(
          planned.includes('snapshots') ? SYMBOLS : ['ES'],
          backupBars,
        )
      : new Map<Sym, SymbolData>();
    if (planned.includes('fires')) plans.fires = await planFires();
    if (planned.includes('premarket'))
      plans.premarket = await planPremarket(data);
    if (planned.includes('snapshots'))
      plans.snapshots = await planSnapshots(data);
  } finally {
    neonConfig.fetchFunction = undefined;
  }

  const gateInputs: GateInput[] = planned.flatMap((store) => {
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
      ...(opts.backup == null
        ? []
        : [
            `Phase 2 backup ${opts.backup}: ${backupBars.length} rows (${backupBars.filter((b) => b.op === 'update').length} updated, ${backupBars.filter((b) => b.op === 'delete').length} deleted)`,
          ]),
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
  // Every planned store's checks must hold; only the stores to be written have
  // an approved total to equal.
  const approved: Partial<Record<Store, number | null>> = {};
  for (const store of opts.stores) approved[store] = expectations(opts)[store];
  const problems = checkApplyGate(gateInputs, approved);
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
