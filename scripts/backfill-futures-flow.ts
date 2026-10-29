/**
 * One-time backfill of futures_bars order flow (buy/sell volume and print
 * counts) from Unusual Whales REST prints, back to the start of UW's REST
 * history: ES from 2026-06-30, NQ/RTY/CL/GC/ZN from 2026-07-21 (spec
 * Phase 6b). The nightly backfill-futures-gaps cron repairs only its
 * 3-day window; this reaches the rest.
 *
 * Writes only bars whose buy_volume is still NULL, and only minutes whose
 * REST volume is within 2% of the bar's. So it never overwrites websocket
 * flow, and a re-run skips the root-days it already finished. Logic and
 * rules: scripts/_lib/futures-flow-backfill.ts.
 *
 * Usage (env from .env.local, like the other scripts: DATABASE_URL and
 * UW_API_KEY, never printed). Run after the close: it refuses to start
 * during market hours and stops between dates if they begin.
 *   npx tsx scripts/backfill-futures-flow.ts --dry-run
 *   npx tsx scripts/backfill-futures-flow.ts
 *   npx tsx scripts/backfill-futures-flow.ts 2026-07-14 2026-07-15
 *   npx tsx scripts/backfill-futures-flow.ts --from 2026-08-01 --to 2026-08-31 --roots ES,NQ
 * Flags: --dry-run (read and match, no writes) · --from/--to YYYY-MM-DD
 *        (UTC, inclusive; default: each root's history start to today) ·
 *        --roots ES,NQ,... (default all six) · --max-pages N (default
 *        20000, checked between dates; the log says where to resume).
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
