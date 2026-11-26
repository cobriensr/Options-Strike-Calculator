/**
 * Repair the options-volume features stored in `training_features`: the
 * `opt_*` columns that hold another day's numbers for 112 of 159 dates, and the
 * `prev_day_opt_*` columns that are empty before phase 1b (spec:
 * docs/superpowers/specs/2026-11-26-options-volume-prev-day-design.md, phase 2).
 * What is planned, how it is rounded and why a second apply writes nothing is in
 * scripts/_lib/options-volume-repair.ts.
 *
 * The only input is a saved UW /stock/SPX/options-volume reply, `--source`. The
 * tool never calls UW and never reads UW_API_KEY. One date first, then every
 * date:
 *
 *   npx tsx scripts/repair-options-volume.ts --source docs/tmp/opt-volume/<reply>.json --date 2026-10-01   # dry run, one date: writes a plan file
 *   npx tsx scripts/repair-options-volume.ts --source <reply> --apply --plan docs/tmp/options-volume-repair/dry-run-2026-10-01-<time>.json
 *   npx tsx scripts/repair-options-volume.ts --source <reply>                    # dry run, every date: writes a plan file
 *   npx tsx scripts/repair-options-volume.ts --source <reply> --plan docs/tmp/options-volume-repair/dry-run-all-<time>.json
 *   npx tsx scripts/repair-options-volume.ts --source <reply> --apply --all --plan docs/tmp/options-volume-repair/dry-run-all-<time>.json
 *   npx tsx scripts/repair-options-volume.ts --undo-file docs/tmp/options-volume-repair/backup-<scope>-<time>.json --apply
 *
 * The dry run READS the database DATABASE_URL points at (production, in
 * .env.local) and writes a plan file under docs/tmp/options-volume-repair/ and
 * nothing to the database. The database is named, `host/name`, in a "Database:"
 * line after the run: no name derived from DATABASE_URL is printed or written
 * until a query on it has succeeded, so a failed run names none (see
 * scripts/_lib/db-host.ts).
 *
 * `--apply --plan F --source S` refuses at once if F was written for another
 * database, or if F covers more than one date and `--all` is not also given. It
 * refuses a source whose sha256 is not F's, plans afresh, and refuses unless
 * every date's stored and new values are F's. Then it writes a backup file (an
 * existing file is never overwritten) and the dates, 500 to a statement, in one
 * transaction, each only where it still holds the values the read found. A second
 * apply writes nothing. `--undo-file F --apply` restores a backup, each date only
 * where it still holds the repaired values, and refuses a backup written for
 * another database.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change), 1 any error
 * (bad argument, no env file, a source that is not a UW reply, a value a column
 * cannot hold, a plan that is not F, a DB error, an existing backup file) and an
 * apply or an undo that wrote fewer dates than it planned. The code is set on
 * `process.exitCode`, never with `process.exit`, so a piped stdout is flushed
 * before the process ends.
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import {
  USAGE,
  exitCodeOf,
  exitCodeOfUndo,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  parseArgs,
  runRepair,
  runUndo,
} from './_lib/options-volume-repair.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  // The database is named by the run, after its queries have succeeded (an
  // undo names the one its backup recorded), not read off DATABASE_URL here:
  // a URL that cannot connect can parse so that part of the password lands in
  // its host.
  if (args.undoFile != null) {
    const undone = await runUndo({ file: args.undoFile, apply: args.apply });
    console.log(`Database: ${undone.database}`);
    console.log(formatUndoReport(undone));
    return exitCodeOfUndo(undone);
  }
  const result = await runRepair({
    source: args.source,
    date: args.date,
    since: args.since,
    until: args.until,
    apply: args.apply,
    planFile: args.planFile,
    all: args.all,
    backupDir: args.backupDir,
  });
  console.log(`Database: ${result.database}`);
  console.log(formatReport(result));
  if (result.applied != null) console.log(formatApplyReport(result.applied));
  return exitCodeOf(result);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
