/**
 * The one-shot history backfill for the server-side event-day flag (spec:
 * docs/superpowers/specs/2026-11-11-server-side-event-day-flags.md, phase 3).
 * Logic for scripts/backfill-snapshot-event-flags.ts; it lives here so vitest
 * covers it (scripts/_lib/**).
 *
 * Past snapshots were saved with the client's event list, which was empty for
 * every past date. This sets, from the same sources `/api/snapshot` now uses
 * (`fetchMarketEvents` and `eventNamesForSnapshot` in
 * api/_lib/market-events.ts):
 *   1. market_snapshots.event_names and is_event_day, for every row dated
 *      today (ET) or earlier;
 *   2. training_features.is_event_day, for the snapshot dates that have a row.
 *
 * Events are fetched once per calendar month that has a snapshot date, in
 * turn, never in parallel: 7 FRED calls a month, and one Finnhub call over a
 * month, so no answer is truncated. The run refuses before writing when a
 * key is unset, the table is empty, or any month comes back incomplete.
 *
 * Dry run is the default and writes nothing. `--apply` writes an undo file,
 * then the whole plan in ONE `sql.transaction`. Every snapshot UPDATE is
 * guarded on the values it was read with (R6), so a save that lands between
 * the read and the write is skipped and reported, never overwritten; a
 * second run plans zero writes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  eventNamesForSnapshot,
  fetchMarketEvents,
  type EventItem,
  type MarketEventsResult,
} from '../../api/_lib/market-events.js';
import { getETToday } from '../../src/utils/timezone.js';

/** Snapshot rows read per query (keyset on id), and per UPDATE (R5). */
export const READ_PAGE = 5000;
export const WRITE_CHUNK = 500;

/** Where `--apply` leaves its undo file, relative to the working directory. */
export const UNDO_DIR = 'docs/tmp/snapshot-event-flags';

/** A stored name `--keep-earnings` keeps when the computed list lacks it. */
const EARNINGS_NAME = / Earnings$/;

/** Failed rows listed in the report before "and N more". */
const SKIPPED_SHOWN = 20;

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  keepEarnings: boolean;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/backfill-snapshot-event-flags.ts [options]

Sets market_snapshots.is_event_day and event_names, and
training_features.is_event_day, from the server's event sources.
Needs FRED_API_KEY and FINNHUB_API_KEY in the environment.

Options:
  --apply            write (without it: dry run, which writes nothing)
  --dry-run          the default, said aloud; contradicts --apply
  --keep-earnings    keep a stored "<TICKER> Earnings" name the computed list
                     lacks (use it if Finnhub returns no past earnings)
  --env-file <path>  .env.local to load (default: the nearest one up the tree)
  --help, -h         print this and exit`;

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let keepEarnings = false;
  let help = false;
  let envFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--keep-earnings') keepEarnings = true;
    else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--env-file') {
      i += 1;
      const value = argv[i];
      if (value == null || value.startsWith('--')) {
        throw new Error('--env-file needs a value');
      }
      envFile = value;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run contradict');
  return { apply, keepEarnings, envFile, help };
}

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * Both keys are required. Without Finnhub, `fetchMarketEvents` still reports
 * the list complete, but it holds no earnings, so the run would strip every
 * stored earnings name. Messages name the variable, never its value.
 */
export function requireApiKeys(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const problems: string[] = [];
  if (!env.FRED_API_KEY) {
    problems.push(
      'FRED_API_KEY is not set: no economic release can be fetched without it.',
    );
  }
  if (!env.FINNHUB_API_KEY) {
    problems.push(
      'FINNHUB_API_KEY is not set: without it the computed names hold no earnings, and the run would strip every stored earnings name.',
    );
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to run. ${problems.join(' ')}`);
  }
}

/** Replace both key values in `text`, so an upstream error cannot echo them. */
function redactKeys(text: string): string {
  let out = text;
  for (const key of [process.env.FRED_API_KEY, process.env.FINNHUB_API_KEY]) {
    if (key) out = out.replaceAll(key, '[redacted]');
  }
  return out;
}

// ── Months ──────────────────────────────────────────────────────────────────

export interface MonthRange {
  /** `YYYY-MM` */
  month: string;
  /** `YYYY-MM-DD`, clipped to the earliest snapshot date in the first month. */
  start: string;
  /** `YYYY-MM-DD`, clipped to the latest snapshot date in the last month. */
  end: string;
}

