/**
 * Fill cum_ncp_at_fire + cum_npp_at_fire on lottery_finder_fires and
 * silent_boom_alerts rows that have none. Logic and what it writes:
 * scripts/_lib/ticker-flow-backfill.ts. Replaces
 * scripts/backfill-ticker-flow-at-fire.mjs, whose own series SQL doubled the
 * flow after the close (spec:
 * docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md).
 *
 * Run it from the repo root:
 *
 *   npx tsx scripts/backfill-ticker-flow-at-fire.ts --date 2026-11-13 --dry-run
 *   npx tsx scripts/backfill-ticker-flow-at-fire.ts --date 2026-11-13
 *
 * It READS and WRITES the database DATABASE_URL points at (production, in
 * .env.local); only --dry-run writes nothing. A "Redis not configured" log line
 * at start is expected: the env file loads after the imports.
 *
 * Options: see --help. Exit codes: 0 done, 1 any error (bad argument, no env
 * file, a DB error; a failed run is safe to repeat).
 */

import { config } from 'dotenv';
import { getDb } from '../api/_lib/db.js';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { dbHost } from './_lib/econ-label-backfill.js';
import {
  formatSummary,
  parseArgs,
  runBackfill,
  USAGE,
} from './_lib/ticker-flow-backfill.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  console.log(`Database host: ${dbHost(process.env.DATABASE_URL)}`);
  console.log('Querying NULL cum_ncp_at_fire groups…');
  const summary = await runBackfill(getDb(), args, (group, index, total) => {
    console.log(
      `[${index + 1}/${total}] ${group.ticker} ${group.date} (${group.nRows} rows across both tables)`,
    );
  });
  console.log(`\n${formatSummary(summary, args.dryRun)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
