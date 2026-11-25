#!/usr/bin/env node

/**
 * Replace the placeholder SPX and NDX one-minute rows in index_candles_1m, one
 * date and one symbol at a time: UW's SPY (or QQQ) final bars times that
 * date's Schwab daily-close ratio, checked against the day's real close before
 * anything is written, in one transaction per date, with a backup and an undo.
 * Spec: docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md.
 * This file is arguments, guards and wiring; every decision (the lists, the
 * delete predicate, the day check, the backup, the undo) is in
 * scripts/_lib/index-candle-repair.mjs, which the test covers.
 *
 * The lists (exact trading days, no range that touches another day):
 *   spx-repair  SPX 2026-02-25 -> 04-10        replace the x10 placeholders
 *   ndx-repair  NDX 2026-03-23 -> 05-01        replace the x48 placeholders
 *   ndx-fill    NDX 2026-02-25 -> 03-20        insert only
 *   gap         SPX and NDX, 09-21 -> 09-30 and 10-08 -> 10-15   insert only
 *
 * Dry run is the default: it fetches, maps and checks each date, reads what is
 * stored, and prints the delete and insert counts and the ratio. It writes
 * nothing, no backup either. `--apply` writes. Per date, with --apply:
 *   1. the rows the delete predicate selects are written to
 *      <main checkout>/docs/tmp/spx-candle-repair/<symbol>-<date>-<stamp>.jsonl
 *      (every column as text, id and created_at included) and read back;
 *   2. a manifest next to it records the ids and a run marker, committed: false;
 *   3. one transaction deletes those rows and inserts the new ones
 *      (ON CONFLICT (symbol, date, timestamp) DO NOTHING);
 *   4. the manifest is rewritten with the inserted ids, committed: true.
 * A date whose UW answer is an error, empty, short or at the row cap, that has
 * no ratio, whose last regular close is not within 4 pt of outcomes.settlement
 * (SPX) or 15 pt of the Schwab $NDX close (NDX), or whose new rows would leave
 * a stored regular minute empty, is skipped untouched with the reason, and the
 * run ends with exit code 1. Each date's line also prints `dropped` (UW bars
 * left out as malformed) and `uncovered` (stored pre- or post-market minutes
 * no new row replaces: they are deleted, not skipped, since the placeholder
 * there held a wrong value anyway).
 *
 * `--undo <manifest>` restores one run: it removes what the run inserted and
 * puts the backed-up rows back with their own id and created_at. It is a dry
 * run too until --apply comes with it, and needs no UW key, no Schwab and no
 * market-hours wait. Undo runs newest first: undoing an older run over a newer
 * one fails and changes nothing. A `--lottery-spots` manifest says so in its
 * `kind`, and the same flag undoes it (it puts the old spot and distance back).
 *
 * `--lottery-spots` runs after the gap days' candles are repaired (the `gap`
 * list), takes no --symbol, --list or --date, and corrects the stale
 * `spot_at_event` and `strike_dist` of the gap days' periscope_lottery_fires
 * from those candles (scripts/_lib/lottery-spot-repair.mjs has the rules).
 * Dry run unless --apply: it prints how many fires would change, how many no
 * longer pass their own filter (they are kept, not deleted), each fire with no
 * same-day SPX bar (left unchanged) and each fire whose bar is more than 5
 * minutes older than the fire (updated all the same: it means that day's
 * candles are not repaired). With --apply the old values go to a JSONL backup
 * and a manifest beside it first, then one transaction updates the two columns
 * and nothing else, each fire only while it still holds the values the plan
 * read. It needs only DATABASE_URL (no UW key, no Schwab call) and keeps only
 * the 08:15-15:30 CT guard, which refuses until 15:30 CT, so run it after
 * 15:30 CT, once the candle repair is done (spec decision 5's "after 15:00 CT"
 * is the looser bound). Exit 1 when any fire has no same-day bar, dry run or
 * apply: those fires keep their stale spot.
 *
 * Schwab: the token record is read from the PRODUCTION Upstash Redis and, when
 * it has run out, refreshed in place with a compare-and-set, so the repair
 * refuses to start on a weekday 13:00-22:59 UTC, when the Schwab crons run.
 * Like the backfills it also refuses 08:15-15:30 CT and stops taking dates when
 * that window opens mid-run (exit 3). There is no flag to lift either, so the
 * refusals name none. A dry run still calls Schwab and UW.
 * Runs against whatever DATABASE_URL points at (.env.local = PRODUCTION).
 *
 * Usage (from the repo root; the keys are never printed):
 *   node --env-file=.env.local scripts/repair-index-candle-placeholders.mjs \
 *     --symbol SPX --date 2026-03-26 [--apply]
 *   node --env-file=.env.local scripts/repair-index-candle-placeholders.mjs \
 *     --symbol NDX --list ndx-repair [--apply]
 *   node --env-file=.env.local scripts/repair-index-candle-placeholders.mjs \
 *     --undo docs/tmp/spx-candle-repair/<symbol>-<date>-<stamp>.manifest.json [--apply]
 *   node --env-file=.env.local scripts/repair-index-candle-placeholders.mjs \
 *     --lottery-spots [--apply]
 *   node --env-file=.env.local scripts/repair-index-candle-placeholders.mjs \
 *     --undo docs/tmp/spx-candle-repair/lottery-spots-<stamp>.manifest.json [--apply]
 *
 * Flags:
 *   --symbol SPX|NDX   required, except with --undo and --lottery-spots
 *   --list <name>      one of spx-repair, ndx-repair, ndx-fill, gap
 *   --date YYYY-MM-DD  one date, which must be in a list of that symbol
 *   --apply            write (default: dry run)
 *   --undo <manifest>  restore a run, from its manifest
 *   --lottery-spots    correct the gap days' lottery fire spots (alone)
 *
 * Environment: UW_API_KEY; DATABASE_URL; UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN);
 * SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET. The repair needs all of them, the
 * undo and --lottery-spots only DATABASE_URL.
 *
 * Exit codes: 0 every date done, 1 a date was skipped or failed (or a key is
 * missing, or the run aborted), 2 bad flags, 3 a guard refused or stopped the
 * run.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';

import {
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  EXIT_OK,
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  formatRunSummary,
  redact,
  runDays,
  summarizeRun,
} from './_lib/backfill-cli.mjs';
import { loadSchwabCloses, ratioLines } from './_lib/candles-backfill.mjs';
import { git } from './_lib/git-run.mjs';
import {
  defaultBackupDir,
  describeUndo,
  parseRepairArgs,
  processRepairDay,
  repairGuardRefusal,
  undoRepair,
} from './_lib/index-candle-repair.mjs';
import {
  describeUndoLotterySpots,
  lotterySpotLines,
  lotterySpotsExitCode,
  lotterySpotsGuardRefusal,
  manifestKind,
  repairLotterySpots,
  undoLotterySpots,
} from './_lib/lottery-spot-repair.mjs';
import { readSchwabEnv } from './_lib/schwab-local.mjs';

let plan;
try {
  plan = parseRepairArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(EXIT_BAD_ARGS);
}

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const secrets = { uwKey: UW_API_KEY, databaseUrl: DATABASE_URL };
const say = (line = '') => console.log(redact(line, secrets));

/**
 * The undo: report the plan, and with --apply run it. Returns the exit code.
 * The manifest's `kind` picks the repair: a lottery-spots one or, with none,
 * an index-candle one.
 */
