/**
 * One-time seed of the per-session front-month tables from UW's daily
 * candles: `futures_contract_volume` (volume per contract and trade date,
 * for the sessions before the current one) and `futures_front_month` (the
 * contract per root and trade date, from 2026-07-22 through the running
 * session). The rule is `ensureFrontMonth`'s, run in memory over the
 * sessions; a decision row that is already stored is kept, and the walk
 * carries on from it. Writes are ON CONFLICT DO NOTHING, so a re-run
 * writes only what is missing. About 30 light UW calls; no market-hours
 * guard. Logic and rules: scripts/_lib/futures-front-month-backfill.ts.
 *
 * Usage (env from .env.local in the working directory, like the other
 * scripts: DATABASE_URL and UW_API_KEY, never printed; .env.local points at
 * PRODUCTION). Run a dry run first: it fetches, reads the stored rows,
 * walks and prints each root's switches, and writes nothing.
 *   npx tsx scripts/backfill-futures-front-month.ts --dry-run
 *   npx tsx scripts/backfill-futures-front-month.ts
 *   npx tsx scripts/backfill-futures-front-month.ts --roots ES,NQ
 * Flags: --dry-run (read, fetch and walk; write nothing, no read-back) ·
 *        --roots ES,NQ,... (default all six).
 *
 * The current trade date always gets a decision row. Run on a weekday, or
 * after the Sunday 17:00 CT open, to avoid a row for a date with no
 * session; the row is harmless if you do not.
 *
 * Exit code 1 when any root failed (named in the log, with the arguments
 * that re-run it); the other roots still run.
 *
 * Spec: docs/superpowers/specs/2026-11-06-futures-session-front-month.md
 * (Phase 3b)
 */

import { config as loadEnv } from 'dotenv';

// Load env BEFORE importing the seed: the UW limiter's Redis client is
// built at import time, and without KV_REST_API_* it fails open, so the
// run would not share the crons' concurrency slots.
loadEnv({ path: '.env.local' });
const { parseSeedArgs, runFrontMonthSeed } =
  await import('./_lib/futures-front-month-backfill.js');

let options: ReturnType<typeof parseSeedArgs>;
try {
  options = parseSeedArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const apiKey = process.env.UW_API_KEY;
if (!process.env.DATABASE_URL || !apiKey) {
  console.error('Missing DATABASE_URL or UW_API_KEY — load .env.local first.');
  process.exit(1);
}

try {
  process.exitCode = await runFrontMonthSeed({ ...options, apiKey });
} catch (err) {
  console.error('Seed failed:', err);
  process.exitCode = 1;
}
