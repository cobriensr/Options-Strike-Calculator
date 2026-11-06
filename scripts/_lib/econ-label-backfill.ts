/**
 * The one-shot history backfill for the economic-event label fix (spec:
 * docs/superpowers/specs/2026-11-06-economic-events-fomc-classification.md,
 * phase 5). Logic for scripts/backfill-economic-event-labels.ts; it lives here
 * so vitest covers it (scripts/_lib/**).
 *
 * What it repairs, from the corrected classifier and the Fed's schedule:
 *   1. economic_events.event_type: every row reclassified by name.
 *   2. training_features: is_fomc, event_type and days_to_next_event, for
 *      every row, from the corrected rows (summarizeDayEvents, the rule
 *      build-features uses) and the calendar-day gap to the next event date.
 *      days_to_next_event is NULL where the value would come from missing
 *      data, not the calendar: a row dated before the first economic_events
 *      row (the table did not exist yet), or a gap over
 *      MAX_PLAUSIBLE_EVENT_GAP_DAYS (nextEventGap, the one rule
 *      addEventFeatures applies live; both import it from
 *      api/_lib/economic-event-features.ts). event_count is not touched.
 *   3. 2026-04-29 (the real decision day the old static date missed):
 *      market_snapshots and training_features.is_event_day become true.
 *   4. 2026-05-06 (the old wrong date): FOMC leaves market_snapshots.
 *      event_names, and is_event_day follows what is left.
 *   5. ws_gamma_setup_fires.is_fomc_day = true for fires on a decision day,
 *      by the fire's ET date.
 *
 * Dry run is the default and writes nothing. `--apply` computes the whole
 * plan up front, then writes it in ONE `sql.transaction`, so a failure
 * leaves every table as it was. Every UPDATE is guarded by the value it is
 * about to change, so a second run matches zero rows.
 */

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  MAX_PLAUSIBLE_EVENT_GAP_DAYS,
  nextEventGap,
  summarizeDayEvents,
} from '../../api/_lib/economic-event-features.js';
import {
  classifyEconomicEvent,
  type EconomicEventType,
} from '../../api/_lib/economic-event-type.js';
import { FOMC_DECISION_DATES } from '../../api/_lib/fomc-schedule.js';

/** Rows per UPDATE statement (R5: batch around 500 rows). */
export const WRITE_CHUNK = 500;

/** The real decision day the old static date missed. */
export const FOMC_MISSED_DATE = '2026-04-29';
/** The old static date, which was never a decision day. */
export const FOMC_WRONG_DATE = '2026-05-06';

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  envFile: string | null;
}

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let envFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
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
  return { apply, envFile };
}

/** The host of DATABASE_URL, for the header line. Never the credentials. */
export function dbHost(databaseUrl: string | undefined): string {
  try {
    return new URL(databaseUrl ?? '').hostname;
  } catch {
    return '(DATABASE_URL missing or not a URL)';
  }
}

// ── Plan (pure) ─────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  /** `YYYY-MM-DD` */
  date: string;
  eventName: string;
  eventType: string;
}

export interface FeatureRow {
  /** `YYYY-MM-DD` */
  date: string;
  isFomc: boolean | null;
  eventType: string | null;
  daysToNextEvent: number | null;
}

export interface EventChange {
  id: number;
  date: string;
  eventName: string;
  from: string;
  to: EconomicEventType;
}

interface Transition<From, To = From> {
  from: From;
  to: To;
}

/** A training_features row whose new values differ from what is stored. */
export interface FeatureChange {
  date: string;
  isFomc: Transition<boolean | null, boolean>;
  eventType: Transition<string | null>;
  daysToNextEvent: Transition<number | null>;
}

