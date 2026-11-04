/**
 * One-shot backfill of `wave2_status` (and `wave2_detected_at`) on
 * lottery_finder_fires and silent_boom_alerts, for old rows that
 * api/cron/wave2-confirmation.ts never labelled: late-day fires from before
 * the 2026-11-03 post-close fix (commit 600cb6b5) and the fires of the cron
 * outage days. The cron only looks at fires 75 to 90 minutes old, so nothing
 * else will.
 *
 * It applies the cron's own rule (api/_lib/wave2-rule.ts) and writes the
 * cron's columns, nothing else: no push, no notification. Scope, per table:
 * `wave2_status IS NULL`, at or after the table's first labelled row (a
 * query at run time), and more than 2 hours old. Rows before the first
 * label predate the feature and are left alone. Logic, shape and the
 * parity argument: scripts/_lib/wave2-backfill.ts.
 *
 * Idempotent and resumable: every UPDATE requires `wave2_status IS NULL`,
 * so a re-run changes nothing it already did, and a run that died just
 * continues. It is set-based (500 rows per statement), a few minutes for
 * about 22,000 rows.
 *
 * Usage (DATABASE_URL from .env.local, which points at PRODUCTION; never
 * printed). Run in this order, and review each output before the next:
 *   npx tsx scripts/backfill-wave2-status.ts --dry-run        read-only: per table
 *       and per verdict what it would write, plus per-day lines
 *   npx tsx scripts/backfill-wave2-status.ts --limit 50       writes at most 50 rows
 *       per table (the oldest in scope), the probe
 *   npx tsx scripts/backfill-wave2-status.ts                  the full run, ending
 *       in before and after counts of in-scope NULL rows
 * Exit code: 0 for a dry run, a --limit run, and a full run that left no
 * in-scope NULL row; 1 for a full run that did (re-run) or any error.
 *
 * Spec: docs/superpowers/specs/cron-followups-2026-11-03.md (item 7).
 */

import { config as loadEnv } from 'dotenv';

// Load env BEFORE importing the backfill, like the other prod-DB scripts.
loadEnv({ path: '.env.local' });
const { parseArgs, runBackfill } = await import('./_lib/wave2-backfill.js');

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; load .env.local first.');
  process.exit(1);
}

try {
  process.exitCode = await runBackfill(options);
} catch (err) {
  console.error(
    'Backfill failed (pages already written stay written; re-run to continue):',
    err,
  );
  process.exitCode = 1;
}
