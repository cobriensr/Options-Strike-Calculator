/**
 * Re-score the lottery fires whose V2 score is NULL only because the detector
 * wrote them without flow. Spec: docs/superpowers/specs/
 * sentry-noise-fixes-2026-11-13.md, Phase 5 ("The repair").
 *
 * Why the rows exist. `detect-lottery-fires` reads one ticker-day's net-flow
 * series before it scores a fire. When that read passed its deadline, the fire
 * was still written, with `cum_ncp_at_fire` / `cum_npp_at_fire` NULL, and a
 * fire with no flow is not aligned, so its V2 score is NULL too. 2,032 fires
 * from 2026-10-29 to 2026-11-13 are that kind. `backfill-ticker-flow-at-fire.mjs`
 * fills the two flow columns from the net-flow tables, point in time. This
 * script is the second step: it gives those rows the score the detector would
 * have given them.
 *
 * The score is the live one, and so is its version. The scoring function is
 * `scoreLotteryV2`, called as the cron calls it, with the weights of the
 * version the `active` pointer names (`loadLotteryWeights().active`, the
 * loader the cron scores with), and the fire is tagged with that version in
 * `score_version`, as the cron's INSERT tags it. The inputs are the same as
 * the cron's: the row's own columns, `isAlignedFire` on the stored flow, and
 * `weekdayOf` on the fire's date. A parity test pins the two together. This is
 * the version rule of the one whole-table rescore
 * (`scripts/backfill_lottery_scores.py`, run without `--version`): the active
 * version, and the pointer must still name it when a row is written. That
 * rescore cannot do this job: it has no way to scope a run, and rewrites every
 * fire (about 1.06 million rows at the first promotion, per the Phase 4 plan,
 * D5), where this repair must touch only the fires that had no flow. If the
 * store cannot be read the loader answers with the seed in both slots; this
 * script stops instead, as it would otherwise tag rows with a version the
 * store did not give it.
 *
 * What it writes: `score` and `score_version`, on rows where `score` is NULL,
 * and nothing else.
 *   - `cluster_bonus` is not touched. The cron stores it in its own column and
 *     never folds it into `score`, so a recomputed `score` is complete without
 *     it. (A neighbour's bonus counts co-firing tier-1 tickers by score, so a
 *     NULL-score fire never counted; rerunning
 *     `backfill-lottery-cluster-bonus.py` afterwards is a separate, owner
 *     decision.)
 *   - `score_version` takes the active version, whatever tag the row held
 *     (NULL for a fire from before the store, or the version the cron wrote
 *     with its NULL score). The undo file keeps the old tag of each row.
 *   - `combined_score` is a generated column and follows `score`.
 *
 * Which rows. `score IS NULL`, both flow columns set, `dte` 0 to 3, on or
 * after `--since`. A row the V2 scorer still gives NULL (a fire against the
 * flow) is examined and left as it is, tag and all. A second run therefore
 * selects the same rows, scores them the same way, and writes nothing.
 *
 * Writes are batches of 500 through `unnest`, each guarded again by `score IS
 * NULL`, by the `score_version` the row held when it was read, and by the
 * `active` pointer still naming the version being written. So a row some other
 * writer scored or tagged in between is never overwritten, and a promotion
 * that moves the pointer stops the writes. Each batch is its own statement, so
 * a failed run stops cleanly and a rerun finishes it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDb } from '../../api/_lib/db.js';
import {
  isAlignedFire,
  scoreLotteryV2,
  weekdayOf,
} from '../../api/_lib/lottery-score-weights-v2.js';
import {
  loadLotteryWeights,
  type VersionedWeights,
} from '../../api/_lib/lottery-weights-loader.js';
import type {
  LotteryWeights,
  TimeOfDay,
} from '../../api/_lib/lottery-weights-schema.js';

type Sql = ReturnType<typeof getDb>;

/**
 * The first ET trading day the seed weights were live. Commit f9f220fa put
 * them on the scorer on 2026-09-07 (after the close; plan
 * 2026-11-05-nightly-pipeline-phase4.md, "quintile-boundary bug" section), and
 * a fire before that day was scored with older weights. Re-scoring one here
 * would be a methodology change (the whole-table rescore does it on purpose,
 * at a promotion), so `--since` may not go back past this day.
 */
export const SEED_WEIGHTS_LIVE_FROM = '2026-09-08';

/** Rows per UPDATE, as everywhere in this repo's batch writes (R5). */
const WRITE_CHUNK = 500;
/** Rows per SELECT page: a keyset page on `id`, so memory stays bounded. */
const PAGE_SIZE = 5_000;

