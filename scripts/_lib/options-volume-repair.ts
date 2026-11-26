/**
 * The repair of the options-volume features stored in `training_features`
 * (spec: docs/superpowers/specs/2026-11-26-options-volume-prev-day-design.md,
 * phase 2). Logic for scripts/repair-options-volume.ts; it lives here so vitest
 * covers it (scripts/_lib/**).
 *
 * Why. Until 20b25329d (2026-11-25), every build of a past date stored UW's
 * newest `/stock/SPX/options-volume` row, because the endpoint has no `date`
 * parameter: 112 of 159 dates with values hold another day's numbers. And the
 * `prev_day_opt_*` columns (migration #213) are empty for every date built
 * before phase 1b. This sets both groups, 15 columns each, from a saved reply.
 *
 * The one input is `--source <file>`: a saved UW reply (`{ data: [...] }`, one
 * row a day, each with its own `date`). The tool never calls UW and never reads
 * UW_API_KEY. A file that is not such a reply is refused before the database is
 * touched: `data` an array of objects, each with a real `date` and a number in
 * every field the features read, no date twice. A plan records the file's
 * sha256, and an apply refuses a source with another one.
 *
 * What it plans, for each `training_features` date D inside the source's span
 * (its oldest date to its newest):
 * - the same-day group, `opt_*`, from the source row dated D, through
 *   `optionsVolumeFeaturesFromRow` (the function the daily build uses, so the
 *   two cannot diverge). A date with no source row inside the span has the 15
 *   columns set to NULL, and is listed.
 * - the previous-day group, `prev_day_opt_*`, from the source row dated
 *   `priorTradingDay(D)`, the same way. If that day is before the span's first
 *   date, the group is left untouched and D is listed. A previous day inside
 *   the span with no row has the 15 columns set to NULL, and is listed.
 * Dates outside the span are listed and left untouched, so a row the fixed daily
 * build wrote after the file was saved is never blanked. `--date`, `--since` and
 * `--until` narrow the dates read.
 *
 * Exact writes. A repair writes the values it computes, not COALESCE: a column
 * the source says is NULL (a zero count, a ratio with no denominator) becomes
 * NULL. Every value is rounded to its column's scale before it is compared,
 * planned or written: counts as integers, premiums to 2 places (DECIMAL(14,2)),
 * ratios to 4 (DECIMAL(6,4)), half away from zero on the number's shortest
 * decimal text, which is what Postgres stores for it. The stored NUMERIC text is
 * compared at the same scale. Without that every ratio would look changed
 * (360136/282619 is 1.274281... against a stored 1.2743), and a second apply
 * would never reach zero. A value that does not fit its column (a ratio of 100
 * or more, a premium of 1e12 or more, a count past INTEGER) stops the run with
 * the date and the column named, before anything is written.
 *
 * The run. A dry run is the default: it reads the database and writes a plan
 * file under the backup directory and nothing to the database. `--apply --plan F`
 * refuses at once if F was written for another database (host and name), or if
 * F's scope covers more than one date and `--all` is not also given. It reads
 * the source again and refuses unless its sha256 is F's, plans afresh, and
 * refuses unless every date's stored and new values are the ones in F (a date F
 * lists that already holds F's new values is fine: a second apply writes
 * nothing). It then writes a backup file (with `wx`: an existing file is never
 * overwritten, and the run stops before any write) and writes the dates, 500 to
 * a statement, in one transaction, each only where it still holds the values the
 * read found in all 30 columns. A date that changed since is listed and left
 * alone. A failure rolls the whole transaction back, so nothing is half written,
 * and says so, with the backup and the undo command. `--undo-file F --apply`
 * restores a backup, each date only where it still holds the repaired values,
 * and refuses a backup written for another database.
 *
 * The tool prints or writes no name derived from DATABASE_URL (`host/name`, see
 * `databaseOf` in db-host.ts) until a query on it has succeeded.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { optionsVolumeFeaturesFromRow } from '../../api/_lib/build-features-phase2.js';
import type { FeatureRow } from '../../api/_lib/build-features-types.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import { priorTradingDay } from '../../src/data/marketHours.js';
import { databaseOf, NO_DATABASE } from './db-host.js';

type Sql = ReturnType<typeof getDb>;

/** Where the plan and backup files go, relative to the working directory. */
export const BACKUP_DIR = 'docs/tmp/options-volume-repair';
/** Dates per UPDATE (R5). */
export const WRITE_CHUNK = 500;
/** A report line names at most this many dates; the count says the rest. */
const LISTED = 12;

// ── The columns ─────────────────────────────────────────────────────────────

type Kind = 'int' | 'decimal2' | 'decimal4';
type Prefix = 'opt_' | 'prev_day_opt_';

/**
 * The 15 features after the prefix, in column order, with the type of their
 * column (migration #24 for `opt_*`, #213 for `prev_day_opt_*`, the same types).
 */
const FEATURES: ReadonlyArray<readonly [suffix: string, kind: Kind]> = [
  ['call_volume', 'int'],
  ['put_volume', 'int'],
  ['call_oi', 'int'],
  ['put_oi', 'int'],
  ['call_premium', 'decimal2'],
  ['put_premium', 'decimal2'],
  ['bullish_premium', 'decimal2'],
  ['bearish_premium', 'decimal2'],
  ['call_vol_ask', 'int'],
  ['put_vol_bid', 'int'],
  ['vol_pcr', 'decimal4'],
  ['oi_pcr', 'decimal4'],
  ['premium_ratio', 'decimal4'],
  ['call_vol_vs_avg30', 'decimal4'],
  ['put_vol_vs_avg30', 'decimal4'],
];

