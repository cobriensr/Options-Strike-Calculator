/**
 * One-shot backfill of `wave2_status` on lottery_finder_fires and
 * silent_boom_alerts. Logic for scripts/backfill-wave2-status.ts (usage and
 * runbook are in that header); it lives here so vitest covers it
 * (scripts/_lib/**).
 *
 * Why: api/cron/wave2-confirmation.ts labels a fire 'confirmed', 'lagging'
 * or 'fizzled', but it only looks at fires 75 to 90 minutes old (it labels a
 * fire once it has settled) and its gate used to stop at the close, so fires
 * from about 15:00 ET on never got a label, and a cron outage day
 * (2026-05-18 before the deploy, 05-20, 05-26, 06-10) left every fire of the
 * day unevaluated. Nothing revisits a NULL row older than 90 minutes. This
 * does, once.
 *
 * The rule is the cron's, not a copy of it. The verdict (the 30 and 60
 * minute bounds, the 75-minute settle age, the `wave2_detected_at` value) is
 * `wave2Verdict` from api/_lib/wave2-rule.ts, the same function the cron
 * calls. Only the follow-up LOOKUP is restated here, as a LATERAL join over
 * a page of candidates instead of one SELECT per candidate; it applies the
 * cron's predicate (same underlying_symbol and option_type, a different id,
 * strictly after the trigger, no later than LAGGING_WINDOW_MIN minutes
 * after it, earliest first). It truncates the trigger to the millisecond
 * because the cron builds its lookup bound from a JS Date. The parity test
 * (wave2-backfill.test.ts) runs the cron's real handler and this backfill
 * over the same rows on real Postgres and compares every row.
 *
 * Writes the cron's columns and nothing else: `wave2_status` always, and
 * `wave2_detected_at` for a follow-up verdict (never for 'fizzled', whose
 * cron UPDATE leaves it alone). No push, no notification.
 *
 * Scope, per table: rows with `wave2_status IS NULL`, at or after the
 * table's first labelled trigger time (read at run time), and more than
 * MIN_AGE_HOURS old. Rows before the first label predate the feature and
 * stay NULL; rows under MIN_AGE_HOURS belong to the cron.
 *
 * Shape (R5, R6): per ET trading day, oldest first, pages of PAGE_SIZE
 * candidates in id order. Each page is one read (candidates and their
 * earliest follow-up) and at most two bulk UPDATEs (follow-up verdicts via
 * unnest, fizzles via ANY), every one guarded by `wave2_status IS NULL`. So
 * a re-run, or a run beside the cron, never changes a label that exists,
 * and a run that died just continues: the finished rows no longer match the
 * scope.
 */

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  LAGGING_WINDOW_MIN,
  WAVE2_TABLES,
  wave2Verdict,
  type Wave2Status,
  type Wave2Table,
} from '../../api/_lib/wave2-rule.js';

/** A row must be older than this to be in scope; younger ones are the cron's. */
const MIN_AGE_HOURS = 2;

/** Candidates read per page, and the most rows one UPDATE writes. */
const PAGE_SIZE = 500;

/**
 * Per-attempt cap on one statement. A page is up to 500 indexed lookups,
 * a few seconds at most; a hung attempt retries (every statement is
 * idempotent).
 */
const ATTEMPT_TIMEOUT_MS = 60_000;

/** The status the cron gives a fire with no follow-up. */
const FIZZLED: Wave2Status = 'fizzled';

const USAGE = 'usage: backfill-wave2-status.ts [--dry-run] [--limit N]';

export interface BackfillOptions {
  /** Read and report only; no UPDATE. */
  dryRun: boolean;
  /** Write at most this many rows per table (null: no limit). */
  limit: number | null;
}

/** Parse the CLI flags; throws a message the CLI prints on a bad one. */
export function parseArgs(argv: readonly string[]): BackfillOptions {
  let dryRun = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--limit') {
      const raw = argv[i + 1];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new Error(
          `--limit needs a positive whole number, e.g. --limit 50\n${USAGE}`,
        );
      }
      limit = Number.parseInt(raw, 10);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return { dryRun, limit };
}

type StatusCounts = Record<Wave2Status, number>;

function emptyCounts(): StatusCounts {
  return { confirmed: 0, lagging: 0, fizzled: 0 };
}

function sumCounts(c: StatusCounts): number {
  return c.confirmed + c.lagging + c.fizzled;
}

function describeCounts(c: StatusCounts): string {
  return `confirmed ${c.confirmed} · lagging ${c.lagging} · fizzled ${c.fizzled}`;
}

/** One statement through the retry wrapper. Identifiers in `text` are code constants. */
async function run<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const sql = getDb();
  return (await withDbRetry(
    () => sql.query(text, params),
    2,
    ATTEMPT_TIMEOUT_MS,
  )) as T[];
}

