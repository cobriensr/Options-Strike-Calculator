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
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and writes only report.txt into --work-dir. --apply WRITES to that
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
 * after reads some of them) except on the days the Phase 1 detector
 * confirmed contaminated in --detector-days. Without that file the thin roots' rows
 * after the span end are left too. A row is stale when its price is the close of a
 * bar older than the freshness gate (found by value, 96 hours back) or when it sits
 * in a run of consecutive rows with one stored price that spans more than the gate
 * (the September outage rows, whose last good bar is weeks old); the recompute must
 * be fresh and differ. The "not written" lists in the report are what is left after
 * every planned step with the opt-in steps on. --rewrite-stale-at-write is refused
 * when more than 10% of a thin root's after-span stale rows sit on contaminated days.
 *
 * Before any write, the apply saves its whole plan: plan.json names a backup-*.jsonl in
 * --work-dir that holds every row to change (the step that writes it, the row as it is
 * now and the new values), and the apply reads the steps back from that file. If a run
 * fails between steps, run the same command again: it finishes the steps that are not
 * marked from the saved plan, without planning again (a fresh plan no longer finds the
 * rows a finished step wrote). A row that holds neither the plan's old value nor its new
 * value stops that step before it writes; a different command or --force plans again.
 *
 * Options:
 *   --backup <file>         the Phase 2 backup JSONL (docs/tmp/futures-contract-repair/backup-*.jsonl);
 *                           required with --apply or with the snapshots or premarket store
 *   --work-dir <dir>        report.txt, backup-*.jsonl and the {store}.applied
 *                           markers (default docs/tmp/futures-derived-recompute)
 *   --stores s1 s2 ...      only these of snapshots, premarket, fires (default all). A dry run
 *                           plans only these; --apply still plans and checks all three and
 *                           writes only these
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
