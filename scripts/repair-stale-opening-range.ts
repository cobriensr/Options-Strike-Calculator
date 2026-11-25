/**
 * Repair the opening range stored on `market_snapshots` rows that was stale when
 * saved (spec: docs/superpowers/specs/2026-11-22-stale-opening-range-design.md,
 * phase 3). The rule for which rows are stale, what a repair writes, the rows it
 * leaves alone and why is in scripts/_lib/stale-opening-range.ts.
 *
 * Three steps, from the repo root. Run the dry run outside 13:00-23:00 UTC on a
 * weekday (it calls /api/history about once a second per snapshot date):
 *
 *   npx tsx scripts/repair-stale-opening-range.ts                      # dry run, every date
 *   npx tsx scripts/repair-stale-opening-range.ts --date 2026-11-16    # dry run, one date
 *   npx tsx scripts/repair-stale-opening-range.ts --apply --date 2026-11-16
 *   npx tsx scripts/repair-stale-opening-range.ts --undo-file docs/tmp/stale-opening-range/backup-<scope>-<time>.json --apply
 *
 * A row with a NULL `median_hl_pct` is NOT graded and NOTHING is written to it:
 * `openingRangeSignal` reads a missing median as 1, which is a guessed value, so
 * such a stale row is listed on its own for the owner. The same holds for a
 * stale row with no usable spot.
 *
 * The dry run READS the database DATABASE_URL points at (production, in
 * .env.local) and calls the owner's /api/history at APP_URL with the cookie
 * OWNER_SECRET (Schwab's 5-minute $SPX bars, the candles the page computed its
 * range from). None of the three is printed: the database host and the history
 * origin are. It prints the counts, a block for every repair with the stored and
 * the new values and the candles used (so a row can be recomputed by hand), the
 * NULL-median list, the rows whose stored prev_close is not the real previous
 * session's close (reported, never repaired), and the dates it could not read.
 * It writes nothing.
 *
 * `--apply` needs `--date D` (apply one date first) or `--all`. It plans afresh,
 * writes a backup file under docs/tmp/stale-opening-range/ (relative to the
 * working directory; an existing file is never overwritten), and then the rows,
 * 500 to a statement, each only where it still holds the values the read found,
 * then the `training_features` copy for each repaired pick row. A second apply
 * writes nothing. `--undo-file F --apply` restores a backup, each row only where
 * it still holds the repaired values.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change), 1 any error
 * (bad argument, no env file, a missing OWNER_SECRET or APP_URL, a refused
 * cookie, Schwab logged out (/api/history answered 503), a DB error, an
 * existing backup file), a date whose history could not be read, and an apply
 * or an undo that wrote fewer rows than it planned. The code is set on
 * `process.exitCode`, never with `process.exit`, so a piped stdout is flushed
 * before the process ends.
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { dbHost } from './_lib/econ-label-backfill.js';
import { historyOrigin } from './_lib/snapshot-price-context.js';
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
} from './_lib/stale-opening-range.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  console.log(`Database host: ${dbHost(process.env.DATABASE_URL)}`);
  if (args.undoFile != null) {
    const undone = await runUndo({ file: args.undoFile, apply: args.apply });
    console.log(formatUndoReport(undone));
    return exitCodeOfUndo(undone);
  }
  // Before the first fetch: where the owner cookie is about to go.
  console.log(`History origin: ${historyOrigin(process.env)}`);
  const result = await runRepair({
    date: args.date,
    since: args.since,
    until: args.until,
    apply: args.apply,
    all: args.all,
    backupDir: args.backupDir,
  });
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