interface Column {
  name: string;
  kind: Kind;
  prefix: Prefix;
}

/** All 30 columns the repair reads and writes: `opt_*`, then `prev_day_opt_*`. */
export const COLUMNS: readonly Column[] = (
  ['opt_', 'prev_day_opt_'] as const
).flatMap((prefix) =>
  FEATURES.map(([suffix, kind]) => ({
    name: `${prefix}${suffix}`,
    kind,
    prefix,
  })),
);

/** A column's value as text, or NULL: what is stored, planned and written. */
export type Values = Record<string, string | null>;

const DECIMALS = {
  decimal2: { scale: 2, precision: 14, label: 'DECIMAL(14,2)' },
  decimal4: { scale: 4, precision: 6, label: 'DECIMAL(6,4)' },
} as const;
/** The largest value of an INTEGER column. */
const INT_MAX = 2_147_483_647;

/**
 * `abs` in units of 10^-scale, rounded half away from zero on its shortest
 * decimal text. Not `Math.round` or `toFixed`, which round the binary value
 * (2.675 gives 2.67 where Postgres, given the text 2.675, gives 2.68). Below 1e-6
 * the text is in exponent form; that is under half a unit at the scales used here.
 */
function scaledUnits(abs: number, scale: number): bigint {
  const text = abs.toString();
  if (text.includes('e')) return 0n;
  const [whole = '0', fraction = ''] = text.split('.');
  return (
    BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale)) +
    ((fraction[scale] ?? '0') >= '5' ? 1n : 0n)
  );
}

/** `units` of 10^-scale as text, with a sign unless it is zero. No negative zero. */
function unitsText(units: bigint, scale: number, negative: boolean): string {
  const digits = units.toString().padStart(scale + 1, '0');
  const body = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && units !== 0n ? `-${body}` : body;
}

/**
 * A computed feature as the text its column stores, or null. Throws, naming the
 * column, on a value its column cannot hold.
 */
function renderValue(column: Column, value: number | null): string | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) {
    throw new RangeError(
      `${column.name}: ${value} is not a value a column holds`,
    );
  }
  if (column.kind === 'int') {
    if (!Number.isInteger(value) || Math.abs(value) > INT_MAX) {
      throw new RangeError(`${column.name}: ${value} does not fit INTEGER`);
    }
    return String(value);
  }
  const { scale, precision, label } = DECIMALS[column.kind];
  const units = scaledUnits(Math.abs(value), scale);
  if (units >= 10n ** BigInt(precision)) {
    throw new RangeError(`${column.name}: ${value} does not fit ${label}`);
  }
  return unitsText(units, scale, value < 0);
}

/**
 * A stored column read back as text, at its column's scale, so it compares with
 * `renderValue`'s. A stored NaN or Infinity (NUMERIC can hold them) and anything
 * that is not a number are kept as they are: they equal no planned value, so the
 * repair replaces them.
 */
function canonicalStored(column: Column, raw: string | null): string | null {
  if (raw == null) return null;
  const text = raw.trim();
  const value = Number(text);
  if (text === '' || !Number.isFinite(value)) return text;
  if (column.kind === 'int')
    return Number.isInteger(value) ? String(value) : text;
  const { scale } = DECIMALS[column.kind];
  return unitsText(scaledUnits(Math.abs(value), scale), scale, value < 0);
}

// ── The source ──────────────────────────────────────────────────────────────

/** The reply fields `optionsVolumeFeaturesFromRow` reads. */
const FIELDS = [
  'call_volume',
  'put_volume',
  'call_open_interest',
  'put_open_interest',
  'call_premium',
  'put_premium',
  'bullish_premium',
  'bearish_premium',
  'call_volume_ask_side',
  'put_volume_bid_side',
  'avg_30_day_call_volume',
  'avg_30_day_put_volume',
] as const;

export interface SourceFingerprint {
  /** sha256 of the file's bytes, hex. */
  sha256: string;
  rows: number;
  /** The oldest and the newest row's date. */
  first: string;
  last: string;
}

export interface Source extends SourceFingerprint {
  /** The reply rows by their own date. */
  byDate: Map<string, Record<string, unknown>>;
}

const ReplySchema = z.object({ data: z.array(z.unknown()) });

const isNumeric = (value: unknown): boolean =>
  typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' &&
      value.trim() !== '' &&
      Number.isFinite(Number(value));

/**
 * A row's own date as `YYYY-MM-DD`: the plain date the live endpoint sends, or
 * the full ISO timestamp UW's docs show, which names the same trading day. Null
 * for anything else, and for a date that is not on the calendar.
 */
function rowDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value)?.[1];
  if (day == null) return null;
  return new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day
    ? day
    : null;
}

/** A value for a refusal message: short, and never a whole row. */
const shortText = (value: unknown): string =>
  (JSON.stringify(value) ?? String(value)).slice(0, 40);

/**
 * Read and check the source: a saved UW options-volume reply. Refuses, before
 * the database is touched, a file that is not one, and a date that appears twice.
 */
