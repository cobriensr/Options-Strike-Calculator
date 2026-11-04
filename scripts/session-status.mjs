#!/usr/bin/env node
/**
 * Read-only status of the work: the main checkout, every worktree and the CI
 * verdict of the last commits on origin/main. Logic lives in
 * scripts/_lib/session-status.mjs.
 *
 *   node scripts/session-status.mjs [--no-ci] [--count <n>] [--fetch]
 *
 * Prints three sections of plain aligned text:
 * - the main checkout: path, branch, ahead/behind origin/main, uncommitted
 *   files;
 * - each worktree: branch, ahead/behind, uncommitted files, age of the last
 *   commit and a tag (merged, dirty, ahead N, missing, locked), cleanup
 *   candidates last. "merged" counts a squashed or rebased branch;
 * - the last commits on origin/main, each with one poll of its CI
 *   (success, failure, pending, canceled-superseded, no-ci for an old commit
 *   that never had a check run, or unknown when gh could not say). --no-ci
 *   skips this section; --count changes its size.
 *
 * It changes nothing, and does not fetch: the first line says how old the
 * origin/main ref is. --fetch runs `git fetch origin` first.
 *
 * Exit codes: 0 printed, 1 unexpected failure, 2 bad arguments, 3 git
 * missing, not a repository, or no origin/main.
 */
import {
  EXIT,
  SetupError,
  USAGE,
  collectStatus,
  formatReport,
  parseArgs,
} from './_lib/session-status.mjs';
import { UsageError } from './_lib/watch-deploy.mjs';

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`session-status: ${err.message}`);
    console.error(USAGE);
    return EXIT.BAD_ARGS;
  }
  if (args.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  try {
    console.log(formatReport(await collectStatus(args)));
    return EXIT.OK;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`session-status: ${message}`);
    return err instanceof SetupError ? EXIT.UNAVAILABLE : EXIT.FAILED;
  }
}

process.exitCode = await main(process.argv.slice(2));
