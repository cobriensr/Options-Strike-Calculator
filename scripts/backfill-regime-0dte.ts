/**
 * One-off backfill of `flow_regime_0dte_daily` from the live source tables.
 *
 * Seeds the 0DTE gamma-regime self-scoring table, and repairs single days of it.
 * The logic is in scripts/_lib/regime-0dte-backfill.ts (its header says what the
 * run does and why it only takes days with all three source tables); this file
 * calls it and exits with its code. It READS and WRITES the database
 * DATABASE_URL points at: production, in .env.local.
 *
 * RUN (from the repo root; DATABASE_URL in .env.local is PROD — DRY-RUN first)
 *   node --import tsx --env-file=.env.local scripts/backfill-regime-0dte.ts
 *   node --import tsx --env-file=.env.local scripts/backfill-regime-0dte.ts --apply
 *   node --import tsx --env-file=.env.local scripts/backfill-regime-0dte.ts \
 *     --from 2026-09-21 --to 2026-09-21 [--apply]
 *
 * Args:  --from YYYY-MM-DD --to YYYY-MM-DD  inclusive dates limiting the
 *          candidate days; either may be given alone, and with neither every
 *          candidate day runs. A range that leaves no day to score exits 1.
 *        --apply  upsert the rows; without it nothing is written
 *
 * Exit codes: 0 done, 1 any failure (a DB error included), 2 a bad flag, before
 * any SQL runs: an unknown flag or a stray argument never falls through to a
 * full run.
 */

import { runRegimeBackfill } from './_lib/regime-0dte-backfill.js';

runRegimeBackfill(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
