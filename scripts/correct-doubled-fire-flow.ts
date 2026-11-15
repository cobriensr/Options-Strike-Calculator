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
 * fires, three ticker-days at a time. The default is a dry run: it prints, per
 * table and per date, the rows correct, doubled and other (left alone, listed),
 * what each corrected lottery fire's score would do, and the alignment flips,
 * and writes nothing. `--apply` writes an undo file under
 * docs/tmp/fire-flow-correction/ (relative to the working directory) first,
 * then the corrected values, 500 rows to a statement, each only where the row
 * still holds the values the dry run read. A second `--apply` writes nothing.
 * `--undo-file` restores the old values from such a file, row by row, only
 * where a row still holds the corrected ones.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change), 1 any error
 * (bad argument, no env file, a DB error; a failed apply is safe to repeat).
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
