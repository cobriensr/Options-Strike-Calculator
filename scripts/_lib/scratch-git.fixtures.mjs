/**
 * Shared fixtures for tests that run real git in throwaway repos under the OS
 * temp dir, with git config isolated from the developer's: review-gate.test.mjs,
 * git-run.test.mjs, and the prune-worktrees tests through
 * prune-worktrees.fixtures.mjs. Not itself a test file; vitest only collects
 * *.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';

/**
 * Timeout for hooks and tests that spawn real git. Measured on Windows: the
 * main prune-worktrees.test.mjs fixture takes ~63 s alone, ~6x that in a full
 * parallel run. Every spawn is synchronous, so vitest can only fail a slow
 * one after it finishes: this is a ceiling, not a cutoff.
 */
export const FIXTURE_TIMEOUT = 600_000;

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
 * Register the file-level setup: FIXTURE_TIMEOUT for every test and hook, an
 * empty git config for every git process (a module under test may spawn git
 * with process.env, so it is stubbed too), and removal of every temp dir
 * afterwards. Call once, at the top of a file.
 */
export function setupScratchGit() {
  // Every consumer spawns real git, so tests and hooks share the ceiling.
  vi.setConfig({ testTimeout: FIXTURE_TIMEOUT, hookTimeout: FIXTURE_TIMEOUT });
  beforeAll(() => {
    gitconfig = path.join(makeTempDir('scratch-git-config-'), 'gitconfig');
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
 * Child env without GIT_* vars or the names in `drop`. A git hook (e.g.
 * pre-commit running tests) exports GIT_DIR / GIT_INDEX_FILE, which would
 * point the scratch repo's git calls at the real repository. System and
 * global config are replaced by an empty file so a developer's config cannot
 * change the scratch repo. `extra` goes on last, and an `extra` value of
 * undefined unsets the var.
 *
 * Names are matched upper-cased: Windows env names are case-insensitive, and
 * a vitest worker there sees them upper-cased (NPM_LIFECYCLE_EVENT=npx). Kept,
 * that copy would shadow a lower-case npm_lifecycle_event set in `extra`.
 *
 * @param {Record<string, string | undefined>} [extra]
 * @param {Iterable<string>} [drop] More inherited names to leave out.
 */
export function cleanEnv(extra = {}, drop = []) {
  const dropped = new Set(Array.from(drop, (name) => name.toUpperCase()));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name.startsWith('GIT_') || dropped.has(name)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    ...extra,
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

/** Git for test setup, as a fixed test identity; trimmed stdout. */
export function git(cwd, ...args) {
  return execFileSync(
    // Test-only: the modules under test run `git` from PATH too.
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

/** A worktree's own admin dir (.git, or .git/worktrees/<name>). */
export function adminDir(wt) {
  return git(wt, 'rev-parse', '--absolute-git-dir');
}