interface Scope {
  /** The table's first labelled trigger time, as timestamptz text (full precision). */
  boundary: string;
  /** Rows at or before this are old enough (timestamptz text). */
  cutoff: string;
  /** The database clock when the scope was read, epoch ms. */
  nowMs: number;
}

/**
 * The scope for one table, read from the database: the first labelled row
 * is a query, not a date in the code. Null when nothing is labelled yet (no
 * anchor, so nothing is in scope). The cutoff and "now" come from the
 * database clock so a skewed local clock cannot change what counts as old.
 */
async function loadScope(t: Wave2Table): Promise<Scope | null> {
  const [row] = await run<{
    boundary: string | null;
    cutoff: string;
    now_ms: string | number;
  }>(
    `SELECT min(${t.triggerCol})::text AS boundary,
            (now() - ($1::int * INTERVAL '1 hour'))::text AS cutoff,
            floor(extract(epoch FROM now()) * 1000)::float8 AS now_ms
       FROM ${t.table}
      WHERE wave2_status IS NOT NULL`,
    [MIN_AGE_HOURS],
  );
  if (!row || row.boundary === null) return null;
  return {
    boundary: row.boundary,
    cutoff: row.cutoff,
    nowMs: Number(row.now_ms),
  };
}

interface PendingCounts {
  /** NULL rows in scope. */
  inScope: number;
  /** NULL rows before the first labelled row: out of scope, left alone. */
  beforeBoundary: number;
}

async function countPending(
  t: Wave2Table,
  scope: Scope,
): Promise<PendingCounts> {
  const [row] = await run<{ in_scope: number; before_boundary: number }>(
    `SELECT count(*) FILTER (WHERE ${t.triggerCol} >= $1::timestamptz
                              AND ${t.triggerCol} <= $2::timestamptz)::int AS in_scope,
            count(*) FILTER (WHERE ${t.triggerCol} < $1::timestamptz)::int AS before_boundary
       FROM ${t.table}
      WHERE wave2_status IS NULL`,
    [scope.boundary, scope.cutoff],
  );
  return {
    inScope: row?.in_scope ?? 0,
    beforeBoundary: row?.before_boundary ?? 0,
  };
}

/** The ET trading days that hold in-scope rows, oldest first, with row counts. */
async function planDays(
  t: Wave2Table,
  scope: Scope,
): Promise<Array<{ day: string; n: number }>> {
  return run<{ day: string; n: number }>(
    `SELECT to_char((${t.triggerCol} AT TIME ZONE 'America/New_York')::date,
                    'YYYY-MM-DD') AS day,
            count(*)::int AS n
       FROM ${t.table}
      WHERE wave2_status IS NULL
        AND ${t.triggerCol} >= $1::timestamptz
        AND ${t.triggerCol} <= $2::timestamptz
      GROUP BY 1
      ORDER BY 1`,
    [scope.boundary, scope.cutoff],
  );
}

type DbTimestamp = string | Date;

interface PageRow {
  /** Text: BIGSERIAL arrives as a string from the HTTP driver. */
  id: string;
  trigger_time: DbTimestamp;
  followup_time: DbTimestamp | null;
}

/**
 * One page of an ET day's in-scope rows after `afterId`, each with its
 * earliest follow-up (null when there is none). The LATERAL block is the
 * cron's follow-up SELECT, run for a whole page at once; see the header.
 * The day is bounded by ET midnights via `::date::timestamp AT TIME ZONE`,
 * so the session time zone cannot shift it.
 */
async function loadPage(
  t: Wave2Table,
  scope: Scope,
  day: string,
  afterId: string,
  size: number,
): Promise<PageRow[]> {
  const col = t.triggerCol;
  return run<PageRow>(
    `SELECT c.id::text AS id,
            c.${col} AS trigger_time,
            f.followup_time
       FROM ${t.table} c
       LEFT JOIN LATERAL (
         SELECT x.${col} AS followup_time
           FROM ${t.table} x
          WHERE x.underlying_symbol = c.underlying_symbol
            AND x.option_type = c.option_type
            AND x.id <> c.id
            AND x.${col} > date_trunc('milliseconds', c.${col})
            AND x.${col} <= date_trunc('milliseconds', c.${col})
                            + ($1::int * INTERVAL '1 minute')
          ORDER BY x.${col} ASC
          LIMIT 1
       ) f ON TRUE
      WHERE c.wave2_status IS NULL
        AND c.${col} >= $2::timestamptz
        AND c.${col} <= $3::timestamptz
        AND c.${col} >= ($4::date::timestamp AT TIME ZONE 'America/New_York')
        AND c.${col} <  (($4::date + 1)::timestamp AT TIME ZONE 'America/New_York')
        AND c.id > $5::bigint
      ORDER BY c.id
      LIMIT $6::int`,
    [LAGGING_WINDOW_MIN, scope.boundary, scope.cutoff, day, afterId, size],
  );
}

