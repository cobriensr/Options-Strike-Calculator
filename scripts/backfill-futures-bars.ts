/**
 * One-time rebuild of missing futures_bars rows (1-minute OHLCV plus the
 * four aggressor-flow columns) from Unusual Whales REST prints, by the
 * live uw-stream handler's rules. Built for the UTC days 2026-09-04 →
 * 09-28, which hold no bar for any root. Writes only minutes that have no
 * bar (ON CONFLICT DO NOTHING), so it never replaces a live bar. A
 * root-day with no missing Globex-open minute makes no UW call, so a
 * re-run skips what it already filled; one that still has a missing
 * minute (a sparse overnight tape, a holiday) is paged again. Each bar
 * comes from, and records, the contract its CME trade date was decided on
 * (futures_front_month; a real run decides a date with no row yet), and
 * only that contract is paged. A root-day on a trade date before
 * 2026-07-28, where the table starts, fails by name. Logic and rules:
 * scripts/_lib/futures-bar-backfill.ts.
 *
 * Usage (env from .env.local, like the other scripts: DATABASE_URL and
 * UW_API_KEY, never printed). Run after the close: it refuses to start
 * during market hours and stops between dates if they begin. A date range
 * is required; every root-day in it is paged in full (about 1,000 pages
 * for an ES day; the September range took 43,130 pages, about 2,500-3,000
 * a weekday across the six roots).
 *   npx tsx scripts/backfill-futures-bars.ts --compare 2026-10-30
 *   npx tsx scripts/backfill-futures-bars.ts --dry-run --from 2026-09-04 --to 2026-09-28 --max-pages 60000
 *   npx tsx scripts/backfill-futures-bars.ts --from 2026-09-04 --to 2026-09-28 --max-pages 60000
 *   npx tsx scripts/backfill-futures-bars.ts 2026-09-04 2026-09-05 --roots ES,NQ
 * Flags: --from/--to YYYY-MM-DD (UTC, inclusive) or explicit dates ·
 *        --roots ES,NQ,... (default all six) · --max-pages N (default
 *        20000, checked between dates: a real run over September needs
 *        more) · --dry-run (read, page and build; write nothing) ·
 *        --compare (write nothing; count how many REST-built bars equal
 *        the bars already stored, and print the first few differences).
 *        Neither writes a front-month row: a trade date with no stored
 *        front month is skipped and reported.
 * The current UTC day is never processed.
 *
 * Exit code 1 when any root-day failed, or the run stopped before its
 * last date (market hours began, or the page budget was spent). The log
 * ends with the failed root-days and the arguments that re-run them or
 * resume the rest.
 *
 * Spec: docs/superpowers/specs/2026-11-06-futures-sept-bar-backfill.md
 */

import { config as loadEnv } from 'dotenv';

// Load env BEFORE importing the backfill: the UW limiter's Redis client is
// built at import time, and without KV_REST_API_* it fails open, so the
// run would not share the crons' concurrency slots.
loadEnv({ path: '.env.local' });
const { parseBarArgs, runBarBackfill } =
  await import('./_lib/futures-bar-backfill.js');

let options: ReturnType<typeof parseBarArgs>;
try {
  options = parseBarArgs(process.argv.slice(2));
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
  process.exitCode = await runBarBackfill({ ...options, apiKey });
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
}