/** The last calendar day of `month` (`YYYY-MM`) as `YYYY-MM-DD`. */
function lastDayOf(month: string): string {
  const [year = 0, mon = 0] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  const day = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** True when the range is the whole calendar month, not clipped at either end. */
const isWholeMonth = (m: MonthRange): boolean =>
  m.start === `${m.month}-01` && m.end === lastDayOf(m.month);

/**
 * The lookup ranges: one per calendar month that has a snapshot date, whole
 * months except the first and last, which are clipped to the min and max
 * date. A month with no snapshot date is skipped.
 */
export function monthRanges(dates: readonly string[]): MonthRange[] {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first == null || last == null) return [];
  const months = [...new Set(sorted.map((d) => d.slice(0, 7)))];
  return months.map((month) => {
    const monthStart = `${month}-01`;
    const monthEnd = lastDayOf(month);
    return {
      month,
      start: monthStart < first ? first : monthStart,
      end: monthEnd > last ? last : monthEnd,
    };
  });
}

export interface MonthFetch extends MonthRange {
  eventCount: number;
}

/**
 * Fetch each month in turn and map every date to its computed names (the one
 * definition `/api/snapshot` uses). A month that is not `complete`, or whose
 * lookup rejects, stops the run before anything is read further or written.
 */
export async function fetchMonthlyNames(
  months: readonly MonthRange[],
): Promise<{ namesByDate: Map<string, string[]>; fetched: MonthFetch[] }> {
  const namesByDate = new Map<string, string[]>();
  const fetched: MonthFetch[] = [];
  for (const m of months) {
    const label = `events for ${m.month} (${m.start}..${m.end})`;
    let result: MarketEventsResult;
    try {
      result = await fetchMarketEvents(m.start, m.end);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${label} could not be fetched: ${redactKeys(reason)}. Nothing was written.`,
        { cause: err },
      );
    }
    if (!result.complete) {
      throw new Error(
        `${label} are incomplete: a FRED release or Finnhub answered with an error or a malformed body (the cause is logged just above). Nothing was written. If Finnhub rejects past dates, this repeats on every run and waiting will not help; otherwise re-run later.`,
      );
    }
    const byDate = new Map<string, EventItem[]>();
    for (const e of result.events) {
      byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    }
    for (const [date, items] of byDate) {
      namesByDate.set(date, eventNamesForSnapshot(items));
    }
    fetched.push({ ...m, eventCount: result.events.length });
  }
  return { namesByDate, fetched };
}

// ── Plan (pure) ─────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: number;
  /** `YYYY-MM-DD` */
  date: string;
  isEventDay: boolean | null;
  eventNames: string[] | null;
}

export interface FeatureRow {
  /** `YYYY-MM-DD` */
  date: string;
  isEventDay: boolean | null;
}

export interface SnapshotChange {
  id: number;
  date: string;
  from: { isEventDay: boolean | null; eventNames: string[] | null };
  to: { isEventDay: boolean; eventNames: string[] };
}

export interface FeatureChange {
  date: string;
  from: boolean | null;
  to: boolean;
}

/** Days on which at least one row gains, or loses, an event name. */
export interface NameDays {
  name: string;
  gained: number;
  lost: number;
}

/** A date whose rows all end with no event flag after at least one had one. */
export interface LostFlagDate {
  date: string;
  /** Every name stored on the date's rows, first seen first. */
  oldNames: string[];
}

export interface Plan {
  snapshotRows: number;
  /** Distinct snapshot dates, ascending. */
  snapshotDates: string[];
  snapshotChanges: SnapshotChange[];
  /** Feature rows on a snapshot date. */
  featureRows: number;
  featureChanges: FeatureChange[];
  nameDays: NameDays[];
  lostFlagDates: LostFlagDate[];
  gainedFlagDates: string[];
}

export interface PlanInput {
  snapshots: readonly SnapshotRow[];
  features: readonly FeatureRow[];
  /** Computed names per date; a date missing from the map has none. */
  namesByDate: ReadonlyMap<string, readonly string[]>;
  keepEarnings: boolean;
}

/** Equal as sets: order and duplicates do not count. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((n) => right.has(n));
}

/**
 * The names a row ends with: the computed ones, plus, with `keepEarnings`,
 * each stored earnings name they lack (once, in stored order).
 */
function namesFor(
  stored: readonly string[],
  computed: readonly string[],
  keepEarnings: boolean,
): string[] {
  if (!keepEarnings) return [...computed];
  const kept: string[] = [];
  for (const name of stored) {
    if (
      EARNINGS_NAME.test(name) &&
      !computed.includes(name) &&
      !kept.includes(name)
    ) {
      kept.push(name);
    }
  }
  return [...computed, ...kept];
}

interface DateTally {
  /** Some row carried a flag or a name before. */
  hadFlag: boolean;
  oldNames: string[];
  /** Some row ends with a name, so the date ends flagged. */
  hasNewFlag: boolean;
}

const addDay = (map: Map<string, Set<string>>, name: string, date: string) =>
  map.set(name, (map.get(name) ?? new Set<string>()).add(date));

/**
 * A row is written when its names differ from the computed ones as sets (NULL
 * is empty), or when its flag is not "has a name". Order and duplicates alone
 * never write. A training_features row follows its date: flagged when any of
 * the date's snapshot rows ends with a name.
 */
export function buildPlan(input: PlanInput): Plan {
  const { snapshots, features, namesByDate, keepEarnings } = input;
  const dates = new Map<string, DateTally>();
  const gained = new Map<string, Set<string>>();
  const lost = new Map<string, Set<string>>();
  const snapshotChanges: SnapshotChange[] = [];

  for (const row of snapshots) {
    const stored = row.eventNames ?? [];
    const next = namesFor(
      stored,
      namesByDate.get(row.date) ?? [],
      keepEarnings,
    );
    const nextFlag = next.length > 0;

    const tally = dates.get(row.date) ?? {
      hadFlag: false,
      oldNames: [],
      hasNewFlag: false,
    };
    tally.hadFlag ||= row.isEventDay === true || stored.length > 0;
    tally.hasNewFlag ||= nextFlag;
    for (const name of stored) {
      if (!tally.oldNames.includes(name)) tally.oldNames.push(name);
    }
    dates.set(row.date, tally);

    if (sameSet(stored, next) && row.isEventDay === nextFlag) continue;
    snapshotChanges.push({
      id: row.id,
      date: row.date,
      from: { isEventDay: row.isEventDay, eventNames: row.eventNames },
      to: { isEventDay: nextFlag, eventNames: next },
    });
    for (const name of new Set(next)) {
      if (!stored.includes(name)) addDay(gained, name, row.date);
    }
    for (const name of new Set(stored)) {
      if (!next.includes(name)) addDay(lost, name, row.date);
    }
  }

  const featureChanges: FeatureChange[] = [];
  let featureRows = 0;
  for (const f of features) {
    const tally = dates.get(f.date);
    if (tally == null) continue;
    featureRows += 1;
    if (f.isEventDay !== tally.hasNewFlag) {
      featureChanges.push({
        date: f.date,
        from: f.isEventDay,
        to: tally.hasNewFlag,
      });
    }
  }

  const snapshotDates = [...dates.keys()].sort();
  const lostFlagDates: LostFlagDate[] = [];
  const gainedFlagDates: string[] = [];
  for (const date of snapshotDates) {
    const tally = dates.get(date);
    if (tally == null) continue;
    if (tally.hadFlag && !tally.hasNewFlag) {
      lostFlagDates.push({ date, oldNames: tally.oldNames });
    } else if (!tally.hadFlag && tally.hasNewFlag) {
      gainedFlagDates.push(date);
    }
  }

  const names = [...new Set([...gained.keys(), ...lost.keys()])].sort();
  return {
    snapshotRows: snapshots.length,
    snapshotDates,
    snapshotChanges,
    featureRows,
    featureChanges,
    nameDays: names.map((name) => ({
      name,
      gained: gained.get(name)?.size ?? 0,
      lost: lost.get(name)?.size ?? 0,
    })),
    lostFlagDates,
    gainedFlagDates,
  };
}

const totalPlanned = (plan: Plan): number =>
  plan.snapshotChanges.length + plan.featureChanges.length;

// ── Reads ───────────────────────────────────────────────────────────────────

type Sql = ReturnType<typeof getDb>;
type Query = ReturnType<Sql>;

/**
 * Every snapshot row dated `today` (ET) or earlier, paged by id so no one
 * query grows with the table. A row saved after its page was read is simply
 * not planned; the write guards cover one changed after.
 */
async function readSnapshots(sql: Sql, today: string): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  let lastId = 0;
  for (;;) {
    const page = (await withDbRetry(
      () => sql`
        SELECT id, to_char(date, 'YYYY-MM-DD') AS day, is_event_day,
               event_names
          FROM market_snapshots
         WHERE date <= ${today}::date
           AND id > ${lastId}
         ORDER BY id
         LIMIT ${READ_PAGE}
      `,
    )) as Array<{
      id: number;
      day: string;
      is_event_day: boolean | null;
      event_names: string[] | null;
    }>;
    for (const r of page) {
      rows.push({
        id: r.id,
        date: r.day,
        isEventDay: r.is_event_day,
        eventNames: r.event_names,
      });
    }
    const last = page.at(-1);
    if (page.length < READ_PAGE || last == null) return rows;
    lastId = last.id;
  }
}

async function readFeatures(
  sql: Sql,
  dates: readonly string[],
): Promise<FeatureRow[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS day, is_event_day
        FROM training_features
       WHERE date = ANY(${[...dates]}::date[])
       ORDER BY date
    `,
  )) as Array<{ day: string; is_event_day: boolean | null }>;
  return rows.map((r) => ({ date: r.day, isEventDay: r.is_event_day }));
}

