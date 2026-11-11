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
 * fire is added or deleted. The one delete is opt-in (`--delete-junk-stale`, off
 * by default): a stale snapshot row whose price is the close of a bar Phase 2
 * deleted, which cannot be recomputed and whose `price` cannot be blanked. A
 * second one runs alone (`--stores frozen --delete-frozen-stale`, off by default,
 * owner OK 2026-11-11): the ES and NQ snapshot rows before 2026-10-01 that
 * computeSnapshot cannot price and whose price is not the close of the latest
 * closed bar, so they are frozen on an older bar (planFrozen).
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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { neonConfig } from '@neondatabase/serverless';
import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  BAR_CLOSE_LAG_MS,
  FUTURES_SYMBOLS,
  MAX_BAR_AGE_MS,
  VOLUME_WINDOW_MS,
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
import { isHoliday } from '../../src/data/marketHours.js';
import {
  getCTDateStr,
  getCTDayOfWeek,
  getCTTime,
  getETDateStr,
  getETMarketOpenUtcIso,
} from '../../src/utils/timezone.js';
import {
  LATE_BAR_MAX_AGE_MIN,
  VALUE_LOOKBACK_MS,
  affectedSnapshotFields,
  aggregateWindow,
  attributeByValue,
  buildPreSeries,
  buildRepair,
  classifyMismatch,
  classifyThinMiss,
  findMergeState,
  inputsMatchSnapshot,
  mergeStateBars,
  parseBackup,
  preRepairWindow,
  snapshotInputs,
  windowAffected,
  type BackupBar,
  type Bar,
  type MergeBarView,
  type MismatchClass,
  type OlderBar,
  type PreBar,
  type Repair,
  type SnapshotField,
  type ValueField,
  type ValueHit,
  type WindowAggregate,
} from './futures-derived-attribution.js';
import {
  CHUNKS_PER_TRANSACTION,
  WRITE_CHUNK,
} from './futures-derived-batch.js';

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
export const SNAPSHOT_LOOKBACK_MS = VOLUME_WINDOW_MS;
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
/**
 * The stale-at-write test reaches every snapshot row before this: the freshness
 * gate (ecf9c021) shipped on 2026-09-30, so until then the writer priced from the
 * last bar it had while minutes were missing. The rows are read to here, far past
 * the 20-day volume window of the repaired span.
 */
export const STALE_UNTIL_MS = Date.UTC(2026, 9, 1);
/**
 * A thin root whose after-span stale rows fall on contaminated days (the Phase 1
 * detector's confirmed month-mix days) by more than this share is not safe to
 * rewrite: the report says to stop.
 */
const CONTAMINATED_SHARE_STOP_PCT = 10;
/**
 * The September outage, 2026-09-04 to 09-28: the snapshot cron priced every root
 * from its last bar for 24 days. It only labels one report line, the count of
 * frozen-run rows inside it; it has no effect on which rows are written.
 */
const OUTAGE = {
  fromMs: Date.UTC(2026, 8, 4),
  toMs: Date.UTC(2026, 8, 29),
} as const;
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
const isoDay = (tsMs: number): string => iso(tsMs).slice(0, 10);

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

/**
 * Why `--apply --delete-junk-stale` must refuse: the rows it would delete must be
 * the count the owner approved from the dry run. Empty without the flag.
 */
export function checkJunkGate(
  o: Pick<RecomputeOptions, 'deleteJunkStale' | 'expectJunkDeletes'>,
  planned: number,
): string[] {
  if (!o.deleteJunkStale) return [];
  if (o.expectJunkDeletes == null) {
    return [
      '--delete-junk-stale needs --expect-junk-deletes J: the count of the dry run you approved',
    ];
  }
  if (o.expectJunkDeletes !== planned) {
    return [
      `the fresh plan deletes ${planned} junk-priced rows, --expect-junk-deletes ${o.expectJunkDeletes} was given`,
    ];
  }
  return [];
}

/**
 * Why `--apply --delete-frozen-stale` must refuse: the rows it would delete must be
 * the count the owner approved from the dry run. Empty without the flag.
 */
export function checkFrozenGate(
  o: Pick<RecomputeOptions, 'deleteFrozenStale' | 'expectFrozenDeletes'>,
  planned: number,
): string[] {
  if (!o.deleteFrozenStale) return [];
  if (o.expectFrozenDeletes == null) {
    return [
      '--delete-frozen-stale needs --expect-frozen-deletes N: the count of the dry run you approved',
    ];
  }
  if (o.expectFrozenDeletes !== planned) {
    return [
      `the fresh plan deletes ${planned} frozen-stale rows, --expect-frozen-deletes ${o.expectFrozenDeletes} was given`,
    ];
  }
  return [];
}

/**
 * Why `--apply --rewrite-stale-at-write` must refuse: the rows it would rewrite
 * must be the count the owner approved from the dry run. Empty without the flag.
 */
