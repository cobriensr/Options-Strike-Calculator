#!/usr/bin/env node
/**
 * Watch a commit's deploy until it settles. Logic lives in
 * scripts/_lib/watch-deploy.mjs.
 *
 *   node scripts/watch-deploy.mjs <sha> [--timeout <min>] [--repo owner/name]
 *
 * Polls the commit's statuses (Vercel and the Railway `Theta-Options -
 * <service>` contexts) and check runs through the authenticated `gh` CLI
 * every 30 s, until none is queued, in progress or pending and at least one
 * check run exists. Prints a line per status and check run, then a verdict.
 * --timeout is in minutes (default 30); --repo defaults to origin's.
 *
 * Exit codes: 0 everything success, skipped or neutral; 1 any failure,
 * cancellation or timed-out check; 2 the timeout was reached; 3 bad
 * arguments or `gh` missing.
 */
import {
  EXIT,
  USAGE,
  UsageError,
  ghAvailable,
  parseArgs,
  resolveRepo,
  watchDeploy,
} from './_lib/watch-deploy.mjs';

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    if (!(await ghAvailable())) {
      console.error(
        'watch-deploy: the `gh` CLI is not installed or not on PATH',
      );
      return EXIT.BAD_ARGS;
    }
    const repo = args.repo ?? resolveRepo();
    const sha = args.sha ?? '';
    console.error(
      `watch-deploy: ${repo}@${sha.slice(0, 7)} (timeout ${args.timeoutMinutes} min)`,
    );
    return await watchDeploy({
      repo,
      sha,
      timeoutMinutes: args.timeoutMinutes,
    });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`watch-deploy: ${err.message}`);
    console.error(USAGE);
    return EXIT.BAD_ARGS;
  }
}

process.exitCode = await main(process.argv.slice(2));