// ── Writes ──────────────────────────────────────────────────────────────────

type Table = 'market_snapshots' | 'training_features';

export interface WriteOutcome {
  /** Rows each table actually changed (RETURNING). */
  written: Record<Table, number>;
  /** Planned rows whose guard did not match: changed since the read. */
  skipped: { snapshotIds: number[]; featureDates: string[] };
}

/**
 * Every UPDATE, built fresh per attempt (a retry must not reuse a spent
 * query), in chunks of WRITE_CHUNK rows.
 *
 * Names travel as JSON text, one string per row, because the rows' arrays
 * have different lengths and a SQL array of arrays must be rectangular. The
 * guard compares `to_jsonb(event_names)` with the JSON read earlier, which
 * keeps order and duplicates, and `IS NOT DISTINCT FROM` matches a stored
 * NULL (sent as a NULL element) as well as a value.
 */
function buildStatements(sql: Sql, plan: Plan) {
  const statements: Array<{ table: Table; query: Query }> = [];

  for (let i = 0; i < plan.snapshotChanges.length; i += WRITE_CHUNK) {
    const chunk = plan.snapshotChanges.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((c) => c.id);
    const oldNames = chunk.map((c) =>
      c.from.eventNames == null ? null : JSON.stringify(c.from.eventNames),
    );
    const oldFlags = chunk.map((c) => c.from.isEventDay);
    const newNames = chunk.map((c) => JSON.stringify(c.to.eventNames));
    const newFlags = chunk.map((c) => c.to.isEventDay);
    statements.push({
      table: 'market_snapshots',
      query: sql`
        UPDATE market_snapshots t
           SET event_names = ARRAY(
                 SELECT n.name
                   FROM jsonb_array_elements_text(v.new_names::jsonb)
                        WITH ORDINALITY AS n(name, ord)
                  ORDER BY n.ord),
               is_event_day = v.new_flag
          FROM unnest(${ids}::int[], ${oldNames}::text[], ${oldFlags}::boolean[],
                      ${newNames}::text[], ${newFlags}::boolean[])
               AS v(id, old_names, old_flag, new_names, new_flag)
         WHERE t.id = v.id
           AND to_jsonb(t.event_names) IS NOT DISTINCT FROM v.old_names::jsonb
           AND t.is_event_day IS NOT DISTINCT FROM v.old_flag
        RETURNING t.id
      `,
    });
  }

  for (let i = 0; i < plan.featureChanges.length; i += WRITE_CHUNK) {
    const chunk = plan.featureChanges.slice(i, i + WRITE_CHUNK);
    const dates = chunk.map((c) => c.date);
    const flags = chunk.map((c) => c.to);
    statements.push({
      table: 'training_features',
      query: sql`
        UPDATE training_features t
           SET is_event_day = v.new_flag
          FROM unnest(${dates}::date[], ${flags}::boolean[])
               AS v(date, new_flag)
         WHERE t.date = v.date
           AND t.is_event_day IS DISTINCT FROM v.new_flag
        RETURNING to_char(t.date, 'YYYY-MM-DD') AS day
      `,
    });
  }
  return statements;
}

