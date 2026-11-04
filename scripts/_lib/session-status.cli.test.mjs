// @vitest-environment node

/**
 * scripts/session-status.mjs run as a real process. Argument errors and the
 * exit-3 cases need no repository worth the name; the rest runs against
 * scratch repos with real git (an origin, a clone with linked worktrees in
 * each state the tags describe), with --no-ci so nothing reaches GitHub. The
 * collector's logic, with git faked, is in session-status.test.mjs.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addWorktree,
  cleanEnv,
  commitFile,
  git,
  initRepo,
  makeTempDir,
  setupScratchGit,
} from './prune-worktrees.fixtures.mjs';

setupScratchGit();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'session-status.mjs');

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function run(args, { cwd = process.cwd(), env = cleanEnv() } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('session-status CLI: arguments', () => {
  it('prints the usage and exits 0 for --help', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: node scripts/session-status.mjs');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['an unknown flag', ['--wait']],
    ['a positional argument', ['origin']],
    ['a count that is not a number', ['--count', 'many']],
    ['a count of zero', ['--count', '0']],
  ])('exits 2 with the usage for %s', (_label, args) => {
    const result = run(args);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: node scripts/session-status.mjs');
  });
});

describe('session-status CLI: git cannot be used', () => {
  it('exits 3 and says so when git is not on PATH', () => {
    const emptyPath = makeTempDir('session-status-empty-path-');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== 'path',
      ),
    );
    env.PATH = emptyPath;

    const result = run(['--no-ci'], { env });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/git is not installed/);
  });

  it('exits 3 outside a git repository', () => {
    const dir = makeTempDir('session-status-no-repo-');
    const env = cleanEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) });

    const result = run(['--no-ci'], { cwd: dir, env });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/not a git repository/);
  });

  it('exits 3 in a repository with no origin/main, and names the fix', () => {
    const repo = initRepo(makeTempDir('session-status-no-origin-'));

    const result = run(['--no-ci'], { cwd: repo });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/no origin\/main/);
    expect(result.stderr).toContain('--fetch');
  });
});

describe('session-status CLI: a real repository', () => {
  let base = '';
  let repo = '';
  let origin = '';
  let rebasedBranchTip = '';
  let first;

  /** The worktree table's rows, each split into cells on runs of 2+ spaces. */
  function worktreeRows(stdout) {
    const lines = stdout.split('\n');
    const header = lines.findIndex((l) => l.startsWith('  NAME '));
    const end = lines.indexOf('', header);
    return lines
      .slice(header + 1, end)
      .map((line) => line.trim().split(/\s{2,}/));
  }

  /** The cells of the worktree called `name`. */
  function row(stdout, name) {
    const found = worktreeRows(stdout).find((cells) => cells[0] === name);
    if (found === undefined) throw new Error(`no row ${name} in:\n${stdout}`);
    return found;
  }

  beforeAll(() => {
    base = makeTempDir('session-status-repo-');
    origin = path.join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    repo = initRepo(base);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    mkdirSync(path.join(repo, '.worktrees'));
    appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.worktrees/\n');

    // Linked worktrees, all from the first commit of main.
    const rebased = addWorktree(repo, '.worktrees/rebased', 'feat/rebased');
    rebasedBranchTip = commitFile(rebased, 'a.txt', 'a\n');
    const wip = addWorktree(repo, '.worktrees/wip', 'feat/wip');
    commitFile(wip, 'b.txt', 'b\n');
    const dirty = addWorktree(repo, '.worktrees/dirty', 'feat/dirty');
    writeFileSync(path.join(dirty, 'untracked.txt'), 'x\n');
    addWorktree(repo, '.worktrees/detached');
    const gone = addWorktree(repo, '.worktrees/gone', 'feat/gone');
    rmSync(gone, { recursive: true, force: true });
    addWorktree(repo, '.worktrees/locked', 'feat/locked');
    git(repo, 'worktree', 'lock', '--reason', 'on usb', '.worktrees/locked');

    // feat/rebased lands on main as a different commit with the same patch:
    // not an ancestor of origin/main, but merged all the same.
    git(repo, 'cherry-pick', rebasedBranchTip);
    git(repo, 'push', '-q', 'origin', 'main');

    first = run(['--no-ci'], { cwd: repo });
  });

  it('exits 0 and prints nothing on stderr', () => {
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
  });

  it('is a squash/rebase case git itself calls merged, though not an ancestor', () => {
    // Fixture check: git cherry marks the branch commit "-", and the commit
    // is not reachable from origin/main.
    expect(git(repo, 'cherry', 'origin/main', 'feat/rebased')).toMatch(/^- /);
    expect(() =>
      git(repo, 'merge-base', '--is-ancestor', rebasedBranchTip, 'origin/main'),
    ).toThrow();
  });

  it('prints the main checkout with its branch, ahead/behind and uncommitted files', () => {
    expect(first.stdout).toContain('MAIN CHECKOUT');
    expect(first.stdout).toMatch(/branch\s+main\n/);
    expect(first.stdout).toMatch(/vs origin\s+0 ahead, 0 behind\n/);
    expect(first.stdout).toMatch(/uncommitted\s+0 files\n/);
  });

  it('tags a branch merged by patch-equivalence merged', () => {
    const [, branch, aheadBehind, uncommitted, , tag] = row(
      first.stdout,
      'rebased',
    );
    expect(branch).toBe('feat/rebased');
    expect(aheadBehind).toBe('+1/-1');
    expect(uncommitted).toBe('0');
    expect(tag).toBe('merged');
  });

  it('tags a detached HEAD in origin/main merged', () => {
    const [, branch, , , , tag] = row(first.stdout, 'detached');
    expect(branch).toBe('(detached)');
    expect(tag).toBe('merged');
  });

  it('tags a branch with its own commit ahead', () => {
    expect(row(first.stdout, 'wip')[5]).toBe('ahead 1');
  });

  it('tags an uncommitted tree dirty and counts the file', () => {
    const cells = row(first.stdout, 'dirty');
    expect(cells[3]).toBe('1');
    expect(cells[5]).toBe('dirty');
  });

  it('tags a locked worktree locked', () => {
    expect(row(first.stdout, 'locked')[5]).toBe('locked');
  });

  it('tags a worktree whose folder was deleted missing', () => {
    expect(row(first.stdout, 'gone')[5]).toBe('missing');
  });

  it('lists the cleanup candidates last, and counts them', () => {
    const names = worktreeRows(first.stdout).map((cells) => cells[0]);
    expect(names).toHaveLength(6);
    expect(names.slice(-2).sort()).toEqual(['detached', 'rebased']);
    expect(first.stdout).toContain('WORKTREES (6) - cleanup candidates: 2');
  });

  it('has no recent pushes section with --no-ci', () => {
    expect(first.stdout).not.toContain('RECENT PUSHES');
  });

  it('says how old the origin/main ref is', () => {
    expect(first.stdout.split('\n')[0]).toMatch(
      /^origin\/main {2}[0-9a-f]{8} {2}last (fetched|moved) (.+ ago|just now)/,
    );
  });

  describe('--fetch', () => {
    it('leaves origin/main alone without it, and updates it with it', () => {
      const other = path.join(base, 'other');
      git(base, 'clone', '-q', origin, other);
      commitFile(other, 'c.txt', 'c\n');
      git(other, 'push', '-q', 'origin', 'main');
      const before = git(repo, 'rev-parse', 'origin/main');

      const stale = run(['--no-ci'], { cwd: repo });
      expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
      expect(stale.stdout).toMatch(/vs origin\s+0 ahead, 0 behind\n/);

      const fetched = run(['--no-ci', '--fetch'], { cwd: repo });
      expect(fetched.status).toBe(0);
      expect(git(repo, 'rev-parse', 'origin/main')).not.toBe(before);
      expect(fetched.stdout).toMatch(/vs origin\s+0 ahead, 1 behind\n/);
    });
  });
});