export function readSource(file: string): Source {
  const refuse = (why: string): never => {
    throw new Error(
      `${file} is not a UW options-volume reply: ${why}. Nothing was read from the database or written.`,
    );
  };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read the source ${file}: ${why}`, { cause: err });
  }
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse('it is not JSON');
  }
  const reply = ReplySchema.safeParse(body);
  if (!reply.success) return refuse('it has no `data` array');
  if (reply.data.data.length === 0) return refuse('`data` is empty');

  const byDate = new Map<string, Record<string, unknown>>();
  reply.data.data.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return refuse(`data[${i}] is not an object`);
    }
    const row = raw as Record<string, unknown>;
    const date = rowDate(row.date);
    if (date == null) {
      return refuse(
        `data[${i}] has no usable date (got ${shortText(row.date)})`,
      );
    }
    for (const field of FIELDS) {
      if (!isNumeric(row[field])) {
        return refuse(
          `data[${i}] (${date}) has no number in ${field} (got ${shortText(row[field])})`,
        );
      }
    }
    if (byDate.has(date)) return refuse(`the date ${date} appears twice`);
    byDate.set(date, row);
    return undefined;
  });

  const dates = [...byDate.keys()].sort();
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    rows: byDate.size,
    first: dates[0] ?? '',
    last: dates.at(-1) ?? '',
    byDate,
  };
}

// ── The plan ────────────────────────────────────────────────────────────────

/** A `training_features` row as read: the 30 columns as `::text`. */
export interface StoredRow {
  date: string;
  values: Values;
}

/** Where a group's new values came from. */
export type GroupSource =
  | { kind: 'row'; date: string }
  | { kind: 'no-source-row'; date: string }
  | { kind: 'outside-span'; date: string };

export interface DatePlan {
  date: string;
  sameDay: GroupSource;
  previous: GroupSource;
  /** The stored values, at the columns' scales. */
  before: Values;
  /** What the repair writes. An untouched group keeps its stored values. */
  after: Values;
  /** The columns whose value changes, in column order. */
  changed: string[];
}

export interface RepairPlan {
  source: SourceFingerprint;
  /** The stored dates inside the source's span, oldest first. */
  dates: DatePlan[];
  /** The stored dates outside it: left untouched. */
  outsideSpan: string[];
}

/** One group's 15 target values from a source row, or all NULL without one. */
function groupValues(
  row: Record<string, unknown> | undefined,
  prefix: Prefix,
): Values {
  const features: FeatureRow =
    row == null ? {} : optionsVolumeFeaturesFromRow(row, prefix);
  const out: Values = {};
  for (const column of COLUMNS) {
    if (column.prefix !== prefix) continue;
    const value = features[column.name];
    out[column.name] = renderValue(
      column,
      typeof value === 'number' ? value : null,
    );
  }
  return out;
}

/**
 * Plan every stored date. Pure: the source and the stored rows are its only
 * input. A value that does not fit its column throws, naming the date.
 */
export function planRepair(
  source: Source,
  stored: readonly StoredRow[],
): RepairPlan {
  const dates: DatePlan[] = [];
  const outsideSpan: string[] = [];
  for (const row of stored) {
    if (row.date < source.first || row.date > source.last) {
      outsideSpan.push(row.date);
      continue;
    }
    const before: Values = {};
    for (const column of COLUMNS) {
      before[column.name] = canonicalStored(
        column,
        row.values[column.name] ?? null,
      );
    }
    const previousDate = priorTradingDay(row.date);
    const sameRow = source.byDate.get(row.date);
    const previousRow = source.byDate.get(previousDate);
    const previous: GroupSource =
      previousDate < source.first
        ? { kind: 'outside-span', date: previousDate }
        : previousRow == null
          ? { kind: 'no-source-row', date: previousDate }
          : { kind: 'row', date: previousDate };
    let after: Values;
    try {
      after = {
        ...groupValues(sameRow, 'opt_'),
        ...(previous.kind === 'outside-span'
          ? pick(before, 'prev_day_opt_')
          : groupValues(previousRow, 'prev_day_opt_')),
      };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new RangeError(
        `${row.date}: ${why}. Nothing was written to the database.`,
        { cause: err },
      );
    }
    dates.push({
      date: row.date,
      sameDay:
        sameRow == null
          ? { kind: 'no-source-row', date: row.date }
          : { kind: 'row', date: row.date },
      previous,
      before,
      after,
      changed: COLUMNS.filter((c) => before[c.name] !== after[c.name]).map(
        (c) => c.name,
      ),
    });
  }
  return { source: fingerprintOf(source), dates, outsideSpan };
}

/** The columns of one group, with the values `from` holds. */
function pick(from: Values, prefix: Prefix): Values {
  const out: Values = {};
  for (const column of COLUMNS) {
    if (column.prefix === prefix) out[column.name] = from[column.name] ?? null;
  }
  return out;
}

function fingerprintOf(source: Source): SourceFingerprint {
  return {
    sha256: source.sha256,
    rows: source.rows,
    first: source.first,
    last: source.last,
  };
}

// ── Reading the database ────────────────────────────────────────────────────

/** The stored dates in a scope, with the 30 columns as text, oldest first. */
async function readStored(
  sql: Sql,
  scope: { since: string | null; until: string | null },
): Promise<StoredRow[]> {
  const rows = (await withDbRetry(() =>
    sql.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, ${SELECT_COLUMNS}
         FROM training_features
        WHERE ($1::date IS NULL OR date >= $1::date)
          AND ($2::date IS NULL OR date <= $2::date)
        ORDER BY date`,
      [scope.since, scope.until],
    ),
  )) as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    date: String(r.date),
    values: Object.fromEntries(COLUMNS.map((c) => [c.name, r[c.name] ?? null])),
  }));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** One date of a plan or a backup: what the guarded UPDATE moves. */
export interface MoveRow {
  date: string;
  before: Values;
  after: Values;
}

const sqlType = (column: Column): string =>
  column.kind === 'int' ? 'integer' : 'numeric';

