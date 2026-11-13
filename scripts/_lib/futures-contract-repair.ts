/**
 * Apply tool for the ES/NQ front-month rebuild (Phase 2 of
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md). Phase 1
 * (ml/src/futures_contract_repair.py) wrote the true front-month 1-minute bars
 * as NDJSON; this module turns them into `futures_bars` writes:
 *
 * - Archive span (2026-04-05 22:00Z to 04-17 20:59Z): every field follows the
 *   rebuild, and a row with no rebuilt minute is deleted.
 * - Tick span (2026-04-20 01:56Z to 06-15 14:11Z): field by field. A price is
 *   replaced only when it sits more than half a calendar carry from the
 *   rebuilt value (a back-month field is a full carry off; a front-month
 *   field differs from the rebuild only by a boundary print). Volume follows
 *   the rebuild only in the roll week, on a non-partial multi-cluster minute.
 *   A row with no rebuilt minute is deleted only if it fails the
 *   b-forensics excursion test (docs/tmp/es-contract-month-2026-11-06/
 *   b-forensics.md section 3.1).
 * - Off-session junk, all six roots: rows between Friday 2026-04-10 16:00 CDT
 *   and Sunday 04-12 17:00 CDT are deleted.
 *
 * The order-flow columns, `id`, other roots and every minute outside those
 * windows are never touched. A dry run (the default) reads the database
 * through read-only transactions and writes nothing; `--apply` backs up every
 * row it will change, writes one UTC day per transaction, re-reads the day and
 * only then drops a done marker. The entry script is
 * scripts/repair-futures-contract-mix.ts.
 *
 * `--thin-roots` is Phase 5a (owner decision D1, 2026-11-11): RTY, CL, GC and ZN
 * have no rebuild source, so it reads no Phase 1 output and deletes their bars
 * from 2026-04-05 22:00Z through each root's last bad bar, except the seven
 * clean CT trading days (scope in futures-thin-roots.ts). It never updates a row
 * and never touches ES or NQ. It runs on the same machinery: a dry run, a
 * full-row backup in this tool's format, one UTC day per transaction, a DELETE
 * guarded by id, symbol and values, a verify and a `{day}.applied` marker.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import { getCTTime } from '../../src/utils/timezone.js';
import {
  CLEAN_TRADING_DAYS,
  JUNK_WINDOW,
  THIN_LAST_BAD_MS,
  THIN_ROOTS,
  THIN_WINDOW_START_MS,
  ctTradingDay,
  inThinWindow,
  isThinDeleteBar,
  type ThinRoot,
} from './futures-thin-roots.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const ROOTS = ['ES', 'NQ'] as const;
export type Root = (typeof ROOTS)[number];

/** Roots that lose their off-session junk rows (ES/NQ are in `ROOTS`). */
export const JUNK_ONLY_ROOTS = THIN_ROOTS;

/** UTC days, inclusive. Volume follows the rebuild only here. */
export const ROLL_WEEK = { first: '2026-06-09', last: '2026-06-15' } as const;

/** Excursion threshold X per root (b-forensics.md 3.2, strict column). */
export const EXCURSION_X: Record<Root, number> = { ES: 25, NQ: 120 };

/** The same strict thresholds for the four roots `--thin-roots` deletes from. */
export const THIN_EXCURSION_X: Record<ThinRoot, number> = {
  RTY: 14,
  CL: 1.8,
  GC: 20,
  ZN: 0.125,
};

/** The flagged kept-day bars the report lists per root; the rest are counted. */
const FLAGGED_LIST_CAP = 20;

/** The `gitHead` a `--thin-roots` done marker carries: there is no Phase 1 run. */
export const THIN_ROOTS_STAMP = 'thin-roots';

/** Centred median of this many closes, at least MEDIAN_MIN of them present. */
const MEDIAN_WINDOW = 11;
const MEDIAN_MIN = 6;
/** A gap longer than this many minutes between bars starts a new run. */
const RUN_BREAK_MINUTES = 5;

/** Rows per UPDATE / DELETE statement (R5: batch around 500 rows). */
export const WRITE_CHUNK = 500;
/** UTC days per read page: keeps one response well under Neon's 64 MiB cap. */
const READ_PAGE_DAYS = 7;
/** Extra minutes read past the tick span so the median has its right-hand side. */
const READ_CONTEXT_MINUTES = 15;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;
const FIELDS = [...PRICE_FIELDS, 'volume'] as const;
export type Field = (typeof FIELDS)[number];

// ── Small helpers ───────────────────────────────────────────────────────────

const utcDay = (tsMs: number): string =>
  new Date(tsMs).toISOString().slice(0, 10);

const isoMinute = (tsMs: number): string =>
  new Date(tsMs).toISOString().replace('.000Z', 'Z');

/** futures_bars prices are NUMERIC(12,4): four decimals, half away from zero. */
const SCALE = 10_000;
const toTicks = (x: number): number => Math.round(x * SCALE);

/** `x` as the NUMERIC(12,4) column would store it. */
export const roundNumeric = (x: number): number => toTicks(x) / SCALE;

const num = (x: number): string => String(Number(x.toFixed(4)));

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim();
}

function parseUtc(text: string, what: string): number {
  const parsed = Date.parse(text.replace(' ', 'T'));
  if (Number.isNaN(parsed)) throw new Error(`${what}: "${text}" is not a date`);
  return parsed;
}

const inRollWeek = (tsMs: number): boolean => {
  const day = utcDay(tsMs);
  return day >= ROLL_WEEK.first && day <= ROLL_WEEK.last;
};

const inJunkWindow = (tsMs: number): boolean =>
  tsMs >= JUNK_WINDOW.startMs && tsMs < JUNK_WINDOW.endMs;

/** Regular session 08:30 to 15:00 CT, as b-forensics counts it. */
export function classifySession(tsMs: number): 'rth' | 'overnight' {
  const { hour, minute } = getCTTime(new Date(tsMs));
  const t = hour * 60 + minute;
  return t >= 8 * 60 + 30 && t < 15 * 60 ? 'rth' : 'overnight';
}

// ── Phase 1 manifest ────────────────────────────────────────────────────────

export interface Span {
  startMs: number;
  /** Exclusive. */
  endMs: number;
}

export interface RootParams {
  front: string;
  /** G: the largest gap inside one contract's minute. */
  gap: number;
  /** One calendar spread. */
  carry: number;
  carryHalf: number;
}

export interface Manifest {
  gitHead: string;
  moduleEdited: boolean;
  finishedUtc: string;
  spans: { archive: Span; ticks: Span };
  roots: Record<Root, RootParams>;
  /** The ts_recv gate, the one Phase 1 scores against the archive. */
  gate: Record<
    Root,
    { minutes: number; exactOhlc: number; volumeWithin1pct: number }
  >;
  /** Rebuilt rows by `{root}/{source}`. */
  rows: Record<string, number>;
  ndjsonFiles: number;
  unsplittable: number;
}

const rootParamsSchema = z.object({
  front: z.string(),
  gap: z.number().positive(),
  carry: z.number().positive(),
  carry_half: z.number().positive(),
});

const gateRootSchema = z.object({
  minutes: z.number(),
  exact_ohlc: z.number(),
  volume_within_1pct: z.number(),
  passed: z.boolean(),
});

const spanSchema = z.tuple([z.string(), z.string()]);

const manifestSchema = z.object({
  status: z.string(),
  reason: z.string().default(''),
  git: z.object({ head: z.string().min(7), module_edited: z.boolean() }),
  finished_utc: z.string(),
  spans: z.object({ archive: spanSchema, ticks: spanSchema }),
  roots: z.object({ ES: rootParamsSchema, NQ: rootParamsSchema }),
  gate: z.object({
    ts_recv: z.object({ ES: gateRootSchema, NQ: gateRootSchema }),
  }),
  post_check: z.object({ unsplittable: z.number().int() }),
  rows: z.record(z.string(), z.number().int()),
  ndjson_files: z.number().int(),
});

function toSpan(pair: [string, string], what: string): Span {
  const span = {
    startMs: parseUtc(pair[0], `manifest spans.${what}`),
    endMs: parseUtc(pair[1], `manifest spans.${what}`),
  };
  if (span.endMs <= span.startMs) {
    throw new Error(`manifest spans.${what} ends before it starts`);
  }
  return span;
}

/**
 * Read Phase 1's manifest and refuse unless it records a passing run: status
 * "passed" and the ts_recv gate passed for ES and NQ. (The ts_event gate is
 * informational: Phase 1 scores on the receive clock.)
 */
