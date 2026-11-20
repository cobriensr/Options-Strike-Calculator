#!/usr/bin/env node

/**
 * Repair lottery_finder_fires.range_pos_at_trigger for the CRWD and SOXS fires
 * the 10-29 backfill pinned at 0 or 1: UW's candles are adjusted for a later
 * split and the stored spot_at_first isn't, and computeRangePos clamps the
 * gap (1,183 rows: CRWD 928 pinned at 1, SOXS 255 pinned at 0). Spec:
 * docs/superpowers/specs/2026-11-19-range-pos-split-repair-and-badge-text.md
 * (Task 2). The decisions, SQL and report live in
 * scripts/_lib/range-pos-split-repair.mjs; this file is the I/O around them.
 *
 * Per ticker-day with a non-NULL value in SPLIT_REPAIRS' window (CRWD
 * 2026-05-18..07-01, SOXS 2026-05-18..07-10):
 *   1. one UW GET /stock/{ticker}/ohlc/1m?date= (3 at a time);
 *   2. per row, the backfill's split guard decides:
 *        spot passes             → left alone (notArtifact);
 *        spot fails, spot × scale passes → range_pos recomputed from
 *                                  spot × scale (CRWD 0.25, SOXS 10);
 *        both fail, or no result → blanked (NULL);
 *   3. a UW error or an empty day leaves that day's rows untouched, counts
 *      them as failed and ends the run with exit 1 (a re-run repairs them).
 *
 * Dry run is the default: it does 1 and 2, prints the plan and samples, and
 * writes nothing (no backup either). `--apply` first writes every selected
 * row's current value to docs/tmp/range-pos-split-repair/backup-<UTC
 * stamp>.json (gitignored), reads it back, and only then runs the
 * ≤500-row UPDATEs, each guarded so a row changed since the read is skipped
 * and counted. `--undo <backup.json>` puts a backup's rows back (tickers in
 * SPLIT_REPAIRS only); it is a dry run too until `--apply` comes with it.
 *
 * Runs against whatever DATABASE_URL points at (.env.local = PRODUCTION).
 * The repair refuses to start 08:15–15:30 CT on weekdays, like the backfill:
 * its 3 UW calls in flight skip the shared Redis semaphore. The undo makes no
 * UW call, so it needs neither UW_API_KEY nor the market-hours wait.
 *
 * Usage (from the repo root; the key and URL are never printed):
 *   node --env-file=.env.local scripts/repair-range-pos-splits.mjs
 *   node --env-file=.env.local scripts/repair-range-pos-splits.mjs --apply
 *   node --env-file=.env.local scripts/repair-range-pos-splits.mjs \
 *     --undo docs/tmp/range-pos-split-repair/backup-<stamp>.json [--apply]
 *
 * Flags:
 *   --apply               write (default: dry run)
 *   --undo <backup.json>  restore a backup's rows
 *   --allow-market-hours  start the repair even inside the 08:15–15:30 CT window
 *
 * Exit codes: 0 ok, 1 a UW day failed or the run aborted (env missing, DB
 * error, backup unwritable), 2 bad flags, 3 refused for market hours.
 */

import { neon } from '@neondatabase/serverless';

import { isMarketHoursCt, redact } from './_lib/range-pos-backfill.mjs';
import {
  parseRepairArgs,
  runRepair,
  runUndo,
} from './_lib/range-pos-split-repair.mjs';

let args;
try {
  args = parseRepairArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const undoing = args.undoPath != null;

if (!undoing && isMarketHoursCt() && !args.allowMarketHours) {
  console.error(
    'Refusing to run 08:15–15:30 CT on a weekday: the repair would compete ' +
      "with the live crons for UW's concurrency cap. Run after the close, or " +
      'pass --allow-market-hours (e.g. on a market holiday).',
  );
  process.exit(3);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const required = undoing
  ? [['DATABASE_URL', DATABASE_URL]]
  : [
      ['UW_API_KEY', UW_API_KEY],
      ['DATABASE_URL', DATABASE_URL],
    ];
for (const [name, value] of required) {
  if (!value) {
    console.error(`Missing ${name} (run with --env-file=.env.local)`);
    process.exit(1);
  }
}

const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));
const sql = neon(DATABASE_URL);

try {
  const result = undoing
    ? await runUndo({
        sql,
        backupPath: args.undoPath,
        apply: args.apply,
        say,
      })
    : await runRepair({
        sql,
        apiKey: UW_API_KEY,
        apply: args.apply,
        say,
      });
  process.exitCode = result.exitCode;
} catch (err) {
  console.error(redact(`repair aborted: ${err?.message ?? err}`, secrets));
  process.exitCode = 1;
}