/**
 * The pieces of the guarded UPDATE that do not depend on the rows. The column
 * names are code constants (never request data), so splicing them is safe. The
 * statement takes one array of dates, then one array per column of the values
 * the date holds (`f0`..`f29`), then one per column of the values it moves to
 * (`t0`..`t29`).
 */
const SET_CLAUSE = COLUMNS.map(
  (c, i) => `${c.name} = v.t${i}::${sqlType(c)}`,
).join(', ');
const GUARD = COLUMNS.map(
  (c, i) => `t.${c.name} IS NOT DISTINCT FROM v.f${i}::${sqlType(c)}`,
).join('\n       AND ');
const ARRAYS = [
  '$1::date[]',
  ...COLUMNS.map((_, i) => `$${i + 2}::text[]`),
  ...COLUMNS.map((_, i) => `$${COLUMNS.length + i + 2}::text[]`),
].join(', ');
const ALIASES = [
  'date',
  ...COLUMNS.map((_, i) => `f${i}`),
  ...COLUMNS.map((_, i) => `t${i}`),
].join(', ');
const SELECT_COLUMNS = COLUMNS.map((c) => `${c.name}::text AS ${c.name}`).join(
  ', ',
);

/**
 * The guarded UPDATE of one chunk of dates. Each date moves from its `from`
 * values to its `to` values only where it still holds `from` in all 30 columns
 * (the text is cast in SQL and compared with `IS NOT DISTINCT FROM`, so NULL
 * matches NULL and a stored NaN matches a planned NaN). `apply` moves before to
 * after, `undo` after to before.
 */
function updateStatement(
  chunk: readonly MoveRow[],
  direction: 'apply' | 'undo',
): { text: string; params: unknown[] } {
  const forward = direction === 'apply';
  const from = (r: MoveRow) => (forward ? r.before : r.after);
  const to = (r: MoveRow) => (forward ? r.after : r.before);
  const params: unknown[] = [
    chunk.map((r) => r.date),
    ...COLUMNS.map((c) => chunk.map((r) => from(r)[c.name] ?? null)),
    ...COLUMNS.map((c) => chunk.map((r) => to(r)[c.name] ?? null)),
  ];
  const text = `
    UPDATE training_features AS t
       SET ${SET_CLAUSE}
      FROM unnest(${ARRAYS}) AS v(${ALIASES})
     WHERE t.date = v.date
       AND ${GUARD}
    RETURNING to_char(t.date, 'YYYY-MM-DD') AS day`;
  return { text, params };
}

/**
 * All the chunks in one transaction, so a failure part-way leaves nothing
 * written. Returns the dates a statement moved. A transaction is not retried: if
 * its answer were lost after a commit, the retry would match nothing and call
 * the dates changed.
 */
async function commit(
  sql: Sql,
  rows: readonly MoveRow[],
  direction: 'apply' | 'undo',
): Promise<Set<string>> {
  const chunks: MoveRow[][] = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    chunks.push(rows.slice(i, i + WRITE_CHUNK));
  }
  const results = (await sql.transaction((txn) =>
    chunks.map((chunk) => {
      const { text, params } = updateStatement(chunk, direction);
      return txn.query(text, params);
    }),
  )) as unknown as Array<Array<{ day: string }>>;
  const moved = new Set<string>();
  for (const done of results) for (const r of done) moved.add(r.day);
  return moved;
}

const ValuesSchema = z.strictObject(
  Object.fromEntries(COLUMNS.map((c) => [c.name, z.string().nullable()])),
);
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RowsSchema = z.array(
  z.strictObject({ date: DateText, before: ValuesSchema, after: ValuesSchema }),
);
const SourceSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.number().int().positive(),
  first: DateText,
  last: DateText,
});
const ScopeSchema = z.strictObject({
  date: DateText.nullable(),
  since: DateText.nullable(),
  until: DateText.nullable(),
});
const PlanSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  database: z.string(),
  scope: ScopeSchema,
  source: SourceSchema,
  summary: z.string(),
  rows: RowsSchema,
});
const BackupSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  database: z.string(),
  scope: z.string(),
  source: SourceSchema,
  rows: RowsSchema,
});
type PlanFile = z.infer<typeof PlanSchema>;
type Scope = PlanFile['scope'];

const BACKUP_NOTE =
  'Backup of the options-volume columns a repair replaced. `--undo-file <this file> --apply` restores them, each date only where it still holds the new values.';
const PLAN_NOTE =
  'What a dry run would write. `--apply --plan <this file> --source <the same source file>` plans afresh and writes only if the source is the same, the file was written for this database, and every date, the values it holds now and its new values, is the same as here. A plan that covers more than one date also needs `--all`: apply one date first.';

/**
 * A new JSON file, written with `wx`: a file already there is never
 * overwritten (a backup is the only record of an earlier run), and `flush` puts
 * it on disk before anything can need it.
 */