interface FollowupWrite {
  id: string;
  status: 'confirmed' | 'lagging';
  detectedAtIso: string;
}

interface PagePlan {
  followups: FollowupWrite[];
  fizzledIds: string[];
  /** Rows the rule leaves in flight (cannot happen past MIN_AGE_HOURS). */
  inFlight: number;
}

/** Apply the cron's verdict function to every row of a page. */
function planPage(rows: readonly PageRow[], nowMs: number): PagePlan {
  const plan: PagePlan = { followups: [], fizzledIds: [], inFlight: 0 };
  for (const row of rows) {
    const verdict = wave2Verdict(
      new Date(row.trigger_time).getTime(),
      row.followup_time === null ? null : new Date(row.followup_time).getTime(),
      nowMs,
    );
    if (verdict === null) {
      plan.inFlight += 1;
    } else if (verdict.status === 'fizzled') {
      plan.fizzledIds.push(row.id);
    } else {
      plan.followups.push({
        id: row.id,
        status: verdict.status,
        detectedAtIso: verdict.detectedAtIso,
      });
    }
  }
  return plan;
}

/** What the plan would write, by status. */
function planCounts(plan: PagePlan): StatusCounts {
  const counts = emptyCounts();
  for (const f of plan.followups) counts[f.status] += 1;
  counts.fizzled = plan.fizzledIds.length;
  return counts;
}

