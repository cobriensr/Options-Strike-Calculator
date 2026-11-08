/**
 * One-time backfill of futures_bars order flow (buy/sell volume and print
 * counts) from Unusual Whales REST prints, back to 2026-07-28, the first
 * trade date with a stored front month (spec Phase 6b; UW's REST history
 * reaches back to 2026-06-30 for ES and 2026-07-21 for the rest, but no
 * contract is recorded for those dates, so a root-day on an earlier trade
 * date fails by name). The nightly backfill-futures-gaps cron repairs only
 * its 3-day window; this reaches the rest.
 *
 * Writes only bars whose buy_volume is still NULL, and only minutes whose
 * REST volume is within 2% of the bar's. So it never overwrites websocket
 * flow, and a re-run skips the root-days it already finished. Each minute's
 * contract is the one its CME trade date was decided on (futures_front_month;
 * a real run decides a date with no row yet), and only that contract is
 * paged. Logic and rules: scripts/_lib/futures-flow-backfill.ts.
 *
 * Usage (env from .env.local, like the other scripts: DATABASE_URL and
 * UW_API_KEY, never printed). Run after the close: it refuses to start
 * during market hours and stops between dates if they begin.
 *   npx tsx scripts/backfill-futures-flow.ts --dry-run
 *   npx tsx scripts/backfill-futures-flow.ts
 *   npx tsx scripts/backfill-futures-flow.ts 2026-08-04 2026-08-05
 *   npx tsx scripts/backfill-futures-flow.ts --from 2026-08-01 --to 2026-08-31 --roots ES,NQ
 * Flags: --dry-run (read and match; writes nothing, not even a front-month
 *        row: a trade date with no stored front month is skipped and
 *        reported) · --from/--to YYYY-MM-DD (UTC, inclusive; default:
 *        2026-07-28 to today) ·
 *        --roots ES,NQ,... (default all six) · --max-pages N (default
 *        20000, checked between dates; the log says where to resume).
 *
 * Exit code 1 when any root-day failed, or the run stopped before its last
 * date (market hours began, or the page budget was spent). The log then
 * names the root-days not reached and the arguments that resume them.
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 */

import { config as loadEnv } from 'dotenv';

// Load env BEFORE importing the backfill: the UW limiter's Redis client is
// built at import time, and without KV_REST_API_* it fails open, so the
// run would not share the crons' concurrency slots.
loadEnv({ path: '.env.local' });
const { parseArgs, runBackfill } =
  await import('./_lib/futures-flow-backfill.js');

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
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
  process.exitCode = await runBackfill({ ...options, apiKey });
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
}