/**
 * Write the whole plan in one transaction and report what each table changed
 * and which planned rows the guards skipped. A transient failure retries the
 * whole transaction (it rolled back); if the first attempt had committed
 * before its answer was lost, the guards match nothing on the retry and the
 * report lists every row as skipped, which a fresh dry run (0 planned)
 * settles. Exported for the pglite test.
 */
export async function writePlan(sql: Sql, plan: Plan): Promise<WriteOutcome> {
  const { statements, results } = await withDbRetry(async () => {
    const built = buildStatements(sql, plan);
    return {
      statements: built,
      results: (await sql.transaction(
        built.map((s) => s.query),
      )) as unknown[][],
    };
  });
  const snapshotIds = new Set<number>();
  const featureDates = new Set<string>();
  for (const [i, s] of statements.entries()) {
    const rows = results[i] ?? [];
    if (s.table === 'market_snapshots') {
      for (const r of rows as Array<{ id: number }>) snapshotIds.add(r.id);
    } else {
      for (const r of rows as Array<{ day: string }>) featureDates.add(r.day);
    }
  }
  return {
    written: {
      market_snapshots: snapshotIds.size,
      training_features: featureDates.size,
    },
    skipped: {
      snapshotIds: plan.snapshotChanges
        .map((c) => c.id)
        .filter((id) => !snapshotIds.has(id)),
      featureDates: plan.featureChanges
        .map((c) => c.date)
        .filter((d) => !featureDates.has(d)),
    },
  };
}

