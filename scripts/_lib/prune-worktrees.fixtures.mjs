/**
 * Fixtures for the prune-worktrees tests (prune-worktrees.test.mjs and
 * prune-worktrees.races.test.mjs): scratch repos with linked worktrees under
 * .worktrees/, commits, and backdated idle clocks. The generic temp-repo
 * helpers live in scratch-git.fixtures.mjs; they are re-exported here, so
 * the prune tests import every fixture from this one file. Not itself a test
 * file; vitest only collects *.test.mjs.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adminDir, git } from './scratch-git.fixtures.mjs';

export {
  FIXTURE_TIMEOUT,
  adminDir,
  cleanEnv,
  git,
  makeTempDir,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';

const HOUR_MS = 60 * 60 * 1000;

/**
 * A repo at <base>/repo with one commit on `branch`, ignoring docs/tmp/ as
 * the real repo does; returns its path.
 */
export function initRepo(base, branch = 'main') {
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', branch);
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  writeFileSync(path.join(repo, '.gitignore'), 'docs/tmp/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

/**
 * `git worktree add` at `where` (relative to the repo) from the repo's HEAD:
 * on a new `branch`, or detached when no branch is given.
 */
export function addWorktree(repo, where, branch) {
  const wt = path.resolve(repo, where);
  const target = branch ? ['-b', branch, wt] : ['--detach', wt];
  git(repo, 'worktree', 'add', '-q', ...target, 'HEAD');
  return wt;
}

/**
 * Commit one file in `cwd`; returns the new HEAD SHA. Stages only that file,
 * so committing in the main worktree never picks up .worktrees/.
 */
export function commitFile(cwd, file, body) {
  writeFileSync(path.join(cwd, file), body);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** The files the idle check reads. */
export function idleFiles(wt) {
  const admin = adminDir(wt);
  return [path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD')];
}

/**
 * Backdate a worktree's idle files by `hours` (well past MIN_IDLE_HOURS by
 * default). Call after its last git write.
 */
export function age(wt, hours = 48) {
  const when = new Date(Date.now() - hours * HOUR_MS);
  for (const file of idleFiles(wt)) utimesSync(file, when, when);
}

export function branches(repo) {
  return git(repo, 'branch', '--format=%(refname:short)')
    .split('\n')
    .sort((a, b) => a.localeCompare(b));
}

/** Paths `git worktree list` still knows about, resolved to native form. */
export function listedPaths(repo) {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}
