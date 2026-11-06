/**
 * One-shot history backfill for the economic-event label fix (spec:
 * docs/superpowers/specs/2026-11-06-economic-events-fomc-classification.md,
 * phase 5). The logic is in scripts/_lib/econ-label-backfill.ts, which lists
 * what it repairs.
 *
 *   npx tsx scripts/backfill-economic-event-labels.ts            # dry run
 *   npx tsx scripts/backfill-economic-event-labels.ts --apply    # writes
 *
 * Both modes READ the database DATABASE_URL points at (production, in
 * .env.local). The default is a dry run: it prints what would change and
 * writes nothing. `--apply` writes it all in one transaction. A second
 * `--apply` changes zero rows and says so.
 *
 * ORDER, in production:
 *   1. Deploy the classifier and build-features changes first.
 *   2. Run this after the close, and after that day's post-close
 *      build-features run (`45 20,21 * * 1-5` UTC), so that day's row is
 *      covered.
 *   3. Do not re-run build-features with `?backfill=true` or `?date=` before
 *      this has run. Rows stored under the old classifier still carry `FOMC`
 *      on speech days, and build-features ORs `FOMC` rows into `is_fomc`, so
 *      a rebuild would put the wrong value back until step 1 here has
 *      reclassified economic_events.
 *
 * Options:
 *   --apply            write (without it: dry run)
 *   --dry-run          the default, said aloud; contradicts --apply
 *   --env-file <path>  .env.local to load (default: the nearest one up the
 *                      tree); a path that does not exist is an error, never a
 *                      fallback. Under `npx tsx`, Node itself also reads this
 *                      flag (a missing path exits 9 before the script runs),
 *                      so use the default lookup unless you need another file.
 *
 * Exit codes: 0 done (or nothing to change), 1 any error (bad argument, no
 * env file, a DB error; a failed apply rolled back).
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import {
  dbHost,
  formatReport,
  parseArgs,
  runBackfill,
} from './_lib/econ-label-backfill.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  console.log(`Database host: ${dbHost(process.env.DATABASE_URL)}`);
  const result = await runBackfill({ apply: args.apply });
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