export interface TablePlan {
  eventRows: number;
  eventChanges: EventChange[];
  featureRows: number;
  featureChanges: FeatureChange[];
  /** training_features rows with is_fomc true, before and after. */
  isFomcBefore: number;
  isFomcAfter: number;
  /** Earliest economic_events date, and the feature rows dated before it. */
  firstEventDate: string | null;
  /** Their days_to_next_event is NULL: the table did not exist yet. */
  featureRowsBeforeFirstEvent: number;
  /**
   * Rows on or after the first event date whose next event row is more than
   * MAX_PLAUSIBLE_EVENT_GAP_DAYS away: NULL, the calendar has a hole.
   */
  featureRowsNulledByGap: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole calendar days from `from` to `to` (`YYYY-MM-DD`). UTC midnights are
 * exactly 24 h apart, so no DST shift can move the answer.
 */
export function daysBetween(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    MS_PER_DAY
  );
}

/**
 * Steps 1 and 2: reclassify every event by name, then recompute each
 * training_features row from the corrected types. The Fed-schedule and
 * priority rule is `summarizeDayEvents`; this adds nothing to it.
 * `days_to_next_event` is the gap to the next economic_events date after the
 * row's own, or null when there is none, the gap is implausible, or the row
 * is dated before the first event row (the table did not exist yet): the
 * nextEventGap rule, which addEventFeatures applies live.
 */
export function buildPlan(
  events: readonly EventRow[],
  features: readonly FeatureRow[],
): TablePlan {
  const typesByDate = new Map<string, Set<string>>();
  const eventChanges: EventChange[] = [];
  for (const e of events) {
    const to = classifyEconomicEvent(e.eventName);
    if (to !== e.eventType) {
      eventChanges.push({
        id: e.id,
        date: e.date,
        eventName: e.eventName,
        from: e.eventType,
        to,
      });
    }
    const types = typesByDate.get(e.date) ?? new Set<string>();
    types.add(to);
    typesByDate.set(e.date, types);
  }
  const eventDates = [...typesByDate.keys()].sort();
  const firstEventDate = eventDates[0] ?? null;

  const featureChanges: FeatureChange[] = [];
  let isFomcBefore = 0;
  let isFomcAfter = 0;
  let featureRowsBeforeFirstEvent = 0;
  let featureRowsNulledByGap = 0;
  for (const f of features) {
    const { isFomc, eventType } = summarizeDayEvents(
      f.date,
      typesByDate.get(f.date) ?? new Set<string>(),
    );
    const nextDate = eventDates.find((d) => d > f.date);
    const beforeTable = firstEventDate != null && f.date < firstEventDate;
    const rawGap = nextDate == null ? null : daysBetween(f.date, nextDate);
    const daysToNextEvent = nextEventGap(rawGap, beforeTable);
    if (beforeTable) featureRowsBeforeFirstEvent += 1;
    else if (rawGap != null && daysToNextEvent === null) {
      featureRowsNulledByGap += 1;
    }
    if (f.isFomc === true) isFomcBefore += 1;
    if (isFomc) isFomcAfter += 1;
    if (
      f.isFomc !== isFomc ||
      f.eventType !== eventType ||
      f.daysToNextEvent !== daysToNextEvent
    ) {
      featureChanges.push({
        date: f.date,
        isFomc: { from: f.isFomc, to: isFomc },
        eventType: { from: f.eventType, to: eventType },
        daysToNextEvent: { from: f.daysToNextEvent, to: daysToNextEvent },
      });
    }
  }
  return {
    eventRows: events.length,
    eventChanges,
    featureRows: features.length,
    featureChanges,
    isFomcBefore,
    isFomcAfter,
    firstEventDate,
    featureRowsBeforeFirstEvent,
    featureRowsNulledByGap,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Rows on the table or date, and how many of them the step would change. */
export interface Counts {
  total: number;
  matched: number;
}

export interface BackfillPlan extends TablePlan {
  /** Steps 3 and 4: market_snapshots rows. */
  snapshotsMissed: Counts;
  snapshotsWrong: Counts;
  /** Steps 3 and 4: the training_features.is_event_day rows. */
  featuresEventDayMissed: Counts;
  featuresEventDayWrong: Counts;
  /** Step 5: ws_gamma_setup_fires rows. */
  fires: Counts;
}

type Sql = ReturnType<typeof getDb>;
type Query = ReturnType<Sql>;

interface CountRow {
  total: number;
  matched: number;
}

const toCounts = (rows: unknown): Counts => {
  const row = (rows as CountRow[])[0];
  return { total: row?.total ?? 0, matched: row?.matched ?? 0 };
};

async function readEvents(sql: Sql): Promise<EventRow[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT id, to_char(date, 'YYYY-MM-DD') AS day, event_name, event_type
        FROM economic_events
       ORDER BY date, id
    `,
  )) as Array<{
    id: number;
    day: string;
    event_name: string;
    event_type: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    date: r.day,
    eventName: r.event_name,
    eventType: r.event_type,
  }));
}

async function readFeatures(sql: Sql): Promise<FeatureRow[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS day, is_fomc, event_type,
             days_to_next_event
        FROM training_features
       ORDER BY date
    `,
  )) as Array<{
    day: string;
    is_fomc: boolean | null;
    event_type: string | null;
    days_to_next_event: number | null;
  }>;
  return rows.map((r) => ({
    date: r.day,
    isFomc: r.is_fomc,
    eventType: r.event_type,
    daysToNextEvent: r.days_to_next_event,
  }));
}