export const UNDO_DIR = 'docs/tmp/lottery-v2-rescore';

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  /** `YYYY-MM-DD`, or null when `--help` was asked for without one. */
  since: string | null;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/rescore-lottery-v2-after-flow-backfill.ts --since YYYY-MM-DD [options]

Gives lottery_finder_fires rows the V2 score the detector would give them now,
where the score is NULL, the flow columns are now set (run
backfill-ticker-flow-at-fire.mjs first) and dte is 0 to 3. It scores with the
weights of the version the 'active' pointer names and tags the row with that
version in score_version, as the detector does. Writes only \`score\` and
\`score_version\`, only where the score is NULL, and only while the pointer
still names that version. A second run writes nothing.

Options:
  --since <date>     first fire date to cover, YYYY-MM-DD (required; not before
                     ${SEED_WEIGHTS_LIVE_FROM}, the first day the seed weights were live)
  --apply            write (without it: dry run, which writes nothing)
  --dry-run          the default, said aloud; contradicts --apply
  --env-file <path>  .env.local to load (default: the nearest one up the tree)
  --help, -h         print this and exit`;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let help = false;
  let since: string | null = null;
  let envFile: string | null = null;
  const valueOf = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--since') {
      since = valueOf(flag, i);
      i += 1;
    } else if (flag === '--env-file') {
      envFile = valueOf(flag, i);
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run contradict');
  if (help) return { apply, since, envFile, help };
  if (since == null) throw new Error('--since YYYY-MM-DD is required');
  if (!isIsoDate(since)) {
    throw new Error(`--since ${since} is not a YYYY-MM-DD date`);
  }
  if (since < SEED_WEIGHTS_LIVE_FROM) {
    throw new Error(
      `--since ${since} is before ${SEED_WEIGHTS_LIVE_FROM}, the first day the seed weights were live: earlier fires were scored with older weights, and re-scoring them here would change their meaning`,
    );
  }
  return { apply, since, envFile, help };
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** One candidate row, with every input the scorer takes. */
export interface CandidateRow {
  id: string;
  /** `YYYY-MM-DD` */
  date: string;
  underlying_symbol: string;
  tod: string;
  dte: number;
  option_type: 'C' | 'P';
  trigger_vol_to_oi_window: number | null;
  gamma_at_trigger: number | null;
  trigger_ask_pct: number | null;
  cum_ncp_at_fire: number;
  cum_npp_at_fire: number;
  /** The tag the row holds now: NULL for a fire from before the store. */
  score_version: string | null;
}

/**
 * The V2 score for one row under `weights`: the cron's computation, from the
 * row's columns. Null when the scorer says so (not aligned, or dte outside 0
 * to 3). NaN is never returned: a `tod` the weights do not know would sum to
 * NaN, and that row is `'unscorable'` so it is counted and left alone.
 */
export function rescoreRow(
  weights: LotteryWeights,
  row: CandidateRow,
): number | null | 'unscorable' {
  const score = scoreLotteryV2(weights, {
    ticker: row.underlying_symbol,
    tod: row.tod as TimeOfDay,
    dte: row.dte,
    volOiWindow: row.trigger_vol_to_oi_window,
    gammaAtTrigger: row.gamma_at_trigger,
    triggerAskPct: row.trigger_ask_pct,
    optionType: row.option_type,
    isAligned: isAlignedFire(
      row.option_type,
      row.cum_ncp_at_fire,
      row.cum_npp_at_fire,
    ),
    dayOfWeek: weekdayOf(row.date),
  });
  if (score == null) return null;
  return Number.isInteger(score) ? score : 'unscorable';
}

export interface ScoreUpdate {
  id: string;
  score: number;
  /** The tag the row held when it was read, which the write guards on. */
  previousVersion: string | null;
}

export interface Plan {
  /** Rows examined: score NULL, flow set, dte 0 to 3, on or after `since`. */
  examined: number;
  /** The rows that get a score, in id order. */
  updates: ScoreUpdate[];
  /** Examined rows the scorer still gives NULL (a fire against the flow). */
  stayNull: number;
  /** Examined rows it could not score (an unknown `tod`). */
  unscorable: number;
  /** Rows to score per fire date. */
  byDate: Map<string, number>;
  /** Rows to score per the `score_version` they hold now (null is NULL). */
  byPreviousVersion: Map<string | null, number>;
}

function emptyPlan(): Plan {
  return {
    examined: 0,
    updates: [],
    stayNull: 0,
    unscorable: 0,
    byDate: new Map(),
    byPreviousVersion: new Map(),
  };
}

/** What the rows would get under `weights`, with no I/O. */
export function planRows(
  weights: LotteryWeights,
  rows: readonly CandidateRow[],
): Plan {
  const plan = emptyPlan();
  for (const row of rows) {
    plan.examined += 1;
    const score = rescoreRow(weights, row);
    if (score === 'unscorable') plan.unscorable += 1;
    else if (score == null) plan.stayNull += 1;
    else {
      plan.updates.push({
        id: row.id,
        score,
        previousVersion: row.score_version,
      });
      plan.byDate.set(row.date, (plan.byDate.get(row.date) ?? 0) + 1);
      plan.byPreviousVersion.set(
        row.score_version,
        (plan.byPreviousVersion.get(row.score_version) ?? 0) + 1,
      );
    }
  }
  return plan;
}

/** Add `next` into `into`, so pages can be planned one at a time. */
function mergePlan(into: Plan, next: Plan): void {
  into.examined += next.examined;
  into.updates.push(...next.updates);
  into.stayNull += next.stayNull;
  into.unscorable += next.unscorable;
  for (const [date, n] of next.byDate) {
    into.byDate.set(date, (into.byDate.get(date) ?? 0) + n);
  }
  for (const [version, n] of next.byPreviousVersion) {
    into.byPreviousVersion.set(
      version,
      (into.byPreviousVersion.get(version) ?? 0) + n,
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface ScopeCounts {
  /** score NULL, flow set: the rows this script looks at. */
  nullScoreWithFlow: number;
  /** score NULL, flow NULL: waiting on the flow backfill, or pre-open. */
  nullScoreNoFlow: number;
  /** score set. */
  scored: number;
}

/**
 * Counts over the scope (on or after `since`, dte 0 to 3): the "before" and
 * "after" of a run. `::int` because Neon returns COUNT(*) as a string.
 */
export async function countScope(
  sql: Sql,
  since: string,
): Promise<ScopeCounts> {
  const rows = (await sql`
    SELECT
      (COUNT(*) FILTER (
        WHERE score IS NULL
          AND cum_ncp_at_fire IS NOT NULL AND cum_npp_at_fire IS NOT NULL
      ))::int AS null_score_with_flow,
      (COUNT(*) FILTER (
        WHERE score IS NULL
          AND (cum_ncp_at_fire IS NULL OR cum_npp_at_fire IS NULL)
      ))::int AS null_score_no_flow,
      (COUNT(*) FILTER (WHERE score IS NOT NULL))::int AS scored
    FROM lottery_finder_fires
    WHERE date >= ${since}::date AND dte BETWEEN 0 AND 3
  `) as Array<{
    null_score_with_flow: number;
    null_score_no_flow: number;
    scored: number;
  }>;
  const row = rows[0];
  if (row == null) throw new Error('count query returned no row');
  return {
    nullScoreWithFlow: row.null_score_with_flow,
    nullScoreNoFlow: row.null_score_no_flow,
    scored: row.scored,
  };
}

/**
 * Every candidate row, one keyset page at a time (`id` ascending). NUMERICs
 * are cast to float8 in the SELECT (the driver would return them as strings)
 * and `id` to text (BIGINT arrives as a string too). The query orders and
 * filters on `f.id`: a bare `ORDER BY id` would name the text output column
 * and sort '10' before '9', which breaks the keyset.
 */
async function planScope(
  sql: Sql,
  since: string,
  weights: LotteryWeights,
): Promise<Plan> {
  const plan = emptyPlan();
  let afterId = '0';
  for (;;) {
    const page = (await sql`
      SELECT
        f.id::text AS id,
        f.date::text AS date,
        f.underlying_symbol,
        f.tod,
        f.dte::int AS dte,
        f.option_type,
        f.trigger_vol_to_oi_window::float8 AS trigger_vol_to_oi_window,
        f.gamma_at_trigger::float8 AS gamma_at_trigger,
        f.trigger_ask_pct::float8 AS trigger_ask_pct,
        f.cum_ncp_at_fire::float8 AS cum_ncp_at_fire,
        f.cum_npp_at_fire::float8 AS cum_npp_at_fire,
        f.score_version
      FROM lottery_finder_fires f
      WHERE f.score IS NULL
        AND f.cum_ncp_at_fire IS NOT NULL
        AND f.cum_npp_at_fire IS NOT NULL
        AND f.dte BETWEEN 0 AND 3
        AND f.date >= ${since}::date
        AND f.id > ${afterId}::bigint
      ORDER BY f.id
      LIMIT ${PAGE_SIZE}
    `) as CandidateRow[];
    mergePlan(plan, planRows(weights, page));
    const last = page.at(-1);
    if (last == null || page.length < PAGE_SIZE) return plan;
    afterId = last.id;
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Write the scores and `version`, 500 rows to a statement. Every statement
 * re-checks what the plan was read on: `f.score IS NULL`, the tag the row held
 * (`previousVersion`) and the `active` pointer still naming `version`. A row
 * another writer has scored or tagged since keeps its value, and once a
 * promotion has moved the pointer the statements write nothing. Returns the
 * number of rows actually written.
 */
export async function applyUpdates(
  sql: Sql,
  updates: readonly ScoreUpdate[],
  version: string,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const chunk = updates.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((u) => u.id);
    const scores = chunk.map((u) => u.score);
    const previous = chunk.map((u) => u.previousVersion);
    const done = (await sql`
      UPDATE lottery_finder_fires AS f
      SET score = u.score, score_version = ${version}
      FROM unnest(${ids}::bigint[], ${scores}::int[], ${previous}::text[])
        AS u(id, score, previous_version)
      WHERE f.id = u.id
        AND f.score IS NULL
        AND f.score_version IS NOT DISTINCT FROM u.previous_version
        AND EXISTS (
          SELECT 1 FROM lottery_score_pointers p
          WHERE p.name = 'active' AND p.version = ${version}
        )
      RETURNING f.id
    `) as Array<{ id: unknown }>;
    written += done.length;
  }
  return written;
}

/** The version the `active` pointer names right now, or null if it has none. */
async function activeVersionNow(sql: Sql): Promise<string | null> {
  const rows = (await sql`
    SELECT version FROM lottery_score_pointers WHERE name = 'active'
  `) as Array<{ version: string }>;
  return rows[0]?.version ?? null;
}

/**
 * The undo for a run, as written into its undo file. `$1` is the file's row
 * ids, `$2` their scores and `$3` the tag each held before, in order, and `$4`
 * is the file's `version` (`lottery_finder_fires.score` is an INTEGER, `id` a
 * BIGINT). It restores a row only while it still holds the score and the tag
 * this run gave it, so a row some other writer has scored or tagged since (the
 * nightly refit's promotion, say) keeps its values. Every row in the file had
 * score NULL before the run, so NULL is what it restores; a row another writer
 * gave the same score and tag is restored too, and a re-run scores it again.
 */
export const UNDO_STATEMENT =
  'UPDATE lottery_finder_fires f SET score = NULL, score_version = u.previous_version FROM unnest($1::bigint[], $2::int[], $3::text[]) u(id, score, previous_version) WHERE f.id = u.id AND f.score = u.score AND f.score_version = $4';

/**
 * The rows a run is about to score, each with the score it will get and the
 * tag it holds, in a file written first, so the run can be undone
 * (UNDO_STATEMENT). The score is there because an undo by id alone would also
 * restore a row another writer scored between the plan and the undo.
 */
function writeUndoFile(
  dir: string,
  since: string,
  version: string,
  updates: readonly ScoreUpdate[],
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `undo-${now.toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      note: `Every row below had score NULL before this run, and was planned to get the score shown, with score_version ${version}; previousVersion is the tag it held (null is NULL). Undo: ${UNDO_STATEMENT} with $1 = the id of each row, $2 = its score and $3 = its previousVersion, in order, and $4 = ${JSON.stringify(version)}.`,
      since,
      version,
      rows: updates.map((u) => ({
        id: u.id,
        score: u.score,
        previousVersion: u.previousVersion,
      })),
    }),
  );
  return file;
}

/**
 * The active version and its weights, from the store the cron scores from. The
 * loader answers a store it cannot read with the seed in both slots; scoring
 * and tagging rows with that would put a version on them that the store never
 * gave this run, so a fallback stops the run before anything is read or written.
 */
async function loadActive(): Promise<VersionedWeights> {
  const loaded = await loadLotteryWeights();
  if (loaded.fallback != null) {
    throw new Error(
      `the weights store could not be read (${loaded.fallback.kind}: ${loaded.fallback.reason}), so the active version is not known. Nothing was read or written.`,
    );
  }
  return loaded.active;
}

// ── Run and report ──────────────────────────────────────────────────────────

const n = (value: number): string => value.toLocaleString('en-US');

export interface RescoreResult {
  apply: boolean;
  since: string;
  /** The active version the rows are scored with and tagged with. */
  version: string;
  before: ScopeCounts;
  /** Measured after an apply; a projection for a dry run. */
  after: ScopeCounts;
  plan: Omit<Plan, 'updates'> & { toScore: number };
  written: number;
  undoFile: string | null;
}

export async function runRescore(opts: {
  apply: boolean;
  since: string;
  undoDir: string;
}): Promise<RescoreResult> {
  const sql = getDb();
  const active = await loadActive();
  const before = await countScope(sql, opts.since);
  const plan = await planScope(sql, opts.since, active.weights);
  const { updates, ...planCounts } = plan;
  const summary = { ...planCounts, toScore: updates.length };

  if (!opts.apply || updates.length === 0) {
    return {
      apply: opts.apply,
      since: opts.since,
      version: active.version,
      before,
      after: {
        nullScoreWithFlow: before.nullScoreWithFlow - updates.length,
        nullScoreNoFlow: before.nullScoreNoFlow,
        scored: before.scored + updates.length,
      },
      plan: summary,
      written: 0,
      undoFile: null,
    };
  }

  const undoFile = writeUndoFile(
    opts.undoDir,
    opts.since,
    active.version,
    updates,
    new Date(),
  );
  let written: number;
  try {
    written = await applyUpdates(sql, updates, active.version);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${reason}. The apply did not complete. The undo file ${undoFile} was written before it; every statement is all-or-nothing and the run is safe to repeat: run a dry run to see what is left.`,
      { cause: err },
    );
  }
  // Every statement above wrote only while the pointer named this version, so
  // a promotion in the middle of the run stops the writes. Say so, rather than
  // end with a count that looks like a partial overlap with another writer.
  const nowActive = await activeVersionNow(sql);
  if (nowActive !== active.version) {
    throw new Error(
      `the active pointer moved from ${active.version} to ${nowActive ?? 'nothing'} during the run. ${n(written)} of ${n(updates.length)} planned rows were written under ${active.version} before it moved, and the rest were not. The undo file ${undoFile} lists every planned row. Run a dry run to see what is left; it scores with the new active version.`,
    );
  }
  return {
    apply: true,
    since: opts.since,
    version: active.version,
    before,
    after: await countScope(sql, opts.since),
    plan: summary,
    written,
    undoFile,
  };
}

export function formatReport(result: RescoreResult): string {
  const { before, after, plan } = result;
  const projected = result.apply ? '' : ' (projected)';
  const lines = [
    result.apply
      ? 'APPLY: scores were written.'
      : 'DRY RUN: nothing was written. Re-run with --apply to write.',
    `Scope: lottery_finder_fires, date >= ${result.since}, dte 0 to 3; scored with the weights of the active version, ${result.version}, and tagged with it in score_version.`,
    '',
    'Before:',
    `  score NULL, flow set    ${n(before.nullScoreWithFlow)}   (the rows this script examines)`,
    `  score NULL, flow NULL   ${n(before.nullScoreNoFlow)}   (the flow backfill has not run for these, or they fired before the open)`,
    `  score set               ${n(before.scored)}`,
    '',
    'Examined:',
    `  to be scored            ${n(plan.toScore)}`,
    `  stay NULL (against the flow)  ${n(plan.stayNull)}`,
    `  unscorable (unknown tod)      ${n(plan.unscorable)}`,
    '',
    `After${projected}:`,
    `  score NULL, flow set    ${n(after.nullScoreWithFlow)}`,
    `  score NULL, flow NULL   ${n(after.nullScoreNoFlow)}`,
    `  score set               ${n(after.scored)}`,
  ];
  if (plan.byDate.size > 0) {
    lines.push('', 'Rows to score by fire date:');
    for (const date of [...plan.byDate.keys()].sort()) {
      lines.push(`  ${date}  ${n(plan.byDate.get(date) ?? 0)}`);
    }
  }
  if (plan.byPreviousVersion.size > 0) {
    // The tag the rows hold now, which the write replaces with the active one.
    lines.push('', 'Rows to score by the score_version they hold now:');
    const held = [...plan.byPreviousVersion].map(
      ([version, count]) => [version ?? 'NULL', count] as const,
    );
    for (const [version, count] of held.sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`  ${version}  ${n(count)}`);
    }
  }
  if (result.apply) {
    lines.push('', `Rows written: ${n(result.written)}`);
    if (result.written !== plan.toScore) {
      lines.push(
        `WARNING: ${n(plan.toScore - result.written)} planned rows were scored or tagged by another writer since the read; they kept their value.`,
      );
    }
    if (result.undoFile != null) lines.push(`Undo file: ${result.undoFile}`);
  } else if (plan.toScore === 0) {
    lines.push('', 'Nothing to score.');
  }
  return lines.join('\n');
}
