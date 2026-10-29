#!/usr/bin/env node
/**
 * One-time re-sign of the GEXBot-era gamma rows in periscope_snapshots
 * (owner decision D1, phase P10b of
 * docs/superpowers/specs/gexbot-refresh-2026-10-28.md).
 *
 * GEXBot's per-strike gamma is taker-signed, the negative of the MM
 * convention every Periscope reader and rule assumes. From P10b on,
 * populate-periscope-from-gexbot negates it on ingest and tags its rows
 * source = 'gexbot'. This script fixes the ~488K gamma rows written
 * before that (2026-05-26 17:29Z on), and tags every other row: GEXBot
 * charm/vanna 'gexbot' (sign unchanged), UW scraper rows 'scraper'.
 *
 * ── RUN ORDER (production) ──────────────────────────────────────────────
 *   1. Apply migration #194 (periscope_snapshots.source) FIRST. The P10b
 *      populate INSERT writes the `source` column, so deploying P10b
 *      before #194 makes every populate run fail. This script also
 *      refuses to run without the column.
 *   2. Deploy the P10b code.
 *   3. Run this script soon after the deploy, after the close. Until it
 *      reaches a day, that day's stored gamma still carries the taker
 *      sign, so every periscope_snapshots reader (the Periscope lottery
 *      and gamma-setup detectors, the analyze Periscope block, historical
 *      replay, the GEX Target "MM Γ" column) reads it inverted, while the
 *      live GEXBot readers already serve MM sign.
 *   Steps 2 and 3 are order-safe: every UPDATE requires source IS NULL,
 *   and the new code writes 'gexbot' rows that are already negated, so
 *   no row is ever flipped twice, whichever runs first.
 *
 * What a run does (scripts/_lib/resign-gexbot-gamma.ts):
 *   - Checks the source column exists.
 *   - Scans the NULL-source rows by ET day and cross-checks the cutover
 *     (2026-05-26T17:20Z) against each row's timeframe fingerprint. Any
 *     disagreement: prints the days, writes nothing, exits 1.
 *   - --dry-run: prints per-day and total counts; writes nothing.
 *   - Otherwise: one transaction per ET day (≤ ~20.6K rows), oldest
 *     first, with a progress line per day; then re-scans and exits 1 if
 *     any NULL-source row is left.
 * Resumable: an interrupted run leaves whole days done or untouched;
 * re-run it. A second complete run prints "Nothing to do".
 *
 * Measured 2026-10-28 (read-only): 241 ET days, 2,240,813 rows (488,395
 * GEXBot gamma to negate, 976,787 GEXBot charm/vanna and 775,631 scraper
 * rows to tag), largest day 20,622 rows. Projected runtime about 2–5 min.
 * Every row is rewritten once, so expect the table (562 MB) to grow until
 * autovacuum reclaims the old versions; a manual
 * `VACUUM (ANALYZE) periscope_snapshots` afterwards speeds that up.
 *
 * Usage (DATABASE_URL from .env.local; production by default):
 *   npx tsx --env-file=.env.local scripts/resign-gexbot-gamma.mts --dry-run
 *   npx tsx --env-file=.env.local scripts/resign-gexbot-gamma.mts
 *   npx tsx --env-file=.env.local scripts/resign-gexbot-gamma.mts --yes
 * Without --dry-run it prints the target host and waits 5 s for Ctrl-C
 * before writing; --yes skips the wait.
 */

import { runResign } from './_lib/resign-gexbot-gamma.js';

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
  process.exitCode = await runResign({ dryRun });
} catch (err) {
  console.error(
    'Re-sign failed (days already done stay committed; re-run to resume):',
    err,
  );
  process.exitCode = 1;
}
