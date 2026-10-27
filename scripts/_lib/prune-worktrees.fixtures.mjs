/**
 * Shared fixtures for the prune-worktrees tests (prune-worktrees.test.mjs and
 * prune-worktrees.races.test.mjs): throwaway git repos under the OS temp dir,
 * with git config isolated from the developer's. Not itself a test file;
 * vitest only collects *.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';

const HOUR_MS = 60 * 60 * 1000;

/** Every temp dir made through makeTempDir; removed in afterAll. */
const tempDirs = [];
let gitconfig = '';

/**
 * Long-form real path: git reports long paths, and os.tmpdir() can be an 8.3
 * short name on Windows.
 */
export function makeTempDir(prefix) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/**
 * Register the file-level hooks: an empty git config for every git process
 * (the module under test spawns git with process.env, so it is stubbed too),
 * and removal of every temp dir afterwards. Call once, at the top of a file.
 */
export function setupScratchGit() {
  beforeAll(() => {
    gitconfig = path.join(makeTempDir('prune-wt-config-'), 'gitconfig');
    writeFileSync(gitconfig, '');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

/**
 * Child env without GIT_* vars: a git hook (e.g. pre-commit running tests)
 * exports GIT_DIR / GIT_INDEX_FILE, which would point the scratch repo's git
 * calls at the real repository. System and global config are replaced by an
 * empty file so a developer's config cannot change the scratch repo.
 */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    ...extra,
  };
}

export function git(cwd, ...args) {
  return execFileSync(
    // Test-only: the module under test runs `git` from PATH too.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
    {
      cwd,
      env: cleanEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  ).trim();
}

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

export function adminDir(wt) {
  return git(wt, 'rev-parse', '--absolute-git-dir');
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
