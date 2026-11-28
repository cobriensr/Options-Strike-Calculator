#!/usr/bin/env node

/**
 * Back up, scope and undo the rows Runbook C's rebuilds rewrite (spec
 * docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md, decision
 * 8). Several of those rebuilds have no dry run, so each is preceded by a
 * backup made here, and `--restore` puts it back. This file is arguments and
 * wiring; every decision (the allowlist, the exact-match rule, the guards inside
 * the transactions, the restore) is in scripts/_lib/rebuild-backup.mjs, which
 * the pglite test covers.
 *
 * The tables: training_features, day_labels, ws_gamma_setup_fires,
 * flow_regime_0dte_daily and day_embeddings. Nothing else is accepted.
 *
 * A backup is two files in <main checkout>/docs/tmp/spx-candle-repair/rebuild/:
 * <table>-<first>..<last>-<UTC stamp>.jsonl (every column of every row as text)
 * and <same>.manifest.json (table, key, the dates in scope, columns, row count
 * and checksum). Every write below takes the .jsonl and refuses, writing
 * nothing, unless the manifest is there and intact and the backup holds exactly
 * the rows the write touches, column for column, on dates that cover the whole
 * window.
 *
 *   --backup <table> --dates <list|from..to>
 *       Read-only on the database: writes the backup of the rows whose date
 *       column falls on those dates (the ET session date for fired_at). The
 *       dates are comma-separated, each a YYYY-MM-DD date or a from..to range
 *       of calendar days, at most 62 in all (a restore deletes everything in
 *       them, so a backup is a slice of a table, never the table), and none on
 *       or after today's ET date. It never overwrites a file and takes no
 *       --apply. It prints the absolute path of the backup, to pass to the
 *       other modes as --backup-file.
 *   --delete-gamma-fires --from D --to D --backup-file <path> [--apply]
 *       Deletes the ws_gamma_setup_fires whose ET session date is in the
 *       window; the backup's dates must cover every day of it. Refuses a fire
 *       with trade_taken = true or a non-NULL trade_premium_cost,
 *       trade_premium_close, trade_pnl_dollars or trade_notes (manual journal
 *       entries).
 *   --null-gamma-returns --date D --backup-file <path> [--apply]
 *       Sets ret_15m, ret_30m, ret_60m and ret_eod to NULL on that date's
 *       fires, and changes nothing else.
 *   --restore <table> --backup-file <path> [--apply]
 *       The undo: in one transaction deletes every row in the backup's scope
 *       (its dates, so the rows a rebuild created go too) and re-inserts the
 *       backed-up rows with their own keys, each value cast back to its
 *       column's type (::vector for an embedding), 500 rows at most per insert.
 *       For ws_gamma_setup_fires it refuses when a live fire in that scope has
 *       a journal entry the backup does not hold, as the delete would. A
 *       failed restore changes nothing.
 *
 * Dry run is the default for the three that write: they run every check and
 * print what they would do. --apply writes, in one transaction that checks
 * again: a fire inserted, a row changed or a journal entry written between the
 * check and the write makes the write refuse and change nothing.
 *
 * Runs against whatever DATABASE_URL points at (.env.local = PRODUCTION).
 *
 * Usage (from the repo root, a worktree included; the URL is never printed).
 * <backup.jsonl> is the absolute path the --backup run printed: the backups
 * live in the main checkout, which a relative path from a worktree would miss.
 *   node --env-file=.env.local scripts/rebuild-backup.mjs \
 *     --backup ws_gamma_setup_fires --dates 2026-02-26..2026-04-17
 *   node --env-file=.env.local scripts/rebuild-backup.mjs \
 *     --delete-gamma-fires --from 2026-02-26 --to 2026-04-17 \
 *     --backup-file <backup.jsonl> [--apply]
 *   node --env-file=.env.local scripts/rebuild-backup.mjs \
 *     --null-gamma-returns --date 2026-09-21 --backup-file <backup.jsonl> [--apply]
 *   node --env-file=.env.local scripts/rebuild-backup.mjs \
 *     --restore day_embeddings --backup-file <backup.jsonl> [--apply]
 *
 * Environment: DATABASE_URL.
 *
 * Exit codes: 0 done (or a dry run that passed every check), 1 refused or
 * failed (or DATABASE_URL is missing), 2 bad flags.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';

import { EXIT_BAD_ARGS, EXIT_FAILED, redact } from './_lib/backfill-cli.mjs';
import { git } from './_lib/git-run.mjs';
import { defaultBackupDir } from './_lib/index-candle-repair.mjs';
import { parseRebuildArgs, runRebuildBackup } from './_lib/rebuild-backup.mjs';

let plan;
try {
  plan = parseRebuildArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(EXIT_BAD_ARGS);
}

const DATABASE_URL = process.env.DATABASE_URL;
const secrets = { uwKey: undefined, databaseUrl: DATABASE_URL };
const say = (line) => console.log(redact(line, secrets));

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

try {
  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL (run with --env-file=.env.local)');
    process.exitCode = EXIT_FAILED;
  } else {
    // Before any read: a worktree with no git in reach must not get as far as a
    // backup written to the wrong place.
    const backupDir = plan.mode === 'backup' ? backupDirFromGit() : undefined;
    const { lines, exitCode } = await runRebuildBackup(
      neon(DATABASE_URL),
      plan,
      { backupDir },
    );
    for (const line of lines) say(line);
    process.exitCode = exitCode;
  }
} catch (err) {
  console.error(
    redact(`${plan.mode} aborted: ${err?.message ?? err}`, secrets),
  );
  process.exitCode = EXIT_FAILED;
}
