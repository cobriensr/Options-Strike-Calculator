/**
 * Phase 4 of the ES/NQ contract-mix repair: recompute the three stores that
 * saved values computed from the old bad futures_bars. The logic is in
 * scripts/_lib/futures-derived-recompute.ts. Spec:
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 *
 *   npx tsx scripts/recompute-futures-derived.ts --backup <phase 2 backup.jsonl>   # dry run
 *   npx tsx scripts/recompute-futures-derived.ts --backup <file> --apply --expect-snapshots N --expect-premarket M --expect-fires K
 *   npx tsx scripts/recompute-futures-derived.ts --stores fires    # a dry run of one store, no backup needed
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and writes only report.txt into --work-dir. --apply WRITES to that
 * database, after the close, only after the owner has seen the dry run, and
 * only when every check passes: the snapshot method control (rows written by
 * today's code) recomputes to exactly what is stored (for RTY, CL, GC and ZN a
 * miss that a late bar explains also counts), the pre-market subset
 * check holds on every row outside the span, the fire basis control matches,
 * and the totals equal the --expect-* counts. A saved value is written only
 * where one of its input bars was changed or deleted by Phase 2 (read from the
 * backup). Exit codes: 0 done, 1 failed or refused, 2 stopped between stores
 * because market hours began.
 *
 * Options:
 *   --backup <file>         the Phase 2 backup JSONL (docs/tmp/futures-contract-repair/backup-*.jsonl);
 *                           required with --apply or with the snapshots or premarket store
 *   --work-dir <dir>        report.txt, backup-*.jsonl and the {store}.applied
 *                           markers (default docs/tmp/futures-derived-recompute)
 *   --stores s1 s2 ...      only these of snapshots, premarket, fires (default all). A dry run
 *                           plans only these; --apply still plans and checks all three and
 *                           writes only these
 *   --apply                 write (backup first); needs an --expect-* per store in the run
 *   --expect-snapshots N    the futures_snapshots rows to write in the approved dry run
 *   --expect-premarket M    the pre_market_data rows to write in that dry run
 *   --expect-fires K        the es_basis_change_5m values to write in that dry run;
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
