/**
 * Fill the SPX open, high, low, previous close and overnight gap on existing
 * `market_snapshots` rows (spec: docs/superpowers/specs/
 * 2026-11-17-server-snapshot-builder-design.md, goals G1, G1b and G2). The
 * logic, what each row gets and why a row or a date is skipped is in
 * scripts/_lib/snapshot-price-context.ts. A row with no open is filled; a row
 * with its open, which a replay wrote, loses the 5-minute peek its high and low
 * took (they become the values as of its slot) and gets its previous close and
 * gap. It covers dates through 2026-11-18 only: from the next day a live row
 * carries the quote's real-time open, high and low, and `--until` refuses a
 * later date.
 *
 * Two steps, from the repo root. Run the dry run outside 13:00-23:00 UTC on a
 * weekday (it calls /api/history about once a second per snapshot date, and
 * reads every snapshot row):
 *
 *   npx tsx scripts/backfill-snapshot-price-context.ts                          # dry run
 *   npx tsx scripts/backfill-snapshot-price-context.ts --since 2026-05-01       # a range
 *   npx tsx scripts/backfill-snapshot-price-context.ts --apply --plan docs/tmp/snapshot-price-context/dry-run-<time>.json
 *   npx tsx scripts/backfill-snapshot-price-context.ts --undo-file docs/tmp/snapshot-price-context/undo-<time>.json --apply
 *
 * The dry run READS the database DATABASE_URL points at (production, in
 * .env.local) and calls the owner's /api/history at APP_URL with the cookie
 * OWNER_SECRET, which is never printed (the host it goes to is). It prints the
 * counts, the dates and rows left alone by reason (bad-candles listed by date
 * and id), how many values are fills and how many overwrites, two sample rows
 * per kind for a hand check, and the dates whose training_features pick would
 * change. It prints a progress line per date to stderr. It writes a plan file
 * under docs/tmp/snapshot-price-context/ (relative to the working directory)
 * and nothing to the database.
 *
 * `--apply --plan F` applies exactly that file: no fetch, no re-plan, no
 * OWNER_SECRET. The file is checked first. Then an undo file is written, then
 * the rows, 500 to a statement, each only where the row still holds the values
 * the dry run read, then an apply report next to the undo file. A second
 * apply of the same plan writes nothing. `--undo-file` restores the old values
 * from an undo file, only where a row still holds the new ones.
 *
 * A "Redis not configured" log line at start is expected: the env file loads
 * after the imports, and this script never uses Redis.
 *
 * Options: see --help. Exit codes: 0 done (or nothing to change), 1 any error
 * (bad argument, no env file, a missing OWNER_SECRET or APP_URL, a refused
 * cookie, a plan file that fails its check, a DB error, an apply that stopped
 * part-way), a dry run in which any date's history failed or came back empty
 * (the rest of the dates are planned, and the report lists the failed ones for
 * a re-run with --since and --until), and an apply or an undo that wrote fewer
 * rows than it planned. The code is set on `process.exitCode`, never with
 * `process.exit`, so a piped stdout is flushed before the process ends.
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { dbHost } from './_lib/econ-label-backfill.js';
import {
  UNDO_DIR,
  USAGE,
  exitCodeOfApply,
  exitCodeOfDryRun,
  exitCodeOfUndo,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  historyOrigin,
  parseArgs,
  runApply,
  runDryRun,
  runUndo,
} from './_lib/snapshot-price-context.js';

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
  if (args.planFile != null) {
    const applied = await runApply({
      file: args.planFile,
      apply: args.apply,
      undoDir: UNDO_DIR,
    });
    console.log(formatApplyReport(applied));
    return exitCodeOfApply(applied);
  }
  // Before the first fetch: where the owner cookie is about to go.
  console.log(`History origin: ${historyOrigin(process.env)}`);
  const result = await runDryRun({
    since: args.since,
    until: args.until,
    undoDir: UNDO_DIR,
  });
  console.log(formatReport(result));
  return exitCodeOfDryRun(result);
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
