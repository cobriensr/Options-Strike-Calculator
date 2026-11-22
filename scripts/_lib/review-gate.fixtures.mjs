/**
 * Shared helpers for the commit-gate tests (review-gate.test.mjs and
 * review-gate.cli.test.mjs): git and the gate CLI run the way a Claude commit
 * runs them, against throwaway repos wired to this repo's real .githooks/
 * through an absolute core.hooksPath. The generic temp-repo helpers are in
 * scratch-git.fixtures.mjs, and each test file calls setupScratchGit()
 * itself. Not itself a test file; vitest only collects *.test.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { adminDir, cleanEnv } from './scratch-git.fixtures.mjs';
import { SLOW_CHILD_TIMEOUT, spawnChild } from './spawn-timeout.fixtures.mjs';

// vitest runs from the repo root (same convention as check-coverage-floor).
export const ROOT = process.cwd();
export const CLI = path.join(ROOT, 'scripts', 'review-gate.mjs');
// Forward slashes: the hook finds the CLI with `dirname "$0"`, and sh's
// dirname splits on `/` only.
const HOOKS_DIR = path.join(ROOT, '.githooks').replaceAll('\\', '/');
export const MARKER = 'review-gate.json';

export const NO_MARKER =
  'No passing `npm run review` is on record for this worktree';
export const SEAL_REFUSED =
  'review-gate seal failed: only `npm run review` may seal the review marker';
export const CHECK_FAILED = 'review-gate: commit blocked, the check failed:';
export const DRIFTED =
  'review-gate: commit blocked. These staged files changed after the last passing `npm run review`:';

/**
 * Gate inputs each test sets explicitly instead of inheriting, so cleanEnv
 * drops them along with GIT_*: CLAUDECODE (set in Claude Code's shells),
 * npm_lifecycle_event (set to "review" when `npm run review` runs these
 * tests) and npm_package_json (the path of this repo's package.json then: the
 * `run` subcommand would read the real `review:steps` from it, not the
 * scratch repo's). cleanEnv matches names upper-cased.
 */
const DROPPED_ENV = new Set([
  'CLAUDECODE',
  'NPM_LIFECYCLE_EVENT',
  'NPM_PACKAGE_JSON',
]);

/**
 * The environment of a gate child: every gate input set explicitly (cleanEnv
 * plus `extraEnv`). Shared by `run` below and by tests that spawn the CLI
 * asynchronously.
 */
export function gateEnv(extraEnv = {}) {
  return cleanEnv(extraEnv, DROPPED_ENV);
}

/**
 * Run a command with every gate input set explicitly (gateEnv); returns
 * `{ status, stdout, stderr }` whatever its exit code.
 * Throws when it can't be spawned, or runs past SLOW_CHILD_TIMEOUT: a commit
 * runs the whole gate hook, which makes many git calls of its own. The error
 * names the command, the limit and the stderr so far (spawnChild).
 */
export function run(cwd, command, args, extraEnv = {}) {
  // Test-only: `git` from PATH, as the module under test and the hook use.
  return spawnChild(command, args, {
    cwd,
    env: gateEnv(extraEnv),
    encoding: 'utf8',
    timeout: SLOW_CHILD_TIMEOUT,
    windowsHide: true,
  });
}

/**
 * Run git for test setup; stdout (trimmed) on success, throws otherwise.
 * Not the shared fixture `git`: this one drops CLAUDECODE (DROPPED_ENV), so
 * setup commits pass the real hook.
 */
export function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** The gate CLI, as `npm run review` or the hook would run it. */
export function gate(cwd, command, extraEnv = {}) {
  return run(cwd, process.execPath, [CLI, command], extraEnv);
}

/** Seal the way `npm run review` does; fails the test if sealing fails. */
export function review(cwd) {
  const result = gate(cwd, 'seal', { npm_lifecycle_event: 'review' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

/** `git commit` from a Claude Code shell (CLAUDECODE=1), through the hook. */
export function claudeCommit(cwd, ...args) {
  return run(cwd, 'git', ['commit', '-q', '-m', 'claude', ...args], {
    CLAUDECODE: '1',
  });
}

export function write(cwd, file, body) {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

export function headSubject(cwd) {
  return git(cwd, 'log', '-1', '--format=%s');
}

export function markerFile(cwd) {
  return path.join(adminDir(cwd), MARKER);
}

/**
 * A repo at <base>/repo using the real hook, with a.txt and b.txt committed
 * and ignored.txt gitignored.
 */
export function initRepo(base) {
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.hooksPath', HOOKS_DIR);
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b.txt', 'b\n');
  write(repo, '.gitignore', 'ignored.txt\n');
  git(repo, 'add', '-A');
  // No CLAUDECODE in setup git calls, so the hook lets this through.
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}