/**
 * The undo file: every planned row's id and old values, and every planned
 * feature row's date and old flag, written before the transaction opens. It
 * never overwrites an earlier file. Returns its path.
 */
export function writeUndoFile(dir: string, plan: Plan, now: Date): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replaceAll(/[:.]/g, '-');
  const path = join(dir, `undo-${stamp}.json`);
  const body = {
    createdAt: now.toISOString(),
    snapshots: plan.snapshotChanges.map((c) => ({
      id: c.id,
      isEventDay: c.from.isEventDay,
      eventNames: c.from.eventNames,
    })),
    features: plan.featureChanges.map((c) => ({
      date: c.date,
      isEventDay: c.from,
    })),
  };
  writeFileSync(path, JSON.stringify(body), { flag: 'wx' });
  return path;
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface BackfillResult {
  plan: Plan;
  months: MonthFetch[];
  /** Whether --apply was passed. */
  apply: boolean;
  keepEarnings: boolean;
  /** Null for a dry run, and for an apply with nothing to write. */
  undoFile: string | null;
  /** Null for a dry run, and for an apply with nothing to write. */
  outcome: WriteOutcome | null;
}

/**
 * Check the keys, read the snapshots, fetch the events month by month, plan,
 * and (with `apply`) write the undo file and then the plan in one
 * transaction. A plan with nothing to change writes nothing and opens no
 * transaction. Every refusal throws before anything is written, in both
 * modes. A DB error propagates after withDbRetry and the transaction rolls
 * back as a whole; one from the apply names the undo file already written.
 */
export async function runBackfill(opts: {
  apply: boolean;
  keepEarnings: boolean;
  undoDir: string;
}): Promise<BackfillResult> {
  requireApiKeys(process.env);
  const sql = getDb();
  const today = getETToday();
  const snapshots = await readSnapshots(sql, today);
  if (snapshots.length === 0) {
    throw new Error(
      `Refusing to run: no market_snapshots rows dated ${today} or earlier.`,
    );
  }
  const dates = [...new Set(snapshots.map((s) => s.date))].sort();
  const { namesByDate, fetched } = await fetchMonthlyNames(monthRanges(dates));
  const features = await readFeatures(sql, dates);
  const plan = buildPlan({
    snapshots,
    features,
    namesByDate,
    keepEarnings: opts.keepEarnings,
  });
  const base = { plan, months: fetched, keepEarnings: opts.keepEarnings };
  if (!opts.apply || totalPlanned(plan) === 0) {
    return { ...base, apply: opts.apply, undoFile: null, outcome: null };
  }
  const undoFile = writeUndoFile(opts.undoDir, plan, new Date());
  try {
    return {
      ...base,
      apply: true,
      undoFile,
      outcome: await writePlan(sql, plan),
    };
  } catch (err) {
    // The file was written first; the owner must be able to find it even
    // though no report follows. A failed transaction rolls back, but a lost
    // connection can hide a commit, so point at the dry run too.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${reason}. The apply did not complete. The undo file ${undoFile} was written before it; run a dry run to see what, if anything, changed.`,
      { cause: err },
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

function skippedLine(
  table: Table,
  items: ReadonlyArray<string | number>,
  label: { one: string; many: string } | null,
): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, SKIPPED_SHOWN).join(', ');
  const more =
    items.length > SKIPPED_SHOWN
      ? `, and ${items.length - SKIPPED_SHOWN} more`
      : '';
  const prefix =
    label == null ? '' : `${items.length === 1 ? label.one : label.many} `;
  return `WARNING: ${items.length} ${table} ${items.length === 1 ? 'row' : 'rows'} skipped, changed since the read: ${prefix}${shown}${more}. Re-run (a dry run first) to pick them up.`;
}

