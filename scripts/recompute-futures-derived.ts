/**
 * Phase 4 of the ES/NQ contract-mix repair: recompute the three stores that
 * saved values computed from the old bad futures_bars. The logic is in
 * scripts/_lib/futures-derived-recompute.ts. Spec:
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 *
 *   npx tsx scripts/recompute-futures-derived.ts --backup <phase 2 backup.jsonl>   # dry run
 *   npx tsx scripts/recompute-futures-derived.ts --backup <file> --apply --expect-snapshots N --expect-premarket M --expect-fires K
 *   npx tsx scripts/recompute-futures-derived.ts --stores fires    # a dry run of one store, no backup needed
 *   npx tsx scripts/recompute-futures-derived.ts --backup <file> --apply --expect-snapshots N --expect-premarket M --expect-fires K --delete-junk-stale --expect-junk-deletes J --rewrite-stale-at-write --expect-stale-rewrites S --detector-days <file>
 *   npx tsx scripts/recompute-futures-derived.ts --stores frozen --work-dir <dir>   # a dry run of the frozen-stale delete, no backup needed
 *   npx tsx scripts/recompute-futures-derived.ts --apply --stores frozen --work-dir <dir> --delete-frozen-stale --expect-frozen-deletes N
 *   npx tsx scripts/recompute-futures-derived.ts --backup <5a backup.jsonl> --roots RTY CL GC ZN --work-dir <new dir> --detector-days <file>   # Phase 5b dry run
 *
 * Phase 5b (owner decision D1, 2026-11-11) runs this tool for RTY, CL, GC and ZN after
 * Phase 5a (scripts/repair-futures-contract-mix.ts --thin-roots) deleted their bars in the
 * span: --backup is the 5a backup, which names whole deleted days, and --roots limits every
 * step to those roots. A field that read a deleted bar is recomputed by today's computeSnapshot
 * on the bars that are left (mostly volume_ratio on the clean days and in the 20 days after
 * the span end); a row priced from a deleted bar that is now stale goes to --delete-junk-stale.
 * Use a work dir of its own: the markers and plan.json of an earlier run in --work-dir would
 * skip or resume its steps.
 *
 * The D1 lift of ruling 9: at plan time, read-only, the dry run counts each thin root's bars from
 * the span start through its last bad bar outside the seven clean CT trading days (04-13 to
 * 04-17, 06-01, 06-08) and prints it. A root with none left (5a has applied) is lifted: the
 * stale-at-write rewrite covers it from the span start, like ES and NQ, and the frozen-stale
 * delete (--stores frozen) covers it too. A root with any left keeps today's behavior, so a run
 * before 5a changes nothing. The --detector-days rule for rows after the span end applies as before.
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and writes only report.txt (and merge-state.txt) into --work-dir. --apply WRITES to that
 * database, after the close, only after the owner has seen the dry run, and
 * only when every check passes: the snapshot method control (rows written by
 * today's code) recomputes to exactly what is stored (for RTY, CL, GC and ZN a
 * miss that a late bar explains also counts), the pre-market subset
 * check holds on every row outside the span, the fire basis control matches,
 * and the totals equal the --expect-* counts. A saved value is written only
 * where one of its input bars was changed or deleted by Phase 2 (read from the
 * backup). Exit codes: 0 done, 1 failed or refused, 2 stopped between stores
 * because market hours began.
 *
 * Stale snapshot rows priced from a bar Phase 2 deleted cannot be recomputed
 * and `price` cannot be blanked. The dry run always lists them; --delete-junk-stale
 * deletes them, off by default, and only the owner decides. The writer also had
 * no freshness gate until 2026-09-30: it priced from the last bar it had while
 * minutes were missing, and they have landed since. --rewrite-stale-at-write
 * rewrites those rows from today's bars (off by default). It covers every ES and NQ
 * row before 2026-10-01, and the thin roots' rows from the span end + 20 days (their
 * bars before the span end are still month-mixed, D1, and a snapshot in the 20 days
 * after reads some of them; from the span start for a root the D1 lift below has
 * opened) except on the days the Phase 1 detector
 * confirmed contaminated in --detector-days. Without that file the thin roots' rows
 * after the span end are left too. A row is stale when its price is the close of a
 * bar older than the freshness gate (found by value, 96 hours back) or when it sits
 * in a run of consecutive rows with one stored price that spans more than the gate
 * (the September outage rows, whose last good bar is weeks old); the recompute must
 * be fresh and differ. The "not written" lists in the report are what is left after
 * every planned step with the opt-in steps on. --rewrite-stale-at-write is refused
 * when more than 10% of a thin root's after-span stale rows sit on contaminated days.
 *
 * The ES and NQ snapshot rows before 2026-10-01 that computeSnapshot cannot price
 * (no closed bar within the freshness gate) are left as stored, except the ones whose
 * stored price is not the close of the latest closed bar at any age: those are frozen
 * on an older bar, and `--stores frozen --delete-frozen-stale` deletes them (owner OK
 * 2026-11-11, off by default). It runs alone: it plans no other store and needs no Phase 2
 * backup, so a plan takes seconds, not the full plan's hour. Candidates come from SQL and
 * computeSnapshot confirms each one. A row that repeats the last bar's close stays, as
 * do the thin roots (RTY, CL, GC, ZN: D1) and every row from 2026-10-01 on. The dry run
 * lists the count per root, the first and last ts, how many rows fall in the 16:15 to
 * 17:00 CT break, on a weekend or holiday and elsewhere, the 10 largest differences
 * from the bar's close and the apply command. The delete uses the same plan.json, backup
 * file, <step>.started / <step>.applied markers and resume as the other steps (step
 * "frozen"), guarded by id, symbol and the planned price, and verifies that the rows are
 * gone and that nothing else before 2026-10-01 left the table.
 *
 * Before any write, the apply saves its whole plan: plan.json names a backup-*.jsonl in
 * --work-dir that holds every row to change (the step that writes it, the row as it is
 * now and the new values), with each step's row count and the file's line count and
 * sha256, and the apply reads the steps back from that file; a file that is cut, edited
 * or does not match plan.json is refused. Just before a step's first write it records
 * <step>.started, and when it is done <step>.applied. If a run fails once a step has
 * started or applied, run the same command again: it finishes the steps that are not
 * applied from the saved plan, without planning again (a fresh plan no longer finds the
 * rows a started step wrote). Inside a started step a row that already holds the new
 * value is done; a row that holds neither the plan's old value nor its new value stops
 * that step before it writes. A different command (other totals, opt-in flags, --stores,
 * --backup, --detector-days or --work-dir) is refused, not planned again: use --force to
 * plan again, or remove plan.json. A run that failed before any step started plans again.
 *
 * Options:
 *   --backup <file>         the bar backup JSONL of the repair tool: for Phase 2 a
 *                           docs/tmp/futures-contract-repair/backup-<stamp>.jsonl, for Phase 5a the single
 *                           docs/tmp/futures-contract-repair/thin-roots/backup-thin-roots.jsonl, never a
 *                           part of it or a copy; required with --apply or with the snapshots or premarket store
 *   --work-dir <dir>        report.txt, backup-*.jsonl and the {store}.applied
 *                           markers (default docs/tmp/futures-derived-recompute). A dry run writes report.txt
 *                           (and merge-state.txt); an --apply leaves those alone and writes
 *                           apply-<time>-report.txt (and apply-<time>-merge-state.txt)
 *   --stores s1 s2 ...      only these of snapshots, premarket, fires (default all). A dry run
 *                           plans only these; --apply still plans and checks all three and
 *                           writes only these. `--stores frozen` stands alone: it plans the
 *                           frozen-stale rows and no store, with or without --apply
 *   --roots r1 r2 ...       only these of ES, NQ, ZN, RTY, CL, GC (default all six), in every step:
 *                           snapshots, the stale-at-write rewrite, the junk delete and the frozen-stale
 *                           delete. Premarket and fires are ES-only: without ES here they plan nothing,
 *                           and their --expect-* totals are refused. A resume must repeat the same roots
 *   --apply                 write (backup first); needs an --expect-* per store in the run
 *   --expect-snapshots N    the futures_snapshots rows to write in the approved dry run
 *   --expect-premarket M    the pre_market_data rows to write in that dry run
 *   --expect-fires K        the es_basis_change_5m values to write in that dry run;
 *                           --apply refuses, before any write, when a total differs
 *   --delete-junk-stale     with --apply, also delete the stale futures_snapshots rows whose price
 *                           is the close of a bar Phase 2 deleted (the full rows go to the backup
 *                           first; its own done marker junk.applied). Needs the snapshots store
 *   --expect-junk-deletes J the rows that delete removes in the dry run you approved;
 *                           required with --delete-junk-stale, --apply refuses when it differs
 *   --rewrite-stale-at-write  with --apply, also rewrite the rows whose price is the close of a bar older
 *                           than the 15-minute freshness gate at the row and whose recompute is fresh:
 *                           every differing field the snapshot step does not write (own done marker
 *                           stale.applied; its backup lines say step "stale"). Needs the snapshots store
 *   --expect-stale-rewrites S the rows that rewrite changes in the dry run you approved;
 *                           required with --rewrite-stale-at-write, --apply refuses when it differs
 *   --delete-frozen-stale   with --apply --stores frozen, delete the ES and NQ snapshot rows before
 *                           2026-10-01 that computeSnapshot cannot price and whose price is not
 *                           the close of the latest closed bar (own done marker frozen.applied;
 *                           the full rows go to the backup first)
 *   --expect-frozen-deletes N  the rows that delete removes in the dry run you approved;
 *                           required with --delete-frozen-stale, --apply refuses when it differs
 *   --detector-days <file>  a JSON file {"RTY": {"contaminated": [...], "flagged": [...]}, "CL": {...}, "GC": {...},
 *                           "ZN": {...}} of the CT trading days the Phase 1 detector found in that root's bars
 *                           after the span end (docs/tmp/es-contract-month-2026-11-06/b-after-span/): a
 *                           contaminated day has at least 10 flagged bars and 1% of the day's bars in a run of
 *                           3 days, a flagged day has any flagged bar. The stale rewrite leaves the root's rows
 *                           on the contaminated days (the report prints their share, and the stale rows on the
 *                           flagged days as information). It changes the plan, so a dry run takes it too and
 *                           --apply must repeat it
 *   --force                 with --apply, redo stores that have a done marker and plan again instead of resuming
 *   --env-file <path>       .env.local to load (default: the nearest one up the tree);
 *                           a path that does not exist is an error, never a fallback
 */

import { config } from 'dotenv';
import logger from '../api/_lib/logger.js';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import {
  parseRecomputeArgs,
  runRecompute,
} from './_lib/futures-derived-recompute.js';

async function main(): Promise<number> {
  const args = parseRecomputeArgs(process.argv.slice(2));
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  // computeSnapshot logs one info line per stale row; thousands would bury the report.
  logger.level = 'warn';
  return runRecompute(args);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