/**
 * Steps 3 to 5 are guarded UPDATEs in SQL, so their dry-run numbers come from
 * a SELECT with the same predicate. The pglite test asserts a dry run and an
 * apply agree.
 */
async function readSqlCounts(
  sql: Sql,
): Promise<
  Pick<
    BackfillPlan,
    | 'snapshotsMissed'
    | 'snapshotsWrong'
    | 'featuresEventDayMissed'
    | 'featuresEventDayWrong'
    | 'fires'
  >
> {
  const decisionDates = [...FOMC_DECISION_DATES];
  const [
    snapshotsMissed,
    snapshotsWrong,
    featuresMissed,
    featuresWrong,
    fires,
  ] = await Promise.all([
    withDbRetry(
      () => sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE event_names IS NULL OR event_names = '{}'
                 )::int AS matched
            FROM market_snapshots
           WHERE date = ${FOMC_MISSED_DATE}::date
        `,
    ),
    withDbRetry(
      () => sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE 'FOMC' = ANY(event_names))::int AS matched
            FROM market_snapshots
           WHERE date = ${FOMC_WRONG_DATE}::date
        `,
    ),
    withDbRetry(
      () => sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE is_event_day IS DISTINCT FROM true
                 )::int AS matched
            FROM training_features
           WHERE date = ${FOMC_MISSED_DATE}::date
        `,
    ),
    withDbRetry(
      () => sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE s.any_event IS NOT NULL
                     AND t.is_event_day IS DISTINCT FROM s.any_event
                 )::int AS matched
            FROM training_features t
           CROSS JOIN (
                   SELECT bool_or(cardinality(array_remove(event_names, 'FOMC')) > 0)
                            AS any_event
                     FROM market_snapshots
                    WHERE date = ${FOMC_WRONG_DATE}::date
                 ) s
           WHERE t.date = ${FOMC_WRONG_DATE}::date
        `,
    ),
    withDbRetry(
      () => sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE NOT is_fomc_day
                     AND (fired_at AT TIME ZONE 'America/New_York')::date
                         = ANY(${decisionDates}::date[])
                 )::int AS matched
            FROM ws_gamma_setup_fires
        `,
    ),
  ]);
  return {
    snapshotsMissed: toCounts(snapshotsMissed),
    snapshotsWrong: toCounts(snapshotsWrong),
    featuresEventDayMissed: toCounts(featuresMissed),
    featuresEventDayWrong: toCounts(featuresWrong),
    fires: toCounts(fires),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** The statements, in transaction order; also the keys of `Written`. */
export const STEPS = [
  'economic_events',
  'training_features',
  'market_snapshots_missed',
  'market_snapshots_wrong',
  'training_features_event_day_missed',
  'training_features_event_day_wrong',
  'ws_gamma_setup_fires',
] as const;
export type StepName = (typeof STEPS)[number];

/** Rows each step wrote (RETURNING), summed over its chunks. */
export type Written = Record<StepName, number>;

const emptyWritten = (): Written => ({
  economic_events: 0,
  training_features: 0,
  market_snapshots_missed: 0,
  market_snapshots_wrong: 0,
  training_features_event_day_missed: 0,
  training_features_event_day_wrong: 0,
  ws_gamma_setup_fires: 0,
});

/** What the plan expects each step to write. */
export function plannedWrites(plan: BackfillPlan): Written {
  return {
    economic_events: plan.eventChanges.length,
    training_features: plan.featureChanges.length,
    market_snapshots_missed: plan.snapshotsMissed.matched,
    market_snapshots_wrong: plan.snapshotsWrong.matched,
    training_features_event_day_missed: plan.featuresEventDayMissed.matched,
    training_features_event_day_wrong: plan.featuresEventDayWrong.matched,
    ws_gamma_setup_fires: plan.fires.matched,
  };
}

const totalPlanned = (plan: BackfillPlan): number =>
  Object.values(plannedWrites(plan)).reduce((a, b) => a + b, 0);

/**
 * Every UPDATE, built fresh per attempt (a retry must not reuse a spent
 * query). Each is guarded by the value it changes (IS DISTINCT FROM, the old
 * event_names, the flag still false), so a rerun matches nothing. The
 * `unnest` statements go in chunks of WRITE_CHUNK rows.
 */
function buildStatements(sql: Sql, plan: BackfillPlan) {
  const statements: Array<{ step: StepName; query: Query }> = [];
  const add = (step: StepName, query: Query) =>
    statements.push({ step, query });

  // 1. economic_events, keyed on the primary key: the unique key
  //    (date, event_name, event_time) can hold NULL times, which never `=`.
  for (let i = 0; i < plan.eventChanges.length; i += WRITE_CHUNK) {
    const chunk = plan.eventChanges.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((c) => c.id);
    const types = chunk.map((c) => c.to);
    add(
      'economic_events',
      sql`
        UPDATE economic_events t
           SET event_type = v.event_type
          FROM unnest(${ids}::int[], ${types}::text[]) AS v(id, event_type)
         WHERE t.id = v.id
           AND t.event_type IS DISTINCT FROM v.event_type
        RETURNING t.id
      `,
    );
  }

  // 2. training_features: a direct UPDATE (the build-features upsert's
  //    COALESCE cannot clear a stale value). event_count is not touched.
  for (let i = 0; i < plan.featureChanges.length; i += WRITE_CHUNK) {
    const chunk = plan.featureChanges.slice(i, i + WRITE_CHUNK);
    const dates = chunk.map((c) => c.date);
    const isFomc = chunk.map((c) => c.isFomc.to);
    const eventTypes = chunk.map((c) => c.eventType.to);
    const days = chunk.map((c) => c.daysToNextEvent.to);
    add(
      'training_features',
      sql`
        UPDATE training_features t
           SET is_fomc = v.is_fomc,
               event_type = v.event_type,
               days_to_next_event = v.days_to_next_event
          FROM unnest(${dates}::date[], ${isFomc}::boolean[],
                      ${eventTypes}::text[], ${days}::int[])
               AS v(date, is_fomc, event_type, days_to_next_event)
         WHERE t.date = v.date
           AND (t.is_fomc, t.event_type, t.days_to_next_event)
               IS DISTINCT FROM (v.is_fomc, v.event_type, v.days_to_next_event)
        RETURNING t.date
      `,
    );
  }

  // 3. 2026-04-29: a snapshot with no event names gains FOMC.
  add(
    'market_snapshots_missed',
    sql`
      UPDATE market_snapshots
         SET is_event_day = true,
             event_names = ARRAY['FOMC']
       WHERE date = ${FOMC_MISSED_DATE}::date
         AND (event_names IS NULL OR event_names = '{}')
      RETURNING id
    `,
  );
  add(
    'training_features_event_day_missed',
    sql`
      UPDATE training_features
         SET is_event_day = true
       WHERE date = ${FOMC_MISSED_DATE}::date
         AND is_event_day IS DISTINCT FROM true
      RETURNING date
    `,
  );

  // 4. 2026-05-06: FOMC leaves event_names, and is_event_day follows what is
  //    left (SET reads the old row, so array_remove is applied to it again).
  add(
    'market_snapshots_wrong',
    sql`
      UPDATE market_snapshots
         SET event_names = array_remove(event_names, 'FOMC'),
             is_event_day = cardinality(array_remove(event_names, 'FOMC')) > 0
       WHERE date = ${FOMC_WRONG_DATE}::date
         AND 'FOMC' = ANY(event_names)
      RETURNING id
    `,
  );
  //    The feature row mirrors the day's snapshots as they will be: any name
  //    left once FOMC is removed. Written with array_remove, not read from
  //    the rows above, so a dry run counts the same rows.
  add(
    'training_features_event_day_wrong',
    sql`
      UPDATE training_features t
         SET is_event_day = s.any_event
        FROM (
               SELECT bool_or(cardinality(array_remove(event_names, 'FOMC')) > 0)
                        AS any_event
                 FROM market_snapshots
                WHERE date = ${FOMC_WRONG_DATE}::date
             ) s
       WHERE t.date = ${FOMC_WRONG_DATE}::date
         AND s.any_event IS NOT NULL
         AND t.is_event_day IS DISTINCT FROM s.any_event
      RETURNING t.date
    `,
  );

  // 5. Fires on a decision day, by the fire's ET date (not UTC).
  const decisionDates = [...FOMC_DECISION_DATES];
  add(
    'ws_gamma_setup_fires',
    sql`
      UPDATE ws_gamma_setup_fires
         SET is_fomc_day = true
       WHERE NOT is_fomc_day
         AND (fired_at AT TIME ZONE 'America/New_York')::date
             = ANY(${decisionDates}::date[])
      RETURNING id
    `,
  );
  return statements;
}

/**
 * Write the whole plan in one transaction and return the rows each step
 * wrote. Exported for the pglite test, which replays a stale plan to show the
 * guards match nothing.
 */
export async function writePlan(
  sql: Sql,
  plan: BackfillPlan,
): Promise<Written> {
  const { steps, results } = await withDbRetry(async () => {
    const statements = buildStatements(sql, plan);
    return {
      steps: statements.map((s) => s.step),
      results: (await sql.transaction(
        statements.map((s) => s.query),
      )) as unknown[][],
    };
  });
  const written = emptyWritten();
  for (const [i, step] of steps.entries()) {
    written[step] += results[i]?.length ?? 0;
  }
  return written;
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface BackfillResult {
  plan: BackfillPlan;
  /** Whether --apply was passed. */
  apply: boolean;
  /** Null for a dry run (and when an apply had nothing to write). */
  written: Written | null;
}

/**
 * Read everything, compute the plan, and (with `apply`) write it in one
 * transaction. A plan with nothing to change writes nothing and opens no
 * transaction. An economic_events read of zero rows, with training_features
 * rows present, throws in both modes before anything is planned. A DB error
 * propagates after withDbRetry; the transaction rolls back as a whole.
 */
export async function runBackfill(opts: {
  apply: boolean;
}): Promise<BackfillResult> {
  const sql = getDb();
  const [events, features, sqlCounts] = await Promise.all([
    readEvents(sql),
    readFeatures(sql),
    readSqlCounts(sql),
  ]);
  // Hard stop, dry run included. With no events every training_features row
  // would be recomputed from an empty calendar: no event_type, no
  // days_to_next_event, is_fomc from the schedule alone.
  if (events.length === 0 && features.length > 0) {
    throw new Error(
      'economic_events read returned 0 rows; refusing to touch training_features',
    );
  }
  const plan: BackfillPlan = { ...buildPlan(events, features), ...sqlCounts };
  if (!opts.apply || totalPlanned(plan) === 0) {
    return { plan, apply: opts.apply, written: null };
  }
  return { plan, apply: true, written: await writePlan(sql, plan) };
}

// ── Report ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

function eventLines(plan: BackfillPlan): string[] {
  const lines = [
    `economic_events: ${plan.eventRows} rows read, ${plan.eventChanges.length} change type`,
  ];
  const byTransition = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const c of plan.eventChanges) {
    const transition = `${c.from} → ${c.to}`;
    byTransition.set(transition, (byTransition.get(transition) ?? 0) + 1);
    const key = `${transition}  ${c.eventName}`;
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }
  for (const [transition, n] of [...byTransition].sort()) {
    lines.push(`  ${transition}: ${n}`);
  }
  if (byName.size > 0) {
    lines.push(`  changed event names (${byName.size} distinct):`);
    for (const [key, n] of [...byName].sort()) {
      lines.push(`    ${key} (${plural(n, 'row')})`);
    }
  }
  return lines;
}

function featureLines(plan: BackfillPlan): string[] {
  const changes = plan.featureChanges;
  const flips = changes.filter((c) => (c.isFomc.from === true) !== c.isFomc.to);
  const lines = [
    `training_features: ${plan.featureRows} rows read, ${changes.length} change`,
    `  is_fomc true: ${plan.isFomcBefore} → ${plan.isFomcAfter}`,
    `  is_fomc flips (${flips.length}): ${
      flips
        .map((c) => `${c.date} ${c.isFomc.from}→${c.isFomc.to}`)
        .join(', ') || 'none'
    }`,
    `  event_type changes: ${
      changes.filter((c) => c.eventType.from !== c.eventType.to).length
    }`,
    `  days_to_next_event changes: ${
      changes.filter((c) => c.daysToNextEvent.from !== c.daysToNextEvent.to)
        .length
    }`,
  ];
  if (plan.firstEventDate != null) {
    lines.push(
      `  first economic_events date: ${plan.firstEventDate}; training_features rows before it: ${plan.featureRowsBeforeFirstEvent} (days_to_next_event NULL: the table did not exist yet)`,
    );
  }
  lines.push(
    `  rows NULLed by the gap rule (next event row more than ${MAX_PLAUSIBLE_EVENT_GAP_DAYS} days out, so calendar rows are missing): ${plan.featureRowsNulledByGap}`,
  );
  return lines;
}

function sqlStepLines(plan: BackfillPlan): string[] {
  const rows = (c: Counts) => `${c.matched} of ${c.total} rows match`;
  return [
    'is_event_day:',
    `  ${FOMC_MISSED_DATE}: market_snapshots ${rows(plan.snapshotsMissed)}; training_features ${rows(plan.featuresEventDayMissed)}`,
    `  ${FOMC_WRONG_DATE}: market_snapshots ${rows(plan.snapshotsWrong)}; training_features ${rows(plan.featuresEventDayWrong)}`,
    `ws_gamma_setup_fires: ${rows(plan.fires)} (is_fomc_day false → true)`,
  ];
}

/** The printable summary of a dry run or an apply. */
export function formatReport(result: BackfillResult): string {
  const { plan, apply, written } = result;
  const planned = plannedWrites(plan);
  const lines = [
    `Economic event label backfill: ${
      apply ? 'APPLY (writes in one transaction)' : 'DRY RUN (writes nothing)'
    }`,
    '',
    ...eventLines(plan),
    '',
    ...featureLines(plan),
    '',
    ...sqlStepLines(plan),
    '',
  ];
  if (totalPlanned(plan) === 0) {
    lines.push('Nothing to change: every label is already correct.');
  } else if (written == null) {
    lines.push('Dry run: nothing written. Re-run with --apply to write.');
  } else {
    const counts = STEPS.map((s) => `${s} ${written[s]}`).join(', ');
    lines.push(`Written in one transaction: ${counts}.`);
    for (const step of STEPS) {
      if (written[step] !== planned[step]) {
        lines.push(
          `WARNING: ${step} planned ${planned[step]}, wrote ${written[step]} (rows changed after the read)`,
        );
      }
    }
  }
  return lines.join('\n');
}