export function loadManifest(dir: string): Manifest {
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) {
    throw new Error(`manifest.json not found in ${dir}; run Phase 1 first`);
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `manifest.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`manifest.json is malformed: ${issueText(parsed.error)}`);
  }
  const m = parsed.data;
  if (m.status !== 'passed') {
    throw new Error(
      `Phase 1 did not pass (status "${m.status}"): ${m.reason || 'no reason recorded'}`,
    );
  }
  for (const root of ROOTS) {
    if (!m.gate.ts_recv[root].passed) {
      throw new Error(`Phase 1 ts_recv gate failed for ${root}`);
    }
  }
  const root = (r: z.infer<typeof rootParamsSchema>): RootParams => ({
    front: r.front,
    gap: r.gap,
    carry: r.carry,
    carryHalf: r.carry_half,
  });
  const gate = (g: z.infer<typeof gateRootSchema>) => ({
    minutes: g.minutes,
    exactOhlc: g.exact_ohlc,
    volumeWithin1pct: g.volume_within_1pct,
  });
  return {
    gitHead: m.git.head,
    moduleEdited: m.git.module_edited,
    finishedUtc: m.finished_utc,
    spans: {
      archive: toSpan(m.spans.archive, 'archive'),
      ticks: toSpan(m.spans.ticks, 'ticks'),
    },
    roots: { ES: root(m.roots.ES), NQ: root(m.roots.NQ) },
    gate: { ES: gate(m.gate.ts_recv.ES), NQ: gate(m.gate.ts_recv.NQ) },
    rows: m.rows,
    ndjsonFiles: m.ndjson_files,
    unsplittable: m.post_check.unsplittable,
  };
}

/** Minutes listed in unsplittable.csv (0 when absent or header-only). */
export function unsplittableCount(dir: string): number {
  const file = join(dir, 'unsplittable.csv');
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return Math.max(0, lines.length - 1);
}

// ── Rebuilt bars (Phase 1 NDJSON) ───────────────────────────────────────────

export interface RebuiltBar {
  symbol: Root;
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'archive' | 'ticks';
  nClusters: number;
  partial: boolean;
}

const price = z.number().positive();

const ndjsonLineSchema = z
  .object({
    symbol: z.enum(ROOTS),
    ts: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: z.number().int().nonnegative(),
    source: z.enum(['archive', 'ticks']),
    n_clusters: z.number().int().min(1),
    partial: z.boolean(),
  })
  .refine(
    (l) =>
      l.high >= Math.max(l.open, l.close) && l.low <= Math.min(l.open, l.close),
    'high and low do not bound open and close',
  );

interface ParsedLine {
  bar: RebuiltBar;
  line: number;
}

function parseNdjsonLines(text: string, file: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const where = `${file}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const parsed = ndjsonLineSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${where}: ${issueText(parsed.error)}`);
    }
    const l = parsed.data;
    out.push({
      line: i + 1,
      bar: {
        symbol: l.symbol,
        tsMs: Date.parse(l.ts),
        open: l.open,
        high: l.high,
        low: l.low,
        close: l.close,
        volume: l.volume,
        source: l.source,
        nClusters: l.n_clusters,
        partial: l.partial,
      },
    });
  });
  return out;
}

/** Validate every NDJSON line; a bad one throws with `file:line`. */
export function parseNdjson(text: string, file: string): RebuiltBar[] {
  return parseNdjsonLines(text, file).map((p) => p.bar);
}

export type Rebuild = Record<Root, Map<number, RebuiltBar>>;

const FILE_RE = /^(ES|NQ)-(\d{4}-\d{2}-\d{2})\.ndjson$/;

const inSpan = (span: Span, tsMs: number): boolean =>
  tsMs >= span.startMs && tsMs < span.endMs;

export interface LoadedRebuild {
  rebuild: Rebuild;
  /**
   * The text of every NDJSON file, by file name: the exact bytes the plan is
   * built from, kept so a done marker can be stamped with their digest even
   * if a file is rewritten on disk later.
   */
  texts: Map<string, string>;
}

/**
 * Load every NDJSON file into a per-root map keyed by the minute's epoch ms.
 * The manifest's file and row counts must match, so a missing or truncated
 * file cannot silently turn into "no rebuilt minute" (which deletes the row).
 */
export function loadRebuild(dir: string, m: Manifest): LoadedRebuild {
  const folder = join(dir, 'ndjson');
  if (!existsSync(folder)) throw new Error(`ndjson folder not found in ${dir}`);
  const files = readdirSync(folder)
    .filter((n) => n.endsWith('.ndjson'))
    .sort()
    .map((name) => {
      const hit = FILE_RE.exec(name);
      if (hit == null) throw new Error(`unexpected NDJSON file name ${name}`);
      return { name, root: hit[1] as Root, day: hit[2] ?? '' };
    });
  if (files.length !== m.ndjsonFiles) {
    throw new Error(
      `found ${files.length} NDJSON file(s), manifest says ${m.ndjsonFiles}`,
    );
  }

  const rebuild: Rebuild = { ES: new Map(), NQ: new Map() };
  const texts = new Map<string, string>();
  const counts: Record<string, number> = {};
  for (const { name, root, day } of files) {
    const path = join(folder, name);
    const text = readFileSync(path, 'utf8');
    texts.set(name, text);
    for (const { bar, line } of parseNdjsonLines(text, path)) {
      const where = `${path}:${line}`;
      const stamp = isoMinute(bar.tsMs);
      if (bar.symbol !== root) {
        throw new Error(`${where}: symbol ${bar.symbol} is not ${root}`);
      }
      if (utcDay(bar.tsMs) !== day) {
        throw new Error(
          `${where}: ts ${stamp} is not on the file's day ${day}`,
        );
      }
      if (bar.source === 'archive' && !inSpan(m.spans.archive, bar.tsMs)) {
        throw new Error(
          `${where}: archive bar at ${stamp} is outside the archive span`,
        );
      }
      if (bar.source === 'ticks' && !inSpan(m.spans.ticks, bar.tsMs)) {
        throw new Error(
          `${where}: ticks bar at ${stamp} is outside the tick span`,
        );
      }
      if (rebuild[root].has(bar.tsMs)) {
        throw new Error(`${where}: ${root} minute ${stamp} appears twice`);
      }
      rebuild[root].set(bar.tsMs, bar);
      const key = `${root}/${bar.source}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  for (const root of ROOTS) {
    for (const source of ['archive', 'ticks']) {
      const key = `${root}/${source}`;
      const have = counts[key] ?? 0;
      const want = m.rows[key] ?? 0;
      if (have !== want) {
        throw new Error(`${key} has ${have} rows, manifest says ${want}`);
      }
    }
  }
  return { rebuild, texts };
}

// ── Tick-less windows ───────────────────────────────────────────────────────

export interface TicklessWindow {
  symbol: Root;
  firstMs: number;
  lastMs: number;
  minutes: number;
  openMinutes: number;
}

export function loadTicklessWindows(dir: string): TicklessWindow[] {
  const file = join(dir, 'tickless_windows.csv');
  if (!existsSync(file))
    throw new Error(`tickless_windows.csv not found in ${dir}`);
  const out: TicklessWindow[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (i === 0 || raw.trim() === '') return;
      const where = `${file}:${i + 1}`;
      const [symbol, first, last, minutes, open] = raw.trim().split(',');
      if (symbol !== 'ES' && symbol !== 'NQ') {
        throw new Error(`${where}: symbol ${symbol ?? ''} is not ES or NQ`);
      }
      const n = Number.parseInt(minutes ?? '', 10);
      const o = Number.parseInt(open ?? '', 10);
      if (Number.isNaN(n) || Number.isNaN(o)) {
        throw new Error(`${where}: minutes and open_minutes must be integers`);
      }
      try {
        out.push({
          symbol,
          firstMs: parseUtc(first ?? '', 'first_minute'),
          lastMs: parseUtc(last ?? '', 'last_minute'),
          minutes: n,
          openMinutes: o,
        });
      } catch (err) {
        throw new Error(
          `${where}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    });
  return out;
}

// ── Database rows ───────────────────────────────────────────────────────────

/** A futures_bars row as the SELECT returns it: every value text. */
export interface PgRow {
  id: string;
  symbol: string;
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
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
  /**
   * The dated contract the bar was built from (migration #204), NULL when unknown.
   * A backup line written before this column was read has no such key; it reads as NULL.
   */
  contract: string | null;
}

export interface PgBar {
  id: string;
  symbol: string;
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  row: PgRow;
}

function parseColumn(row: PgRow, field: Field): number {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) {
    throw new Error(
      `futures_bars id ${row.id}: ${field} "${row[field]}" is not a number`,
    );
  }
  return value;
}

export function toBar(row: PgRow): PgBar {
  const tsMs = Date.parse(row.ts);
  if (Number.isNaN(tsMs) || tsMs % MINUTE_MS !== 0) {
    throw new Error(
      `futures_bars id ${row.id} (${row.symbol} ${row.ts}) is not minute-aligned`,
    );
  }
  return {
    id: row.id,
    symbol: row.symbol,
    tsMs,
    open: parseColumn(row, 'open'),
    high: parseColumn(row, 'high'),
    low: parseColumn(row, 'low'),
    close: parseColumn(row, 'close'),
    volume: parseColumn(row, 'volume'),
    row,
  };
}

// ── The field-wise rule ─────────────────────────────────────────────────────

export interface FieldChange {
  field: Field;
  from: number;
  to: number;
}

const sameValue = (a: number, b: number): boolean => toTicks(a) === toTicks(b);

/** Archive span: every field follows the rebuild, at NUMERIC(12,4) precision. */
export function archiveChanges(bar: PgBar, rb: RebuiltBar): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of FIELDS) {
    const to = roundNumeric(rb[field]);
    if (!sameValue(bar[field], to)) out.push({ field, from: bar[field], to });
  }
  return out;
}

/**
 * Tick span. A price is replaced only when it is more than `carryHalf` from
 * the rebuilt value: a field from the wrong contract sits a full carry off,
 * while a field from the front month is Databento's own full-minute value and
 * differs from the rebuild by a boundary print or a feed gap. Volume follows
 * the rebuild in two cases:
 *
 * - The roll week, on a non-partial minute with more than one cluster (PG
 *   volume is the GREATEST across contracts, which equals the front's volume
 *   unless the back month out-traded it within the minute).
 * - Whenever `low` is replaced, roll week or not, partial or not. The stored
 *   low is the LEAST across contracts, so a low a carry above the rebuilt one
 *   means no front-month bar was ever merged into the row: its volume is the
 *   back month's (1 to 33 lots against a front of 949 to 9,526). Even a
 *   partial rebuild's volume is far closer.
 */
