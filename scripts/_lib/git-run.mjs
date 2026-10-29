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

/** A git command that could not run or exited non-zero. */
export class GitError extends Error {
  /**
   * @param {string[]} args
   * @param {string} detail git's stderr, or why git could not run.
   */
  constructor(args, detail) {
    super(`git ${args.join(' ')}: ${detail}`);
    this.name = 'GitError';
    this.detail = detail;
  }
}

/**
 * Run git; returns `{ status, stdout, stderr }` whatever the exit code.
 * Throws GitError only when git could not run, and TypeError when `env` is
 * missing.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runGit(args, env) {
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
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  if (result.error) throw new GitError(args, result.error.message);
  return result;
}

/**
 * Run git; stdout on exit 0, GitError (with git's stderr) otherwise.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function git(args, env) {
  const { status, stdout, stderr } = runGit(args, env);
  if (status !== 0) {
    throw new GitError(args, stderr.trim() || `exit code ${status}`);
  }
  return stdout;
}
