/**
 * One-shot history backfill for the server-side event-day flag (spec:
 * docs/superpowers/specs/2026-11-11-server-side-event-day-flags.md, phase 3).
 * The logic is in scripts/_lib/snapshot-event-flag-backfill.ts, which lists
 * what it repairs.
 *
 * The stored flag is macro-only (owner decision 2026-11-12): the FRED
 * releases, FOMC, and half days and closures. Mega-cap earnings never count,
 * so a stored earnings name (NVDA Earnings, ...) is removed, by design.
 * Finnhub is not used.
 *
 * Run it from the repo root, with the FRED key in the shell (it is not in
 * .env.local; dotenv never overrides a variable already set):
 *
 *   PowerShell:
 *     $env:FRED_API_KEY = '<key>'
 *     npx tsx scripts/backfill-snapshot-event-flags.ts            # dry run
 *     npx tsx scripts/backfill-snapshot-event-flags.ts --apply    # writes
 *   bash:
 *     FRED_API_KEY=<key> npx tsx scripts/backfill-snapshot-event-flags.ts
 *     FRED_API_KEY=<key> npx tsx scripts/backfill-snapshot-event-flags.ts --apply
 *
 * Both modes READ the database DATABASE_URL points at (production, in
 * .env.local) and call FRED. The default is a dry run: it prints what would
 * change and writes nothing. `--apply` first writes an undo file under
 * docs/tmp/snapshot-event-flags/ (relative to the working directory), then
 * writes everything in one transaction. A second `--apply` plans zero writes
 * and says so. The run refuses if FRED_API_KEY is unset.
 *
 * ORDER, in production:
 *   1. The snapshot save that computes the flag on the server (phase 2) is
 *      deployed, so saves made after this run are right too.
 *   2. Run the dry run and read the per-name counts. Earnings names show up as
 *      losses, with a note that says so; that is expected.
 *   3. Run --apply. It does not matter whether it runs before or after the
 *      economic-event label backfill: both compute from the corrected FOMC
 *      schedule and guard every write on the values they read. That holds for
 *      the FOMC names only: if the econ backfill runs first, this one can
 *      still add other events' names on 04-29.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options:
 *   --apply            write (without it: dry run)
 *   --dry-run          the default, said aloud; contradicts --apply
 *   --env-file <path>  .env.local to load (default: the nearest one up the
 *                      tree); a path that does not exist is an error, never a
 *                      fallback. Under `npx tsx`, Node itself also reads this
 *                      flag (a missing path exits 9 before the script runs),
 *                      so use the default lookup unless you need another file.
 *   --help, -h         print the usage and exit
 *
 * Exit codes: 0 done (or nothing to change), 1 any error (bad argument, no
 * env file, an unset FRED key, an empty table, an incomplete month, a DB
 * error; a failed apply rolled back).
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { dbHost } from './_lib/econ-label-backfill.js';
import {
  formatReport,
  parseArgs,
  runBackfill,
  UNDO_DIR,
  USAGE,
} from './_lib/snapshot-event-flag-backfill.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  console.log(`Database host: ${dbHost(process.env.DATABASE_URL)}`);
  const result = await runBackfill({ apply: args.apply, undoDir: UNDO_DIR });
  console.log(formatReport(result));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
