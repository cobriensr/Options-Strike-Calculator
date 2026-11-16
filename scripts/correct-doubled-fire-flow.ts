/**
 * Correct the fires whose stored flow was written DOUBLED by a post-close
 * reader (spec: docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md).
 * The logic, what counts as doubled, what is written and how the score follows
 * is in scripts/_lib/fire-flow-correction.ts.
 *
 * Run it from the repo root, after the close (15:00 CT), and not between 07:15
 * and 12:30 UTC, when the nightly refit may promote a new score version:
 *
 *   npx tsx scripts/correct-doubled-fire-flow.ts --since 2026-10-29            # dry run
 *   npx tsx scripts/correct-doubled-fire-flow.ts --since 2026-10-29 --apply    # writes
 *   npx tsx scripts/correct-doubled-fire-flow.ts --undo-file docs/tmp/fire-flow-correction/undo-<time>.json --apply
 *
 * Both modes READ the database DATABASE_URL points at (production, in
 * .env.local): about two reads (a series, and an aggregate) per ticker-day with
 * fires, plus one more (the WS gaps) for a ticker-day with a doubled or a
 * look-ahead row, three ticker-days at a time. The default is a dry run: it
 * prints, per table and per date, the rows correct, doubled, look-ahead (a fire
 * before its ticker's first WS tick, whose flow goes to NULL) and other (left
 * alone, listed), what each planned lottery fire's score would do, the
 * alignment flips, every planned write (up to --list-limit) with its old and
 * new values, and the WS gaps of the doubled rows and of the look-ahead rows
 * (visibility only), and writes nothing. `--apply` writes an
 * undo file under docs/tmp/fire-flow-correction/ (relative to the working
 * directory) first, then the corrected values, 500 rows to a statement, each
 * only where the row still holds the values the dry run read. A second
 * `--apply` writes nothing.
 * `--undo-file` restores the old values from such a file, row by row, only
 * where a row still holds the corrected ones.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change; also an apply
 * during which the active score pointer moved but every planned row was still
 * written, which the report notes), 1 any error (bad argument, no env file, a DB
 * error, or an apply that left planned rows unwritten because the pointer moved;
 * a failed apply is safe to repeat).
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { dbHost } from './_lib/econ-label-backfill.js';
import {
  UNDO_DIR,
  USAGE,
  formatReport,
  formatUndoReport,
  parseArgs,
  runCorrection,
  runUndo,
} from './_lib/fire-flow-correction.js';

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
    return 0;
  }
  // parseArgs has already refused a missing --since; this narrows the type.
  if (args.since == null) throw new Error('--since YYYY-MM-DD is required');
  const result = await runCorrection({
    apply: args.apply,
    since: args.since,
    undoDir: UNDO_DIR,
    listLimit: args.listLimit,
  });
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
