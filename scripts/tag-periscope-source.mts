#!/usr/bin/env node
/**
 * One-time backfill of periscope_snapshots.source (migration #194, phase
 * P10b′ of docs/superpowers/specs/gexbot-refresh-2026-10-28.md).
 *
 * The table holds two different measurements: UW Periscope's market-maker
 * position estimates (the scraper, until 2026-05-26) and GEXBot's
 * classified taker flow in its taker-side sign (since). Owner decision D1
 * revised (2026-10-29): keep them apart and convert nothing. This script
 * only TAGS rows, 'scraper' before the cutover instant 2026-05-26T17:20Z
 * and 'gexbot' from it on. It never changes a value.
 * populate-periscope-from-gexbot tags every row it writes from P10b′ on.
 *
 * ── RUNBOOK (production, in order) ─────────────────────────────────────
 *   0. GATE: migration #194 must be applied BEFORE the P10b′ deploy. The
 *      new populate INSERT writes `source`, so without the column every
 *      populate run fails. Check (one row = applied):
 *        SELECT 1 FROM information_schema.columns
 *        WHERE table_name = 'periscope_snapshots' AND column_name = 'source';
 *      This script runs the same check and refuses without the column.
 *   1. Push (deploy) only after the 15:00 CT close and before 08:30 CT.
 *   2. Run this script the same evening: --dry-run first (expect
 *      0 fingerprint disagreements), then without it.
 *   3. If it ran BEFORE the deploy, run it again AFTER the deploy: rows the
 *      old code wrote in between have source NULL.
 *   4. After the next session, confirm the new code tags its rows:
 *        SELECT count(*) FROM periscope_snapshots WHERE source IS NULL;
 *      must return 0.
 *   5. After hours, reclaim the space. Every row is rewritten once, and
 *      the heap is at fillfactor 100, so the updates are non-HOT: the heap
 *      and all three indexes keep a dead copy of each row until then.
 *        VACUUM (ANALYZE) periscope_snapshots;
 *        REINDEX TABLE CONCURRENTLY periscope_snapshots;
 *      (REINDEX CONCURRENTLY cannot run inside a transaction block.)
 *
 * What a run does (scripts/_lib/tag-periscope-source.ts):
 *   - Checks the source column exists.
 *   - Scans the NULL-source rows by ET day, cross-checking the cutover
 *     against each row's timeframe fingerprint. On any disagreement it
 *     prints the days, writes nothing, and exits 1.
 *   - --dry-run: prints per-day and total counts; writes nothing.
 *   - Otherwise: one transaction per ET day (≤ ~20.6K rows), oldest
 *     first, with a progress line per day. It warns when a day's tagged
 *     counts differ from its plan (rows changed after the scan), then
 *     re-scans and exits 1 if any NULL-source row is left.
 * Resumable: an interrupted run leaves each day either fully done or
 * untouched, so just re-run it. A second complete run prints
 * "Nothing to do".
 *
 * Measured 2026-10-28 (read-only): 241 ET days and 2,240,813 rows
 * (1,465,182 GEXBot rows and 775,631 scraper rows to tag); the largest
 * day has 20,622 rows. Projected runtime is about 2–5 min.
 *
 * Usage (DATABASE_URL from .env.local, which points at production). It
 * needs tsx, because the api/ modules use `.js` imports that plain Node
 * type stripping cannot resolve:
 *   npx tsx --env-file=.env.local scripts/tag-periscope-source.mts --dry-run
 *   npx tsx --env-file=.env.local scripts/tag-periscope-source.mts
 *   npx tsx --env-file=.env.local scripts/tag-periscope-source.mts --yes
 * Without --dry-run it prints the target host and waits 5 s for Ctrl-C
 * before writing; --yes skips the wait.
 */

import { runTag } from './_lib/tag-periscope-source.js';

const argv = process.argv.slice(2);
const known = new Set(['--dry-run', '--yes', '-y']);
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}`);
  process.exit(1);
}
const dryRun = argv.includes('--dry-run');
const skipWait = argv.includes('--yes') || argv.includes('-y');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set; load .env.local first.');
  process.exit(1);
}
const host = url.split('@')[1]?.split('/')[0] ?? '(unknown host)';
console.log('Target database host:', host);

if (!dryRun && !skipWait) {
  const waitSec = 5;
  console.log(`Writing in ${waitSec} s; Ctrl-C to abort (--yes skips this).`);
  await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
}

try {
  process.exitCode = await runTag({ dryRun });
} catch (err) {
  console.error(
    'Tagging failed (days already done stay committed; re-run to resume):',
    err,
  );
  process.exitCode = 1;
}
