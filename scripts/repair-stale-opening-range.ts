/**
 * Repair the opening range stored on `market_snapshots` rows that was stale when
 * saved (spec: docs/superpowers/specs/2026-11-22-stale-opening-range-design.md,
 * phase 3). The rule for which rows are stale, what a repair writes, the rows it
 * leaves alone and why is in scripts/_lib/stale-opening-range.ts.
 *
 * The steps, from the repo root: one date first, then every date. Run the dry
 * run outside 13:00-23:00 UTC on a weekday (it calls /api/history about once a
 * second per snapshot date):
 *
 *   npx tsx scripts/repair-stale-opening-range.ts --date 2026-11-16     # dry run, one date: writes a plan file
 *   npx tsx scripts/repair-stale-opening-range.ts --apply --plan docs/tmp/stale-opening-range/dry-run-2026-11-16-<time>.json
 *   npx tsx scripts/repair-stale-opening-range.ts                       # dry run, every date: writes a plan file
 *   npx tsx scripts/repair-stale-opening-range.ts --plan docs/tmp/stale-opening-range/dry-run-all-<time>.json
 *   npx tsx scripts/repair-stale-opening-range.ts --apply --all --plan docs/tmp/stale-opening-range/dry-run-all-<time>.json
 *   npx tsx scripts/repair-stale-opening-range.ts --undo-file docs/tmp/stale-opening-range/backup-<scope>-<time>.json --apply
 *
 * A row with a NULL `median_hl_pct`, or one not above 0, is NOT graded and
 * NOTHING is written to it: `openingRangeSignal` reads a missing median as 1,
 * which is a guessed value, so such a stale row is listed on its own for the
 * owner. The same holds for a stale row with no usable spot.
 *
 * The dry run READS the database DATABASE_URL points at (production, in
 * .env.local) and, for a date from 2026-03-05 on, calls the owner's
 * /api/history at APP_URL with the cookie OWNER_SECRET (Schwab's 5-minute $SPX
 * bars, the candles the page computed its range from). APP_URL and OWNER_SECRET
 * are read only when such a date is planned, and the history origin goes to
 * stderr just before the first call. None of the three is printed as it is. The
 * history origin is. The database is named, `host/name`, in a "Database:" line
 * after the run: no name derived from DATABASE_URL is printed or written until
 * a query on it has succeeded, so a failed run names none. A DATABASE_URL the
 * database driver will not parse, or one holding a NUL, CR or LF (which a
 * request header cannot carry), gives a fixed message: `getDb` replaces the
 * driver's error for the first, which holds the whole connection string, and
 * refuses the second before the driver. The driver's other errors, and the
 * database server's own error text on a failed first query, pass through as
 * they are, and the latter can name the role or the database ("password
 * authentication failed for user ..."). It prints the counts, a per-date table,
 * a block for every repair with the stored and the new values and the candles
 * used (so a row can be recomputed by hand), the lists by id (lag, look-ahead,
 * incomplete-range, the NULL-median rows and every other row left alone), the
 * rows whose stored prev_close is not the real previous session's close
 * (reported, never repaired), and the dates it could not read. It writes a plan
 * file under docs/tmp/stale-opening-range/ and nothing to the database.
 *
 * `--apply --plan F` refuses at once if F was written for another database
 * (host and name), or if F's scope covers more than one date and `--all` is not
 * also given: one date first, then all. A one-date plan (`--date`, or `--since`
 * and `--until` naming one day) needs no `--all`. It plans afresh and refuses
 * unless every row, the values it holds now and its new values are the ones in
 * F. Then it writes a backup file under docs/tmp/stale-opening-range/ (relative
 * to the working directory; an existing file is never overwritten), and one
 * date at a time the rows, 500 to a statement, and that date's
 * `training_features` copy in one transaction, each row only where it still
 * holds the values the read found. A second apply writes nothing. `--plan F`
 * without `--apply` only checks the file. `--undo-file F --apply` restores a
 * backup, each row only where it still holds the repaired values, and refuses a
 * backup written for another database.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change), 1 any error
 * (bad argument, no env file, a missing OWNER_SECRET or APP_URL when a date needs
 * the candles, a refused cookie, Schwab logged out (/api/history answered 503), a
 * plan that is not F, a DB error, an existing backup file), a date whose history
 * could not be read, and an apply or an undo that wrote fewer rows than it
 * planned. The code is set on `process.exitCode`, never with `process.exit`, so
 * a piped stdout is flushed before the process ends.
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
} from './_lib/stale-opening-range.js';

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
