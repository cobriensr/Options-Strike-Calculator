/**
 * Phase 4 of the ES/NQ contract-mix repair: recompute the three stores that
 * saved values computed from the old bad futures_bars. The logic is in
 * scripts/_lib/futures-derived-recompute.ts. Spec:
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 *
 *   npx tsx scripts/recompute-futures-derived.ts                   # dry run
 *   npx tsx scripts/recompute-futures-derived.ts --apply --expect-snapshots N --expect-premarket M --expect-fires K
 *   npx tsx scripts/recompute-futures-derived.ts --stores fires    # one store
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and writes only report.txt into --work-dir. --apply WRITES to that
 * database, after the close, only after the owner has seen the dry run, and
 * only when every store's control set (rows outside the repaired span)
 * recomputes to exactly what is stored. Exit codes: 0 done, 1 failed or
 * refused, 2 stopped between stores because market hours began.
 *
 * Options:
 *   --work-dir <dir>        report.txt, backup-*.jsonl and the {store}.applied
 *                           markers (default docs/tmp/futures-derived-recompute)
 *   --stores s1 s2 ...      only these of snapshots, premarket, fires (default all)
 *   --apply                 write (backup first); needs an --expect-* per store in the run
 *   --expect-snapshots N    the futures_snapshots rows to change in the approved dry run
 *   --expect-premarket M    the pre_market_data rows to change in that dry run
 *   --expect-fires K        the es_basis_change_5m values to change in that dry run;
 *                           --apply refuses, before any write, when a total differs
 *   --force                 with --apply, redo stores that have a done marker
 *   --env-file <path>       .env.local to load (default: the nearest one up the tree);
 *                           a path that does not exist is an error, never a fallback
 */

import { config } from 'dotenv';
import logger from '../api/_lib/logger.js';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import {
  parseRecomputeArgs,
  runRecompute,
} from './_lib/futures-derived-recompute.js';

async function main(): Promise<number> {
  const args = parseRecomputeArgs(process.argv.slice(2));
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  // computeSnapshot logs one info line per stale row; thousands would bury the report.
  logger.level = 'warn';
  return runRecompute(args);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
