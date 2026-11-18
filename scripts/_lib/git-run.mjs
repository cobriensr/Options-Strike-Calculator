/**
 * The git runner shared by scripts/_lib: spawnSync without a shell, in the
 * current directory (pass `-C <dir>` for another), with the env the caller
 * gives. `env` has no default because the callers need different ones:
 * prune-worktrees.mjs strips the vars that tie git to one repository, and
 * review-gate.mjs passes process.env through. Each module says why where it
 * builds its env.
 *
 * Node builtins only: .githooks/pre-commit runs scripts/review-gate.mjs,
 * whose _lib module imports this, in worktrees with no node_modules.
 */
import { spawnSync } from 'node:child_process';

/**
 * spawnSync's 1 MB default would fail (ENOBUFS) on a long path list or a
 * huge `git status`.
 */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/**
 * How long one git call may take before it is killed and reported as a
 * GitError. A call is a synchronous spawn: with no limit, a stuck git (an
 * index lock, a prompt, a dead drive) blocks the caller for good, in the
 * SessionStart prune, the pre-commit gate and every test that runs these
 * modules. Five minutes is far above any healthy call, a few seconds even on a
 * machine under full load, and under the 600 s the scratch-git test hooks get
 * (FIXTURE_TIMEOUT in scratch-git.fixtures.mjs), so a stall inside a hook
 * fails with the command named, not as a hook timeout that names nothing.
 */
export const GIT_TIMEOUT_MS = 300_000;

/**
 * A git command that could not run, timed out, or exited non-zero. `timedOut`
 * is true for the one killed at GIT_TIMEOUT_MS (see gitTimeoutError): a caller
 * that turns a failure into advice, such as "run `git fetch`", tests it, and
 * never the wording of `detail`.
 */
export class GitError extends Error {
  /**
   * @param {string[]} args
   * @param {string} detail git's stderr, or why git could not run.
   * @param {{ timedOut?: boolean }} [options]
   */
  constructor(args, detail, { timedOut = false } = {}) {
    super(`git ${args.join(' ')}: ${detail}`);
    this.name = 'GitError';
    this.detail = detail;
    this.timedOut = timedOut;
  }
}

/**
 * The GitError for a git call killed at GIT_TIMEOUT_MS. Every producer builds
 * it here, runGit and session-status's async spawn, so the two agree on the
 * text and on `timedOut`.
 *
 * @param {string[]} args
 */
export function gitTimeoutError(args) {
  return new GitError(args, `timed out after ${GIT_TIMEOUT_MS / 1000} s`, {
    timedOut: true,
  });
}

/**
 * Run git; returns `{ status, stdout, stderr }` whatever the exit code.
 * Throws GitError only when git could not run or ran past GIT_TIMEOUT_MS, and
 * TypeError when `env` is missing.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ input?: string }} [options] `input` is written to git's stdin
 *   (default: an empty stdin, which git sees as EOF).
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runGit(args, env, { input } = {}) {
  // spawnSync would run a missing env as process.env (`options.env ||
  // process.env`), silently undoing a caller's stripped env.
  if (env === null || typeof env !== 'object') {
    throw new TypeError(`runGit: env is required (git ${args.join(' ')})`);
  }
  // `git` from PATH, as for every git command a developer runs. Arguments go
  // in an array, so nothing is shell-parsed.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env,
    input,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    // spawnSync's own message for a kill at the limit is "spawnSync git
    // ETIMEDOUT": no limit in it, so a reader cannot tell a stall from a
    // failure to start.
    if (result.error.code === 'ETIMEDOUT') throw gitTimeoutError(args);
    throw new GitError(args, result.error.message);
  }
  return result;
}

/**
 * Run git; stdout on an exit listed in okStatuses (default: 0), GitError (with
 * git's stderr) otherwise.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ input?: string, okStatuses?: Array<number | null> }} [options]
 *   `input` is written to git's stdin. `okStatuses` (default `[0]`) lists the
 *   exit codes that are an answer, not a failure: `git check-ignore` exits 1
 *   for "nothing ignored", so it passes `[0, 1]`.
 * @returns {string}
 */
export function git(args, env, { input, okStatuses = [0] } = {}) {
  const { status, stdout, stderr } = runGit(args, env, { input });
  if (!okStatuses.includes(status)) {
    throw new GitError(args, stderr.trim() || `exit code ${status}`);
  }
  return stdout;
}