async function runUndo() {
  const lottery = (await manifestKind(plan.manifest)) === 'lottery-spots';
  const what = lottery
    ? 'periscope_lottery_fires spot repair'
    : 'index_candles_1m repair';
  say(
    `${what} UNDO${plan.apply ? '' : ' (DRY RUN: nothing written)'}: ` +
      plan.manifest,
  );
  const describe = lottery ? describeUndoLotterySpots : describeUndo;
  for (const line of await describe(plan.manifest)) say(line);
  if (!plan.apply) {
    say('DRY RUN: nothing written. Re-run with --apply to undo.');
    return EXIT_OK;
  }
  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL (run with --env-file=.env.local)');
    return EXIT_FAILED;
  }
  if (lottery) {
    const { restored } = await undoLotterySpots(
      neon(DATABASE_URL),
      plan.manifest,
    );
    say(`restored the spot and distance of ${restored} fires`);
    return EXIT_OK;
  }
  const { removed, restored } = await undoRepair(
    neon(DATABASE_URL),
    plan.manifest,
  );
  say(`removed ${removed} inserted rows, restored ${restored} backed-up rows`);
  return EXIT_OK;
}

/** The main checkout's backup folder, found from this worktree through git. */
function backupDirFromGit() {
  const out = git(
    [
      '-C',
      dirname(fileURLToPath(import.meta.url)),
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
    process.env,
  );
  return defaultBackupDir(out);
}

/** The repair, one date at a time. Returns the exit code. */
async function runRepair() {
  const { symbol, list, dates, apply } = plan;
  const refusal = repairGuardRefusal();
  if (refusal) {
    console.error(refusal);
    return EXIT_GUARD_STOP;
  }
  const schwabEnv = readSchwabEnv();
  if (!UW_API_KEY) {
    console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
    return EXIT_FAILED;
  }
  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL (run with --env-file=.env.local)');
    return EXIT_FAILED;
  }
  if (schwabEnv.problem) {
    console.error(schwabEnv.problem);
    return EXIT_FAILED;
  }
  // Before any date runs: a worktree with no git in reach must not get as far
  // as a delete.
  const backupDir = apply ? backupDirFromGit() : undefined;

  say(
    `Repairing index_candles_1m ${symbol}, list ${list}, ${dates.length} ` +
      `${dates.length === 1 ? 'date' : 'dates'}, ${dates[0]} -> ${dates.at(-1)}` +
      (apply ? '' : ' (DRY RUN: no Neon writes, no backup)'),
  );
  if (backupDir != null) say(`  backups: ${backupDir}`);

  // The ratios, once for the run. A failure is not fatal here: it fails the
  // dates that needed it, by name (ratioFor).
  const closes = await loadSchwabCloses(
    new Redis({ url: schwabEnv.redisUrl, token: schwabEnv.redisToken }),
    { clientId: schwabEnv.clientId, clientSecret: schwabEnv.clientSecret },
    dates[0],
    dates.at(-1),
  );
  say();
  for (const line of ratioLines(closes, dates)) say(line);
  say();

  const sql = neon(DATABASE_URL);
  const waitForSlot = createRequestThrottle(UW_REQUESTS_PER_MINUTE);
  // offerFlag: false, so a mid-run `stopped:` line names no flag (there is none).
  const run = await runDays(
    dates,
    { allowMarketHours: false, offerFlag: false, secrets },
    (date) =>
      processRepairDay(sql, {
        symbol,
        date,
        list,
        closes,
        uwKey: UW_API_KEY,
        waitForSlot,
        backupDir,
        apply,
      }),
  );
  const summary = summarizeRun(run);
  for (const line of formatRunSummary(summary)) say(line);
  say(
    '(dropped: UW bars left out as malformed. uncovered: stored pre- or ' +
      'post-market minutes no new row replaces; they are deleted. Read both.)',
  );
  if (!apply) {
    say(
      '(dry run: stored is 0 by design; wouldDelete and wouldInsert are what ' +
        '--apply would change)',
    );
  }
  return summary.exitCode;
}

