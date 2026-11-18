/**
 * Time limits for a test that runs a child process with spawnSync, and the
 * helper that applies them. Not itself a test file; vitest only collects
 * *.test.mjs.
 *
 * A synchronous spawn blocks the test worker, so vitest cannot interrupt it:
 * it can only fail the test after the spawn returns, with "Test timed out"
 * and nothing about the child. So the child gets its own limit (`timeout` on
 * the spawn), the test's timeout sits above it, and spawnChild turns a child
 * killed at its limit into an error that names the child, the limit and what
 * it had written to stderr. Without that error a killed child comes back as
 * `status: null` and fails as "expected null to be 1". The limits come from
 * here so they cannot drift apart: a test timeout at or below the spawn's
 * hides the child's failure (greek-nope-backfill.cli.test.mjs ran a 60 s
 * spawn under vitest's default 15 s test timeout, and failed as "Test timed
 * out in 15000ms" under load on 2026-11-17).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GIT_TIMEOUT_MS } from './git-run.mjs';
import { FIXTURE_TIMEOUT } from './scratch-git.fixtures.mjs';

/**
 * What a child gets before spawnSync kills it. A Windows spawn under a full
 * suite run on a loaded machine can take tens of seconds.
 */
export const CHILD_TIMEOUT = 60_000;

/**
 * The test timeout for a test that spawns one child: the child's limit plus a
 * margin for the fixture work and the assertions around the spawn.
 */
export const CHILD_TEST_TIMEOUT = CHILD_TIMEOUT + 30_000;

/**
 * The limit of a child that runs a whole CLI over a scratch repo, which makes
 * many git calls of its own (the prune and session-status CLIs, the review
 * gate). The three limits nest, innermost first: one git call (GIT_TIMEOUT_MS,
 * 300 s) inside the CLI child (this one, halfway to the next: 450 s) inside
 * the hook or test that waits on the child (FIXTURE_TIMEOUT, 600 s, from
 * setupScratchGit). Whichever fires first names what stalled: a stuck git
 * makes the CLI print its GitError and exit before the CLI's own limit, and a
 * stuck CLI is killed by spawnChild before the hook gives up. Equal limits
 * would race, and a git stall could be named as the CLI. Derived from the other
 * two, so the order holds when either moves; spawn-timeout.test.mjs asserts it.
 */
export const SLOW_CHILD_TIMEOUT = (GIT_TIMEOUT_MS + FIXTURE_TIMEOUT) / 2;

/** How much of the child's stderr an error quotes. */
const STDERR_TAIL = 500;

/**
 * spawnSync with a time limit (`options.timeout`, else CHILD_TIMEOUT), and an
 * error instead of a `status: null` result when the child could not run or
 * was killed at its limit. The error names the command and its arguments, the
 * limit, and the last STDERR_TAIL characters of stderr so far (when
 * `options.encoding` makes stderr a string); the spawn's own error is its
 * `cause`. Any child that ran to an exit, whatever the code, is returned
 * unchanged.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
export function spawnChild(command, args, options = {}) {
  const limit = options.timeout ?? CHILD_TIMEOUT;
  const result = spawnSync(command, args, { ...options, timeout: limit });
  const { error } = result;
  if (error === undefined) return result;

  const why =
    error.code === 'ETIMEDOUT'
      ? `timed out after ${limit / 1000} s`
      : `could not run (${error.message})`;
  const tail =
    typeof result.stderr === 'string'
      ? result.stderr.trim().slice(-STDERR_TAIL)
      : '';
  const quoted = tail === '' ? '' : `\nstderr so far:\n${tail}`;
  throw new Error(
    `child process ${why}: ${path.basename(command)} ${args.join(' ')}${quoted}`,
    { cause: error },
  );
}