function tally(rows: ReadonlyArray<{ status: Wave2Status }>): StatusCounts {
  const counts = emptyCounts();
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

/**
 * Write a page: at most PAGE_SIZE rows in total, in the cron's two UPDATE
 * shapes. A follow-up verdict sets `wave2_status` and `wave2_detected_at`;
 * a fizzle sets `wave2_status` only. Both require `wave2_status IS NULL`,
 * so a row already labelled when the UPDATE runs is skipped and not counted.
 * Returns what was actually written, from RETURNING.
 */
async function writePage(t: Wave2Table, plan: PagePlan): Promise<StatusCounts> {
  const written = emptyCounts();
  if (plan.followups.length > 0) {
    const rows = await run<{ status: Wave2Status }>(
      `UPDATE ${t.table} AS t
          SET wave2_status = v.status,
              wave2_detected_at = v.detected_at
         FROM unnest($1::bigint[], $2::text[], $3::timestamptz[])
              AS v(id, status, detected_at)
        WHERE t.id = v.id
          AND t.wave2_status IS NULL
       RETURNING t.wave2_status AS status`,
      [
        plan.followups.map((f) => f.id),
        plan.followups.map((f) => f.status),
        plan.followups.map((f) => f.detectedAtIso),
      ],
    );
    const counts = tally(rows);
    written.confirmed += counts.confirmed;
    written.lagging += counts.lagging;
  }
  if (plan.fizzledIds.length > 0) {
    const rows = await run<{ status: Wave2Status }>(
      `UPDATE ${t.table}
          SET wave2_status = $1
        WHERE id = ANY($2::bigint[])
          AND wave2_status IS NULL
       RETURNING wave2_status AS status`,
      [FIZZLED, plan.fizzledIds],
    );
    written.fizzled += tally(rows).fizzled;
  }
  return written;
}

interface DayOutcome {
  /** Rows given a verdict this day: written, or planned in a dry run. */
  counts: StatusCounts;
  /**
   * Rows the plan wanted to write but found already labelled when the UPDATE
   * ran: another writer, or an earlier attempt of the same UPDATE that
   * `withDbRetry` abandoned on its client-side timeout but that committed.
   */
  skippedLabelled: number;
  inFlight: number;
}

/**
 * One ET day of one table, page by page in id order. `budget` caps the rows
 * handled (the `--limit`); the pages shrink to fit it.
 */
async function processDay(
  t: Wave2Table,
  scope: Scope,
  day: string,
  opts: BackfillOptions,
  budget: number,
): Promise<DayOutcome> {
  const outcome: DayOutcome = {
    counts: emptyCounts(),
    skippedLabelled: 0,
    inFlight: 0,
  };
  let afterId = '0';
  while (budget - sumCounts(outcome.counts) > 0) {
    const size = Math.min(PAGE_SIZE, budget - sumCounts(outcome.counts));
    const rows = await loadPage(t, scope, day, afterId, size);
    if (rows.length === 0) break;
    const plan = planPage(rows, scope.nowMs);
    const planned = planCounts(plan);
    const done = opts.dryRun ? planned : await writePage(t, plan);
    for (const status of ['confirmed', 'lagging', 'fizzled'] as const) {
      outcome.counts[status] += done[status];
    }
    outcome.skippedLabelled += sumCounts(planned) - sumCounts(done);
    outcome.inFlight += plan.inFlight;
    // The cursor moves past every row read, written or not, so a row that
    // stays NULL (in flight) or was already labelled cannot loop.
    afterId = rows.at(-1)?.id ?? afterId;
    if (rows.length < size) break;
  }
  return outcome;
}

/**
 * Backfill one table end to end, printing a line per ET day. Returns the
 * in-scope NULL rows left after a run that wrote, or null (a dry run, or a
 * table with no first label).
 */
async function backfillTable(
  t: Wave2Table,
  opts: BackfillOptions,
): Promise<number | null> {
  console.log(`\n== ${t.table} (${t.triggerCol})`);
  const scope = await loadScope(t);
  if (scope === null) {
    console.log(
      'No labelled row yet, so there is no first label to anchor the scope: skipped.',
    );
    return null;
  }
  const pending = await countPending(t, scope);
  const days = await planDays(t, scope);
  console.log(
    `First labelled row: ${scope.boundary}. In scope: ${pending.inScope} NULL rows ` +
      `older than ${MIN_AGE_HOURS} h across ${days.length} ET days. ` +
      `Left alone (before the first label): ${pending.beforeBoundary}.`,
  );

  const total = emptyCounts();
  let skippedLabelled = 0;
  let inFlight = 0;
  const verb = opts.dryRun ? 'would write' : 'wrote';
  for (const [i, d] of days.entries()) {
    const remaining =
      (opts.limit ?? Number.POSITIVE_INFINITY) - sumCounts(total);
    if (remaining <= 0) break;
    const started = Date.now();
    const day = await processDay(t, scope, d.day, opts, remaining);
    for (const status of ['confirmed', 'lagging', 'fizzled'] as const) {
      total[status] += day.counts[status];
    }
    skippedLabelled += day.skippedLabelled;
    inFlight += day.inFlight;
    console.log(
      `[${i + 1}/${days.length}] ${d.day}  ${verb} ${sumCounts(day.counts)} ` +
        `of ${d.n}: ${describeCounts(day.counts)} (${Date.now() - started} ms)`,
    );
    if (day.skippedLabelled > 0) {
      console.warn(
        `  warning: ${day.skippedLabelled} rows on ${d.day} were already labelled when the UPDATE ran (another writer, or an earlier attempt that timed out but committed) and were left as they are.`,
      );
    }
  }
  if (opts.limit !== null && sumCounts(total) >= opts.limit) {
    console.log(`Limit reached (${opts.limit} rows); the rest is untouched.`);
  }
  if (inFlight > 0) {
    console.warn(
      `warning: ${inFlight} rows were still in flight by the rule and were skipped.`,
    );
  }
  console.log(
    `${t.table}: ${verb} ${sumCounts(total)} rows: ${describeCounts(total)}.` +
      (skippedLabelled > 0 ? ` ${skippedLabelled} already labelled.` : ''),
  );

  if (opts.dryRun) return null;
  const after = (await countPending(t, scope)).inScope;
  console.log(
    `${t.table}: NULL rows in scope, before ${pending.inScope} · after ${after}.`,
  );
  return after;
}

/**
 * The whole run, for both tables. Returns the process exit code: 0 for a
 * dry run or a `--limit` run, and for a full run that left no in-scope NULL
 * row; 1 for a full run that did (a concurrent writer or a skipped row:
 * re-run to finish). A database error propagates after `withDbRetry`; the
 * pages already written stay written and a re-run continues.
 */
export async function runBackfill(opts: BackfillOptions): Promise<number> {
  const limitNote =
    opts.limit === null ? '' : `, at most ${opts.limit} rows per table`;
  console.log(
    `wave2_status backfill: ${
      opts.dryRun ? 'DRY RUN (no writes)' : 'APPLY (writes)'
    }${limitNote}.`,
  );
  console.log(
    `Scope: wave2_status IS NULL, at or after each table's first labelled row, older than ${MIN_AGE_HOURS} h.`,
  );

  let exitCode = 0;
  for (const t of WAVE2_TABLES) {
    const left = await backfillTable(t, opts);
    if (opts.limit === null && left !== null && left > 0) {
      console.error(
        `${t.table}: ${left} in-scope rows are still NULL. Re-run to finish.`,
      );
      exitCode = 1;
    }
  }
  if (opts.dryRun) {
    console.log('\nDry run: nothing written.');
  } else if (exitCode === 0) {
    console.log('\nDone.');
  } else {
    console.log('\nNot finished: re-run to continue.');
  }
  return exitCode;
}