export function checkStaleGate(
  o: Pick<RecomputeOptions, 'rewriteStaleAtWrite' | 'expectStaleRewrites'>,
  planned: number,
): string[] {
  if (!o.rewriteStaleAtWrite) return [];
  if (o.expectStaleRewrites == null) {
    return [
      '--rewrite-stale-at-write needs --expect-stale-rewrites S: the count of the dry run you approved',
    ];
  }
  if (o.expectStaleRewrites !== planned) {
    return [
      `the fresh plan rewrites ${planned} stale-at-write rows, --expect-stale-rewrites ${o.expectStaleRewrites} was given`,
    ];
  }
  return [];
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

/**
 * Bars are read from this long before the span, so the pre-market windows, the
 * hour-ago bars and the value rule's whole look-back are covered for the first
 * row of the scope.
 */
export const BARS_LEAD_MS = VALUE_LOOKBACK_MS;

interface SymbolData {
  /** Every bar from BARS_LEAD_MS before the span to the end of the snapshot scope, by ts. */
  bars: Bar[];
  repair: Repair;
  backup: BackupBar[];
  /** The same bars as they were before Phase 2, for finding a stored row's inputs by value. */
  series: PreBar[];
  /** The bars Phase 2 updated, by ts, with their values before it. */
  updates: Map<number, BackupBar>;
}

interface RawBar {
  ts: string;
  open: string;
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
               open::text AS open, high::text AS high, low::text AS low,
               close::text AS close, volume::text AS volume
          FROM futures_bars
         WHERE symbol = ${symbol}
           AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
         ORDER BY ts`,
    );
    for (const r of page) {
      out.push({
        tsMs: Date.parse(r.ts),
        open: Number(r.open),
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
      Math.max(scope.toMs, STALE_UNTIL_MS),
    );
    const mine = backup.filter((b) => b.symbol === symbol);
    out.set(symbol, {
      bars,
      backup: mine,
      repair: buildRepair(mine, new Map(bars.map((b) => [b.tsMs, b]))),
      series: buildPreSeries(mine, bars),
      updates: new Map(
        mine.filter((b) => b.op === 'update').map((b) => [b.tsMs, b]),
      ),
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
  /** Every match to a bar whose close Phase 2 changed, with how much older the bar is than the row. */
  closeChanged: { line: string; coincidence: boolean }[];
  /** Matched bars older than the freshness gate (MAX_BAR_AGE_MS) and older than COINCIDENCE_MIN, by what Phase 2 did to them. */
  older15: { deleted: number; 'close-changed': number };
  older60: { deleted: number; 'close-changed': number };
}

/**
 * The merge-state attribution rule (ruling 6) for an ES or NQ report: a row
 * with no value match whose stored price lies in the pre-repair range of a bar
 * Phase 2 changed (see findMergeState) has price, 1h and day affected.
 */
export interface MergeStateReport {
  /** Rows the rule made affected that no other rule had (a field it added). */
  added: number;
  fields: Record<SnapshotField, number>;
  /** Of those, rows whose recompute differs in an added field: in the write set because of the rule. */
  written: number;
  /** One line per added row. */
  rows: string[];
  /** The same rows with every bar, for merge-state.txt. */
  detail: string[];
  /** Rows that meet the test but match an unrepaired bar by value: not attributed by this rule. */
  valueMatched: {
    meeting: number;
    attributed: number;
    notAttributed: number;
    wouldWrite: number;
  };
}

/**
 * A row priced from a bar older than the freshness gate allows, with a fresh
 * recompute: the opt-in `--rewrite-stale-at-write` rewrites the fields the normal
 * snapshot step does not write on it.
 */
export interface StaleRewrite {
  /** `fields` are the differing fields the normal step leaves; `to` is the whole recompute. */
  change: SnapshotChange;
  /** The fields the normal step writes on the same row: each field is written once, by one step. */
  alsoWritten: SnapshotField[];
  /**
   * The bar whose close the stored price equals, and how many minutes older than
   * the row it is. Null when only the frozen-run clause makes the row stale.
   */
  barTsMs: number | null;
  ageMin: number | null;
  /** The frozen run the row is in, if it is in one. */
  run: PriceRun | null;
}

/**
 * Consecutive rows (by ts) of one root that all store the same price, from the
 * first row to the last.
 */
export interface PriceRun {
  startMs: number;
  endMs: number;
  rows: number;
}

/** A stretch of planned stale rows that store the same price, with the range of their recompute. */
export interface FrozenRun extends PriceRun {
  price: number;
  minTo: number;
  maxTo: number;
}

/** Day lists the Phase 1 detector produced for a thin root's bars after the span end, CT trading days. */
export interface DetectorDays {
  /** At least 10 flagged bars and 1% of the day's bars, in a run of at least 3 days: a month-mix. */
  contaminated: ReadonlySet<string>;
  /** At least one flagged bar. A single one is noise at the clean-day rate: information only. */
  flagged: ReadonlySet<string>;
}

/** What the detector's days did to a thin root's stale rows after the span end. */
export interface DetectorStats {
  contaminatedListed: number;
  flaggedListed: number;
  /** Stale rows left on a contaminated day, by CT trading day. */
  contaminatedRows: Map<string, number>;
  /** Stale rows on a day with a flagged bar (planned or left), by CT trading day: information. */
  flaggedRows: Map<string, number>;
}

/** One root's stale-at-write rows. */
export interface StaleStats {
  /** Planned rows: in the span (before its end) and after it, up to STALE_UNTIL_MS. */
  count: number;
  inSpan: number;
  afterSpan: number;
  /** Rows that meet the test but are left: a thin root's rows before the span end (D1). */
  left: number;
  /**
   * A thin root's rows from the span end to the end of the 20-day window after it
   * (the reach of a snapshot's 1h change, day change and volume window into the
   * span): left, because those inputs are contract-mixed (D1).
   */
  window: number;
  /** A thin root's rows after the span end that are left because no --detector-days file was given. */
  unchecked: number;
  /** Thin roots with a --detector-days file only. */
  detector: DetectorStats | null;
  /** Planned rows that only the frozen-run clause makes stale (no bar matches the stored price), and those in the outage. */
  frozenAdded: number;
  frozenAddedInOutage: number;
  /** The TOP_STALE largest price changes, with the matched bar's age. */
  largest: UnwrittenDiff[];
  /** Runs of two or more consecutive planned rows with the same stored price. */
  runs: number;
  rowsInRuns: number;
  /** The TOP_RUNS longest of them. */
  longest: FrozenRun[];
}

/** Stored price differs from the recompute by over 0.15% though no pre-repair bar has the stored price: not written. */
export interface UnmatchedLarge {
  count: number;
  /** The first SAMPLE_N by time. */
  first: string[];
  /** The TOP_UNMATCHED largest by difference. */
  largest: UnwrittenDiff[];
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
  /** Rows in both the normal write set and the stale plan: written once per field, by two steps. */
  alsoStale: number;
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
  /** The DRIFT_LIST_CAP largest price drifts among rows that can be recomputed and whose price is not written. */
  driftTop: UnwrittenDiff[];
  /** Those rows over UNWRITTEN_FLAG_SHARE of the price. */
  driftOverMark: number;
  unmatchedLarge: UnmatchedLarge;
  /** ES and NQ only: null for a root Phase 2 only deleted bars of. */
  mergeState: MergeStateReport | null;
  /** A thin root's rows before the span end are left (D1: its bars there are still month-mixed). */
  stale: StaleStats;
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

/** A stale or missing snapshot row whose stored price is the close of a bar Phase 2 deleted: priced from junk, and not recomputable. */
export interface JunkRow {
  id: number;
  symbol: Sym;
  tsMs: number;
  storedPrice: number;
  /** The deleted bar whose close the stored price equals, and that close. */
  barTsMs: number;
  barClose: number;
  /** The close of the latest closed bar at the row's ts: what the row could have said. */
  latestClose: number | null;
  row: Row;
}

/**
 * An ES or NQ snapshot row that computeSnapshot cannot price (stale or missing) and
 * whose stored price is not the close of the latest closed bar: frozen on an older
 * bar, and not recomputable. The opt-in `--delete-frozen-stale` deletes it.
 */
export interface FrozenRow {
  id: number;
  symbol: Sym;
  tsMs: number;
  storedPrice: number;
  /** The latest closed bar at the row (ts <= at - 60 s, at any age) and its close. */
  barTsMs: number;
  barClose: number;
  row: Row;
}

/** Where a snapshot row falls in the futures week. */
type Closure = 'break' | 'weekendOrHoliday' | 'elsewhere';

/** One root's frozen-stale rows, and the rows of the root that stay. */
export interface FrozenSymbolReport {
  symbol: Sym;
  /** Rows the SQL found: the latest closed bar is older than the freshness gate and the price differs from its close. */
  candidates: number;
  /** Candidates that computeSnapshot calls fresh: kept. */
  fresh: number;
  /** Rows to delete. */
  rows: number;
  byClosure: Record<Closure, number>;
  firstMs: number | null;
  lastMs: number | null;
  /** Kept: the latest closed bar is older than the gate and the price is its close. */
  repeatsLastClose: number;
  /** Kept: no bar at or before the row. */
  noBar: number;
}

export interface FrozenPlan {
  /** Rows to delete, ES then NQ, each by time. */
  rows: FrozenRow[];
  symbols: FrozenSymbolReport[];
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
  /** The control's misses of the exact roots (ES, NQ), classified like the information window. */
  controlMisses: SnapshotInfo[];
  /** Rows the opt-in `--delete-junk-stale` would delete: always planned and reported, never deleted by default. */
  junk: JunkRow[];
  /** Rows the opt-in `--rewrite-stale-at-write` would rewrite: always planned and reported, never rewritten by default. */
  staleRewrites: StaleRewrite[];
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
  /** Planned alone (`--stores frozen`), with no other store. */
  frozen?: FrozenPlan;
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
/**
 * The safety-net list of recomputable rows nothing will write names up to this
 * many: after every step ES and NQ keep a few dozen rows over the mark (ruling 7
 * asks for each of them by name), where the other lists show the first 10.
 */
const DRIFT_LIST_CAP = 50;
const TOP_UNMATCHED = 3;
/** A price difference over this share of the price is named in the report. */
const UNWRITTEN_FLAG_SHARE = 0.0015;
/** A value match to a bar this many minutes older than the row is marked a probable coincidence. */
const COINCIDENCE_MIN = 60;

function noteUnwritten(
  list: UnwrittenDiff[],
  row: SnapshotRow,
  recomputed: number,
  why: string,
  cap = TOP_UNWRITTEN,
): void {
  const diff = Math.abs(row.stored.price - recomputed);
  if (list.length >= cap && diff <= (list.at(-1)?.diff ?? 0)) return;
  const flag = diff > UNWRITTEN_FLAG_SHARE * Math.abs(row.stored.price);
  list.push({
    diff,
    line: `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${row.stored.price}, recomputed ${recomputed}, difference ${diff.toFixed(2)}, ${why}${flag ? ' [over 0.15% of the price]' : ''}`,
  });
  list.sort((a, b) => b.diff - a.diff);
  list.length = Math.min(list.length, cap);
}

function noteUnmatchedLarge(
  stats: UnmatchedLarge,
  row: SnapshotRow,
  recomputed: number,
): void {
  stats.count += 1;
  const why = 'no pre-repair bar has the stored price';
  const diff = Math.abs(row.stored.price - recomputed);
  if (stats.first.length < SAMPLE_N) {
    stats.first.push(
      `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${row.stored.price}, recomputed ${recomputed}, difference ${diff.toFixed(2)}`,
    );
  }
  noteUnwritten(stats.largest, row, recomputed, why, TOP_UNMATCHED);
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
  const matched = new Map<number, ValueHit>();
  for (const h of hits) {
    if (
      valueHitFields(h.field).some((f) => newly.includes(f)) &&
      !matched.has(h.bar.tsMs)
    ) {
      matched.set(h.bar.tsMs, h);
    }
  }
  for (const { field, bar } of matched.values()) {
    if (bar.repair == null) continue;
    stats.byKind[bar.repair] += 1;
    const olderMs = row.tsMs - bar.tsMs;
    if (olderMs > MAX_BAR_AGE_MS) stats.older15[bar.repair] += 1;
    if (olderMs > COINCIDENCE_MIN * MINUTE_MS) stats.older60[bar.repair] += 1;
    if (bar.repair === 'close-changed') {
      const ageMin = Math.round(olderMs / MINUTE_MS);
      const coincidence = ageMin > COINCIDENCE_MIN;
      stats.closeChanged.push({
        coincidence,
        line: `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${field} ${row.stored[field]} matches the close-changed bar of ${isoSecond(bar.tsMs)} (close ${bar.closePre} before Phase 2, ${bar.closeNow} now), ${ageMin} min older${coincidence ? ', probable coincidence' : ''}`,
      });
    }
  }
  if (stats.samples.length < SAMPLE_N) {
    const first = hits[0];
    if (first != null) {
      const now = first.bar.closeNow ?? 'gone';
      const ageMin = Math.round((row.tsMs - first.bar.tsMs) / MINUTE_MS);
      stats.samples.push(
        `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${first.field} matches the ${first.bar.repair} bar of ${isoSecond(first.bar.tsMs)} (close ${first.bar.closePre} before Phase 2, ${now} now), ${ageMin} min older; newly affected: ${newly.join(', ')}`,
      );
    }
  }
}

const ohlcText = (
  v: { open: number | null } & Omit<MergeBarView['now'], 'open'>,
) => [v.open ?? '?', v.high, v.low, v.close].join('/');

/** One bar of a merge-state row: its age against the latest closed bar, before and now, and what Phase 2 did. */
function mergeBarText(v: MergeBarView): string {
  const age = v.ageMin === 0 ? 'L' : `L-${v.ageMin} min`;
  const before = v.pre == null ? 'not in the backup' : ohlcText(v.pre);
  let did = 'Phase 2 left it unchanged';
  if (v.pre == null) did = 'Phase 2 did not update it';
  else if (v.changed) did = 'Phase 2 changed it';
  return `  ${age} ${isoSecond(v.tsMs)}: O/H/L/C before ${before}, now ${ohlcText(v.now)}, ${did}`;
}

const TOP_STALE = 10;
const TOP_RUNS = 10;

/** Index of the first bar with ts >= tsMs. */
function firstBarAt(bars: readonly Bar[], tsMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar).tsMs < tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The bar used by the recompute and the minutes either side of it: a thin root's continuity at a glance. */
function neighbourText(bars: readonly Bar[], latestMs: number): string {
  const at = (ms: number): string => {
    const i = firstBarAt(bars, ms);
    const b = bars[i];
    return b != null && b.tsMs === ms ? String(b.close) : 'none';
  };
  return `the bar used (${isoSecond(latestMs)}) closed at ${at(latestMs)}, the minutes before and after at ${at(latestMs - MINUTE_MS)} and ${at(latestMs + MINUTE_MS)}`;
}

function noteStale(
  stats: StaleStats,
  rewrite: StaleRewrite,
  row: SnapshotRow,
  extra: string,
): void {
  const c = rewrite.change;
  stats.count += 1;
  if (row.tsMs >= SPAN.endMs) stats.afterSpan += 1;
  else stats.inSpan += 1;
  const diff = Math.abs(c.to.price - c.from.price);
  if (rewrite.barTsMs == null) {
    stats.frozenAdded += 1;
    if (row.tsMs >= OUTAGE.fromMs && row.tsMs < OUTAGE.toMs) {
      stats.frozenAddedInOutage += 1;
    }
  }
  if (
    stats.largest.length < TOP_STALE ||
    diff > (stats.largest.at(-1)?.diff ?? 0)
  ) {
    const why =
      rewrite.barTsMs == null
        ? `no bar has the stored price, the row is in a frozen run of ${rewrite.run?.rows} rows from ${isoSecond(rewrite.run?.startMs ?? 0)} to ${isoSecond(rewrite.run?.endMs ?? 0)}`
        : `the matched bar of ${isoSecond(rewrite.barTsMs)} is ${rewrite.ageMin} min older`;
    stats.largest.push({
      diff,
      line: `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: price ${c.from.price} -> ${c.to.price} (${diff.toFixed(2)}), ${why}; writes ${c.fields.join(', ')}${extra}`,
    });
    stats.largest.sort((a, b) => b.diff - a.diff);
    stats.largest.length = Math.min(stats.largest.length, TOP_STALE);
  }
}

/** Closes the open frozen run: a run of two or more rows is counted and, if long, kept. */
function endRun(stats: StaleStats, state: { run: FrozenRun | null }): void {
  const run = state.run;
  state.run = null;
  if (run == null) return;
  if (run.rows < 2) return;
  stats.runs += 1;
  stats.rowsInRuns += run.rows;
  stats.longest.push(run);
  stats.longest.sort((a, b) => b.rows - a.rows);
  stats.longest.length = Math.min(stats.longest.length, TOP_RUNS);
}

/**
 * For each row of one root (ordered by ts), the unbroken run of consecutive rows
 * with the identical stored price that it belongs to, when that run spans more than
 * the freshness gate from its first row to its last; null otherwise. A market that
 * moved cannot print one price for longer than a bar can be stale, so such a run is
 * frozen. A run of a market that really was flat recomputes equal: nothing to write.
 *
 * The span is measured between cron timestamps, which carry jitter, so a run of four
 * rows at a nominal five minutes (15 minutes) is frozen about half the time, and it
 * does not split at a time gap (a weekend or a break), so identical prices on either
 * side of a closure join. Both are harmless in the direction ruling 8 states: a row
 * of a flat run recomputes equal and is not written; a row whose bar landed late gets
 * today's value.
 */
export function frozenRunsOf(
  rows: readonly { tsMs: number; stored: { price: number } }[],
): (PriceRun | null)[] {
  const out: (PriceRun | null)[] = rows.map(() => null);
  let start = 0;
  for (let i = 1; i <= rows.length; i += 1) {
    const first = rows[start];
    const last = rows[i - 1];
    if (first == null || last == null) break;
    if (i < rows.length && rows[i]?.stored.price === first.stored.price) {
      continue;
    }
    if (last.tsMs - first.tsMs > MAX_BAR_AGE_MS) {
      const run: PriceRun = {
        startMs: first.tsMs,
        endMs: last.tsMs,
        rows: i - start,
      };
      for (let j = start; j < i; j += 1) out[j] = run;
    }
    start = i;
  }
  return out;
}

/**
 * The CT trading day of a snapshot row, as the Phase 1 detector keys its flags
 * (feat.py: the CT date of the time plus 7 hours, so the Globex session that opens
 * at 17:00 CT belongs to the next calendar day).
 */
export const ctTradingDay = (tsMs: number): string =>
  getCTDateStr(new Date(tsMs + 7 * 60 * MINUTE_MS));

/**
 * The days the Phase 1 detector found in a thin root's bars after the span end:
 * `{"RTY": {"contaminated": ["2026-07-14", ...], "flagged": [...]}, "CL": {...},
 * "GC": {...}, "ZN": {...}}`, CT trading days. Every thin root must be listed, so
 * a root left out of the file cannot pass as clean.
 */
export function parseDetectorDays(
  text: string,
  source: string,
): Map<Sym, DetectorDays> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${source} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const thin = SYMBOLS.filter(isThinRoot);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be an object with a day list per root`);
  }
  const byRoot = parsed as Record<string, unknown>;
  const stray = Object.keys(byRoot).find(
    (k) => !(thin as readonly string[]).includes(k),
  );
  if (stray != null) {
    throw new Error(
      `${source} lists ${stray}, which is not a thin root (${thin.join(', ')})`,
    );
  }
  const dayList = (value: unknown): string[] | null =>
    Array.isArray(value) &&
    value.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      ? (value as string[])
      : null;
  const out = new Map<Sym, DetectorDays>();
  for (const root of thin) {
    const entry = byRoot[root] as
      | { contaminated?: unknown; flagged?: unknown }
      | null
      | undefined;
    const contaminated = dayList(entry?.contaminated);
    const flagged = dayList(entry?.flagged);
    if (contaminated == null || flagged == null) {
      throw new Error(
        `${source} must list ${root} as {"contaminated": [...], "flagged": [...]} of YYYY-MM-DD days (empty arrays when none)`,
      );
    }
    out.set(root, {
      contaminated: new Set(contaminated),
      flagged: new Set(flagged),
    });
  }
  return out;
}

function noteMergeState(
  m: MergeStateReport,
  row: SnapshotRow,
  outcome: SnapshotOutcome,
  views: MergeBarView[],
  found: MergeBarView,
  added: SnapshotField[],
): void {
  m.added += 1;
  for (const f of added) m.fields[f] += 1;
  const recomputed =
    outcome.kind === 'change' ? String(outcome.to.price) : 'no change';
  if (
    outcome.kind === 'change' &&
    outcome.fields.some((f) => added.includes(f))
  ) {
    m.written += 1;
  }
  const head = `${row.symbol} ${isoSecond(row.tsMs)} id ${row.id}: stored ${row.stored.price}, recomputed ${recomputed}`;
  const verdict = `merge-state (newest bar ${isoSecond(found.tsMs)})`;
  m.rows.push(`${head}, ${verdict}`);
  m.detail.push(`${head}: ${verdict}`, ...views.map(mergeBarText));
}

