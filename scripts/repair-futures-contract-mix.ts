/**
 * Phase 2 of the ES/NQ contract-mix repair: turn the Phase 1 front-month
 * rebuild (ml/data/futures-contract-repair/) into futures_bars writes. The
 * logic is in scripts/_lib/futures-contract-repair.ts. Spec:
 * docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
 *
 *   npx tsx scripts/repair-futures-contract-mix.ts                 # dry run
 *   npx tsx scripts/repair-futures-contract-mix.ts --apply         # writes
 *   npx tsx scripts/repair-futures-contract-mix.ts --apply --dates 2026-04-07
 *
 * The default is a DRY RUN: it reads the database DATABASE_URL points at
 * (production, in .env.local) through read-only transactions, prints the
 * summary and the full delete list, and writes only the report files into
 * --work-dir. --apply WRITES to that database, after the close, and only
 * after the owner has seen the dry run.
 *
 * Options:
 *   --dir <dir>        Phase 1 output (default ml/data/futures-contract-repair)
 *   --work-dir <dir>   report.txt, delete-list.csv, backup-*.jsonl and the
 *                      {day}.applied markers (default docs/tmp/futures-contract-repair)
 *   --apply            write (backup first, one UTC day per transaction)
 *   --dates d1 d2 ...  only these UTC days
 *   --force            with --apply, redo days that have a done marker
 *   --env-file <path>  .env.local to load (default: the nearest one up the tree);
 *                      a path that does not exist is an error, never a fallback
 */

import { config } from 'dotenv';
import { resolveEnvFile } from './_lib/anchor-backfill.js';
import { parseRepairArgs, runRepair } from './_lib/futures-contract-repair.js';

async function main(): Promise<number> {
  const args = parseRepairArgs(process.argv.slice(2));
  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  return runRepair(args);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