/**
 * The gap days' lottery fire spots: report the plan, and with --apply write
 * it. Only the market-hours guard applies (no Schwab call is made). Returns
 * the exit code: 1 when any fire has no same-day bar (lotterySpotsExitCode).
 */
async function runLotterySpots() {
  const { apply } = plan;
  const refusal = lotterySpotsGuardRefusal();
  if (refusal) {
    console.error(refusal);
    return EXIT_GUARD_STOP;
  }
  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL (run with --env-file=.env.local)');
    return EXIT_FAILED;
  }
  // Before the plan is read: a worktree with no git in reach must not get as
  // far as an update.
  const backupDir = apply ? backupDirFromGit() : undefined;

  say(
    `Correcting periscope_lottery_fires spot_at_event and strike_dist on the ` +
      `gap days${apply ? '' : ' (DRY RUN: no Neon writes, no backup)'}`,
  );
  if (backupDir != null) say(`  backups: ${backupDir}`);
  const result = await repairLotterySpots(neon(DATABASE_URL), {
    apply,
    backupDir,
  });
  for (const line of lotterySpotLines(result, { apply })) say(line);
  if (!apply) {
    say('(dry run: nothing written. Re-run with --apply to update.)');
  }
  const exitCode = lotterySpotsExitCode(result);
  if (exitCode !== EXIT_OK) {
    say(
      '(exit 1: the fires with no same-day SPX bar keep their stale spot; ' +
        'repair the candles of those days, then run this again)',
    );
  }
  return exitCode;
}

const RUNNERS = {
  repair: runRepair,
  undo: runUndo,
  'lottery-spots': runLotterySpots,
};

try {
  process.exitCode = await RUNNERS[plan.mode]();
} catch (err) {
  console.error(
    redact(`${plan.mode} aborted: ${err?.message ?? err}`, secrets),
  );
  process.exitCode = EXIT_FAILED;
}
