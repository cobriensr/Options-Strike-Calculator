/**
 * Phase 2 of the ES/NQ contract-mix repair: turn the Phase 1 front-month
 * rebuild (ml/data/futures-contract-repair/) into futures_bars writes. The
 * logic is in scripts/_lib/futures-contract-repair.ts. Spec:
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 *
 *   npx tsx scripts/repair-futures-contract-mix.ts                 # dry run
 *   npx tsx scripts/repair-futures-contract-mix.ts --apply --expect-updates N --expect-deletes M
 *   npx tsx scripts/repair-futures-contract-mix.ts --apply --expect-updates 1 --expect-deletes 1 --dates 2026-04-07
 *   npx tsx scripts/repair-futures-contract-mix.ts --thin-roots --work-dir <dir>                           # Phase 5a dry run
 *   npx tsx scripts/repair-futures-contract-mix.ts --thin-roots --apply --expect-deletes N --work-dir <dir>
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and the full delete list, and writes only the report files into
 * --work-dir. --apply WRITES to that database, after the close, and only
 * after the owner has seen the dry run. Exit codes: 0 done, 1 failed or
 * refused, 2 stopped between days because market hours began.
 *
 * --thin-roots (Phase 5a, owner decision D1, 2026-11-11) needs no Phase 1 output.
 * RTY, CL, GC and ZN have no rebuild source, so it deletes their bars from
 * 2026-04-05 22:00Z through each root's last bad bar (14:10Z on 2026-06-15; ZN
 * 14:11Z), except the CT trading days 04-13 to 04-17, 06-01 and 06-08 (scope in
 * scripts/_lib/futures-thin-roots.ts). It never updates a row and never touches
 * ES or NQ. The dry run lists per root the rows to delete, the first and last,
 * the rows kept, the kept-day bars Phase 1's strict test flags, and the apply
 * command. Its backup is one file across every run, backup-thin-roots.jsonl in the
 * work dir: each --apply adds the pending rows whose id it does not hold yet before
 * its first write, and refuses if an id is there with other values. It is in this
 * tool's format, and recompute-futures-derived.ts reads it as its --backup (Phase 5b).
 * Pass that one file, never a copy of part of it.
 *
 * An --apply leaves the dry run's report.txt and delete-list.csv alone (they are
 * what the owner approved) and writes apply-<time>-report.txt and
 * apply-<time>-delete-list.csv. So does a dry run in a work dir that holds any
 * {day}.applied marker, under dryrun-<time>-report.txt and
 * dryrun-<time>-delete-list.csv: after an apply it plans only what is left, and
 * must not replace the files the apply was approved from.
 *
 * A backup line holds the whole futures_bars row, the dated contract (#204)
 * included, and the delete is guarded by it. A line written before the contract
 * was read has no such key and reads as NULL.
 *
 * Options:
 *   --dir <dir>        Phase 1 output (default ml/data/futures-contract-repair);
 *                      refused with --thin-roots
 *   --work-dir <dir>   report.txt, delete-list.csv, backup-*.jsonl (with --thin-roots,
 *                      the one backup-thin-roots.jsonl) and the {day}.applied markers
 *                      (default docs/tmp/futures-contract-repair; with --thin-roots,
 *                      its thin-roots subfolder)
 *   --apply            write (backup first, one UTC day per transaction); needs
 *                      --expect-updates and --expect-deletes (with --thin-roots,
 *                      --expect-deletes only)
 *   --thin-roots       Phase 5a: delete the RTY, CL, GC and ZN window bars (above)
 *   --expect-updates N the rows to update in the dry run the owner approved;
 *                      refused with --thin-roots, which never updates
 *   --expect-deletes M the rows to delete in that dry run; --apply refuses, before
 *                      any write, when the fresh plan's totals differ
 *   --dates d1 d2 ...  only these UTC days
 *   --force            with --apply, redo days that have a done marker
 *   --env-file <path>  .env.local to load (default: the nearest one up the tree);
 *                      a path that does not exist is an error, never a fallback
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { parseRepairArgs, runRepair } from './_lib/futures-contract-repair.js';

async function main(): Promise<number> {
  const args = parseRepairArgs(process.argv.slice(2));
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  return runRepair(args);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