function writeNewFile(
  dir: string,
  prefix: string,
  scope: string,
  payload: object,
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replaceAll(':', '-');
  const file = join(dir, `${prefix}-${scope}-${stamp}.json`);
  try {
    writeFileSync(file, JSON.stringify(payload), { flag: 'wx', flush: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Refusing to overwrite ${file}. Nothing was written to the database.`,
        { cause: err },
      );
    }
    throw err;
  }
  return file;
}

/** What the file names say about the run's reach: a date, a range or all. */
function scopeLabel(scope: Scope): string {
  if (scope.date != null) return scope.date;
  if (scope.since == null && scope.until == null) return 'all';
  return `${scope.since ?? 'first'}..${scope.until ?? 'last'}`;
}

/**
 * Whether a plan reaches more than one date: its scope is not a single date
 * (`--date`, or `--since` and `--until` naming the same one). This is the scope
 * the dry run was given, not the dates that happened to need a write.
 */
function coversManyDates(scope: Scope): boolean {
  if (scope.date != null) return false;
  return !(scope.since != null && scope.since === scope.until);
}

/** Read a JSON file this script wrote, or say it is not one. */
function readFileAs<T>(file: string, schema: z.ZodType<T>, what: string): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file} is not a ${what} this script wrote: ${why}`, {
      cause: err,
    });
  }
}

/**
 * Refuse a file written for another database than DATABASE_URL names, before
 * any connection. The message carries the name the file recorded and never the
 * one derived from DATABASE_URL, which no query has confirmed yet. A file that
 * records no usable name, or a DATABASE_URL that gives none, never matches.
 */
function requireSameDatabase(file: string, recorded: string): void {
  if (recorded === NO_DATABASE) {
    throw new Error(
      `${file} records no usable database name, so it cannot be matched to DATABASE_URL. Nothing was written.`,
    );
  }
  if (databaseOf(process.env.DATABASE_URL) !== recorded) {
    throw new Error(
      `${file} was written for the database ${recorded}, and DATABASE_URL names a different database or is not a usable URL. Nothing was written.`,
    );
  }
}

/** Refuse a dry run, before `getDb()`, when DATABASE_URL names no usable database. */
function requireUsableDatabase(): void {
  if (databaseOf(process.env.DATABASE_URL) === NO_DATABASE) {
    throw new Error(
      'DATABASE_URL is missing or is not a usable database URL. Nothing was read or written.',
    );
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** The saved UW reply. */
  source: string | null;
  /** `YYYY-MM-DD`: only this date. */
  date: string | null;
  since: string | null;
  until: string | null;
  /**
   * Write. Needs `planFile`, whose scope replaces `date`, `since` and `until`.
   * Without it, `planFile` only checks the file against a fresh plan.
   */
  apply: boolean;
  planFile: string | null;
  /**
   * The owner's one-date-first rule: an apply of a plan that covers more than
   * one date needs this as a confirmation. A single-date plan does not.
   */
  all: boolean;
  backupDir: string;
}

export interface ApplyResult {
  backupFile: string | null;
  planned: number;
  written: number;
  /** Planned dates no statement wrote: they changed since the read. */
  changedSinceRead: string[];
}

export interface RunResult {
  apply: boolean;
  plan: RepairPlan;
  scope: Scope;
  backupFile: string | null;
  /** The plan file a dry run wrote, or the one `--plan` named. */
  planFile: string | null;
  applied: ApplyResult | null;
  /**
   * The database it read, `host/name`, derived from DATABASE_URL only after the
   * reads succeeded. The CLI prints this, not a name of its own taken earlier.
   */
  database: string;
}

const writesOf = (plan: RepairPlan): MoveRow[] =>
  plan.dates
    .filter((d) => d.changed.length > 0)
    .map((d) => ({ date: d.date, before: d.before, after: d.after }));

function planSummary(plan: RepairPlan): string {
  const writes = writesOf(plan).length;
  return `Planned ${writes} dates to write, ${plan.dates.length - writes} already right, ${plan.outsideSpan.length} outside the source's span left alone.`;
}

/** The columns that differ between two value sets, as `column a then b now`. */
function showDifference(then: Values, now: Values): string {
  const diffs = COLUMNS.filter((c) => then[c.name] !== now[c.name]).map(
    (c) =>
      `${c.name} ${then[c.name] ?? 'NULL'} then, ${now[c.name] ?? 'NULL'} now`,
  );
  const shown = diffs.slice(0, 3).join('; ');
  return diffs.length > 3 ? `${shown}; and ${diffs.length - 3} more` : shown;
}

const sameValues = (a: Values, b: Values): boolean =>
  COLUMNS.every((c) => (a[c.name] ?? null) === (b[c.name] ?? null));

/**
 * The problems that make a fresh plan differ from the file the owner reviewed:
 * a date planned now that the file did not list, a date whose new values differ,
 * a date whose stored values changed since (it would be overwritten unreviewed),
 * a listed date no longer planned (unless it already holds the file's new values:
 * a second apply writes nothing), and a different source. Empty when the fresh
 * plan writes exactly what the file says, or what is left of it.
 */
export function comparePlan(
  file: Pick<PlanFile, 'rows' | 'source'>,
  plan: RepairPlan,
): string[] {
  const problems: string[] = [];
  if (file.source.sha256 !== plan.source.sha256) {
    problems.push(
      `the source file is not the one the plan was made from (sha256 ${plan.source.sha256.slice(0, 12)} now, ${file.source.sha256.slice(0, 12)} then)`,
    );
  }
  const listed = new Map(file.rows.map((r) => [r.date, r]));
  const fresh = new Map(plan.dates.map((d) => [d.date, d]));
  for (const d of plan.dates) {
    if (d.changed.length === 0) continue;
    const was = listed.get(d.date);
    if (was == null) {
      problems.push(`${d.date} is planned now and is not in the file`);
      continue;
    }
    if (!sameValues(was.after, d.after)) {
      problems.push(
        `${d.date}: the new values differ from the file's (${showDifference(was.after, d.after)})`,
      );
    }
    if (!sameValues(was.before, d.before)) {
      problems.push(
        `${d.date}: the stored values changed since the dry run (${showDifference(was.before, d.before)})`,
      );
    }
  }
  for (const was of file.rows) {
    const now = fresh.get(was.date);
    if (now != null && now.changed.length > 0) continue;
    if (now != null && sameValues(now.before, was.after)) continue;
    problems.push(
      `${was.date} is in the file and is no longer planned (${now == null ? 'it is no longer read' : 'it holds other values than the file writes'})`,
    );
  }
  return problems;
}

/**
 * Read, plan and, with `apply`, write. A dry run reads the database, writes a
 * plan file and nothing to the database. `--plan F` plans afresh with F's scope
 * and refuses unless the plan is F's; without `apply` it only says so.
 */
export async function runRepair(opts: RunOptions): Promise<RunResult> {
  if (opts.apply && opts.planFile == null) {
    throw new Error(
      'Refusing to apply without --plan <dry-run file>: the dry run names what will be written.',
    );
  }
  if (opts.source == null) {
    throw new Error(
      '--source <file> is required: the saved UW reply is the only input.',
    );
  }
  const reviewed =
    opts.planFile == null
      ? null
      : readFileAs(opts.planFile, PlanSchema, 'dry-run plan');
  if (reviewed == null) requireUsableDatabase();
  else requireSameDatabase(opts.planFile ?? '', reviewed.database);
  if (
    opts.apply &&
    reviewed != null &&
    !opts.all &&
    coversManyDates(reviewed.scope)
  ) {
    throw new Error(
      `${opts.planFile} covers more than one date (${scopeLabel(reviewed.scope)}). Apply one date first: dry-run with --date <date> and apply that plan. To apply every date in this plan, add --all. Nothing was written.`,
    );
  }
  const source = readSource(opts.source);
  if (reviewed != null && source.sha256 !== reviewed.source.sha256) {
    throw new Error(
      `${opts.source} is not the source ${opts.planFile} was made from (sha256 ${source.sha256.slice(0, 12)} now, ${reviewed.source.sha256.slice(0, 12)} then). Nothing was written.`,
    );
  }
  const scope: Scope = reviewed?.scope ?? {
    date: opts.date,
    since: opts.since,
    until: opts.until,
  };

  const sql = getDb();
  const stored = await readStored(sql, {
    since: scope.date ?? scope.since,
    until: scope.date ?? scope.until,
  });
  if (stored.length === 0) {
    throw new Error('no training_features rows in that range');
  }
  const plan = planRepair(source, stored);
  // Queries on this URL have succeeded (the read): from here its name may be
  // printed and written, and not before.
  const database = databaseOf(process.env.DATABASE_URL);

  if (reviewed != null) {
    const problems = comparePlan(reviewed, plan);
    if (problems.length > 0) {
      const shown = problems.slice(0, 10).join('\n  ');
      const more =
        problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : '';
      throw new Error(
        `A fresh plan is not the plan in ${opts.planFile}. Nothing was written.\n  ${shown}${more}`,
      );
    }
    if (!opts.apply) {
      return {
        apply: false,
        plan,
        scope,
        backupFile: null,
        planFile: opts.planFile,
        applied: null,
        database,
      };
    }
    const applied = await applyPlan(sql, plan, {
      backupDir: opts.backupDir,
      scope: scopeLabel(scope),
      database,
    });
    return {
      apply: true,
      plan,
      scope,
      backupFile: applied.backupFile,
      planFile: opts.planFile,
      applied,
      database,
    };
  }

  const planFile = writeNewFile(
    opts.backupDir,
    'dry-run',
    scopeLabel(scope),
    {
      note: PLAN_NOTE,
      createdAt: new Date().toISOString(),
      database,
      scope,
      source: plan.source,
      summary: planSummary(plan),
      rows: writesOf(plan),
    } satisfies PlanFile,
    new Date(),
  );
  return {
    apply: false,
    plan,
    scope,
    backupFile: null,
    planFile,
    applied: null,
    database,
  };
}

/**
 * The backup first, then every date in one transaction. Nothing to write writes
 * no backup. A failure rolls the whole transaction back, and throws with what is
 * and is not done, the backup and the undo command.
 */
async function applyPlan(
  sql: Sql,
  plan: RepairPlan,
  ctx: { backupDir: string; scope: string; database: string },
): Promise<ApplyResult> {
  const rows = writesOf(plan);
  if (rows.length === 0) {
    return { backupFile: null, planned: 0, written: 0, changedSinceRead: [] };
  }
  const backupFile = writeNewFile(
    ctx.backupDir,
    'backup',
    ctx.scope,
    {
      note: BACKUP_NOTE,
      createdAt: new Date().toISOString(),
      database: ctx.database,
      scope: ctx.scope,
      source: plan.source,
      rows,
    } satisfies z.infer<typeof BackupSchema>,
    new Date(),
  );
  let moved: Set<string>;
  try {
    moved = await commit(sql, rows, 'apply');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${why}. The apply did not complete: the ${rows.length} planned dates are written in one transaction, so none of them was written by it. Backup: ${backupFile}. If a dry run shows otherwise, undo with: npx tsx scripts/repair-options-volume.ts --undo-file ${backupFile} --apply`,
      { cause: err },
    );
  }
  return {
    backupFile,
    planned: rows.length,
    written: moved.size,
    changedSinceRead: rows.filter((r) => !moved.has(r.date)).map((r) => r.date),
  };
}

export interface UndoResult {
  apply: boolean;
  rows: number;
  restored: number;
  changedSince: string[];
  /**
   * The database the backup was written for, as the file recorded it. It
   * matched DATABASE_URL's, so it is the one named, and it is not taken from
   * the URL.
   */
  database: string;
}

/**
 * Restore a backup in one transaction: each date only where it still holds the
 * values the repair wrote. Without `apply` it only counts what the file holds. A
 * backup written for another database is refused, counting or not.
 */
export async function runUndo(opts: {
  file: string;
  apply: boolean;
}): Promise<UndoResult> {
  const parsed = readFileAs(opts.file, BackupSchema, 'backup');
  requireSameDatabase(opts.file, parsed.database);
  const base = {
    apply: opts.apply,
    rows: parsed.rows.length,
    database: parsed.database,
  };
  if (!opts.apply) return { ...base, restored: 0, changedSince: [] };
  let moved: Set<string>;
  try {
    moved = await commit(getDb(), parsed.rows, 'undo');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${why}. The undo did not complete: the dates are restored in one transaction, so none of them was restored by it. Run the same command again.`,
      { cause: err },
    );
  }
  return {
    ...base,
    restored: moved.size,
    changedSince: parsed.rows
      .filter((r) => !moved.has(r.date))
      .map((r) => r.date),
  };
}

export function exitCodeOf(result: RunResult): 0 | 1 {
  const a = result.applied;
  // A guarded write that matched nothing (a date that changed since the read)
  // is a run that did not do what it planned.
  return a != null && (a.changedSinceRead.length > 0 || a.written < a.planned)
    ? 1
    : 0;
}

export function exitCodeOfUndo(result: UndoResult): 0 | 1 {
  return result.apply &&
    (result.changedSince.length > 0 || result.restored < result.rows)
    ? 1
    : 0;
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  source: string | null;
  apply: boolean;
  /** Confirms an apply of a plan that covers more than one date. */
  all: boolean;
  date: string | null;
  since: string | null;
  until: string | null;
  planFile: string | null;
  undoFile: string | null;
  backupDir: string;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/repair-options-volume.ts --source <file> [--date D | --since D --until D]
       npx tsx scripts/repair-options-volume.ts --source <file> --plan <dry-run file> [--apply]
       npx tsx scripts/repair-options-volume.ts --undo-file <backup> [--apply]

Sets the options-volume features of training_features, opt_* (the date's own
row) and prev_day_opt_* (the previous trading day's row), from a saved UW
/stock/SPX/options-volume reply. The reply is the only input: the tool never
calls UW and never reads UW_API_KEY. A file that is not such a reply is refused.

It plans every training_features date inside the reply's span, oldest row to
newest. A date outside the span is listed and left alone. A previous trading
day outside the span leaves prev_day_opt_* alone. A date or a previous day with
no row in the reply inside the span has its columns set to NULL, and is listed.
Values are written exactly (not COALESCE), rounded to the column's scale, so a
second apply writes nothing.

The dry run is the default: it reads the database DATABASE_URL points at
(production, in .env.local) and writes nothing to it. It prints the counts, a
per-date table, every changed value as stored then new, and the lists. It
writes a plan file under ${BACKUP_DIR}/. --apply needs --plan <that file> and
the same --source: it plans afresh, refuses unless the source and every date,
the values it holds now and its new values, are the file's (and the file was
written for this database, host and name), writes a backup file under
${BACKUP_DIR}/ first (never overwriting one), then every date in one
transaction (500 to a statement), each only where it still holds the values the
dry run read. --plan without --apply only checks the file.

One date first: a plan whose scope covers more than one date (a dry run with no
--date, or a --since and --until range of more than one day) is applied only
with --all as well. Dry-run one date with --date, apply that plan, then the rest.

Options:
  --source <f>       the saved UW reply (required, except with --undo-file)
  --date <D>         only this date, YYYY-MM-DD
  --since <D>        first date to cover, YYYY-MM-DD
  --until <D>        last date to cover, YYYY-MM-DD
  --plan <f>         a dry-run file: check it, or with --apply write it
  --apply            write the plan named by --plan
  --all              with --apply --plan: confirm a plan that covers more than
                     one date (apply one date first, then this)
  --dry-run          the default, said aloud; contradicts --apply
  --undo-file <f>    restore a backup (with --apply; without it, only counts)
  --backup-dir <d>   where the plan and the backup go (default ${BACKUP_DIR})
  --env-file <path>  .env.local to load (default: the nearest one up the tree)
  --help, -h         print this and exit`;

const IsoDate = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(flag: string, value: string | undefined): string {
  if (value == null || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !IsoDate.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${flag} must be a real date, YYYY-MM-DD (got "${value}")`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    source: null,
    apply: false,
    all: false,
    date: null,
    since: null,
    until: null,
    planFile: null,
    undoFile: null,
    backupDir: BACKUP_DIR,
    envFile: null,
    help: false,
  };
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--date':
        args.date = checkDate(flag, next);
        i += 1;
        break;
      case '--since':
        args.since = checkDate(flag, next);
        i += 1;
        break;
      case '--until':
        args.until = checkDate(flag, next);
        i += 1;
        break;
      case '--source':
      case '--plan':
      case '--undo-file':
      case '--backup-dir':
      case '--env-file': {
        if (next == null || next.startsWith('--')) {
          throw new Error(`${flag} needs a value`);
        }
        if (flag === '--source') args.source = next;
        else if (flag === '--plan') args.planFile = next;
        else if (flag === '--undo-file') args.undoFile = next;
        else if (flag === '--backup-dir') args.backupDir = next;
        else args.envFile = next;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument ${flag ?? ''}. Try --help.`);
    }
  }
  if (args.help) return args;
  if (dryRun && args.apply) {
    throw new Error('--dry-run and --apply contradict each other');
  }
  if (args.date != null && (args.since != null || args.until != null)) {
    throw new Error('--date cannot be combined with --since or --until');
  }
  if (
    args.planFile != null &&
    (args.date != null ||
      args.since != null ||
      args.until != null ||
      args.undoFile != null)
  ) {
    throw new Error(
      '--plan names its own scope: it contradicts --date, --since, --until and --undo-file',
    );
  }
  if (
    args.undoFile != null &&
    (args.source != null ||
      args.date != null ||
      args.since != null ||
      args.until != null)
  ) {
    throw new Error(
      '--undo-file restores a backup: it contradicts --source, --date, --since and --until',
    );
  }
  if (args.undoFile == null && args.source == null) {
    throw new Error(
      '--source <file> is required: the saved UW reply is the only input',
    );
  }
  if (args.apply && args.undoFile == null && args.planFile == null) {
    throw new Error(
      'Refusing to apply without --plan <dry-run file>: the dry run names what will be written',
    );
  }
  if (args.all && !(args.apply && args.planFile != null)) {
    throw new Error(
      '--all only confirms --apply --plan <dry-run file>: it lets a plan that covers more than one date be applied. Apply one date first',
    );
  }
  return args;
}

// ── The report ──────────────────────────────────────────────────────────────

const shown = (value: string | null): string => value ?? 'NULL';

/** A list of dates, at most LISTED of them, and the count of the rest. */
function listLine(label: string, dates: readonly string[]): string[] {
  if (dates.length === 0) return [];
  const head = dates.slice(0, LISTED).join(', ');
  const more =
    dates.length > LISTED ? `, and ${dates.length - LISTED} more` : '';
  return [`${label} (${dates.length}): ${head}${more}`];
}

const groupNote = (g: GroupSource): string =>
  g.kind === 'row'
    ? `row ${g.date}`
    : g.kind === 'no-source-row'
      ? `NO ROW ${g.date}: NULL`
      : `${g.date} outside the span: untouched`;

export function formatReport(
  result: Pick<RunResult, 'plan' | 'scope' | 'planFile'>,
): string {
  const { plan } = result;
  const writes = plan.dates.filter((d) => d.changed.length > 0);
  const lines: string[] = [];
  lines.push(
    `Source: ${plan.source.rows} rows, ${plan.source.first} to ${plan.source.last} (sha256 ${plan.source.sha256.slice(0, 12)})`,
    `Scope: ${scopeLabel(result.scope)}`,
    `training_features dates read: ${plan.dates.length + plan.outsideSpan.length} (${plan.dates.length} inside the span, ${plan.outsideSpan.length} outside it)`,
    `Planned: ${writes.length} dates to write (${writes.reduce((n, d) => n + d.changed.length, 0)} column values), ${plan.dates.length - writes.length} already right`,
    '',
    'Per date (opt_* from the same-day row, prev_day_opt_* from the previous trading day):',
  );
  for (const d of plan.dates) {
    const status =
      d.changed.length === 0 ? 'right' : `change ${d.changed.length} columns`;
    lines.push(
      `  ${d.date}  ${status}  [opt_: ${groupNote(d.sameDay)}; prev_day_opt_: ${groupNote(d.previous)}]`,
    );
  }
  if (writes.length > 0) lines.push('', 'Changed values, as stored then new:');
  for (const d of writes) {
    lines.push(`  ${d.date}`);
    for (const name of d.changed) {
      lines.push(
        `    ${name}: ${shown(d.before[name] ?? null)} -> ${shown(d.after[name] ?? null)}`,
      );
    }
  }
  const lists = [
    ...listLine('Outside the span, left untouched', plan.outsideSpan),
    ...listLine(
      'Previous trading day outside the span, prev_day_opt_* left untouched',
      plan.dates
        .filter((d) => d.previous.kind === 'outside-span')
        .map((d) => d.date),
    ),
    ...listLine(
      'No source row for the date, opt_* set to NULL',
      plan.dates
        .filter((d) => d.sameDay.kind === 'no-source-row')
        .map((d) => d.date),
    ),
    ...listLine(
      'No source row for the previous trading day, prev_day_opt_* set to NULL',
      plan.dates
        .filter((d) => d.previous.kind === 'no-source-row')
        .map((d) => d.date),
    ),
  ];
  if (lists.length > 0) lines.push('', ...lists);
  if (result.planFile != null) lines.push('', `Plan file: ${result.planFile}`);
  return lines.join('\n');
}

export function formatApplyReport(applied: ApplyResult): string {
  if (applied.planned === 0)
    return 'Nothing to write: every date is already right.';
  const lines = [
    `Wrote ${applied.written} of ${applied.planned} planned dates.`,
    `Backup: ${applied.backupFile ?? 'none'}`,
  ];
  if (applied.changedSinceRead.length > 0) {
    lines.push(
      ...listLine(
        'Changed since the read, not written',
        applied.changedSinceRead,
      ),
    );
  }
  return lines.join('\n');
}

export function formatUndoReport(result: UndoResult): string {
  if (!result.apply) {
    return `The backup holds ${result.rows} dates. Add --apply to restore them, each only where it still holds the repaired values.`;
  }
  const lines = [`Restored ${result.restored} of ${result.rows} dates.`];
  if (result.changedSince.length > 0) {
    lines.push(
      ...listLine(
        'Changed since the repair, not restored',
        result.changedSince,
      ),
    );
  }
  return lines.join('\n');
}