async function planSnapshots(
  data: Map<Sym, SymbolData>,
  detectorDays: Map<Sym, DetectorDays> | null,
): Promise<SnapshotStore> {
  const scope = scopeRanges().snapshots;
  const changes: SnapshotChange[] = [];
  const unrecomputable: string[] = [];
  const reports: SnapshotSymbolReport[] = [];
  const controlEvals: SnapshotEvaluation[] = [];
  const problems: string[] = [];
  const infos: SnapshotInfo[] = [];
  const controlMisses: SnapshotInfo[] = [];
  const junk: JunkRow[] = [];
  const staleRewrites: StaleRewrite[] = [];
  const readTo = Math.max(scope.toMs, STALE_UNTIL_MS);

  for (const symbol of SYMBOLS) {
    const sd = data.get(symbol);
    if (sd == null) throw new Error(`no bars were read for ${symbol}`);
    const rows = await readSnapshots(symbol, scope.fromMs, readTo);
    console.log(`snapshots ${symbol}: ${rows.length} rows in range`);
    const report: SnapshotSymbolReport = {
      symbol,
      inRange: rows.length,
      rowsToWrite: 0,
      alsoStale: 0,
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
        closeChanged: [],
        older15: { deleted: 0, 'close-changed': 0 },
        older60: { deleted: 0, 'close-changed': 0 },
      },
      unmatched: { price: 0, change1hPct: 0, changeDayPct: 0 },
      unwritten: [],
      driftTop: [],
      driftOverMark: 0,
      unmatchedLarge: { count: 0, first: [], largest: [] },
      stale: {
        count: 0,
        inSpan: 0,
        afterSpan: 0,
        left: 0,
        window: 0,
        unchecked: 0,
        detector:
          detectorDays?.get(symbol) == null
            ? null
            : {
                contaminatedListed:
                  detectorDays.get(symbol)?.contaminated.size ?? 0,
                flaggedListed: detectorDays.get(symbol)?.flagged.size ?? 0,
                contaminatedRows: new Map(),
                flaggedRows: new Map(),
              },
        frozenAdded: 0,
        frozenAddedInOutage: 0,
        largest: [],
        runs: 0,
        rowsInRuns: 0,
        longest: [],
      },
      mergeState:
        sd.updates.size === 0
          ? null
          : {
              added: 0,
              fields: emptyFields(),
              written: 0,
              rows: [],
              detail: [],
              valueMatched: {
                meeting: 0,
                attributed: 0,
                notAttributed: 0,
                wouldWrite: 0,
              },
            },
      attributionInconsistent: 0,
      controlRows: 0,
      controlMatched: 0,
      controlDays: 0,
      thin: null,
    };

    const frozen: { run: FrozenRun | null; last: number } = {
      run: null,
      last: -2,
    };
    const frozenRuns = frozenRunsOf(rows);
    const evaluated = await evaluateSnapshots(
      rows,
      `${symbol} snapshots in range`,
    );
    for (const [idx, { row, result, outcome }] of evaluated.entries()) {
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
      const inputs = snapshotInputs(sd.bars, row.tsMs, dayOpenMs);
      // The merge-state rule (ruling 6, ES and NQ): a row no pre-repair bar
      // matches by value, whose price lies in the pre-repair range of a bar Phase 2
      // changed near the latest closed bar and not in its current range, is a
      // value that existed only before the repair (the cron read the bar while
      // contract months were still merged into it). A row that matches an
      // unrepaired bar by value stays as it is: the range test does not override it.
      const noValueMatch = byValue.unmatched.includes('price');
      const mergeViews =
        report.mergeState != null && inputs.latest != null
          ? mergeStateBars(sd.bars, sd.updates, inputs.latest)
          : [];
      const mergeFound = findMergeState(mergeViews, row.stored.price);
      const mergeFields: SnapshotField[] =
        mergeFound != null && noValueMatch
          ? ['price', 'change1hPct', 'changeDayPct']
          : [];
      const affected = new Set<SnapshotField>([
        ...byRule,
        ...byValue.fields,
        ...mergeFields,
      ]);
      const newly = [...byValue.fields].filter((f) => !byRule.has(f));
      if (newly.length > 0) {
        noteValueRule(report.valueRule, row, byValue.hits, newly);
      }
      if (
        result.kind === 'fresh' &&
        !inputsMatchSnapshot(inputs, result.snapshot)
      ) {
        report.attributionInconsistent += 1;
      }
      // A recomputable row whose price is not written, that no pre-repair bar
      // explains and that is far from the recompute: the open D1 question.
      const largeUnmatched =
        outcome.kind === 'change' &&
        outcome.fields.includes('price') &&
        !affected.has('price') &&
        byValue.unmatched.includes('price') &&
        Math.abs(row.stored.price - outcome.to.price) >
          UNWRITTEN_FLAG_SHARE * Math.abs(row.stored.price);
      if (report.mergeState != null && mergeFound != null) {
        const added = mergeFields.filter(
          (f) => !byRule.has(f) && !byValue.fields.has(f),
        );
        if (added.length > 0) {
          noteMergeState(
            report.mergeState,
            row,
            outcome,
            mergeViews,
            mergeFound,
            added,
          );
        } else if (!noValueMatch) {
          const vm = report.mergeState.valueMatched;
          vm.meeting += 1;
          if (affected.has('price')) {
            vm.attributed += 1;
          } else {
            vm.notAttributed += 1;
            if (outcome.kind === 'change' && outcome.fields.includes('price')) {
              vm.wouldWrite += 1;
            }
          }
        }
      }
      if (outcome.kind === 'unrecomputable') {
        const junkHit = byValue.hits.find(
          (h) => h.field === 'price' && h.bar.repair === 'deleted',
        );
        if (junkHit != null) {
          junk.push({
            id: row.id,
            symbol,
            tsMs: row.tsMs,
            storedPrice: row.stored.price,
            barTsMs: junkHit.bar.tsMs,
            barClose: junkHit.bar.closePre,
            latestClose: inputs.latest?.close ?? null,
            row: row.row,
          });
        }
        // A row in the junk plan is deleted by the opt-in step: it is listed in the
        // junk section, not as left alone.
        if (junkHit == null && affected.size > 0) {
          report.affectedLeftAlone += 1;
          noteLeftAlone(report.leftAlone, result.kind, affected, row.tsMs);
          unrecomputable.push(
            `${snapshotLine(row, null, outcome.why)} [affected: ${[...affected].sort().join(', ')}]`,
          );
        } else if (junkHit == null) {
          report.unaffectedLeftAlone += 1;
        }
        const latest = inputs.latest;
        // A row in the junk plan is deleted by the opt-in step: not "not written".
        if (latest != null && junkHit == null) {
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
      // The writer had no freshness gate until 2026-09-30: it priced from the last
      // bar it had while minutes were missing, and they have landed since. A row
      // that matches such a bar by value and has a fresh recompute is a
      // stale-at-write row. The stale step writes the differing fields the normal
      // step does not, so each field is written once, by one step. A row is also
      // stale when it sits in a frozen run (frozenRunsOf), which finds the outage
      // rows whose last good bar is older than the value look-back. A thin root's
      // bars are still month-mixed before the span end (D1): its rows there are
      // left. So are its rows in the 20 days after it (ruling 9): a snapshot there
      // reads the hour-ago bar, the day-open bar and a 20-day volume window that
      // reach back into the span. After that the inputs are today's continuous-front
      // bars, except on the days the Phase 1 detector confirmed contaminated, and
      // only when a detector-days file says so.
      const staleBar =
        byValue.priceBar != null &&
        row.tsMs - byValue.priceBar.tsMs > MAX_BAR_AGE_MS
          ? byValue.priceBar
          : null;
      const frozenRun = frozenRuns[idx] ?? null;
      const staleFields =
        staleBar == null && frozenRun == null
          ? []
          : outcome.fields.filter((f) => !writable.includes(f));
      let stalePlanned = staleFields.length > 0;
      if (stalePlanned && isThinRoot(symbol)) {
        const stats = report.stale.detector;
        const days = detectorDays?.get(symbol);
        const day = ctTradingDay(row.tsMs);
        if (row.tsMs < SPAN.endMs) {
          report.stale.left += 1;
          stalePlanned = false;
        } else if (row.tsMs < scope.toMs) {
          report.stale.window += 1;
          stalePlanned = false;
        } else if (stats == null || days == null) {
          report.stale.unchecked += 1;
          stalePlanned = false;
        } else {
          if (days.flagged.has(day)) {
            stats.flaggedRows.set(day, (stats.flaggedRows.get(day) ?? 0) + 1);
          }
          if (days.contaminated.has(day)) {
            stats.contaminatedRows.set(
              day,
              (stats.contaminatedRows.get(day) ?? 0) + 1,
            );
            stalePlanned = false;
          }
        }
      }
      // The "not written" lists are what is left after every planned step with the
      // opt-in steps on: a field the stale step writes is not in them.
      const staleWrites = (f: SnapshotField): boolean =>
        stalePlanned && staleFields.includes(f);
      for (const f of outcome.fields) {
        if (!affected.has(f) && !staleWrites(f)) report.drift[f] += 1;
      }
      if (
        outcome.fields.includes('price') &&
        !writable.includes('price') &&
        !staleWrites('price')
      ) {
        noteUnwritten(
          report.unwritten,
          row,
          outcome.to.price,
          'method drift, price not affected',
        );
        // The drift list is the safety net for rows nothing will write.
        noteUnwritten(
          report.driftTop,
          row,
          outcome.to.price,
          'recomputable, price not affected',
          DRIFT_LIST_CAP,
        );
        if (
          Math.abs(row.stored.price - outcome.to.price) >
          UNWRITTEN_FLAG_SHARE * Math.abs(row.stored.price)
        ) {
          report.driftOverMark += 1;
        }
      }
      if (largeUnmatched && !staleWrites('price')) {
        noteUnmatchedLarge(report.unmatchedLarge, row, outcome.to.price);
      }
      if (stalePlanned) {
        const rewrite: StaleRewrite = {
          change: {
            id: row.id,
            symbol,
            tsMs: row.tsMs,
            fields: staleFields,
            from: row.stored,
            to: outcome.to,
            row: row.row,
          },
          alsoWritten: writable,
          barTsMs: staleBar?.tsMs ?? null,
          ageMin:
            staleBar == null
              ? null
              : Math.round((row.tsMs - staleBar.tsMs) / MINUTE_MS),
          run: frozenRun,
        };
        staleRewrites.push(rewrite);
        noteStale(
          report.stale,
          rewrite,
          row,
          isThinRoot(symbol) && inputs.latest != null
            ? `; ${neighbourText(sd.bars, inputs.latest.tsMs)}`
            : '',
        );
        const open = frozen.run;
        if (
          open != null &&
          open.price === row.stored.price &&
          frozen.last === idx - 1
        ) {
          open.endMs = row.tsMs;
          open.rows += 1;
          open.minTo = Math.min(open.minTo, outcome.to.price);
          open.maxTo = Math.max(open.maxTo, outcome.to.price);
        } else {
          endRun(report.stale, frozen);
          frozen.run = {
            startMs: row.tsMs,
            endMs: row.tsMs,
            rows: 1,
            price: row.stored.price,
            minTo: outcome.to.price,
            maxTo: outcome.to.price,
          };
        }
        frozen.last = idx;
      }
      if (writable.length === 0) continue;
      if (stalePlanned) report.alsoStale += 1;
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

    endRun(report.stale, frozen);

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
    junk,
    staleRewrites,
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

// ── Frozen-stale ES and NQ rows ─────────────────────────────────────────────

/**
 * The roots Phase 2 repaired. The thin roots (RTY, CL, GC, ZN) have more stale
 * rows of the same kind and stay: they are D1.
 */
const FROZEN_ROOTS: readonly Sym[] = ['ES', 'NQ'];

/** The largest |stored - last bar close| differences the report lists. */
const TOP_FROZEN = 10;

interface RawFrozen {
  id: string;
  ts: string;
  price: string;
  bar_ts: string;
  bar_close: string;
  row: Row;
}

/**
 * The root's snapshot rows before STALE_UNTIL_MS whose latest closed bar (ts <= the
 * row - BAR_CLOSE_LAG_MS, at any age) is older than MAX_BAR_AGE_MS and whose price is
 * not that bar's close. The SQL only keeps computeSnapshot, which has the last word on
 * whether a row is stale (planFrozen), off the rows that cannot qualify. A row with no
 * bar at all has no close to differ from and is not a candidate.
 */
async function readFrozenCandidates(symbol: Sym): Promise<FrozenRow[]> {
  const page = await readRows<RawFrozen>(
    (sql) => sql`
      SELECT f.id::text AS id,
             to_char(f.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
             f.price::text AS price,
             to_char(b.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bar_ts,
             b.close::text AS bar_close,
             to_jsonb(f) AS row
        FROM futures_snapshots f
        JOIN LATERAL (
               SELECT ts, close FROM futures_bars
                WHERE symbol = f.symbol
                  AND ts <= f.ts - ${BAR_CLOSE_LAG_MS / 1000}::float8 * interval '1 second'
                ORDER BY ts DESC LIMIT 1) b ON true
       WHERE f.symbol = ${symbol}
         AND f.ts < ${iso(STALE_UNTIL_MS)}::timestamptz
         AND (extract(epoch FROM f.ts) - extract(epoch FROM b.ts)) * 1000 > ${MAX_BAR_AGE_MS}
         AND f.price <> b.close
       ORDER BY f.ts`,
  );
  return page.map((r) => ({
    id: Number(r.id),
    symbol,
    tsMs: Date.parse(r.ts),
    storedPrice: Number(r.price),
    barTsMs: Date.parse(r.bar_ts),
    barClose: Number(r.bar_close),
    row: r.row,
  }));
}

/** The root's rows before STALE_UNTIL_MS that stay although the latest closed bar is old or missing. */
async function readFrozenKept(
  symbol: Sym,
): Promise<{ repeatsLastClose: number; noBar: number }> {
  const [counts] = await readRows<{ repeats: string; no_bar: string }>(
    (sql) => sql`
      SELECT count(*) FILTER (
               WHERE (extract(epoch FROM f.ts) - extract(epoch FROM b.ts)) * 1000 > ${MAX_BAR_AGE_MS}
                 AND f.price = b.close)::text AS repeats,
             count(*) FILTER (WHERE b.ts IS NULL)::text AS no_bar
        FROM futures_snapshots f
        LEFT JOIN LATERAL (
               SELECT ts, close FROM futures_bars
                WHERE symbol = f.symbol
                  AND ts <= f.ts - ${BAR_CLOSE_LAG_MS / 1000}::float8 * interval '1 second'
                ORDER BY ts DESC LIMIT 1) b ON true
       WHERE f.symbol = ${symbol}
         AND f.ts < ${iso(STALE_UNTIL_MS)}::timestamptz`,
  );
  return {
    repeatsLastClose: Number(counts?.repeats ?? 0),
    noBar: Number(counts?.no_bar ?? 0),
  };
}

/**
 * Where a row falls in the futures week, for the dry run's count. Globex is closed
 * from Friday 17:00 CT to Sunday 17:00 CT, and on a NYSE full-day holiday by CT date;
 * the 16:15 to 17:00 CT break comes after those (so a Sunday 16:30 is a weekend row,
 * a Friday 16:30 a break row).
 */
function closureOf(tsMs: number): Closure {
  const at = new Date(tsMs);
  const day = getCTDayOfWeek(at);
  const { hour } = getCTTime(at);
  const weekend =
    day === 6 || (day === 0 && hour < 17) || (day === 5 && hour >= 17);
  if (weekend || isHoliday(getCTDateStr(at))) return 'weekendOrHoliday';
  return inDailyBreak(tsMs) ? 'break' : 'elsewhere';
}

/**
 * The ES and NQ snapshot rows to delete (owner OK 2026-11-11): before STALE_UNTIL_MS,
 * computeSnapshot returns stale or missing (no closed bar within the freshness gate, so
 * today's code would not have written the row and nothing can be recomputed), and the
 * stored price is not the close of the latest closed bar at any age (a row that repeats
 * the last known price stays; one that does not is frozen on an older bar). SQL finds
 * the candidates; computeSnapshot confirms each, so no full plan is needed.
 */
async function planFrozen(): Promise<FrozenPlan> {
  const rows: FrozenRow[] = [];
  const symbols: FrozenSymbolReport[] = [];
  for (const symbol of FROZEN_ROOTS) {
    const candidates = await readFrozenCandidates(symbol);
    const kept = await readFrozenKept(symbol);
    console.log(`frozen ${symbol}: ${candidates.length} candidate(s)`);
    const verdicts = await mapPool(
      candidates,
      CONCURRENCY,
      `${symbol} frozen candidates`,
      async (c) => {
        const at = new Date(c.tsMs);
        const result = await withDbRetry(
          () => computeSnapshot(symbol, getETDateStr(at), at),
          COMPUTE_RETRIES,
        );
        return result.kind;
      },
    );
    const mine = candidates.filter((_, i) => verdicts[i] !== 'fresh');
    const byClosure: Record<Closure, number> = {
      break: 0,
      weekendOrHoliday: 0,
      elsewhere: 0,
    };
    for (const r of mine) byClosure[closureOf(r.tsMs)] += 1;
    symbols.push({
      symbol,
      candidates: candidates.length,
      fresh: candidates.length - mine.length,
      rows: mine.length,
      byClosure,
      firstMs: mine[0]?.tsMs ?? null,
      lastMs: mine.at(-1)?.tsMs ?? null,
      ...kept,
    });
    rows.push(...mine);
  }
  return { rows, symbols };
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

function olderMatchesText(v: ValueRuleStats): string {
  const f = (m: ValueRuleStats['older15']) =>
    `deleted ${m.deleted}, close-changed ${m['close-changed']}`;
  return `    matched bars older than the ${MAX_BAR_AGE_MS / MINUTE_MS}-minute gate: ${f(v.older15)}; older than ${COINCIDENCE_MIN} min: ${f(v.older60)}`;
}

function mergeStateText(m: MergeStateReport): string[] {
  const v = m.valueMatched;
  return [
    `    the merge-state rule (a row with no value match whose stored price lies in the pre-repair [low, high] of a bar Phase 2 changed within ${LATE_BAR_MAX_AGE_MIN} min of the latest closed bar, and not in its current range): ${m.added} rows added (${byFieldText(m.fields)}), ${m.written} of them in the write set because of it`,
    ...m.rows.map((l) => `      ${l}`),
    `    rows that meet the same test but match an unrepaired bar by value (not attributed by the rule; they stay as stored): ${v.meeting} (price already attributed by another rule ${v.attributed}; not attributed ${v.notAttributed}, of which a recompute that differs in price ${v.wouldWrite})`,
    '    every bar of the added rows: merge-state.txt',
  ];
}

/** The share of a thin root's after-span stale rows (planned or left) that fall on contaminated days, in percent. */
function contaminatedSharePct(st: StaleStats, d: DetectorStats): number {
  const rows = [...d.contaminatedRows.values()].reduce((a, b) => a + b, 0);
  return (rows / Math.max(1, rows + st.afterSpan)) * 100;
}

/**
 * `--rewrite-stale-at-write` is refused when more than the stop share of a thin
 * root's after-span stale rows sit on contaminated days: that root's source is
 * not clean enough to rewrite from.
 */
export function checkStaleShare(
  symbols: readonly Pick<SnapshotSymbolReport, 'symbol' | 'stale'>[],
): string[] {
  return symbols.flatMap(({ symbol, stale }) => {
    if (stale.detector == null) return [];
    const share = contaminatedSharePct(stale, stale.detector);
    return share > CONTAMINATED_SHARE_STOP_PCT
      ? [
          `${symbol}: ${share.toFixed(1)}% of its after-span stale rows fall on contaminated days, over ${CONTAMINATED_SHARE_STOP_PCT}%: its source is not clean enough for --rewrite-stale-at-write`,
        ]
      : [];
  });
}

const dayCounts = (byDay: Map<string, number>): string[] =>
  [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, n]) => `${day} (${n})`);

/**
 * A thin root's Phase 1 detector days: the contaminated days whose stale rows are
 * left (the share of its after-span stale rows, and the stop rule), and, as
 * information, the stale rows on the days with a single flagged bar.
 */
function detectorDaysText(st: StaleStats, d: DetectorStats): string[] {
  const rows = [...d.contaminatedRows.values()].reduce((a, b) => a + b, 0);
  const share = contaminatedSharePct(st, d);
  const verdict =
    share > CONTAMINATED_SHARE_STOP_PCT
      ? `OVER ${CONTAMINATED_SHARE_STOP_PCT}%: stop and report before committing`
      : `within ${CONTAMINATED_SHARE_STOP_PCT}%`;
  const left = dayCounts(d.contaminatedRows);
  const leftList = left.length > 0 ? `: ${left.join(', ')}` : '';
  const flaggedRows = [...d.flaggedRows.values()].reduce((a, b) => a + b, 0);
  const flagged = dayCounts(d.flaggedRows);
  const flaggedList = flagged.length > 0 ? `: ${flagged.join(', ')}` : '';
  return [
    `      contaminated days (Phase 1 detector, ${d.contaminatedListed} listed): ${rows} stale rows on ${left.length} of them are left, ${share.toFixed(1)}% of the ${rows + st.afterSpan} after-span stale rows, ${verdict}${leftList}`,
    `      information, days with a flagged bar (${d.flaggedListed} listed; one flagged bar is the clean-day false-positive rate, so these are not left): ${flaggedRows} stale rows on ${flagged.length} of them${flaggedList}`,
  ];
}

function staleText(st: StaleStats): string[] {
  const left =
    (st.left > 0
      ? `; ${st.left} more before the span end are left (D1: this root's bars there are still month-mixed)`
      : '') +
    (st.window > 0
      ? `; ${st.window} more inside the 20-day window after the span (thin root, inside the 20-day window after the span: their 1h change, day change and volume window read bars inside the span, D1) are left`
      : '') +
    (st.unchecked > 0
      ? `; ${st.unchecked} more after it are left (no --detector-days file: the source is unchecked)`
      : '');
  const out = [
    `    stale-at-write rows (opt-in --rewrite-stale-at-write; the stored price is the close of a bar older than ${MAX_BAR_AGE_MS / MINUTE_MS} min at the row, the recompute is fresh, every differing field the normal step does not write): ${st.count} planned (${st.inSpan} in the span, ${st.afterSpan} after it, up to ${isoSecond(STALE_UNTIL_MS)})${left}`,
    ...(st.detector == null ? [] : detectorDaysText(st, st.detector)),
    `      the frozen-run clause (consecutive rows with one stored price spanning more than ${MAX_BAR_AGE_MS / MINUTE_MS} min, a fresh recompute that differs) adds ${st.frozenAdded} of these rows, ${st.frozenAddedInOutage} of them in the ${isoDay(OUTAGE.fromMs)} to ${isoDay(OUTAGE.toMs - DAY_MS).slice(5)} outage`,
  ];
  if (st.count === 0) return out;
  out.push(
    `      the ${st.largest.length} largest price changes:`,
    ...st.largest.map((u) => `        ${u.line}`),
    `      frozen runs (consecutive rows with the same stored price): ${st.runs} runs hold ${st.rowsInRuns} of the ${st.count} rows; the ${st.longest.length} longest:`,
    ...st.longest.map(
      (r) =>
        `        ${isoSecond(r.startMs)} .. ${isoSecond(r.endMs)}, ${r.rows} rows, price ${r.price}, recompute ${r.minTo} to ${r.maxTo}`,
    ),
  );
  return out;
}

function driftText(r: SnapshotSymbolReport): string[] {
  return [
    `    the ${r.driftTop.length} largest price drifts on rows that can be recomputed (price not affected, not written, not in the stale-at-write plan; ${r.driftOverMark} rows over 0.15% of the price):`,
    ...r.driftTop.map((u) => `      ${u.line}`),
  ];
}

function closeChangedText(v: ValueRuleStats): string[] {
  if (v.closeChanged.length === 0) return [];
  const coincidences = v.closeChanged.filter((m) => m.coincidence).length;
  return [
    `    all ${v.closeChanged.length} matches to a bar whose close Phase 2 changed (the matched bar's age; over ${COINCIDENCE_MIN} min is marked a probable coincidence, ${coincidences} of them):`,
    ...v.closeChanged.map((m) => `      ${m.line}`),
  ];
}

function unmatchedLargeText(u: UnmatchedLarge): string[] {
  const out = [
    `    stored price matches no pre-repair bar and differs from the recompute by over 0.15% (not written, after every planned step with the opt-in steps on; the open D1 question): ${u.count} rows`,
  ];
  if (u.count === 0) return out;
  out.push(
    `      the first ${u.first.length} by time:`,
    ...u.first.map((l) => `        ${l}`),
    `      the ${u.largest.length} largest:`,
    ...u.largest.map((l) => `        ${l.line}`),
  );
  return out;
}

function junkText(junk: JunkRow[]): string[] {
  const out = [
    `  stale rows priced from a deleted junk bar (not recomputable; --delete-junk-stale deletes them, off by default): ${junk.length}`,
  ];
  if (junk.length === 0) return out;
  for (const symbol of SYMBOLS) {
    const mine = junk.filter((j) => j.symbol === symbol);
    if (mine.length === 0) continue;
    const times = mine.map((j) => j.tsMs);
    const away = mine
      .flatMap((j) =>
        j.latestClose == null ? [] : [Math.abs(j.storedPrice - j.latestClose)],
      )
      .sort((a, b) => a - b);
    const spread =
      away.length === 0
        ? ''
        : `; |stored - the latest closed bar's close| min ${(away[0] ?? 0).toFixed(2)}, median ${percentile(away, 0.5).toFixed(2)}, max ${(away.at(-1) ?? 0).toFixed(2)}`;
    out.push(
      `    ${symbol}: ${mine.length}, first ${isoSecond(Math.min(...times))}, last ${isoSecond(Math.max(...times))}${spread}`,
    );
  }
  const first = [...junk].sort((a, b) => a.tsMs - b.tsMs).slice(0, SAMPLE_N);
  out.push(
    `    the first ${first.length} by time:`,
    ...first.map((j) => {
      const compare =
        j.latestClose == null
          ? 'no closed bar before it'
          : `the latest closed bar then closed at ${j.latestClose}`;
      return `      ${j.symbol} ${isoSecond(j.tsMs)} id ${j.id}: stored price ${j.storedPrice}, the deleted bar of ${isoSecond(j.barTsMs)} closed at ${j.barClose}; ${compare}`;
    }),
  );
  return out;
}

/**
 * Rows touched, per root and in total, so the owner can reconcile the three
 * totals against the distinct rows: the normal step's rows, the stale step's and
 * the junk deletes overlap only where a row is in both of the first two.
 */
function touchedText(r: SnapshotStore): string[] {
  const line = (
    label: string,
    normal: number,
    stale: number,
    both: number,
    junk: number,
  ): string =>
    `  rows touched, ${label}: normal step only ${normal - both}, stale step only ${stale - both}, both ${both}, junk delete ${junk}; distinct rows ${normal + stale - both + junk} (${normal} + ${stale} + ${junk} - ${both})`;
  const out: string[] = [];
  let normal = 0;
  let stale = 0;
  let both = 0;
  for (const s of r.symbols) {
    const junk = r.junk.filter((j) => j.symbol === s.symbol).length;
    out.push(line(s.symbol, s.rowsToWrite, s.stale.count, s.alsoStale, junk));
    normal += s.rowsToWrite;
    stale += s.stale.count;
    both += s.alsoStale;
  }
  out.push(line('all roots', normal, stale, both, r.junk.length));
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
  out.push(...touchedText(r));
  for (const s of r.symbols) {
    out.push(
      `  ${s.symbol}: rows in range ${s.inRange}, rows to write ${s.rowsToWrite} (${byFieldText(s.byField)})`,
      `    left alone, stale or missing recompute (the rows in the junk plan are not counted here): ${s.affectedLeftAlone} with an affected field, ${s.unaffectedLeftAlone} with none`,
      `      the ${s.affectedLeftAlone} with an affected field (kept as stored): ${leftAloneText(s.leftAlone)}`,
      `    ${volumeRatioWriteText(r.changes, s.symbol)}`,
      `    information, unaffected fields where today's method differs from the stored value (not written, after every planned step with the opt-in steps on): ${byFieldText(s.drift)}`,
      `    method control, rows from ${isoSecond(SNAPSHOT_CONTROL_FROM_MS)}: ${s.controlMatched} of ${s.controlRows} match over ${s.controlDays} days`,
      ...(s.thin == null ? [] : thinControlText(s.symbol, s.thin)),
      `    attribution inputs disagreeing with computeSnapshot: ${s.attributionInconsistent}`,
      `    newly affected by the value rule (the stored input found by value, a bar Phase 2 deleted or changed): ${s.valueRule.rows} rows (${byFieldText(s.valueRule.fields)}), matched bars deleted ${s.valueRule.byKind.deleted}, close-changed ${s.valueRule.byKind['close-changed']}`,
      ...s.valueRule.samples.map((l) => `      ${l}`),
      olderMatchesText(s.valueRule),
      ...closeChangedText(s.valueRule),
      `    unmatched (no pre-repair bar matched the stored value, so the field is left to the other rule): price=${s.unmatched.price} change1hPct=${s.unmatched.change1hPct} changeDayPct=${s.unmatched.changeDayPct}`,
      `    the ${s.unwritten.length} largest price differences not written, after every planned step with the opt-in steps on (stored vs recomputed, or vs the latest closed bar when the recompute is stale):`,
      ...s.unwritten.map((u) => `      ${u.line}`),
      ...driftText(s),
      ...unmatchedLargeText(s.unmatchedLarge),
      ...(s.mergeState == null ? [] : mergeStateText(s.mergeState)),
      ...staleText(s.stale),
    );
  }
  out.push(
    '  largest price diffs written:',
    ...top.map(
      (c) =>
        `    ${snapshotLine({ id: c.id, symbol: c.symbol, tsMs: c.tsMs, stored: c.from, row: c.row }, c.to)} [writes ${c.fields.join(', ')}]`,
    ),
    ...unrecomputableText(r.unrecomputable),
    ...junkText(r.junk),
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

const frozenGap = (r: FrozenRow): number =>
  Math.abs(r.storedPrice - r.barClose);

function frozenText(plan: FrozenPlan): string[] {
  const out = [
    'Frozen-stale ES and NQ snapshot rows (--stores frozen; --delete-frozen-stale deletes them, off by default; owner OK 2026-11-11)',
    `  A row before ${isoSecond(STALE_UNTIL_MS)} that computeSnapshot cannot price (the latest closed bar, ts <= at - ${BAR_CLOSE_LAG_MS / 1000} s, is over ${MAX_BAR_AGE_MS / MINUTE_MS} minutes old, or there is none) and whose stored price is not that bar's close.`,
    `  rows to delete: ${plan.rows.length}`,
  ];
  for (const s of plan.symbols) {
    const where =
      s.firstMs == null || s.lastMs == null
        ? ''
        : `, first ${isoSecond(s.firstMs)}, last ${isoSecond(s.lastMs)}; 16:15-17:00 CT break ${s.byClosure.break}, weekend or holiday ${s.byClosure.weekendOrHoliday}, elsewhere ${s.byClosure.elsewhere}`;
    out.push(
      `    ${s.symbol}: ${s.rows}${where}`,
      `      candidates ${s.candidates}, computeSnapshot calls fresh (kept) ${s.fresh}`,
      `      kept, stale and equal to the last bar's close: ${s.repeatsLastClose}; kept, no bar at all: ${s.noBar}`,
    );
  }
  const largest = [...plan.rows]
    .sort((a, b) => frozenGap(b) - frozenGap(a))
    .slice(0, TOP_FROZEN);
  if (largest.length > 0) {
    out.push(
      `  the ${largest.length} largest |stored - last bar close|:`,
      ...largest.map(
        (r) =>
          `    ${r.symbol} ${isoSecond(r.tsMs)} id ${r.id}: stored ${r.storedPrice}, the bar of ${isoSecond(r.barTsMs)} closed at ${r.barClose} (${Math.round((r.tsMs - r.barTsMs) / MINUTE_MS)} min old), difference ${frozenGap(r).toFixed(2)}`,
      ),
    );
  }
  out.push('  RTY, CL, GC and ZN stay: their stale rows are D1.');
  return out;
}

export function formatReport(
  plans: Plans,
  header: string[],
  gateProblems: string[],
  applyCommand: string | null = null,
): string {
  const out = [...header, ''];
  if (plans.snapshots) out.push(...snapshotsText(plans.snapshots), '');
  if (plans.premarket) out.push(...premarketText(plans.premarket), '');
  if (plans.fires) out.push(...firesText(plans.fires), '');
  if (plans.frozen) out.push(...frozenText(plans.frozen), '');
  // The frozen delete has no control set: its one check is the count at --apply.
  if (plans.frozen == null) {
    out.push(
      gateProblems.length === 0
        ? 'Apply gate: every check passes.'
        : 'APPLY WOULD REFUSE:',
      ...gateProblems.map((p) => `  ${p}`),
    );
  }
  if (applyCommand != null) {
    out.push(
      '',
      'To apply, after the close (add --env-file as for this dry run; each total is the count above):',
      `  ${applyCommand}`,
    );
  }
  return out.join('\n');
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Writes only the fields the plan names for each row: a `set_*` flag per field
 * keeps the stored value of every other field, so an unaffected field is never
 * touched. The guard compares the values the row would hold afterwards, so a
 * row that already holds them is not rewritten.
 */
function updateSnapshots(sql: Sql, rows: SnapshotWrite[]) {
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
function updatePremarket(sql: Sql, rows: PremarketWrite[]) {
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
function updateFires(sql: Sql, rows: FireWrite[]) {
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

/** A store, or one of the opt-in steps: the stale rewrite and the two deletes. */
type ApplyStep = Store | 'stale' | 'junk' | 'frozen';

/** The opt-in steps that delete futures_snapshots rows. */
type DeleteStep = 'junk' | 'frozen';

/**
 * One JSONL line of the plan file: the row as it is now (`row`), the step that
 * writes it and the values that step writes (`to`). The apply reads the plan back
 * from this file, so a run that fails between steps can finish from it.
 */
interface BackupEntry {
  step: ApplyStep;
  store: Store;
  id: number;
  /** Snapshot rows, in all three of their steps. */
  symbol?: string;
  /** Snapshot and stale lines: the fields this step writes. */
  fields?: SnapshotField[];
  row: Row;
  to: unknown;
  /** Only on a stale line: the new values of the fields the snapshot step writes on the same row. */
  also?: Partial<Record<SnapshotField, number | null>>;
  /** Only on a deleted row: its `to` is null and `row` is everything the restore needs. */
  op?: 'delete';
}

/** What a step needs to write one row. */
type SnapshotWrite = Pick<
  SnapshotChange,
  'id' | 'symbol' | 'fields' | 'to' | 'row'
>;
type PremarketWrite = Pick<PremarketChange, 'id' | 'to' | 'row'>;
type FireWrite = Pick<FireChange, 'id' | 'to' | 'row'>;
/** What a delete step needs to delete one row: only while it still holds the planned price. */
type DeleteWrite = Pick<JunkRow, 'id' | 'symbol' | 'storedPrice' | 'row'>;
/** `fields` are the stale step's; `also` are the snapshot step's on the same row, and `to` holds both. */
interface StaleWrite extends SnapshotWrite {
  also: SnapshotField[];
}

/** The plan as read back from the file, by step. */
interface LoadedPlan {
  snapshots: SnapshotWrite[];
  premarket: PremarketWrite[];
  fires: FireWrite[];
  stale: StaleWrite[];
  junk: DeleteWrite[];
  frozen: DeleteWrite[];
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

/**
 * One JSONL line per row about to change, full row included, with the step that
 * writes it; the line count is checked back. This file is the plan the apply
 * reads. `normalPending` is whether the snapshot step runs in this apply: if it
 * does not, a stale line has no `also` fields to expect.
 */
function writeBackup(
  workDir: string,
  plans: Plans,
  optIn: { junk: JunkRow[]; stale: StaleRewrite[]; frozen: FrozenRow[] },
  normalPending: boolean,
): WrittenPlan {
  const entries: BackupEntry[] = [];
  for (const store of STORES) {
    const result = plans[store];
    for (const c of result?.changes ?? []) {
      entries.push({
        step: store,
        store,
        id: c.id,
        ...('symbol' in c && { symbol: c.symbol, fields: c.fields }),
        row: c.row,
        to: backedUpValues(c),
      });
    }
  }
  for (const r of optIn.stale) {
    entries.push({
      step: 'stale',
      store: 'snapshots',
      id: r.change.id,
      symbol: r.change.symbol,
      fields: r.change.fields,
      row: r.change.row,
      to: backedUpValues(r.change),
      also: normalPending
        ? Object.fromEntries(r.alsoWritten.map((f) => [f, r.change.to[f]]))
        : {},
    });
  }
  const deletes: [DeleteStep, { id: number; symbol: Sym; row: Row }[]][] = [
    ['junk', optIn.junk],
    ['frozen', optIn.frozen],
  ];
  for (const [step, rows] of deletes) {
    for (const d of rows) {
      entries.push({
        step,
        store: 'snapshots',
        id: d.id,
        symbol: d.symbol,
        row: d.row,
        to: null,
        op: 'delete',
      });
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(workDir, `backup-${stamp}.jsonl`);
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const text = readFileSync(path, 'utf8');
  const written = text.split('\n').filter((l) => l !== '').length;
  if (written !== entries.length) {
    throw new Error(
      `backup ${path} has ${written} lines, expected ${entries.length}`,
    );
  }
  const rows: Partial<Record<ApplyStep, number>> = {};
  for (const e of entries) rows[e.step] = (rows[e.step] ?? 0) + 1;
  return { path, rows, lines: written, sha256: sha256Of(text) };
}

/** The plan file as written: its path, the rows of each step, its line count and the sha256 of its bytes. */
interface WrittenPlan {
  path: string;
  rows: Partial<Record<ApplyStep, number>>;
  lines: number;
  sha256: string;
}

const sha256Of = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const APPLY_STEPS: readonly ApplyStep[] = [
  ...STORES,
  'stale',
  'junk',
  'frozen',
];

/** The snapshot values of a plan line: the step's fields and, on a stale line, the snapshot step's. */
function snapshotValuesOf(e: BackupEntry): SnapshotValues {
  const v = { ...(e.to as Row), ...(e.also ?? {}) } as Partial<SnapshotValues>;
  return {
    price: v.price ?? Number(e.row.price),
    change1hPct: v.change1hPct ?? null,
    changeDayPct: v.changeDayPct ?? null,
    volumeRatio: v.volumeRatio ?? null,
  };
}

/**
 * Reads a plan file back into the rows each step writes. Before a line is read the
 * file must be the one `plan.json` recorded: the same number of lines and the same
 * sha256; and after, each step must hold the rows the pointer recorded for it, which
 * must equal the totals it was approved for. Any mismatch is an error that names the
 * step or the file and both values, before a write.
 */
function readPlan(path: string, pointer: PlanPointer): LoadedPlan {
  const plan: LoadedPlan = {
    snapshots: [],
    premarket: [],
    fires: [],
    stale: [],
    junk: [],
    frozen: [],
  };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l !== '');
  if (lines.length !== pointer.lines) {
    throw new Error(
      `${path} has ${lines.length} lines, plan.json recorded ${pointer.lines}`,
    );
  }
  const digest = sha256Of(text);
  if (digest !== pointer.sha256) {
    throw new Error(
      `${path} has sha256 ${digest}, plan.json recorded ${pointer.sha256}`,
    );
  }
  for (const [i, line] of lines.entries()) {
    const where = `${path} line ${i + 1}`;
    let e: BackupEntry;
    try {
      e = JSON.parse(line) as BackupEntry;
    } catch (err) {
      throw new Error(`${where} is not JSON`, { cause: err });
    }
    if (
      !APPLY_STEPS.includes(e.step) ||
      typeof e.id !== 'number' ||
      e.row == null ||
      typeof e.row !== 'object'
    ) {
      throw new Error(`${where} is not a plan line`);
    }
    const fields = e.fields ?? [];
    if (
      !fields.every((f) => (SNAPSHOT_KEYS as readonly string[]).includes(f))
    ) {
      throw new Error(`${where} names a field that is not a snapshot field`);
    }
    if (e.step === 'snapshots' || e.step === 'stale') {
      if (typeof e.symbol !== 'string' || e.fields == null) {
        throw new Error(`${where} has no symbol or fields`);
      }
      const write: SnapshotWrite = {
        id: e.id,
        symbol: e.symbol as Sym,
        fields,
        to: snapshotValuesOf(e),
        row: e.row,
      };
      if (e.step === 'snapshots') plan.snapshots.push(write);
      else
        plan.stale.push({
          ...write,
          also: Object.keys(e.also ?? {}) as SnapshotField[],
        });
    } else if (e.step === 'premarket') {
      plan.premarket.push({ id: e.id, to: e.to as GlobexValues, row: e.row });
    } else if (e.step === 'fires') {
      plan.fires.push({ id: e.id, to: e.to as number, row: e.row });
    } else {
      if (typeof e.symbol !== 'string')
        throw new Error(`${where} has no symbol`);
      plan[e.step].push({
        id: e.id,
        symbol: e.symbol as Sym,
        storedPrice: Number(e.row.price),
        row: e.row,
      });
    }
  }
  for (const step of pointer.steps) {
    const have = stepRows(plan, step);
    const recorded = pointer.rows[step];
    const approved = approvedRows(pointer, step);
    if (have !== recorded) {
      throw new Error(
        `step ${step}: the plan file has ${have} rows, plan.json recorded ${recorded}`,
      );
    }
    if (recorded !== approved) {
      throw new Error(
        `step ${step}: plan.json recorded ${recorded} rows, its expect says ${approved}`,
      );
    }
  }
  return plan;
}

/** The rows a step was approved for in the dry run's totals. */
const approvedRows = (pointer: PlanPointer, step: ApplyStep): number | null =>
  pointer.expect[step];

/** The rows a step has in a plan. */
const stepRows = (plan: LoadedPlan, step: ApplyStep): number =>
  plan[step].length;

/**
 * `plan.json` names the plan file of an apply and what it was approved for. A run
 * that fails between steps leaves it with some steps marked and some not; the next
 * run with the same work dir finishes the rest from the plan file, without planning
 * again.
 */
interface PlanPointer {
  createdAt: string;
  /** The plan file, in the same work dir. */
  backup: string;
  /** The steps this plan carries, in order. */
  steps: ApplyStep[];
  /** The rows each of those steps writes, as counted when the plan file was written. */
  rows: Partial<Record<ApplyStep, number>>;
  /** The plan file's line count and the sha256 of its bytes: a cut or edited file is refused. */
  lines: number;
  sha256: string;
  /** The totals of the dry run's plan: each store's rows, and the opt-in steps' (null when not asked for). */
  expect: Record<Store, number> & {
    junk: number | null;
    stale: number | null;
    frozen: number | null;
  };
  /** What the command was: a resume repeats it. */
  command: {
    workDir: string;
    stores: Store[];
    backup: string | null;
    detectorDays: string | null;
  };
}

const pointerPath = (workDir: string): string => join(workDir, 'plan.json');

function writePlanPointer(workDir: string, pointer: PlanPointer): void {
  writeFileSync(pointerPath(workDir), `${JSON.stringify(pointer, null, 2)}\n`);
}

function readPlanPointer(workDir: string): PlanPointer | null {
  const where = pointerPath(workDir);
  if (!existsSync(where)) return null;
  let p: PlanPointer;
  try {
    p = JSON.parse(readFileSync(where, 'utf8')) as PlanPointer;
  } catch (err) {
    throw new Error(`${where} is not a plan pointer`, { cause: err });
  }
  const bad = (what: string): Error =>
    new Error(`${where} is not a plan pointer: ${what}`);
  if (p == null || typeof p !== 'object') throw bad('it is not an object');
  if (typeof p.backup !== 'string') throw bad('it has no "backup"');
  if (!Array.isArray(p.steps)) throw bad('it has no "steps"');
  for (const step of p.steps) {
    if (!APPLY_STEPS.includes(step)) {
      throw bad(`"${String(step)}" is not a step`);
    }
  }
  if (p.rows == null || typeof p.rows !== 'object')
    throw bad('it has no "rows"');
  for (const step of p.steps) {
    if (typeof p.rows[step] !== 'number') {
      throw bad(`it has no "rows" for "${step}"`);
    }
  }
  if (typeof p.lines !== 'number') throw bad('it has no "lines"');
  if (typeof p.sha256 !== 'string') throw bad('it has no "sha256"');
  if (p.expect == null || typeof p.expect !== 'object') {
    throw bad('it has no "expect"');
  }
  if (p.command == null || typeof p.command !== 'object') {
    throw bad('it has no "command"');
  }
  return p;
}

/** `<step>.started`: written once the step's rows are checked and just before its first write. */
const startedPath = (workDir: string, step: ApplyStep): string =>
  join(workDir, `${step}.started`);

function writeStarted(workDir: string, step: ApplyStep, rows: number): void {
  writeFileSync(
    startedPath(workDir, step),
    `${JSON.stringify({ step, rows, startedAt: new Date().toISOString() })}\n`,
  );
}

export const markerPath = (workDir: string, store: ApplyStep): string =>
  join(workDir, `${store}.applied`);

function writeMarker(workDir: string, store: ApplyStep, rows: number): void {
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

async function verifySnapshots(changes: SnapshotWrite[]): Promise<void> {
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

async function verifyPremarket(changes: PremarketWrite[]): Promise<void> {
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

async function verifyFires(changes: FireWrite[]): Promise<void> {
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

/**
 * Deletes by id and symbol, and only while the row still holds the price it
 * was planned with, so a row that changed since the plan is left alone.
 */
function deleteSnapshots(sql: Sql, rows: DeleteWrite[]) {
  return sql`
    DELETE FROM futures_snapshots f
     USING unnest(${rows.map((d) => d.id)}::int[],
                  ${rows.map((d) => d.symbol)}::text[],
                  ${rows.map((d) => d.storedPrice)}::numeric[])
           AS r(id, symbol, price)
     WHERE f.id = r.id AND f.symbol = r.symbol AND f.price = r.price
    RETURNING f.id`;
}

/**
 * The rows a delete step's verify counts before and after, which hold all of its
 * planned rows: the recompute's snapshot scope for the junk delete, every row before
 * STALE_UNTIL_MS (the frozen delete's date limit) for the frozen one. Both lie in the
 * past, so no live writer adds to them.
 */
function deleteScope(step: DeleteStep): Range {
  return step === 'junk'
    ? scopeRanges().snapshots
    : { fromMs: 0, toMs: STALE_UNTIL_MS };
}

async function countSnapshotsIn(range: Range): Promise<number> {
  const rows = await readRows<{ n: string }>(
    (sql) => sql`
      SELECT count(*)::text AS n FROM futures_snapshots
       WHERE ts >= ${iso(range.fromMs)}::timestamptz
         AND ts < ${iso(range.toMs)}::timestamptz`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** The rows are gone, and nothing else is: the scope holds exactly that many fewer. */
async function verifyDeletes(
  step: DeleteStep,
  planned: DeleteWrite[],
  before: number,
  present: number,
): Promise<void> {
  for (const group of chunks(planned, WRITE_CHUNK)) {
    const ids = group.map((d) => d.id);
    const left = await readRows<{ id: string }>(
      (sql) => sql`
        SELECT id::text AS id FROM futures_snapshots WHERE id = ANY(${ids}::int[])`,
    );
    if (left.length > 0) {
      throw new Error(
        `verify failed for ${step}: ${left.length} of ${group.length} row(s) are still there: ${left
          .slice(0, 3)
          .map((r) => r.id)
          .join(', ')}`,
      );
    }
  }
  const after = await countSnapshotsIn(deleteScope(step));
  if (after !== before - present) {
    throw new Error(
      `verify failed for ${step}: ${before} rows in scope before, ${after} after, ${before - present} expected`,
    );
  }
}

/**
 * Before a step writes a row, the row must still hold what the plan read (the old
 * value) or what the step writes (the new one, when an earlier run got that far).
 * Any other value was put there since: the step stops before it writes anything.
 */
function refuseChanged(step: ApplyStep, bad: string[], total: number): void {
  if (bad.length === 0) return;
  throw new Error(
    `${bad.length} of ${total} row(s) hold neither the planned old value nor the new one, so ${step} is not written: ${bad.slice(0, 3).join('; ')}`,
  );
}

async function preflightSnapshots(
  step: ApplyStep,
  writes: SnapshotWrite[],
): Promise<void> {
  const bad: string[] = [];
  for (const group of chunks(writes, WRITE_CHUNK)) {
    const ids = group.map((w) => w.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(f) AS row
          FROM futures_snapshots f WHERE id = ANY(${ids}::int[])`,
    );
    const found = new Map(actual.map((r) => [Number(r.id), r.row]));
    for (const w of group) {
      const have = found.get(w.id);
      if (have == null) {
        bad.push(`id ${w.id}: row is gone`);
        continue;
      }
      for (const f of w.fields) {
        const col = SNAPSHOT_COLUMNS[f];
        const now = stable(have[col]);
        if (now !== stable(w.row[col]) && now !== stable(w.to[f])) {
          bad.push(
            `id ${w.id}: ${col} holds ${now}, planned ${stable(w.row[col])} to ${stable(w.to[f])}`,
          );
        }
      }
    }
  }
  refuseChanged(step, bad, writes.length);
}

async function preflightPremarket(writes: PremarketWrite[]): Promise<void> {
  const bad: string[] = [];
  for (const group of chunks(writes, WRITE_CHUNK)) {
    const ids = group.map((w) => w.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(m) AS row
          FROM market_snapshots m WHERE id = ANY(${ids}::int[])`,
    );
    const found = new Map(actual.map((r) => [Number(r.id), r.row]));
    for (const w of group) {
      const have = found.get(w.id);
      if (have == null) {
        bad.push(`id ${w.id}: row is gone`);
        continue;
      }
      const was = (w.row.pre_market_data ?? {}) as Row;
      const now = (have.pre_market_data ?? {}) as Row;
      for (const [key, value] of Object.entries(w.to)) {
        if (
          stable(now[key]) !== stable(was[key]) &&
          stable(now[key]) !== stable(value)
        ) {
          bad.push(
            `id ${w.id}: ${key} holds ${stable(now[key])}, planned ${stable(was[key])} to ${stable(value)}`,
          );
        }
      }
    }
  }
  refuseChanged('premarket', bad, writes.length);
}

async function preflightFires(writes: FireWrite[]): Promise<void> {
  const bad: string[] = [];
  for (const group of chunks(writes, WRITE_CHUNK)) {
    const ids = group.map((w) => w.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(f) AS row
          FROM ws_gamma_setup_fires f WHERE id = ANY(${ids}::bigint[])`,
    );
    const found = new Map(actual.map((r) => [Number(r.id), r.row]));
    for (const w of group) {
      const have = found.get(w.id);
      if (have == null) {
        bad.push(`id ${w.id}: row is gone`);
        continue;
      }
      const now = stable(have.es_basis_change_5m);
      if (now !== stable(w.row.es_basis_change_5m) && now !== stable(w.to)) {
        bad.push(
          `id ${w.id}: es_basis_change_5m holds ${now}, planned ${stable(w.row.es_basis_change_5m)} to ${stable(w.to)}`,
        );
      }
    }
  }
  refuseChanged('fires', bad, writes.length);
}

/** How many of the rows are still there; one that is there must still hold its planned price. */
async function preflightDeletes(
  step: DeleteStep,
  planned: DeleteWrite[],
): Promise<number> {
  const bad: string[] = [];
  let present = 0;
  for (const group of chunks(planned, WRITE_CHUNK)) {
    const ids = group.map((d) => d.id);
    const actual = await readRows<{ id: string; row: Row }>(
      (sql) => sql`
        SELECT id::text AS id, to_jsonb(f) AS row
          FROM futures_snapshots f WHERE id = ANY(${ids}::int[])`,
    );
    const found = new Map(actual.map((r) => [Number(r.id), r.row]));
    for (const d of group) {
      const have = found.get(d.id);
      if (have == null) continue;
      present += 1;
      if (stable(have.price) !== stable(d.row.price)) {
        bad.push(
          `id ${d.id}: price holds ${stable(have.price)}, planned ${stable(d.row.price)}`,
        );
      }
    }
  }
  refuseChanged(step, bad, planned.length);
  return present;
}

/** The snapshot fields' columns, for the check before a write. */
const SNAPSHOT_COLUMNS: Record<SnapshotField, string> = {
  price: 'price',
  change1hPct: 'change_1h_pct',
  changeDayPct: 'change_day_pct',
  volumeRatio: 'volume_ratio',
};

/** The same guarded UPDATE and verify as the snapshot writes, for the stale-at-write rows. */
async function applyStale(
  rewrites: StaleWrite[],
  begin: () => void,
): Promise<number> {
  await preflightSnapshots('stale', rewrites);
  begin();
  await writeInTransactions(rewrites, updateSnapshots);
  // The row holds the snapshot step's fields too: that step runs first.
  await verifySnapshots(
    rewrites.map((r) => ({ ...r, fields: [...r.fields, ...r.also] })),
  );
  return rewrites.length;
}

/** The junk and frozen deletes: the same guarded DELETE and verify, each in its own scope. */
async function applyDeletes(
  step: DeleteStep,
  planned: DeleteWrite[],
  begin: () => void,
): Promise<number> {
  const present = await preflightDeletes(step, planned);
  begin();
  const before = await countSnapshotsIn(deleteScope(step));
  await writeInTransactions(planned, deleteSnapshots);
  await verifyDeletes(step, planned, before, present);
  return planned.length;
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface RecomputeOptions {
  /** report.txt, backups and the per-store done markers. */
  workDir: string;
  apply: boolean;
  force: boolean;
  stores: Store[];
  /**
   * `--stores frozen`: plan, and with the delete write, only the frozen-stale ES and
   * NQ snapshot rows, and no store (`stores` is empty). It needs no Phase 2 backup.
   */
  frozen: boolean;
  /** The Phase 2 backup JSONL: required for the snapshots and premarket stores. */
  backup: string | null;
  /** The rows to write in the dry run the owner approved. Null on a dry run. */
  expectSnapshots: number | null;
  expectPremarket: number | null;
  expectFires: number | null;
  /**
   * Also delete the stale snapshot rows whose price is the close of a bar Phase 2
   * deleted (they cannot be recomputed and `price` cannot be blanked). Off by
   * default: the owner decides, after reading the dry run's list.
   */
  deleteJunkStale: boolean;
  /** The rows that delete removes in the dry run the owner approved. */
  expectJunkDeletes: number | null;
  /**
   * Also rewrite the rows the writer priced from a bar older than the freshness
   * gate allows (until 2026-09-30), from today's bars. Off by default: the owner
   * decides, after reading the dry run's list.
   */
  rewriteStaleAtWrite: boolean;
  /** The rows that rewrite changes in the dry run the owner approved. */
  expectStaleRewrites: number | null;
  /**
   * Also delete the ES and NQ snapshot rows before 2026-10-01 that computeSnapshot
   * cannot price and whose price is not the close of the latest closed bar (frozen
   * on an older bar). Off by default; needs `frozen`. Owner OK 2026-11-11.
   */
  deleteFrozenStale: boolean;
  /** The rows that delete removes in the dry run the owner approved. */
  expectFrozenDeletes: number | null;
  /**
   * The Phase 1 detector's days for RTY, CL, GC and ZN after the span end (a JSON
   * file, see parseDetectorDays). Their rows on the contaminated days are left out
   * of the stale rewrite; without the file their rows after the span end are left
   * too, because the source is unchecked. It changes the plan, so a dry run takes
   * it as well.
   */
  detectorDays: string | null;
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
    frozen: false,
    backup: null,
    expectSnapshots: null,
    expectPremarket: null,
    expectFires: null,
    deleteJunkStale: false,
    expectJunkDeletes: null,
    rewriteStaleAtWrite: false,
    expectStaleRewrites: null,
    deleteFrozenStale: false,
    expectFrozenDeletes: null,
    detectorDays: null,
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
      if (values.includes('frozen')) {
        if (values.length > 1) {
          throw new Error(
            '--stores frozen runs alone: it plans no other store',
          );
        }
        args.frozen = true;
        args.stores = [];
      } else {
        const bad = values.find(
          (v) => !(STORES as readonly string[]).includes(v),
        );
        if (bad != null) throw new Error(`unknown store "${bad}"`);
        args.stores = values as Store[];
      }
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
    else if (flag === '--rewrite-stale-at-write')
      args.rewriteStaleAtWrite = true;
    else if (flag === '--expect-stale-rewrites')
      args.expectStaleRewrites = parseCount(flag, next());
    else if (flag === '--detector-days') args.detectorDays = next();
    else if (flag === '--delete-junk-stale') args.deleteJunkStale = true;
    else if (flag === '--expect-junk-deletes')
      args.expectJunkDeletes = parseCount(flag, next());
    else if (flag === '--delete-frozen-stale') args.deleteFrozenStale = true;
    else if (flag === '--expect-frozen-deletes')
      args.expectFrozenDeletes = parseCount(flag, next());
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.force && !args.apply)
    throw new Error('--force only applies with --apply');
  if (!args.apply && (args.deleteJunkStale || args.expectJunkDeletes != null)) {
    throw new Error(
      `${args.deleteJunkStale ? '--delete-junk-stale' : '--expect-junk-deletes'} only applies with --apply`,
    );
  }
  if (
    !args.apply &&
    (args.rewriteStaleAtWrite || args.expectStaleRewrites != null)
  ) {
    throw new Error(
      `${args.rewriteStaleAtWrite ? '--rewrite-stale-at-write' : '--expect-stale-rewrites'} only applies with --apply`,
    );
  }
  if (args.expectStaleRewrites != null && !args.rewriteStaleAtWrite) {
    throw new Error('--expect-stale-rewrites needs --rewrite-stale-at-write');
  }
  if (args.rewriteStaleAtWrite) {
    if (!args.stores.includes('snapshots')) {
      throw new Error(
        '--rewrite-stale-at-write writes futures_snapshots, so --stores must include snapshots',
      );
    }
    if (args.expectStaleRewrites == null) {
      throw new Error(
        '--rewrite-stale-at-write needs --expect-stale-rewrites S: the count of the dry run you approved',
      );
    }
  }
  if (args.expectJunkDeletes != null && !args.deleteJunkStale) {
    throw new Error('--expect-junk-deletes needs --delete-junk-stale');
  }
  if (args.deleteJunkStale) {
    if (!args.stores.includes('snapshots')) {
      throw new Error(
        '--delete-junk-stale deletes from futures_snapshots, so --stores must include snapshots',
      );
    }
    if (args.expectJunkDeletes == null) {
      throw new Error(
        '--delete-junk-stale needs --expect-junk-deletes J: the count of the dry run you approved',
      );
    }
  }
  if (
    !args.apply &&
    (args.deleteFrozenStale || args.expectFrozenDeletes != null)
  ) {
    throw new Error(
      `${args.deleteFrozenStale ? '--delete-frozen-stale' : '--expect-frozen-deletes'} only applies with --apply`,
    );
  }
  if (args.expectFrozenDeletes != null && !args.deleteFrozenStale) {
    throw new Error('--expect-frozen-deletes needs --delete-frozen-stale');
  }
  if (args.deleteFrozenStale) {
    if (!args.frozen) {
      throw new Error(
        '--delete-frozen-stale deletes frozen-stale rows, so --stores must be frozen',
      );
    }
    if (args.expectFrozenDeletes == null) {
      throw new Error(
        '--delete-frozen-stale needs --expect-frozen-deletes N: the count of the dry run you approved',
      );
    }
  }
  if (args.apply && args.frozen && !args.deleteFrozenStale) {
    throw new Error(
      '--apply with --stores frozen needs --delete-frozen-stale and --expect-frozen-deletes N: the count of the dry run you approved',
    );
  }
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
  if (args.frozen) {
    for (const store of STORES) {
      if (given[store] != null) {
        throw new Error(
          `${EXPECT_FLAGS[store].flag} does not apply with --stores frozen`,
        );
      }
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
 * needs the Phase 2 backup too. `--stores frozen` plans no store, so it needs none.
 */
const needsBackup = (o: RecomputeOptions): boolean =>
  (o.apply && !o.frozen) ||
  o.stores.includes('snapshots') ||
  o.stores.includes('premarket');

function expectations(o: RecomputeOptions): Record<Store, number | null> {
  return {
    snapshots: o.expectSnapshots,
    premarket: o.expectPremarket,
    fires: o.expectFires,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

/**
 * The one command that would apply what this dry run planned, every total next
 * to the delete of the stale rows priced from a deleted junk bar when there are
 * any (leave out its two flags to apply without it).
 */
function applyCommand(opts: RecomputeOptions, plans: Plans): string | null {
  if (plans.frozen != null) {
    return plans.frozen.rows.length === 0
      ? null
      : [
          'npx tsx scripts/recompute-futures-derived.ts --apply',
          `--work-dir ${opts.workDir}`,
          '--stores frozen',
          '--delete-frozen-stale',
          `--expect-frozen-deletes ${plans.frozen.rows.length}`,
        ].join(' ');
  }
  const planned = STORES.filter((store) => plans[store] != null);
  if (planned.length === 0) return null;
  const junk = plans.snapshots?.junk.length ?? 0;
  const stale = plans.snapshots?.staleRewrites.length ?? 0;
  return [
    'npx tsx scripts/recompute-futures-derived.ts --apply',
    `--work-dir ${opts.workDir}`,
    ...(opts.backup == null ? [] : [`--backup ${opts.backup}`]),
    ...(planned.length === STORES.length
      ? []
      : [`--stores ${planned.join(' ')}`]),
    ...planned.map(
      (store) =>
        `${EXPECT_FLAGS[store].flag} ${plans[store]?.changes.length ?? 0}`,
    ),
    ...(junk === 0
      ? []
      : ['--delete-junk-stale', `--expect-junk-deletes ${junk}`]),
    ...(stale === 0
      ? []
      : ['--rewrite-stale-at-write', `--expect-stale-rewrites ${stale}`]),
    ...(opts.detectorDays == null
      ? []
      : [`--detector-days ${opts.detectorDays}`]),
  ].join(' ');
}

/**
 * Whether an opt-in step still runs: it was asked for, it has no done marker (or
 * `--force`) and the fresh plan lists rows. Says so when a marker skips it.
 */
function optInPending(
  opts: RecomputeOptions,
  step: 'junk' | 'stale' | 'frozen',
  asked: boolean,
  rows: number,
  what: string,
  verb: string,
): boolean {
  if (!asked) return false;
  if (!opts.force && existsSync(markerPath(opts.workDir, step))) {
    console.log(
      rows > 0
        ? `WARNING: ${what} is marked done but the fresh plan still lists ${rows} row(s); it is skipped. Use --force to redo it.`
        : `${what} is marked done and has nothing left to ${verb}`,
    );
    return false;
  }
  return rows > 0;
}

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
  // A run that failed between steps left a plan with some steps marked: finish it.
  const saved =
    opts.apply && !opts.force ? readPlanPointer(opts.workDir) : null;
  if (saved != null && resumable(opts.workDir, saved)) {
    return await resume(opts, saved);
  }
  const startedAt = Date.now();
  const backupBars =
    needsBackup(opts) && opts.backup != null
      ? parseBackup(readFileSync(opts.backup, 'utf8'), opts.backup)
      : [];
  const detectorDays =
    opts.detectorDays == null
      ? null
      : parseDetectorDays(
          readFileSync(opts.detectorDays, 'utf8'),
          opts.detectorDays,
        );
  console.log(
    `Futures derived-store recompute${opts.apply ? '' : ' (DRY RUN: read-only, no writes)'}`,
  );

  const plans: Plans = {};
  // A dry run plans what it was asked for; --apply plans every store, to check it.
  // --stores frozen plans no store at all.
  const planned: Store[] = opts.frozen
    ? []
    : opts.apply
      ? [...STORES]
      : opts.stores;
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
      plans.snapshots = await planSnapshots(data, detectorDays);
    if (opts.frozen) plans.frozen = await planFrozen();
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
  const elapsed = `elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`;
  const header = opts.frozen
    ? [
        `frozen-stale scope: ES and NQ futures_snapshots rows before ${isoSecond(STALE_UNTIL_MS)}`,
        ...session,
        elapsed,
      ]
    : [
        `repaired span ${span}`,
        `snapshot scope ${isoSecond(scope.snapshots.fromMs)} .. ${isoSecond(scope.snapshots.toMs)} (span end + 20 days)`,
        `fire scope ${isoSecond(scope.fires.fromMs)} .. ${isoSecond(scope.fires.toMs)} (span end + 6 minutes)`,
        `stale-at-write test reaches ${isoSecond(STALE_UNTIL_MS)} (the freshness gate shipped on 2026-09-30); ES and NQ from the span start, the thin roots from the span end + 20 days (${isoSecond(scope.snapshots.toMs)}) and off the contaminated days in ${opts.detectorDays ?? 'no file (their rows after the span end are left)'}`,
        ...(opts.backup == null
          ? []
          : [
              `Phase 2 backup ${opts.backup}: ${backupBars.length} rows (${backupBars.filter((b) => b.op === 'update').length} updated, ${backupBars.filter((b) => b.op === 'delete').length} deleted)`,
            ]),
        ...session,
        elapsed,
      ];
  const report = formatReport(
    plans,
    header,
    controlProblems,
    applyCommand(opts, plans),
  );
  console.log(`\n${report}`);
  writeFileSync(join(opts.workDir, 'report.txt'), `${report}\n`);
  console.log(`\nreport: ${join(opts.workDir, 'report.txt')}`);
  const mergeDetail =
    plans.snapshots?.symbols.flatMap((r) => r.mergeState?.detail ?? []) ?? [];
  if (mergeDetail.length > 0) {
    writeFileSync(
      join(opts.workDir, 'merge-state.txt'),
      `${mergeDetail.join('\n')}\n`,
    );
  }
  if (!opts.apply) return 0;

  // Refuse before any marker, backup or write: the totals must be the approved
  // ones and every control set must match.
  // Every planned store's checks must hold; only the stores to be written have
  // an approved total to equal.
  const approved: Partial<Record<Store, number | null>> = {};
  for (const store of opts.stores) approved[store] = expectations(opts)[store];
  const problems = [
    ...checkApplyGate(gateInputs, approved),
    ...checkJunkGate(opts, plans.snapshots?.junk.length ?? 0),
    ...checkStaleGate(opts, plans.snapshots?.staleRewrites.length ?? 0),
    ...checkFrozenGate(opts, plans.frozen?.rows.length ?? 0),
    ...(opts.rewriteStaleAtWrite
      ? checkStaleShare(plans.snapshots?.symbols ?? [])
      : []),
  ];
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
  const junk = plans.snapshots?.junk ?? [];
  const junkPending = optInPending(
    opts,
    'junk',
    opts.deleteJunkStale,
    junk.length,
    'the junk delete',
    'delete',
  );
  const stale = plans.snapshots?.staleRewrites ?? [];
  const stalePending = optInPending(
    opts,
    'stale',
    opts.rewriteStaleAtWrite,
    stale.length,
    'the stale-at-write rewrite',
    'rewrite',
  );
  const frozen = plans.frozen?.rows ?? [];
  const frozenPending = optInPending(
    opts,
    'frozen',
    opts.deleteFrozenStale,
    frozen.length,
    'the frozen-stale delete',
    'delete',
  );
  if (pending.length === 0 && !stalePending && !junkPending && !frozenPending) {
    return 0;
  }

  const written = writeBackup(
    opts.workDir,
    {
      snapshots: pending.includes('snapshots') ? plans.snapshots : undefined,
      premarket: pending.includes('premarket') ? plans.premarket : undefined,
      fires: pending.includes('fires') ? plans.fires : undefined,
    },
    {
      junk: junkPending ? junk : [],
      stale: stalePending ? stale : [],
      frozen: frozenPending ? frozen : [],
    },
    pending.includes('snapshots'),
  );
  console.log(`backup: ${written.path}`);

  const steps: ApplyStep[] = [
    ...pending,
    ...(stalePending ? (['stale'] as const) : []),
    ...(junkPending ? (['junk'] as const) : []),
    ...(frozenPending ? (['frozen'] as const) : []),
  ];
  const pointer: PlanPointer = {
    createdAt: new Date().toISOString(),
    backup: basename(written.path),
    steps,
    rows: Object.fromEntries(
      steps.map((step) => [step, written.rows[step] ?? 0]),
    ),
    lines: written.lines,
    sha256: written.sha256,
    expect: {
      snapshots: plans.snapshots?.changes.length ?? 0,
      premarket: plans.premarket?.changes.length ?? 0,
      fires: plans.fires?.changes.length ?? 0,
      junk: opts.deleteJunkStale ? junk.length : null,
      stale: opts.rewriteStaleAtWrite ? stale.length : null,
      frozen: opts.deleteFrozenStale ? frozen.length : null,
    },
    command: {
      workDir: resolve(opts.workDir),
      stores: opts.stores,
      backup: opts.backup,
      detectorDays: opts.detectorDays,
    },
  };
  writePlanPointer(opts.workDir, pointer);
  // Apply from the file just written, the same way a resumed run does.
  return await applySteps(opts.workDir, readPlan(written.path, pointer), steps);
}

async function applyStep(
  step: ApplyStep,
  plan: LoadedPlan,
  workDir: string,
): Promise<number> {
  // Every row of the step is checked first; then the step is recorded as started,
  // so a run that dies after its first batch commits is resumed, not planned again.
  const begin = (): void => writeStarted(workDir, step, stepRows(plan, step));
  if (step === 'junk') return await applyDeletes(step, plan.junk, begin);
  if (step === 'frozen') return await applyDeletes(step, plan.frozen, begin);
  if (step === 'stale') return await applyStale(plan.stale, begin);
  if (step === 'snapshots') {
    await preflightSnapshots(step, plan.snapshots);
    begin();
    await writeInTransactions(plan.snapshots, updateSnapshots);
    await verifySnapshots(plan.snapshots);
    return plan.snapshots.length;
  }
  if (step === 'premarket') {
    await preflightPremarket(plan.premarket);
    begin();
    await writeInTransactions(plan.premarket, updatePremarket);
    await verifyPremarket(plan.premarket);
    return plan.premarket.length;
  }
  await preflightFires(plan.fires);
  begin();
  await writeInTransactions(plan.fires, updateFires);
  await verifyFires(plan.fires);
  return plan.fires.length;
}

/** Runs the steps in order, each checked, written, verified and then marked. Exit code 0, or 2 at the open. */
async function applySteps(
  workDir: string,
  plan: LoadedPlan,
  steps: ApplyStep[],
): Promise<number> {
  for (const step of steps) {
    // The apply can outlast the close, so the guard is checked before every step.
    if (isMarketHours()) {
      console.error(
        `apply stopped before ${step}: market hours began (09:25 ET). Finished steps are marked; run the same command again after the close to finish from the saved plan.`,
      );
      return 2;
    }
    try {
      const done = await applyStep(step, plan, workDir);
      console.log(
        `${step}: ${done} row(s) ${step === 'junk' || step === 'frozen' ? 'deleted' : 'changed'} and verified`,
      );
    } catch (err) {
      throw new Error(
        `apply failed: ${step}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    writeMarker(workDir, step, stepRows(plan, step));
  }
  return 0;
}

/** The steps of a saved plan that no marker covers. */
const stepsLeft = (workDir: string, saved: PlanPointer): ApplyStep[] =>
  saved.steps.filter((step) => !existsSync(markerPath(workDir, step)));

/**
 * A saved plan is resumed when one of its steps is started or applied and not all
 * are applied. A step that is started has begun writing and may have committed some
 * batches, so a fresh plan would no longer find the rows it wrote. Its plan file must
 * be there: if it is gone the run stops and says so.
 */
function resumable(workDir: string, saved: PlanPointer): boolean {
  const applied = saved.steps.filter((s) => existsSync(markerPath(workDir, s)));
  const begun = saved.steps.filter(
    (s) => existsSync(startedPath(workDir, s)) || applied.includes(s),
  );
  if (begun.length === 0 || applied.length === saved.steps.length) return false;
  if (!existsSync(join(workDir, saved.backup))) {
    throw new Error(
      `the plan file ${saved.backup} that ${pointerPath(workDir)} names is missing from ${workDir}, though a step is started or applied (${begun.join(', ')}): it cannot be resumed (use --force to plan again)`,
    );
  }
  return true;
}

/** The command must be the one the plan was made for: its inputs, its totals and its opt-in steps. */
function checkResume(opts: RecomputeOptions, saved: PlanPointer): string[] {
  const problems: string[] = [];
  const c = saved.command;
  if (resolve(opts.workDir) !== c.workDir) {
    problems.push(
      `--work-dir ${opts.workDir} was given, the saved plan was made in ${c.workDir}`,
    );
  }
  const stores = (list: readonly string[]): string =>
    [...list].sort().join(' ');
  if (stores(opts.stores) !== stores(c.stores)) {
    problems.push(
      `--stores ${opts.stores.join(' ')} was given, the saved plan was made with --stores ${c.stores.join(' ')}`,
    );
  }
  if (opts.backup !== c.backup) {
    problems.push(
      `--backup ${opts.backup} was given, the saved plan was made with --backup ${c.backup}`,
    );
  }
  if (opts.detectorDays !== c.detectorDays) {
    problems.push(
      `--detector-days ${opts.detectorDays} was given, the saved plan was made with --detector-days ${c.detectorDays}`,
    );
  }
  for (const store of opts.stores) {
    const given = expectations(opts)[store];
    if (given !== saved.expect[store]) {
      problems.push(
        `${EXPECT_FLAGS[store].flag} ${given} was given, the saved plan has ${saved.expect[store]}`,
      );
    }
  }
  if (opts.deleteJunkStale !== (saved.expect.junk != null)) {
    problems.push(
      `the saved plan ${saved.expect.junk == null ? 'has no' : 'has a'} junk delete, --delete-junk-stale was ${opts.deleteJunkStale ? 'given' : 'not given'}`,
    );
  } else if (opts.expectJunkDeletes !== saved.expect.junk) {
    problems.push(
      `--expect-junk-deletes ${opts.expectJunkDeletes} was given, the saved plan has ${saved.expect.junk}`,
    );
  }
  if (opts.rewriteStaleAtWrite !== (saved.expect.stale != null)) {
    problems.push(
      `the saved plan ${saved.expect.stale == null ? 'has no' : 'has a'} stale rewrite, --rewrite-stale-at-write was ${opts.rewriteStaleAtWrite ? 'given' : 'not given'}`,
    );
  } else if (opts.expectStaleRewrites !== saved.expect.stale) {
    problems.push(
      `--expect-stale-rewrites ${opts.expectStaleRewrites} was given, the saved plan has ${saved.expect.stale}`,
    );
  }
  // A plan.json from before the frozen delete has no key for it: none was asked for.
  const savedFrozen = saved.expect.frozen ?? null;
  if (opts.deleteFrozenStale !== (savedFrozen != null)) {
    problems.push(
      `the saved plan ${savedFrozen == null ? 'has no' : 'has a'} frozen delete, --delete-frozen-stale was ${opts.deleteFrozenStale ? 'given' : 'not given'}`,
    );
  } else if (opts.expectFrozenDeletes !== savedFrozen) {
    problems.push(
      `--expect-frozen-deletes ${opts.expectFrozenDeletes} was given, the saved plan has ${savedFrozen}`,
    );
  }
  return problems;
}

/**
 * Finishes an apply that failed between steps, from the plan file it saved and
 * without planning again (planning takes the better part of an hour, and a fresh
 * plan no longer finds the rows a finished step already wrote).
 */
async function resume(
  opts: RecomputeOptions,
  saved: PlanPointer,
): Promise<number> {
  const problems = checkResume(opts, saved);
  if (problems.length > 0) {
    const listed = problems.map((p) => `  ${p}`).join('\n');
    throw new Error(
      `Refusing to resume. Nothing was written.\n${listed}\n  use --force to plan again, or remove plan.json`,
    );
  }
  const left = stepsLeft(opts.workDir, saved);
  console.log(
    `Resuming from ${saved.backup}: ${left.join(', ')} left of ${saved.steps.join(', ')}; no planning`,
  );
  return await applySteps(
    opts.workDir,
    readPlan(join(opts.workDir, saved.backup), saved),
    left,
  );
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
