/**
 * Step 2 of the repair for lottery fires the detector wrote without flow
 * (spec: docs/superpowers/specs/sentry-noise-fixes-2026-11-13.md, Phase 5).
 * The logic, and what it does and does not write, is in
 * scripts/_lib/lottery-v2-rescore.ts.
 *
 * Run it from the repo root, AFTER `node scripts/backfill-ticker-flow-at-fire.mjs`
 * has filled `cum_ncp_at_fire` / `cum_npp_at_fire` for the same dates:
 *
 *   npx tsx scripts/rescore-lottery-v2-after-flow-backfill.ts --since 2026-10-29            # dry run
 *   npx tsx scripts/rescore-lottery-v2-after-flow-backfill.ts --since 2026-10-29 --apply    # writes
 *
 * Both modes READ the database DATABASE_URL points at (production, in
 * .env.local). The default is a dry run: it prints the active version, the
 * before and after counts and the rows per fire date, and writes nothing.
 * It scores with the weights of the version the `active` pointer names and
 * writes that version into `score_version`, as the detector does.
 * `--apply` writes an undo file under docs/tmp/lottery-v2-rescore/ (relative
 * to the working directory) first, then the scores and the version, 500 rows
 * to a statement, only where the score is still NULL, the row's tag is what
 * the dry run read, and the pointer still names that version. A second
 * `--apply` writes nothing and says so. Run it after the close (15:00 CT),
 * and not between 07:15 and 12:30 UTC, when the nightly refit may promote a
 * new version.
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
  formatReport,
  parseArgs,
  runRescore,
  UNDO_DIR,
  USAGE,
} from './_lib/lottery-v2-rescore.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // parseArgs has already refused a missing --since; this narrows the type.
  if (args.since == null) throw new Error('--since YYYY-MM-DD is required');
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  console.log(`Database host: ${dbHost(process.env.DATABASE_URL)}`);
  const result = await runRescore({
    apply: args.apply,
    since: args.since,
    undoDir: UNDO_DIR,
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
