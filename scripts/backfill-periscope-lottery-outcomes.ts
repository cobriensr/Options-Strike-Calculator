/**
 * Backfill the outcome columns of periscope_lottery_fires from UW
 * per-contract minute bars (/option-contract/{id}/intraday).
 *
 * The enrich-periscope-lottery-outcomes cron reads ws_option_trades, which
 * keeps WS_OPTION_TRADES_RETENTION_DAYS (2) of tape. A fire still unlocked
 * after that window can never be enriched by the cron. This script covers
 * exactly those fires: outcome_locked = FALSE, entry_px present, and
 * fire_time older than the retention window. The cron reads only fires
 * inside it.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply. It refuses to
 * run during market hours, because UW's 3-request concurrency cap is shared
 * with the live crons.
 *
 * What a run does (scripts/_lib/periscope-outcome-backfill.ts):
 *   1. Lists the rows it will never touch: unlocked fires with no
 *      entry_px, and unlocked fires that already hold some outcome column.
 *   2. Parity gate. Recomputes, from UW bars, the fires the cron locked
 *      inside the retention window and compares every outcome column
 *      (tolerance: NUMERIC(10,4) rounding). Any disagreement, or fewer
 *      than 20 comparable fires, fails loudly and blocks --apply.
 *   3. Walks the candidate days oldest first. It fetches each contract-day
 *      once and computes each fire with outcomeFromMinuteBars
 *      (api/_lib/periscope-lottery-outcome.ts, which documents the
 *      bar ↔ trade-tape mapping).
 *   4. Dry run: prints per-day counts, sample rows and totals.
 *      --apply: one batched unnest UPDATE per ≤ 500 fires.
 *
 * No outcome is not zero. A fire is left UNLOCKED, and reported by reason,
 * when:
 *   no_bars         UW has no bars for its contract-day;
 *   uw_error        the fetch failed (HTTP, network, timeout, or a malformed
 *                   body);
 *   tape_tail_dead  no fetched contract that day has a bar wholly in the
 *                   10 min before the close, so UW's session may be
 *                   truncated;
 *   in_flight       the window has not settled yet;
 *   bars_miss_entry / ambiguous_peak / ambiguous_eod
 *                   the bars cannot prove the cron's value.
 * A UW failure makes the run exit 1; re-running retries those days.
 *
 * Idempotent and resumable. Each UPDATE is conditional: the row must still
 * be unlocked, every outcome column still NULL, and entry_px unchanged
 * since the read. It RETURNs the ids actually written, so the script never
 * overwrites a value. Days commit independently. Re-running picks up
 * whatever is still unlocked; --start resumes from a day.
 *
 * Design, thresholds, dry-run numbers and the proposed outcome_source
 * migration: docs/superpowers/specs/periscope-lottery-outcome-backfill-2026-10-02.md
 *
 * Usage (env from .env.local, like the other scripts: DATABASE_URL and
 * UW_API_KEY):
 *   npx tsx scripts/backfill-periscope-lottery-outcomes.ts
 *   npx tsx scripts/backfill-periscope-lottery-outcomes.ts --start 2026-06-12 --end 2026-09-29
 *   npx tsx scripts/backfill-periscope-lottery-outcomes.ts --apply
 * Flags: --apply · --start/--end YYYY-MM-DD (expiry, inclusive) ·
 *        --parity N (max cron fires compared, default 500) ·
 *        --sample N (computed rows printed, default 10)
 */

import { config as loadEnv } from 'dotenv';
import { runBackfill } from './_lib/periscope-outcome-backfill.js';

// getDb() reads DATABASE_URL lazily, so loading here (after the hoisted
// imports) is still in time.
loadEnv({ path: '.env.local' });

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function positiveInt(
  raw: string | null,
  fallback: number,
  name: string,
): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${name} must be a positive integer, got ${raw}`);
    process.exit(1);
  }
  return n;
}

const argv = process.argv.slice(2);
const startDate = flagValue(argv, '--start');
const endDate = flagValue(argv, '--end');
for (const [name, v] of [
  ['--start', startDate],
  ['--end', endDate],
] as const) {
  if (v !== null && !DATE_RX.test(v)) {
    console.error(`${name} must be YYYY-MM-DD, got ${v}`);
    process.exit(1);
  }
}

const apiKey = process.env.UW_API_KEY;
if (!process.env.DATABASE_URL || !apiKey) {
  console.error('Missing DATABASE_URL or UW_API_KEY — load .env.local first.');
  process.exit(1);
}

try {
  process.exitCode = await runBackfill({
    apply: argv.includes('--apply'),
    startDate,
    endDate,
    parityLimit: positiveInt(flagValue(argv, '--parity'), 500, '--parity'),
    sampleSize: positiveInt(flagValue(argv, '--sample'), 10, '--sample'),
    apiKey,
  });
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
}