export function tickChanges(
  bar: PgBar,
  rb: RebuiltBar,
  carryHalf: number,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of PRICE_FIELDS) {
    if (Math.abs(bar[field] - rb[field]) > carryHalf) {
      out.push({ field, from: bar[field], to: roundNumeric(rb[field]) });
    }
  }
  const lowReplaced = out.some((c) => c.field === 'low');
  const rollWeekMixed = inRollWeek(bar.tsMs) && rb.nClusters > 1 && !rb.partial;
  if ((lowReplaced || rollWeekMixed) && !sameValue(bar.volume, rb.volume)) {
    out.push({ field: 'volume', from: bar.volume, to: rb.volume });
  }
  return out;
}

// ── Excursion test (b-forensics.md 3.1) ─────────────────────────────────────

export interface Excursion {
  /** Centred median of 11 closes; null when fewer than 6 are in the window. */
  f: number | null;
  /** max |field - F| over the four prices. */
  e: number | null;
  flagged: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/**
 * F and E for every bar (sorted by ts). The median runs inside contiguous
 * runs: a gap of more than 5 minutes between bars starts a new run. A bar is
 * flagged when E is at least `x`; a bar with no F is untestable and unflagged.
 */
export function excursions(bars: PgBar[], x: number): Excursion[] {
  const out: Excursion[] = new Array<Excursion>(bars.length);
  const half = MEDIAN_WINDOW >> 1;
  let runStart = 0;
  for (let i = 0; i <= bars.length; i += 1) {
    const prev = bars[i - 1];
    const here = bars[i];
    const breaks =
      i === bars.length ||
      (prev != null &&
        here != null &&
        here.tsMs - prev.tsMs > RUN_BREAK_MINUTES * MINUTE_MS);
    if (!breaks) continue;
    const run = bars.slice(runStart, i);
    run.forEach((bar, j) => {
      const lo = Math.max(0, j - half);
      const hi = Math.min(run.length - 1, j + half);
      if (hi - lo + 1 < MEDIAN_MIN) {
        out[runStart + j] = { f: null, e: null, flagged: false };
        return;
      }
      const f = median(run.slice(lo, hi + 1).map((b) => b.close));
      const e = Math.max(
        ...PRICE_FIELDS.map((field) => Math.abs(bar[field] - f)),
      );
      out[runStart + j] = { f, e, flagged: e >= x };
    });
    runStart = i;
  }
  return out;
}

// ── The plan ────────────────────────────────────────────────────────────────

export type PlanSpan = 'archive' | 'ticks';

export interface PlannedUpdate {
  symbol: Root;
  tsMs: number;
  id: string;
  span: PlanSpan;
  /** The row as read, for the backup. */
  row: PgRow;
  /** The fields the rule picks. Every other field is left as the database has it. */
  changes: FieldChange[];
}

/** The value the update writes to `field`, or null when the rule leaves it alone. */
const pickedValue = (u: PlannedUpdate, field: Field): number | null =>
  u.changes.find((c) => c.field === field)?.to ?? null;

export type DeleteReason =
  | 'junk_window'
  | 'archive_no_rebuild'
  | 'tick_excursion'
  | 'thin_root';

export interface PlannedDelete {
  symbol: string;
  tsMs: number;
  id: string;
  reason: DeleteReason;
  /** A junk-window ES/NQ row that also has no rebuilt minute. */
  alsoNoRebuild: boolean;
  row: PgRow;
  f: number | null;
  excursion: number | null;
}

export interface TicklessReport extends TicklessWindow {
  pgRows: number;
  flagged: number;
}

export interface RepairPlan {
  updates: PlannedUpdate[];
  deletes: PlannedDelete[];
  tickless: TicklessReport[];
  /** Rebuilt minutes with no PG row. The tool inserts nothing for them. */
  rebuiltWithoutRow: Record<Root, Record<PlanSpan, number>>;
  /** Junk-window rows that also have a rebuilt minute; the delete wins. */
  junkWithRebuild: number;
}

export interface PlanInput {
  manifest: Manifest;
  rebuild: Rebuild;
  /** PG bars by symbol. */
  bars: Record<string, PgBar[]>;
  tickless: TicklessWindow[];
}

function spanOf(m: Manifest, tsMs: number): PlanSpan | null {
  if (inSpan(m.spans.archive, tsMs)) return 'archive';
  if (inSpan(m.spans.ticks, tsMs)) return 'ticks';
  return null;
}

const bySymbolTime = (
  a: { symbol: string; tsMs: number },
  b: { symbol: string; tsMs: number },
): number => a.symbol.localeCompare(b.symbol) || a.tsMs - b.tsMs;

/**
 * Decide, from the PG rows and the rebuild, which rows to update and delete.
 * Pure: nothing here reads or writes.
 */
export function buildPlan(input: PlanInput): RepairPlan {
  const { manifest: m, rebuild } = input;
  const updates: PlannedUpdate[] = [];
  const deletes: PlannedDelete[] = [];
  const tickless: TicklessReport[] = [];
  const rebuiltWithoutRow: RepairPlan['rebuiltWithoutRow'] = {
    ES: { archive: 0, ticks: 0 },
    NQ: { archive: 0, ticks: 0 },
  };
  let junkWithRebuild = 0;

  const junkDelete = (bar: PgBar, alsoNoRebuild: boolean): PlannedDelete => ({
    symbol: bar.symbol,
    tsMs: bar.tsMs,
    id: bar.id,
    reason: 'junk_window',
    alsoNoRebuild,
    row: bar.row,
    f: null,
    excursion: null,
  });

  for (const root of ROOTS) {
    const series = [...(input.bars[root] ?? [])].sort(
      (a, b) => a.tsMs - b.tsMs,
    );
    const ex = excursions(series, EXCURSION_X[root]);
    const rebuilt = rebuild[root];
    const params = m.roots[root];

    series.forEach((bar, i) => {
      const rb = rebuilt.get(bar.tsMs);
      if (inJunkWindow(bar.tsMs)) {
        if (rb != null) junkWithRebuild += 1;
        deletes.push(junkDelete(bar, rb == null));
        return;
      }
      const span = spanOf(m, bar.tsMs);
      if (span == null) return;
      if (rb == null) {
        const test = ex[i];
        if (span === 'archive') {
          deletes.push({
            symbol: root,
            tsMs: bar.tsMs,
            id: bar.id,
            reason: 'archive_no_rebuild',
            alsoNoRebuild: false,
            row: bar.row,
            f: null,
            excursion: null,
          });
        } else if (test?.flagged) {
          deletes.push({
            symbol: root,
            tsMs: bar.tsMs,
            id: bar.id,
            reason: 'tick_excursion',
            alsoNoRebuild: false,
            row: bar.row,
            f: test.f,
            excursion: test.e,
          });
        }
        return;
      }
      const changes =
        span === 'archive'
          ? archiveChanges(bar, rb)
          : tickChanges(bar, rb, params.carryHalf);
      if (changes.length === 0) return;
      updates.push({
        symbol: root,
        tsMs: bar.tsMs,
        id: bar.id,
        span,
        row: bar.row,
        changes,
      });
    });

    const have = new Set(series.map((b) => b.tsMs));
    for (const [tsMs, rb] of rebuilt) {
      if (!have.has(tsMs)) rebuiltWithoutRow[root][rb.source] += 1;
    }

    for (const window of input.tickless.filter((w) => w.symbol === root)) {
      let pgRows = 0;
      let flagged = 0;
      series.forEach((bar, i) => {
        if (bar.tsMs < window.firstMs || bar.tsMs > window.lastMs) return;
        pgRows += 1;
        if (ex[i]?.flagged) flagged += 1;
      });
      tickless.push({ ...window, pgRows, flagged });
    }
  }

  for (const symbol of JUNK_ONLY_ROOTS) {
    for (const bar of input.bars[symbol] ?? []) {
      if (inJunkWindow(bar.tsMs)) deletes.push(junkDelete(bar, false));
    }
  }

  updates.sort(bySymbolTime);
  deletes.sort(bySymbolTime);
  return { updates, deletes, tickless, rebuiltWithoutRow, junkWithRebuild };
}

// ── Days ────────────────────────────────────────────────────────────────────

export interface DayPlan {
  day: string;
  updates: PlannedUpdate[];
  deletes: PlannedDelete[];
}

/** One entry per UTC day that has a write, oldest first. */
export function groupByDay(
  plan: { updates?: PlannedUpdate[]; deletes: PlannedDelete[] },
  only: string[] = [],
): DayPlan[] {
  const days = new Map<string, DayPlan>();
  const dayOf = (tsMs: number): DayPlan | null => {
    const day = utcDay(tsMs);
    if (only.length > 0 && !only.includes(day)) return null;
    let entry = days.get(day);
    if (entry == null) {
      entry = { day, updates: [], deletes: [] };
      days.set(day, entry);
    }
    return entry;
  };
  for (const u of plan.updates ?? []) dayOf(u.tsMs)?.updates.push(u);
  for (const d of plan.deletes) dayOf(d.tsMs)?.deletes.push(d);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ── Thin roots (D1) ─────────────────────────────────────────────────────────

export interface FlaggedKeptBar {
  tsMs: number;
  /** The centred median of 11 closes the bar is measured against. */
  f: number;
  /** max |field - F| over the four prices. */
  e: number;
}

export interface ThinRootReport {
  root: ThinRoot;
  /** Rows in the window, kept or deleted. */
  windowRows: number;
  deletes: number;
  /** Rows kept because they sit on a clean trading day. */
  kept: number;
  /** Rows kept, by CT trading day. */
  keptByDay: Record<string, number>;
  firstDeleteMs: number | null;
  lastDeleteMs: number | null;
  /** Kept-day bars the Phase 1 strict test flags (b-forensics.md 3.1, X in THIN_EXCURSION_X). */
  flaggedKept: FlaggedKeptBar[];
}

export interface ThinRootsPlan {
  deletes: PlannedDelete[];
  roots: ThinRootReport[];
}

/**
 * The `--thin-roots` plan: every RTY, CL, GC and ZN bar in the window outside
 * the clean days. `bars` holds the PG bars by symbol; a symbol that is not one
 * of the four is ignored. The strict test runs over each root's whole series
 * (the median needs its neighbours) and is counted on the kept days only.
 * Pure: nothing here reads or writes.
 */
export function buildThinRootsPlan(
  bars: Record<string, PgBar[]>,
): ThinRootsPlan {
  const deletes: PlannedDelete[] = [];
  const roots: ThinRootReport[] = [];
  for (const root of THIN_ROOTS) {
    const series = [...(bars[root] ?? [])].sort((a, b) => a.tsMs - b.tsMs);
    const ex = excursions(series, THIN_EXCURSION_X[root]);
    const report: ThinRootReport = {
      root,
      windowRows: 0,
      deletes: 0,
      kept: 0,
      keptByDay: {},
      firstDeleteMs: null,
      lastDeleteMs: null,
      flaggedKept: [],
    };
    series.forEach((bar, i) => {
      if (!inThinWindow(root, bar.tsMs)) return;
      report.windowRows += 1;
      if (isThinDeleteBar(root, bar.tsMs)) {
        report.deletes += 1;
        report.firstDeleteMs ??= bar.tsMs;
        report.lastDeleteMs = bar.tsMs;
        deletes.push({
          symbol: root,
          tsMs: bar.tsMs,
          id: bar.id,
          reason: 'thin_root',
          alsoNoRebuild: false,
          row: bar.row,
          f: null,
          excursion: null,
        });
        return;
      }
      report.kept += 1;
      const day = ctTradingDay(bar.tsMs);
      report.keptByDay[day] = (report.keptByDay[day] ?? 0) + 1;
      const test = ex[i];
      if (test?.flagged) {
        report.flaggedKept.push({
          tsMs: bar.tsMs,
          f: test.f ?? 0,
          e: test.e ?? 0,
        });
      }
    });
    roots.push(report);
  }
  deletes.sort(bySymbolTime);
  return { deletes, roots };
}

/**
 * The plan narrowed to `days` (UTC days with a delete, from `groupByDay`): the
 * deletes and each root's delete count and first and last delete follow; the
 * window and kept counts stay, they describe the rows read.
 */
function restrictThinPlan(
  plan: ThinRootsPlan,
  days: readonly DayPlan[],
): ThinRootsPlan {
  const keep = new Set(days.map((d) => d.day));
  const deletes = plan.deletes.filter((d) => keep.has(utcDay(d.tsMs)));
  return {
    deletes,
    roots: plan.roots.map((r) => {
      const mine = deletes.filter((d) => d.symbol === r.root);
      return {
        ...r,
        deletes: mine.length,
        firstDeleteMs: mine[0]?.tsMs ?? null,
        lastDeleteMs: mine.at(-1)?.tsMs ?? null,
      };
    }),
  };
}

/** The command that applies this dry run's plan, to print under it. */
function thinApplyCommand(opts: RepairOptions, deletes: number): string {
  const parts = [
    'npx tsx scripts/repair-futures-contract-mix.ts',
    '--thin-roots',
    '--apply',
    `--expect-deletes ${deletes}`,
    `--work-dir ${opts.workDir}`,
  ];
  if (opts.dates.length > 0) parts.push(`--dates ${opts.dates.join(' ')}`);
  return parts.join(' ');
}

function dayCounts(deletes: PlannedDelete[]): string[] {
  const lines: string[] = [];
  for (const root of THIN_ROOTS) {
    const byDay = groupBy(
      deletes.filter((d) => d.symbol === root),
      (d) => utcDay(d.tsMs),
    );
    for (const [day, rows] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`  ${root} ${day} deleted ${rows.length}`);
    }
  }
  return lines;
}

/** The thin-roots dry-run summary. The row-by-row list is the csv, not this. */
export function formatThinRootsReport(
  plan: ThinRootsPlan,
  applyCommand: string,
): string {
  const out: string[] = [];
  const lastBad = THIN_ROOTS.map(
    (r) => `${r} ${isoMinute(THIN_LAST_BAD_MS[r])}`,
  ).join(', ');
  out.push(
    'Thin-roots delete (D1): RTY, CL, GC and ZN have no rebuild source, so their bars in the contract-mix window go.',
    `  window: ${isoMinute(THIN_WINDOW_START_MS)} through each root's last bad bar, inclusive (${lastBad})`,
    `  kept: the CT trading days ${CLEAN_TRADING_DAYS.join(', ')} (trading day = the CT date of ts + 7 h)`,
    '',
    'Per root:',
  );
  for (const r of plan.roots) {
    const first = r.firstDeleteMs == null ? 'none' : isoMinute(r.firstDeleteMs);
    const last = r.lastDeleteMs == null ? 'none' : isoMinute(r.lastDeleteMs);
    out.push(
      `  ${r.root.padEnd(3)}  window rows ${r.windowRows}  delete ${r.deletes}  keep ${r.kept} (clean days)`,
      `       first delete ${first}  last delete ${last}`,
      `       strict test on the kept days (X=${THIN_EXCURSION_X[r.root]}): ${r.flaggedKept.length} flagged of ${r.kept}`,
    );
    for (const f of r.flaggedKept.slice(0, FLAGGED_LIST_CAP)) {
      out.push(
        `         ${r.root} ${isoMinute(f.tsMs)} F=${num(f.f)} E=${num(f.e)}`,
      );
    }
    if (r.flaggedKept.length > FLAGGED_LIST_CAP) {
      out.push(
        `         ... and ${r.flaggedKept.length - FLAGGED_LIST_CAP} more`,
      );
    }
  }

  out.push('', 'Rows kept on each clean day:');
  for (const r of plan.roots) {
    for (const [day, n] of Object.entries(r.keptByDay).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      out.push(`  ${r.root} ${day} ${n}`);
    }
  }

  out.push('', 'Deleted per root and UTC day:', ...dayCounts(plan.deletes));

  const split = plan.roots.map((r) => `${r.root} ${r.deletes}`).join(', ');
  out.push(
    '',
    'Totals:',
    `  total deletes ${plan.deletes.length} (${split}); this mode never updates a row and never touches ES or NQ`,
    '  the full delete list, one line per row with every value, is delete-list.csv',
    '',
    'Apply, after the close and the owner OK of this dry run:',
    `  ${applyCommand}`,
  );
  return out.join('\n');
}

// ── Report ──────────────────────────────────────────────────────────────────

function countFields(updates: PlannedUpdate[]): Record<Field, number> {
  const counts: Record<Field, number> = {
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
  };
  for (const u of updates) for (const c of u.changes) counts[c.field] += 1;
  return counts;
}

const fieldCounts = (updates: PlannedUpdate[]): string =>
  Object.entries(countFields(updates))
    .map(([field, n]) => `${field}=${n}`)
    .join(' ');

function topDiffs(updates: PlannedUpdate[], n = 5): string {
  const diffs = updates.flatMap((u) =>
    u.changes
      .filter((c) => c.field !== 'volume')
      .map((c) => ({ u, c, size: Math.abs(c.to - c.from) })),
  );
  diffs.sort((a, b) => b.size - a.size);
  return diffs
    .slice(0, n)
    .map(
      ({ u, c }) =>
        `${c.field} ${isoMinute(u.tsMs).slice(11, 16)}Z ${num(c.from)} -> ${num(c.to)}`,
    )
    .join('; ');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

const deleteLine = (d: PlannedDelete): string => {
  const r = d.row;
  const test =
    d.reason === 'tick_excursion'
      ? ` F=${num(d.f ?? 0)} E=${num(d.excursion ?? 0)}`
      : '';
  return (
    `  ${d.symbol} ${isoMinute(d.tsMs)} id ${d.id} ${d.reason}` +
    `${d.alsoNoRebuild ? '+no_rebuild' : ''} O ${num(Number(r.open))} H ${num(Number(r.high))} ` +
    `L ${num(Number(r.low))} C ${num(Number(r.close))} V ${r.volume}${test}`
  );
};

/** The full delete list, one CSV line per row, with every value. */
export function deleteCsv(deletes: PlannedDelete[]): string {
  const header =
    'symbol,ts,reason,also_no_rebuild,id,open,high,low,close,volume,buy_volume,sell_volume,f,excursion';
  const lines = deletes.map((d) =>
    [
      d.symbol,
      isoMinute(d.tsMs),
      d.reason,
      d.alsoNoRebuild,
      d.id,
      d.row.open,
      d.row.high,
      d.row.low,
      d.row.close,
      d.row.volume,
      d.row.buy_volume ?? '',
      d.row.sell_volume ?? '',
      d.f ?? '',
      d.excursion ?? '',
    ].join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}

/** The dry-run summary: provenance, per root and day, totals and the lists. */
export function formatReport(plan: RepairPlan, m: Manifest): string {
  const out: string[] = [];
  out.push(
    `Phase 1 manifest: git ${m.gitHead} (python module edited since: ${m.moduleEdited ? 'YES' : 'no'}), finished ${m.finishedUtc}`,
  );
  for (const root of ROOTS) {
    const p = m.roots[root];
    const g = m.gate[root];
    out.push(
      `  ${root} front ${p.front} G=${num(p.gap)} carry=${num(p.carry)} carry_half=${num(p.carryHalf)}  ` +
        `ts_recv gate ${g.exactOhlc}/${g.minutes} exact OHLC, ${g.volumeWithin1pct}/${g.minutes} volume within 1%`,
    );
  }
  out.push(
    `  archive span ${isoMinute(m.spans.archive.startMs)} .. ${isoMinute(m.spans.archive.endMs)} (end exclusive)`,
    `  tick span    ${isoMinute(m.spans.ticks.startMs)} .. ${isoMinute(m.spans.ticks.endMs)} (end exclusive)`,
    `  junk window  ${isoMinute(JUNK_WINDOW.startMs)} .. ${isoMinute(JUNK_WINDOW.endMs)} (end exclusive), all six roots`,
    '',
    `Tick-less windows (PG rows and excursion flags inside each): ${plan.tickless.length}`,
  );
  for (const w of plan.tickless) {
    out.push(
      `  ${w.symbol} ${isoMinute(w.firstMs)} .. ${isoMinute(w.lastMs)} minutes ${w.minutes} open ${w.openMinutes}  pg_rows ${w.pgRows}  flagged ${w.flagged}`,
    );
  }

  out.push('', 'Per root and day:');
  const days = groupByDay(plan);
  for (const day of days) {
    for (const symbol of [...ROOTS, ...JUNK_ONLY_ROOTS]) {
      const ups = day.updates.filter((u) => u.symbol === symbol);
      const dels = day.deletes.filter((d) => d.symbol === symbol);
      if (ups.length === 0 && dels.length === 0) continue;
      out.push(
        `  ${symbol} ${day.day}  updated ${ups.length}  deleted ${dels.length}  fields ${fieldCounts(ups)}`,
      );
      if (ups.length > 0)
        out.push(`      largest price diffs: ${topDiffs(ups)}`);
    }
  }

  out.push('', 'Totals:');
  for (const root of ROOTS) {
    for (const span of ['archive', 'ticks'] as const) {
      const ups = plan.updates.filter(
        (u) => u.symbol === root && u.span === span,
      );
      out.push(
        `  ${root} ${span} span: updated ${ups.length} (${fieldCounts(ups)}), ` +
          `rebuilt minutes with no PG row ${plan.rebuiltWithoutRow[root][span]} (nothing inserted)`,
      );
    }
  }
  const reasons: DeleteReason[] = [
    'archive_no_rebuild',
    'tick_excursion',
    'junk_window',
  ];
  for (const symbol of [...ROOTS, ...JUNK_ONLY_ROOTS]) {
    const mine = plan.deletes.filter((d) => d.symbol === symbol);
    const parts = reasons.map(
      (r) => `${r}=${mine.filter((d) => d.reason === r).length}`,
    );
    out.push(`  ${symbol} deletes ${mine.length}: ${parts.join(' ')}`);
  }
  out.push(
    `  total updates ${plan.updates.length}, total deletes ${plan.deletes.length} ` +
      `(each row counted once; ${plan.junkWithRebuild} junk-window row(s) also had a rebuilt minute, delete wins)`,
  );

  const lowMoves = plan.updates.filter((u) =>
    u.changes.some(
      (c) =>
        c.field === 'low' && Math.abs(c.to - c.from) > m.roots[u.symbol].gap,
    ),
  );
  out.push(
    '',
    `Low moves greater than G (ES ${num(m.roots.ES.gap)}, NQ ${num(m.roots.NQ.gap)}): ${lowMoves.length}`,
  );
  for (const u of lowMoves) {
    const c = u.changes.find((x) => x.field === 'low');
    out.push(
      `  ${u.symbol} ${isoMinute(u.tsMs)} low ${num(c?.from ?? 0)} -> ${num(c?.to ?? 0)}`,
    );
  }
  for (const root of ROOTS) {
    const moves = plan.updates.filter(
      (u) =>
        u.symbol === root &&
        u.changes.some(
          (c) =>
            c.field === 'close' && Math.abs(c.to - c.from) > m.roots[root].gap,
        ),
    );
    const bySession = groupBy(moves, (u) => classifySession(u.tsMs));
    out.push(
      `${root} close moves greater than G=${num(m.roots[root].gap)}: ` +
        `rth ${bySession.get('rth')?.length ?? 0}, overnight ${bySession.get('overnight')?.length ?? 0}`,
    );
  }

  out.push('', `Delete list (${plan.deletes.length} rows):`);
  for (const d of plan.deletes) out.push(deleteLine(d));
  return out.join('\n');
}

// ── Database reads ──────────────────────────────────────────────────────────

/** Rows of `symbol` with `fromMs <= ts < toMs`, read in a read-only transaction. */
async function readRows(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<PgRow[]> {
  const sql = getDb();
  const [rows] = await withDbRetry(() =>
    sql.transaction(
      [
        sql`
          SELECT id::text AS id, symbol,
                 to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
                 open::text AS open, high::text AS high, low::text AS low,
                 close::text AS close, volume::text AS volume,
                 buy_volume::text AS buy_volume, sell_volume::text AS sell_volume,
                 buy_prints::text AS buy_prints, sell_prints::text AS sell_prints,
                 contract::text AS contract
            FROM futures_bars
           WHERE symbol = ${symbol}
             AND ts >= ${isoMinute(fromMs)}::timestamptz
             AND ts < ${isoMinute(toMs)}::timestamptz
           ORDER BY ts`,
      ],
      { readOnly: true },
    ),
  );
  return (rows ?? []) as unknown as PgRow[];
}

/** Paged by UTC days so no response grows with the range. */
async function readPaged(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<PgRow[]> {
  const out: PgRow[] = [];
  for (let at = fromMs; at < toMs; at += READ_PAGE_DAYS * DAY_MS) {
    out.push(
      ...(await readRows(
        symbol,
        at,
        Math.min(toMs, at + READ_PAGE_DAYS * DAY_MS),
      )),
    );
  }
  return out;
}

interface PgSnapshot {
  rows: Record<string, PgRow[]>;
  cover: Record<string, { fromMs: number; toMs: number }>;
}

/** Everything the plan needs: ES/NQ over both spans, the junk window for the rest. */
async function readSnapshot(m: Manifest): Promise<PgSnapshot> {
  const snapshot: PgSnapshot = { rows: {}, cover: {} };
  const wide = {
    fromMs: m.spans.archive.startMs,
    toMs: m.spans.ticks.endMs + READ_CONTEXT_MINUTES * MINUTE_MS,
  };
  for (const root of ROOTS) {
    snapshot.cover[root] = wide;
    snapshot.rows[root] = await readPaged(root, wide.fromMs, wide.toMs);
    console.log(`read ${root}: ${snapshot.rows[root]?.length ?? 0} rows`);
  }
  for (const symbol of JUNK_ONLY_ROOTS) {
    const cover = { fromMs: JUNK_WINDOW.startMs, toMs: JUNK_WINDOW.endMs };
    snapshot.cover[symbol] = cover;
    snapshot.rows[symbol] = await readRows(symbol, cover.fromMs, cover.toMs);
  }
  return snapshot;
}

/** The four thin roots over the window, each to its last bad bar. */
async function readThinSnapshot(): Promise<PgSnapshot> {
  const snapshot: PgSnapshot = { rows: {}, cover: {} };
  for (const root of THIN_ROOTS) {
    const cover = {
      fromMs: THIN_WINDOW_START_MS,
      toMs: THIN_LAST_BAD_MS[root] + MINUTE_MS,
    };
    snapshot.cover[root] = cover;
    snapshot.rows[root] = await readPaged(root, cover.fromMs, cover.toMs);
    console.log(`read ${root}: ${snapshot.rows[root]?.length ?? 0} rows`);
  }
  return snapshot;
}

// ── Database writes ─────────────────────────────────────────────────────────

type Sql = ReturnType<typeof getDb>;

/**
 * Writes only the fields the rule picked: every other field arrives as NULL
 * and COALESCE keeps the database's own value, so a change made to a kept
 * field after the plan was read survives (and fails the verify, instead of
 * being put back). The guard compares the same picked values, so a row that
 * already holds them is not rewritten. A bar whose contract (#204) is no longer
 * the one the plan read is left alone too, and the verify fails the day.
 */
function updateStatement(sql: Sql, rows: PlannedUpdate[]) {
  return sql`
    UPDATE futures_bars f
       SET open = COALESCE(r.open, f.open), high = COALESCE(r.high, f.high),
           low = COALESCE(r.low, f.low), close = COALESCE(r.close, f.close),
           volume = COALESCE(r.volume, f.volume)
      FROM unnest(${rows.map((u) => u.symbol)}::text[],
                  ${rows.map((u) => isoMinute(u.tsMs))}::timestamptz[],
                  ${rows.map((u) => pickedValue(u, 'open'))}::numeric[],
                  ${rows.map((u) => pickedValue(u, 'high'))}::numeric[],
                  ${rows.map((u) => pickedValue(u, 'low'))}::numeric[],
                  ${rows.map((u) => pickedValue(u, 'close'))}::numeric[],
                  ${rows.map((u) => pickedValue(u, 'volume'))}::bigint[],
                  ${rows.map((u) => u.row.contract)}::text[])
           AS r(symbol, ts, open, high, low, close, volume, contract)
     WHERE f.symbol = r.symbol AND f.ts = r.ts
       AND f.contract IS NOT DISTINCT FROM r.contract
       AND (f.open, f.high, f.low, f.close, f.volume)
           IS DISTINCT FROM (COALESCE(r.open, f.open), COALESCE(r.high, f.high),
                             COALESCE(r.low, f.low), COALESCE(r.close, f.close),
                             COALESCE(r.volume, f.volume))
    RETURNING f.id`;
}

/**
 * Deletes a row only while its current values still equal the backed-up ones,
 * the contract (#204) included: a bar a writer has since tied to a dated contract
 * is not the row that was backed up.
 */
function deleteStatement(sql: Sql, rows: PlannedDelete[]) {
  return sql`
    DELETE FROM futures_bars f
     USING unnest(${rows.map((d) => d.id)}::bigint[],
                  ${rows.map((d) => d.symbol)}::text[],
                  ${rows.map((d) => d.row.ts)}::timestamptz[],
                  ${rows.map((d) => d.row.open)}::numeric[],
                  ${rows.map((d) => d.row.high)}::numeric[],
                  ${rows.map((d) => d.row.low)}::numeric[],
                  ${rows.map((d) => d.row.close)}::numeric[],
                  ${rows.map((d) => d.row.volume)}::bigint[],
                  ${rows.map((d) => d.row.contract)}::text[])
           AS r(id, symbol, ts, open, high, low, close, volume, contract)
     WHERE f.id = r.id AND f.symbol = r.symbol AND f.ts = r.ts
       AND f.open = r.open AND f.high = r.high AND f.low = r.low
       AND f.close = r.close AND f.volume = r.volume
       AND f.contract IS NOT DISTINCT FROM r.contract
    RETURNING f.id`;
}

function chunks<T>(items: T[], size = WRITE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * One UTC day in one transaction. The UPDATEs and DELETEs commit or roll back
 * together at the SQL level, but the DELETE's value check is NOT atomic with
 * the day's plan: a row that changed since the backup is skipped without an
 * error, so the day's updates commit while that delete does not. The check
 * stays outside the transaction on purpose: `withDbRetry` replays the
 * transaction when a commit's response is lost, and the replay deletes 0 rows,
 * so an in-transaction count check would fail a day that fully succeeded.
 * `verifyDay` catches the skipped delete after the commit, fails the day
 * (unmarked, exit 1), and a rerun re-plans from the new state and converges.
 */
async function writeDay(
  day: DayPlan,
): Promise<{ updated: number; deleted: number }> {
  const sql = getDb();
  const updateChunks = chunks(day.updates);
  const results = await withDbRetry(() =>
    sql.transaction([
      ...updateChunks.map((c) => updateStatement(sql, c)),
      ...chunks(day.deletes).map((c) => deleteStatement(sql, c)),
    ]),
  );
  const sizes = results.map((r) => r.length);
  return {
    updated: sizes.slice(0, updateChunks.length).reduce((a, b) => a + b, 0),
    deleted: sizes.slice(updateChunks.length).reduce((a, b) => a + b, 0),
  };
}

// ── Backup, marker, verify ──────────────────────────────────────────────────

interface BackupEntry {
  op: 'update' | 'delete';
  reason: string;
  row: PgRow;
}

/** One JSONL line per row about to change; the line count is checked back. */
function writeBackup(workDir: string, days: DayPlan[]): string {
  const entries: BackupEntry[] = days.flatMap((d) => [
    ...d.updates.map(
      (u): BackupEntry => ({
        op: 'update',
        reason: `${u.span}_span`,
        row: u.row,
      }),
    ),
    ...d.deletes.map(
      (x): BackupEntry => ({ op: 'delete', reason: x.reason, row: x.row }),
    ),
  ]);
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

/**
 * The one backup a `--thin-roots` apply keeps across runs. A run that stops
 * (a failed day, the open) is finished by another, so a file per run would
 * split the deleted rows between files and 5b takes a single `--backup`.
 */
export const THIN_BACKUP_FILE = 'backup-thin-roots.jsonl';

const thinBackupLineSchema = z.object({
  op: z.literal('delete'),
  reason: z.string(),
  row: z.record(z.string(), z.string().nullable()),
});

/** The first column in which a backed-up row and a database row differ, or null. */
function firstDifference(
  was: Record<string, string | null>,
  now: PgRow,
): keyof PgRow | null {
  for (const column of Object.keys(now) as (keyof PgRow)[]) {
    if ((was[column] ?? null) !== now[column]) return column;
  }
  return null;
}

/**
 * Adds a line to `backup-thin-roots.jsonl` for each row of the pending days
 * whose id the file does not hold yet, before the first write, so after any
 * run of failed and resumed applies the file holds each deleted row once. A
 * row whose id is in the file with other values refuses the run (nothing is
 * written), and the line count is checked back. The file is replaced whole (a
 * temporary file, then a rename), so an interrupted run leaves the old file or
 * the new one, never a cut line.
 */
function appendThinBackup(
  workDir: string,
  days: readonly DayPlan[],
): { path: string; added: number; total: number } {
  const path = join(workDir, THIN_BACKUP_FILE);
  const had = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const held = had.split('\n').filter((l) => l !== '');
  const known = new Map<string, Record<string, string | null>>();
  held.forEach((raw, i) => {
    const where = `${path}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const parsed = thinBackupLineSchema.safeParse(json);
    const id = parsed.success ? parsed.data.row.id : undefined;
    if (!parsed.success || id == null) {
      throw new Error(
        `${where}: not a backup entry (${parsed.success ? 'no row id' : issueText(parsed.error)})`,
      );
    }
    if (known.has(id)) throw new Error(`${where}: id ${id} appears twice`);
    known.set(id, parsed.data.row);
  });

  const fresh: string[] = [];
  const queued = new Set<string>();
  for (const d of days.flatMap((x) => x.deletes)) {
    const was = known.get(d.id);
    if (was != null) {
      const column = firstDifference(was, d.row);
      if (column != null) {
        throw new Error(
          `Refusing to --apply: ${path} already holds id ${d.id} (${d.symbol} ${isoMinute(d.tsMs)}) with a different ${column}: ` +
            `file "${was[column] ?? 'null'}", database "${d.row[column] ?? 'null'}". Nothing was written.`,
        );
      }
      continue;
    }
    if (queued.has(d.id)) continue;
    queued.add(d.id);
    fresh.push(JSON.stringify({ op: 'delete', reason: d.reason, row: d.row }));
  }
  if (fresh.length > 0) {
    const tmp = `${path}.tmp`;
    const lead = had === '' || had.endsWith('\n') ? '' : '\n';
    const added = fresh.map((l) => `${l}\n`).join('');
    writeFileSync(tmp, `${had}${lead}${added}`);
    renameSync(tmp, path);
    const written = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l !== '').length;
    if (written !== held.length + fresh.length) {
      throw new Error(
        `backup ${path} has ${written} lines, expected ${held.length + fresh.length}`,
      );
    }
  }
  return { path, added: fresh.length, total: held.length + fresh.length };
}

export const markerPath = (workDir: string, day: string): string =>
  join(workDir, `${day}.applied`);

/**
 * SHA-256 over the day's ES and NQ NDJSON as `loadRebuild` read them (name and
 * text; a missing file counts as absent). Taken from memory, not from disk, so
 * the digest names the bars the plan used.
 */
export function dayDigest(
  texts: ReadonlyMap<string, string>,
  day: string,
): string {
  const hash = createHash('sha256');
  for (const root of ROOTS) {
    const name = `${root}-${day}.ndjson`;
    const text = texts.get(name);
    hash.update(text == null ? `${name} absent\n` : `${name}\n${text}\n`);
  }
  return hash.digest('hex');
}

/**
 * A done marker is tied to the Phase 1 run (its git SHA) and to that day's
 * rebuilt bars (the digest), so re-running Phase 1 with a changed value never
 * leaves a stale marker skipping a day that now has a different plan.
 */
const markerSchema = z.object({
  gitHead: z.string(),
  ndjsonSha256: z.string(),
  appliedAt: z.string(),
});

export interface MarkerStamp {
  gitHead: string;
  ndjsonSha256: string;
}

export type MarkerState =
  | { state: 'none' }
  | { state: 'done' }
  | { state: 'stale'; reason: string };

/**
 * 'done' only when the marker was written for this Phase 1 run and these bars.
 * `bars` names what the digest covers in the "different ..." message.
 */
export function markerState(
  workDir: string,
  day: string,
  expected: MarkerStamp,
  bars: string,
): MarkerState {
  const path = markerPath(workDir, day);
  if (!existsSync(path)) return { state: 'none' };
  let parsed: ReturnType<typeof markerSchema.safeParse>;
  try {
    parsed = markerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { state: 'stale', reason: 'is unreadable' };
  }
  if (!parsed.success) return { state: 'stale', reason: 'is unreadable' };
  if (parsed.data.gitHead !== expected.gitHead) {
    return {
      state: 'stale',
      reason: `is from Phase 1 git ${parsed.data.gitHead.slice(0, 8)}, not ${expected.gitHead.slice(0, 8)}`,
    };
  }
  if (parsed.data.ndjsonSha256 !== expected.ndjsonSha256) {
    return { state: 'stale', reason: `was written for different ${bars}` };
  }
  return { state: 'done' };
}

/**
 * The row as one text: the day digest and the verify compare it. The contract is
 * part of it only when the bar has one, so a row with none (every bar of the
 * span) keeps the text it had before #204 was read, and a done marker written
 * then still names the same rows.
 */
const canon = (r: PgRow): string =>
  [
    r.id,
    r.ts,
    ...PRICE_FIELDS.map((f) => toTicks(Number(r[f]))),
    Number(r.volume),
    r.buy_volume,
    r.sell_volume,
    r.buy_prints,
    r.sell_prints,
    ...(r.contract == null ? [] : [r.contract]),
  ].join('|');

/**
 * SHA-256 over a `--thin-roots` day's planned deletes (symbol and the full row,
 * in any order). It stands where `dayDigest` does for the Phase 1 bars: a
 * marker written for other rows than the fresh plan's is re-planned.
 */
export function thinDayDigest(deletes: readonly PlannedDelete[]): string {
  const hash = createHash('sha256');
  const lines = deletes.map((d) => `${d.symbol}|${canon(d.row)}\n`).sort();
  for (const line of lines) hash.update(line);
  return hash.digest('hex');
}

/**
 * Re-read the day and require the rows to equal the pre-write rows with the
 * plan applied: the picked fields of an updated row at their new values, deleted
 * rows gone, every other field, row and column untouched. A change made to a
 * kept field after the plan was read therefore fails the day. Prints before and
 * after counts.
 */
async function verifyDay(day: DayPlan, snap: PgSnapshot): Promise<void> {
  const dayStart = Date.parse(`${day.day}T00:00:00Z`);
  const symbols = [
    ...new Set([...day.updates, ...day.deletes].map((x) => x.symbol)),
  ];
  const gone = new Set(day.deletes.map((d) => d.id));
  const picked = new Map(day.updates.map((u) => [u.id, u.changes]));
  for (const symbol of symbols.sort()) {
    const cover = snap.cover[symbol];
    if (cover == null)
      throw new Error(`no read coverage recorded for ${symbol}`);
    const fromMs = Math.max(dayStart, cover.fromMs);
    const toMs = Math.min(dayStart + DAY_MS, cover.toMs);
    const before = (snap.rows[symbol] ?? []).filter((r) => {
      const t = Date.parse(r.ts);
      return t >= fromMs && t < toMs;
    });
    const expected = before
      .filter((r) => !gone.has(r.id))
      .map((r) => {
        const row = { ...r };
        for (const c of picked.get(r.id) ?? []) row[c.field] = String(c.to);
        return row;
      });
    const actual = await readRows(symbol, fromMs, toMs);
    console.log(
      `  ${symbol} ${day.day} rows before ${before.length} after ${actual.length}`,
    );
    const want = new Set(expected.map(canon));
    const have = new Set(actual.map(canon));
    const missing = expected.filter((r) => !have.has(canon(r)));
    const extra = actual.filter((r) => !want.has(canon(r)));
    if (
      missing.length > 0 ||
      extra.length > 0 ||
      actual.length !== expected.length
    ) {
      const sample = [
        ...missing.map((r) => `expected ${canon(r)}`),
        ...extra.map((r) => `found ${canon(r)}`),
      ]
        .slice(0, 5)
        .join('; ');
      throw new Error(
        `verify failed for ${symbol} ${day.day}: ${missing.length} expected row(s) missing, ` +
          `${extra.length} unexpected (a delete skipped by its value check shows as unexpected): ${sample}`,
      );
    }
  }
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface RepairOptions {
  /** Phase 1 output folder: manifest.json, ndjson/, tickless_windows.csv. Unused with `thinRoots`. */
  dir: string;
  /** Report, delete list, backups and done markers. */
  workDir: string;
  apply: boolean;
  force: boolean;
  /**
   * Phase 5a: delete the RTY, CL, GC and ZN bars in the window (futures-thin-roots.ts),
   * with no Phase 1 input. Never updates a row, so `expectUpdates` stays null.
   */
  thinRoots: boolean;
  /** Only these UTC days; empty means all. */
  dates: string[];
  /**
   * The totals of the dry run the owner approved. `--apply` refuses, before it
   * writes anything, when the fresh plan's rows to update or delete differ.
   * Null on a dry run.
   */
  expectUpdates: number | null;
  expectDeletes: number | null;
}

export interface RepairArgs extends RepairOptions {
  envFile: string | null;
}

const isRealDate = (text: string): boolean => {
  const parsed = new Date(`${text}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
  );
};

function parseCount(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} needs a whole number, got "${value}"`);
  }
  return Number.parseInt(value, 10);
}

/** `--thin-roots` keeps its backups and markers apart from Phase 2's. */
const THIN_WORK_DIR = 'docs/tmp/futures-contract-repair/thin-roots';

/** The rules that differ in `--thin-roots` mode; the shared ones ran before. */
function checkThinRootsArgs(
  args: RepairArgs,
  given: { dir: boolean; workDir: boolean },
): void {
  if (given.dir) {
    throw new Error(
      '--dir does not apply with --thin-roots: it reads no Phase 1 output',
    );
  }
  if (args.expectUpdates != null) {
    throw new Error(
      '--expect-updates does not apply with --thin-roots: the mode never updates a row',
    );
  }
  if (args.apply && args.expectDeletes == null) {
    throw new Error(
      '--apply --thin-roots needs --expect-deletes N: the total of the dry run you approved',
    );
  }
  if (!args.apply && args.expectDeletes != null) {
    throw new Error('--expect-deletes only applies with --apply');
  }
  if (!given.workDir) args.workDir = THIN_WORK_DIR;
}

export function parseRepairArgs(argv: string[]): RepairArgs {
  const args: RepairArgs = {
    dir: 'ml/data/futures-contract-repair',
    workDir: 'docs/tmp/futures-contract-repair',
    apply: false,
    force: false,
    thinRoots: false,
    dates: [],
    expectUpdates: null,
    expectDeletes: null,
    envFile: null,
  };
  const given = { dir: false, workDir: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value == null || value.startsWith('--'))
        throw new Error(`${flag} needs a value`);
      return value;
    };
    if (flag === '--dates') {
      const values: string[] = [];
      while (argv[i + 1] != null && !argv[i + 1]?.startsWith('--')) {
        i += 1;
        values.push(argv[i] ?? '');
      }
      if (values.length === 0) throw new Error('--dates needs a value');
      const bad = values.find((v) => !isRealDate(v));
      if (bad != null) throw new Error(`${bad} is not a YYYY-MM-DD date`);
      args.dates = values;
    } else if (flag === '--expect-updates')
      args.expectUpdates = parseCount(flag, next());
    else if (flag === '--expect-deletes')
      args.expectDeletes = parseCount(flag, next());
    else if (flag === '--dir') {
      args.dir = next();
      given.dir = true;
    } else if (flag === '--work-dir') {
      args.workDir = next();
      given.workDir = true;
    } else if (flag === '--env-file') args.envFile = next();
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--thin-roots') args.thinRoots = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.force && !args.apply)
    throw new Error('--force only applies with --apply');
  if (args.thinRoots) {
    checkThinRootsArgs(args, given);
    return args;
  }
  const expects = [args.expectUpdates, args.expectDeletes];
  if (args.apply && expects.some((n) => n == null)) {
    throw new Error(
      '--apply needs --expect-updates N and --expect-deletes M: the totals of the dry run you approved',
    );
  }
  if (!args.apply && expects.some((n) => n != null)) {
    throw new Error(
      '--expect-updates and --expect-deletes only apply with --apply',
    );
  }
  return args;
}

// ── Run ─────────────────────────────────────────────────────────────────────

/**
 * An apply has written, or was about to write, in the work dir: a day is marked
 * done, or the backup it takes before its first write is there (`backup-<time>.jsonl`,
 * or `backup-thin-roots.jsonl`). An apply that fails on its first day marks no day
 * done and leaves only the backup. One that is refused first (the totals, the open)
 * leaves neither, and a dry run after it may replace the report.
 */
const hasApplyFiles = (workDir: string): boolean =>
  readdirSync(workDir).some(
    (f) =>
      f.endsWith('.applied') ||
      (f.startsWith('backup-') && f.endsWith('.jsonl')),
  );

/**
 * Writes the report and the delete list. The dry run's two files are what the
 * owner approves, so an `--apply` leaves them alone and writes its own copies
 * under names that carry its time: a refused or partial apply plans only the
 * days left and would otherwise overwrite the approved list. So does a dry run
 * once an apply has written here (see `hasApplyFiles`): it plans only what is
 * left (an empty list after a full apply), and would otherwise replace the files
 * the apply was approved from.
 */
function writeReportFiles(
  opts: RepairOptions,
  report: string,
  deletes: PlannedDelete[],
): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let prefix = '';
  if (opts.apply) prefix = `apply-${stamp}-`;
  else if (hasApplyFiles(opts.workDir)) prefix = `dryrun-${stamp}-`;
  const reportPath = join(opts.workDir, `${prefix}report.txt`);
  const listPath = join(opts.workDir, `${prefix}delete-list.csv`);
  writeFileSync(reportPath, `${report}\n`);
  writeFileSync(listPath, deleteCsv(deletes));
  console.log(`\nreport: ${reportPath}`);
  console.log(`delete list: ${listPath}`);
}

/**
 * `--thin-roots`: read the four roots over the window, plan the deletes, print
 * the summary and write report.txt and delete-list.csv. With `--apply`, check
 * the total against `--expect-deletes` before any write, then apply by UTC day.
 */
async function runThinRoots(opts: RepairOptions): Promise<number> {
  console.log(
    `Futures thin-roots delete (D1)${opts.apply ? '' : ' (DRY RUN: read-only, no writes)'}`,
  );
  const snap = await readThinSnapshot();
  const bars: Record<string, PgBar[]> = {};
  for (const [symbol, rows] of Object.entries(snap.rows))
    bars[symbol] = rows.map(toBar);
  const full = buildThinRootsPlan(bars);
  const days = groupByDay(full, opts.dates);
  const plan = restrictThinPlan(full, days);

  mkdirSync(opts.workDir, { recursive: true });
  const report = formatThinRootsReport(
    plan,
    thinApplyCommand(opts, plan.deletes.length),
  );
  console.log(`\n${report}`);
  writeReportFiles(opts, report, plan.deletes);
  if (!opts.apply) return 0;

  if (plan.deletes.length !== opts.expectDeletes) {
    throw new Error(
      `Refusing to --apply: the fresh plan has ${plan.deletes.length} deletes, ` +
        `but --expect-deletes ${opts.expectDeletes ?? 'missing'} was given. ` +
        'Nothing was written. Review a fresh dry run (after a partial --apply it reports only the days left) and pass its total. ' +
        `The backup for 5b is the one file ${join(opts.workDir, THIN_BACKUP_FILE)}, kept across runs.`,
    );
  }
  const planned = days.map((day) => ({
    day,
    stamp: {
      gitHead: THIN_ROOTS_STAMP,
      ndjsonSha256: thinDayDigest(day.deletes),
    } satisfies MarkerStamp,
  }));
  return applyPlanned(opts, planned, snap, 'planned deletes');
}

/** Exit codes: 0 done, 1 failed or refused, 2 stopped between days (market hours began). */
async function run(opts: RepairOptions): Promise<number> {
  if (opts.apply && isMarketHours()) {
    throw new Error(
      'Refusing to --apply during market hours (09:25 to 16:05 ET): run after the close.',
    );
  }
  if (opts.thinRoots) return runThinRoots(opts);
  const m = loadManifest(opts.dir);
  const unsplittable = Math.max(m.unsplittable, unsplittableCount(opts.dir));
  if (unsplittable > 0) {
    const message = `${unsplittable} unsplittable minute(s) listed by Phase 1`;
    if (opts.apply) throw new Error(`Refusing to --apply: ${message}`);
    console.log(`WARNING: ${message}; --apply would refuse.`);
  }
  const { rebuild, texts } = loadRebuild(opts.dir, m);
  const tickless = loadTicklessWindows(opts.dir);
  console.log(
    `Futures contract-mix repair${opts.apply ? '' : ' (DRY RUN: read-only, no writes)'}`,
  );

  const snap = await readSnapshot(m);
  const bars: Record<string, PgBar[]> = {};
  for (const [symbol, rows] of Object.entries(snap.rows))
    bars[symbol] = rows.map(toBar);
  const full = buildPlan({ manifest: m, rebuild, bars, tickless });
  const days = groupByDay(full, opts.dates);
  const kept = new Set(days.map((d) => d.day));
  const plan: RepairPlan = {
    ...full,
    updates: full.updates.filter((u) => kept.has(utcDay(u.tsMs))),
    deletes: full.deletes.filter((d) => kept.has(utcDay(d.tsMs))),
  };

  mkdirSync(opts.workDir, { recursive: true });
  const report = formatReport(plan, m);
  console.log(`\n${report}`);
  writeReportFiles(opts, report, plan.deletes);
  if (!opts.apply) return 0;

  // The plan must be the one the owner approved. Checked on the whole fresh
  // plan, before any marker, backup or write.
  if (
    plan.updates.length !== opts.expectUpdates ||
    plan.deletes.length !== opts.expectDeletes
  ) {
    throw new Error(
      `Refusing to --apply: the fresh plan has ${plan.updates.length} updates and ${plan.deletes.length} deletes, ` +
        `but --expect-updates ${opts.expectUpdates ?? 'missing'} and --expect-deletes ${opts.expectDeletes ?? 'missing'} were given. ` +
        'Nothing was written. Review a fresh dry run (after a partial --apply it reports only the days left) and pass its totals.',
    );
  }

  // One stamp per day, from the bytes the plan was built on, carried to the
  // marker write: a file rewritten on disk during a long apply cannot change
  // what the marker says was applied.
  const planned = days.map((day) => ({
    day,
    stamp: {
      gitHead: m.gitHead,
      ndjsonSha256: dayDigest(texts, day.day),
    } satisfies MarkerStamp,
  }));
  return applyPlanned(opts, planned, snap, 'rebuilt bars');
}

interface StampedDay {
  day: DayPlan;
  stamp: MarkerStamp;
}

/**
 * Backs up, writes and verifies the days that have no done marker, one UTC day
 * per transaction. The same loop applies the Phase 2 plan and `--thin-roots`;
 * `bars` names what a stale marker's digest covered. Exit codes as `run`.
 */
async function applyPlanned(
  opts: RepairOptions,
  planned: StampedDay[],
  snap: PgSnapshot,
  bars: string,
): Promise<number> {
  const pending: StampedDay[] = [];
  for (const entry of planned) {
    const { day } = entry;
    const state = opts.force
      ? ({ state: 'none' } as const)
      : markerState(opts.workDir, day.day, entry.stamp, bars);
    if (state.state === 'done') {
      // A done day that still has changes has drifted since it was applied.
      // The totals above count it; it is skipped, so say so.
      console.log(
        `WARNING: ${day.day} is marked done but the fresh plan still has ${day.updates.length} update(s) and ${day.deletes.length} delete(s) for it. ` +
          'It is skipped, and the --expect totals count them. Use --force to redo it.',
      );
      continue;
    }
    if (state.state === 'stale') {
      console.log(`marker for ${day.day} ${state.reason}; re-planning`);
    }
    pending.push(entry);
  }
  console.log(
    `\n${planned.length - pending.length} day(s) already applied (done marker), ${pending.length} to apply`,
  );
  if (pending.length === 0) return 0;

  const pendingDays = pending.map((p) => p.day);
  const next = opts.thinRoots
    ? 'run a fresh dry run and --apply --thin-roots with its total (--expect-deletes N).'
    : 'run a fresh dry run and --apply with its totals.';
  // `--thin-roots` keeps one backup across runs. It lists the pending rows before
  // their deletes, so it is complete only once a run prints "done.".
  const backupNote = opts.thinRoots
    ? ` The backup is the one file ${join(opts.workDir, THIN_BACKUP_FILE)}; it is complete only after a run prints "done.".`
    : '';
  // Said before a day is written when the open has come; true stops the apply.
  const stoppedAtOpen = (index: number): boolean => {
    if (!isMarketHours()) return false;
    const left = pending.slice(index).map((p) => p.day);
    console.error(
      `apply stopped before day ${left[0]?.day}: market hours began (09:25 ET). ` +
        `${index} day(s) done and marked; ${left.length} left ` +
        `(${left.reduce((n, d) => n + d.updates.length, 0)} updates, ${left.reduce((n, d) => n + d.deletes.length, 0)} deletes). ` +
        `After the close, ${next}${backupNote}`,
    );
    return true;
  };

  // The first day's check comes before the backup, so a run the open refuses
  // appends nothing to it.
  if (stoppedAtOpen(0)) return 2;

  // Phase 2 writes a backup per run; `--thin-roots` keeps one cumulative file
  // that 5b takes as --backup, so a resumed apply never splits the deleted rows.
  let backup: string;
  if (opts.thinRoots) {
    const kept = appendThinBackup(opts.workDir, pendingDays);
    backup = kept.path;
    console.log(
      `backup: ${backup} (+${kept.added} rows, ${kept.total} in the file)`,
    );
  } else {
    backup = writeBackup(opts.workDir, pendingDays);
    console.log(`backup: ${backup}`);
  }
  for (const [index, { day, stamp }] of pending.entries()) {
    // A full apply can outlast the close, so the guard is checked before every
    // day, not only at the start. Finished days are already marked.
    if (stoppedAtOpen(index)) return 2;
    try {
      const { updated, deleted } = await writeDay(day);
      console.log(`${day.day} updated ${updated} deleted ${deleted}`);
      await verifyDay(day, snap);
    } catch (err) {
      throw new Error(
        `apply failed: day ${day.day}: ${err instanceof Error ? err.message : String(err)}${backupNote}`,
        { cause: err },
      );
    }
    writeFileSync(
      markerPath(opts.workDir, day.day),
      `${JSON.stringify({ ...stamp, appliedAt: new Date().toISOString() })}\n`,
    );
  }
  if (opts.thinRoots) console.log(`done. Backup for 5b --backup: ${backup}`);
  return 0;
}

/** Runs the repair and returns the process exit code: 0 done, 1 failed or refused, 2 stopped between days at the open. */
export async function runRepair(opts: RepairOptions): Promise<number> {
  try {
    return await run(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