function nameLines(plan: Plan): string[] {
  if (plan.nameDays.length === 0) return ['Event names: no name changes.'];
  const width = Math.max(...plan.nameDays.map((n) => n.name.length));
  return [
    'Event names, days gaining / losing the name:',
    ...plan.nameDays.map(
      (n) => `  ${n.name.padEnd(width)}  gain ${n.gained}  lose ${n.lost}`,
    ),
  ];
}

function flagLines(plan: Plan): string[] {
  const lines: string[] = [];
  if (plan.lostFlagDates.length === 0) {
    lines.push('Dates that lose their event flag: none');
  } else {
    lines.push(
      `Dates that lose their event flag (${plan.lostFlagDates.length}):`,
    );
    for (const d of plan.lostFlagDates) {
      const old =
        d.oldNames.length > 0 ? d.oldNames.join(', ') : '(flag set, no names)';
      lines.push(`  ${d.date}  ${old} -> (none)`);
    }
  }
  lines.push(
    plan.gainedFlagDates.length === 0
      ? 'Dates that gain an event flag: none'
      : `Dates that gain an event flag (${plan.gainedFlagDates.length}): ${plan.gainedFlagDates.join(', ')}`,
  );
  return lines;
}

/** The printable summary of a dry run or an apply. */
export function formatReport(result: BackfillResult): string {
  const { plan, months, apply, keepEarnings, undoFile, outcome } = result;
  const first = plan.snapshotDates[0] ?? '?';
  const last = plan.snapshotDates.at(-1) ?? '?';
  const lines = [
    `Snapshot event-flag backfill: ${
      apply ? 'APPLY (one transaction)' : 'DRY RUN (writes nothing)'
    }`,
    `--keep-earnings: ${keepEarnings ? 'on' : 'off'}`,
    '',
    `Read: ${plural(plan.snapshotRows, 'market_snapshots row')} on ${plural(plan.snapshotDates.length, 'date')} (${first} to ${last})`,
    `Months fetched (${months.length}, one lookup each, in turn):`,
    ...months.map((m) => {
      // A whole calendar month always holds CPI and NFP, so none means the
      // answer was empty or malformed even though it was marked complete.
      const warning =
        m.eventCount === 0 && isWholeMonth(m)
          ? '  WARNING: 0 events in a whole month (CPI and NFP alone make that impossible), so the payload is probably bad'
          : '';
      return `  ${m.month} (${m.start}..${m.end}): ${plural(m.eventCount, 'event')}${warning}`;
    }),
    '',
    ...nameLines(plan),
    '',
    ...flagLines(plan),
    '',
    `market_snapshots: ${plan.snapshotChanges.length} of ${plan.snapshotRows} rows to write`,
    `training_features: ${plan.featureChanges.length} of ${plan.featureRows} rows to write`,
    `Total planned writes: ${totalPlanned(plan)}`,
    '',
  ];
  if (totalPlanned(plan) === 0) {
    lines.push(
      'Nothing to change: every row already matches the computed events.',
    );
  } else if (outcome == null) {
    lines.push('Dry run: nothing written. Re-run with --apply to write.');
  } else {
    lines.push(
      `Undo file: ${undoFile ?? '(none)'}`,
      `Written in one transaction: market_snapshots ${outcome.written.market_snapshots}, training_features ${outcome.written.training_features}.`,
    );
    const warnings = [
      skippedLine('market_snapshots', outcome.skipped.snapshotIds, {
        one: 'id',
        many: 'ids',
      }),
      skippedLine('training_features', outcome.skipped.featureDates, null),
    ];
    for (const w of warnings) if (w != null) lines.push(w);
  }
  return lines.join('\n');
}
