// @vitest-environment node

/**
 * Tests for scripts/_lib/prune-worktrees.mjs and its CLI,
 * scripts/prune-merged-worktrees.mjs. Every case runs real git against a
 * throwaway repo under the OS temp dir (fixtures in
 * prune-worktrees.fixtures.mjs). A worktree is made "old" by backdating the
 * admin `index` and `logs/HEAD` the idle check reads. Races and git failures
 * that real git cannot produce on demand are in prune-worktrees.races.test.mjs.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  adminDir,
  age,
  branches,
  cleanEnv,
  commitFile,
  git,
  idleFiles,
  initRepo,
  listedPaths,
  makeTempDir,
  setupScratchGit,
} from './prune-worktrees.fixtures.mjs';
import {
  MIN_IDLE_HOURS,
  findRepoRoot,
  formatResult,
  formatSummary,
  parseWorktreeList,
  pruneWorktrees,
} from './prune-worktrees.mjs';

// vitest runs from the repo root (same convention as check-coverage-floor).
const CLI = path.resolve(
  process.cwd(),
  'scripts',
  'prune-merged-worktrees.mjs',
);
// ~80 git spawns per fixture: a few seconds alone, more under a loaded run.
const FIXTURE_TIMEOUT = 120_000;

setupScratchGit();

function byName(outcome) {
  return new Map(outcome.results.map((result) => [result.name, result]));
}

describe('MIN_IDLE_HOURS', () => {
  it('defaults the idle floor to the spec value of 24 hours', () => {
    expect(MIN_IDLE_HOURS).toBe(24);
  });
});

describe('parseWorktreeList', () => {
  /** `git worktree list --porcelain -z` output: NUL per line, NUL per record. */
  function listing(...records) {
    return records.map((fields) => `${fields.join('\0')}\0\0`).join('');
  }

  it('reads branch, detached, locked and prunable records, main worktree first', () => {
    const text = listing(
      ['worktree C:/repo', 'HEAD aaa', 'branch refs/heads/main'],
      ['worktree C:/repo/.worktrees/a', 'HEAD bbb', 'detached', 'locked'],
      [
        'worktree C:/repo/.worktrees/b c',
        'HEAD ccc',
        'branch refs/heads/fix/b',
        'locked in use',
        'prunable gitdir file points to non-existent location',
      ],
    );
    expect(parseWorktreeList(text)).toEqual([
      {
        path: 'C:/repo',
        head: 'aaa',
        branch: 'main',
        bare: false,
        locked: null,
        prunable: null,
      },
      {
        path: 'C:/repo/.worktrees/a',
        head: 'bbb',
        branch: null,
        bare: false,
        locked: '',
        prunable: null,
      },
      {
        path: 'C:/repo/.worktrees/b c',
        head: 'ccc',
        branch: 'fix/b',
        bare: false,
        locked: 'in use',
        prunable: 'gitdir file points to non-existent location',
      },
    ]);
  });

  it('reads the all-zero HEAD of an unborn (orphan) branch as no HEAD', () => {
    const [orphan] = parseWorktreeList(
      listing([
        'worktree /repo/.worktrees/o',
        `HEAD ${'0'.repeat(40)}`,
        'branch refs/heads/fix/o',
      ]),
    );
    expect(orphan.head).toBeNull();
    expect(orphan.branch).toBe('fix/o');
  });

  it('marks a bare main repository', () => {
    const [main] = parseWorktreeList(
      listing(['worktree /srv/repo.git', 'bare']),
    );
    expect(main).toMatchObject({
      path: '/srv/repo.git',
      bare: true,
      head: null,
    });
  });

  it('returns no worktrees for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('ignores fields it does not know', () => {
    const [main] = parseWorktreeList(
      listing([
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        'future x',
      ]),
    );
    expect(main.branch).toBe('main');
  });

  it('throws on a field before any worktree line, since the format changed', () => {
    expect(() => parseWorktreeList('HEAD aaa\0\0')).toThrow(
      /unexpected "HEAD aaa" before the first worktree line/,
    );
  });
});

describe('formatResult', () => {
  const base = { name: 'a', path: '/repo/.worktrees/a', head: 'f00d' };

  it('names the deleted branch and its old SHA', () => {
    expect(
      formatResult({
        ...base,
        branch: 'fix/a',
        action: 'removed',
        reason: 'merged, clean, idle 40.2h',
        deletedBranchSha: 'f00d',
      }),
    ).toBe('removed a (branch fix/a deleted, was f00d)');
  });

  it('gives the reason when no branch was deleted', () => {
    expect(
      formatResult({
        ...base,
        branch: null,
        action: 'removed',
        reason: 'detached HEAD at f00d, no branch to delete',
      }),
    ).toBe('removed a (detached HEAD at f00d, no branch to delete)');
  });

  it('gives the reason a worktree was kept', () => {
    expect(
      formatResult({
        ...base,
        branch: 'fix/a',
        action: 'kept',
        reason: 'locked',
      }),
    ).toBe('kept a: locked');
  });

  it('says "would remove" on a dry run', () => {
    expect(
      formatResult({
        ...base,
        branch: 'fix/a',
        action: 'would-remove',
        reason: 'merged, clean, idle 40.2h; would delete branch fix/a at f00d',
      }),
    ).toBe(
      'would remove a (merged, clean, idle 40.2h; would delete branch fix/a at f00d)',
    );
  });
});

describe('formatSummary', () => {
  const removed = { action: 'removed' };
  const kept = { action: 'kept' };

  it('counts removed and kept worktrees', () => {
    expect(
      formatSummary({
        dryRun: false,
        results: [removed, kept, kept],
        errors: [],
      }),
    ).toBe('worktrees prune: removed 1, kept 2');
  });

  it('counts git errors', () => {
    expect(
      formatSummary({ dryRun: false, results: [kept], errors: ['x', 'y'] }),
    ).toBe('worktrees prune: removed 0, kept 1, 2 git errors');
  });

  it('labels a dry run', () => {
    expect(
      formatSummary({
        dryRun: true,
        results: [{ action: 'would-remove' }],
        errors: ['x'],
      }),
    ).toBe('worktrees prune (dry run): would remove 1, kept 0, 1 git error');
  });
});

describe('pruneWorktrees', () => {
  let repo = '';
  let outside = '';
  let lookalike = '';
  let outcome;
  let results;
  const wts = {};
  const shas = {};

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-wt-'));

    // One commit, cherry-picked onto main: a new SHA with the same patch id.
    wts.picked = addWorktree(repo, '.worktrees/picked', 'fix/picked');
    shas.picked = commitFile(wts.picked, 'picked.txt', 'picked\n');
    git(repo, 'cherry-pick', shas.picked);

    // A --no-ff merge whose merge commit adds a file of its own. Its side
    // commit is cherry-picked onto main, so `git cherry` (which skips merge
    // commits) prints nothing: only the merge commit holds unmerged work.
    wts.noff = addWorktree(repo, '.worktrees/noff', 'fix/noff');
    git(wts.noff, 'checkout', '-q', '-b', 'noff-side');
    const side = commitFile(wts.noff, 'side.txt', 'side\n');
    git(wts.noff, 'checkout', '-q', 'fix/noff');
    git(wts.noff, 'merge', '-q', '--no-ff', '--no-commit', 'noff-side');
    commitFile(wts.noff, 'extra.txt', 'only in the merge commit\n');
    shas.noffMerge = git(wts.noff, 'rev-parse', 'HEAD');
    git(repo, 'cherry-pick', side);

    // No commits of its own: a worktree an agent created and never used.
    wts.empty = addWorktree(repo, '.worktrees/empty', 'fix/empty');
    shas.empty = git(wts.empty, 'rev-parse', 'HEAD');

    wts.unmerged = addWorktree(repo, '.worktrees/unmerged', 'fix/unmerged');
    shas.unmerged = commitFile(wts.unmerged, 'unmerged.txt', 'unmerged\n');

    wts.dirty = addWorktree(repo, '.worktrees/dirty', 'fix/dirty');
    writeFileSync(path.join(wts.dirty, 'scratch.txt'), 'wip\n');

    // Clean to git (docs/tmp/ is ignored), but `git worktree remove` would
    // delete the report with the worktree.
    wts.scratch = addWorktree(repo, '.worktrees/scratch', 'fix/scratch');
    mkdirSync(path.join(wts.scratch, 'docs', 'tmp'), { recursive: true });
    writeFileSync(
      path.join(wts.scratch, 'docs', 'tmp', 'report.md'),
      'notes\n',
    );

    // An unborn branch: git lists its HEAD as forty zeros.
    wts.orphan = addWorktree(repo, '.worktrees/orphan');
    git(wts.orphan, 'checkout', '-q', '--orphan', 'fix/orphan');

    wts.recent = addWorktree(repo, '.worktrees/recent', 'fix/recent');

    wts.locked = addWorktree(repo, '.worktrees/locked', 'fix/locked');
    git(
      repo,
      'worktree',
      'lock',
      '--reason',
      'in use by a session',
      wts.locked,
    );

    wts.detached = addWorktree(repo, '.worktrees/detached');
    shas.detached = git(wts.detached, 'rev-parse', 'HEAD');

    // Deleted by hand: git now lists it as prunable.
    wts.gone = addWorktree(repo, '.worktrees/gone', 'fix/gone');

    // Passes every check, but an admin modules/ dir makes git refuse to
    // remove it ("working trees containing submodules cannot be moved or
    // removed"): a real git failure at the removal step.
    wts.blocked = addWorktree(repo, '.worktrees/blocked', 'fix/blocked');

    outside = addWorktree(repo, '../outside', 'fix/outside');
    lookalike = addWorktree(repo, '.worktrees-old/x', 'fix/lookalike');

    for (const name of [
      'picked',
      'noff',
      'empty',
      'unmerged',
      'dirty',
      'scratch',
      'orphan',
      'locked',
      'detached',
      'blocked',
    ]) {
      age(wts[name]);
    }
    age(outside);
    age(lookalike);
    mkdirSync(path.join(adminDir(wts.blocked), 'modules'));
    rmSync(wts.gone, { recursive: true, force: true });

    outcome = pruneWorktrees({ repoRoot: repo });
    results = byName(outcome);
  }, FIXTURE_TIMEOUT);

  it('reports every worktree under .worktrees/ and nothing else', () => {
    expect([...results.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'blocked',
      'detached',
      'dirty',
      'empty',
      'gone',
      'locked',
      'noff',
      'orphan',
      'picked',
      'recent',
      'scratch',
      'unmerged',
    ]);
    expect(outcome.dryRun).toBe(false);
  });

  it('removes a worktree whose commit was cherry-picked onto main and deletes its branch', () => {
    expect(results.get('picked')).toMatchObject({
      action: 'removed',
      branch: 'fix/picked',
      path: wts.picked,
      deletedBranchSha: shas.picked,
    });
    expect(existsSync(wts.picked)).toBe(false);
    expect(listedPaths(repo)).not.toContain(wts.picked);
  });

  it('removes a worktree whose branch has no commits of its own', () => {
    expect(results.get('empty')).toMatchObject({
      action: 'removed',
      branch: 'fix/empty',
      deletedBranchSha: shas.empty,
    });
    expect(existsSync(wts.empty)).toBe(false);
  });

  it('keeps a worktree with a commit not in main and names the commit', () => {
    const result = results.get('unmerged');
    expect(result.action).toBe('kept');
    expect(result.reason).toBe(
      `1 commit not in main: ${shas.unmerged.slice(0, 10)}`,
    );
    expect(existsSync(wts.unmerged)).toBe(true);
  });

  it('keeps a worktree whose merge commit is not in main, though git cherry sees nothing', () => {
    expect(results.get('noff')).toMatchObject({
      action: 'kept',
      reason: `merge commit not in main: ${shas.noffMerge.slice(0, 10)}`,
    });
    expect(existsSync(path.join(wts.noff, 'extra.txt'))).toBe(true);
  });

  it('keeps a worktree with an untracked file', () => {
    const result = results.get('dirty');
    expect(result.action).toBe('kept');
    expect(result.reason).toBe('uncommitted changes: ?? scratch.txt');
    expect(existsSync(path.join(wts.dirty, 'scratch.txt'))).toBe(true);
  });

  it('keeps a worktree with ignored scratch files in docs/tmp/', () => {
    expect(results.get('scratch')).toMatchObject({
      action: 'kept',
      reason: 'ignored scratch files in docs/tmp/: docs/tmp/report.md',
    });
    expect(existsSync(path.join(wts.scratch, 'docs', 'tmp', 'report.md'))).toBe(
      true,
    );
  });

  it('keeps an orphan worktree with no commits yet, without a git error', () => {
    expect(results.get('orphan')).toMatchObject({
      action: 'kept',
      branch: 'fix/orphan',
      head: null,
      reason: 'no commits yet',
    });
    expect(outcome.errors.join('\n')).not.toContain('orphan');
  });

  it('keeps a merged, clean worktree that has not been idle for MIN_IDLE_HOURS', () => {
    const result = results.get('recent');
    expect(result.action).toBe('kept');
    expect(result.reason).toBe('idle 0.0h, under the 24h minimum');
    expect(existsSync(wts.recent)).toBe(true);
  });

  it('keeps a locked worktree and quotes the lock reason', () => {
    expect(results.get('locked')).toMatchObject({
      action: 'kept',
      reason: 'locked: in use by a session',
    });
    expect(existsSync(wts.locked)).toBe(true);
  });

  it('removes a merged detached-HEAD worktree without deleting a branch', () => {
    const result = results.get('detached');
    expect(result).toMatchObject({
      action: 'removed',
      branch: null,
      reason: `detached HEAD at ${shas.detached}, no branch to delete`,
    });
    expect(result.deletedBranchSha).toBeUndefined();
    expect(existsSync(wts.detached)).toBe(false);
  });

  it('counts a prunable worktree (directory already gone) as removed, prunes its entry and keeps its branch', () => {
    const result = results.get('gone');
    expect(result.action).toBe('removed');
    expect(result.reason).toMatch(/^prunable: .+; branch fix\/gone kept$/);
    expect(listedPaths(repo)).not.toContain(wts.gone);
  });

  it('records a failed `git worktree remove` as an error and keeps the worktree', () => {
    const result = results.get('blocked');
    expect(result.action).toBe('kept');
    expect(result.reason).toMatch(
      /^git worktree remove failed: .*submodules cannot be moved or removed/,
    );
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(
      /^blocked: git .*worktree remove .*submodules cannot be moved or removed/,
    );
    expect(existsSync(wts.blocked)).toBe(true);
  });

  it('never touches worktrees outside .worktrees/, including a look-alike .worktrees-old/', () => {
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    const listed = listedPaths(repo);
    expect(listed).toContain(outside);
    expect(listed).toContain(lookalike);
  });

  it('deletes exactly the branches of removed worktrees', () => {
    expect(branches(repo)).toEqual([
      'fix/blocked',
      'fix/dirty',
      'fix/gone',
      'fix/locked',
      'fix/lookalike',
      'fix/noff',
      'fix/outside',
      'fix/recent',
      'fix/scratch',
      'fix/unmerged',
      'main',
      'noff-side',
    ]);
  });

  it('finds the main repo root from inside a linked worktree', () => {
    expect(findRepoRoot(wts.unmerged)).toBe(repo);
  });
});

describe('pruneWorktrees dry run', () => {
  let repo = '';
  let outcome;
  let results;
  const wts = {};
  let sha = '';
  let mtimesBefore = [];
  let listedBefore = [];
  let branchesBefore = [];

  /** mtimes of every idle file, in a fixed order. */
  function idleMtimes() {
    return [wts.merged, wts.unmerged].flatMap((wt) =>
      idleFiles(wt).map((file) => statSync(file).mtimeMs),
    );
  }

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-wt-dry-'));
    wts.merged = addWorktree(repo, '.worktrees/merged', 'fix/merged');
    sha = git(wts.merged, 'rev-parse', 'HEAD');
    wts.unmerged = addWorktree(repo, '.worktrees/unmerged', 'fix/unmerged');
    commitFile(wts.unmerged, 'unmerged.txt', 'unmerged\n');
    wts.gone = addWorktree(repo, '.worktrees/gone', 'fix/gone');
    age(wts.merged);
    age(wts.unmerged);
    rmSync(wts.gone, { recursive: true, force: true });

    mtimesBefore = idleMtimes();
    listedBefore = listedPaths(repo);
    branchesBefore = branches(repo);
    outcome = pruneWorktrees({ repoRoot: repo, dryRun: true });
    results = byName(outcome);
  }, FIXTURE_TIMEOUT);

  it('reports what it would remove without removing it', () => {
    expect(outcome).toMatchObject({ dryRun: true, errors: [] });
    expect(results.get('merged')).toMatchObject({
      action: 'would-remove',
      branch: 'fix/merged',
      reason: `merged, clean, idle 48.0h; would delete branch fix/merged at ${sha}`,
    });
    expect(results.get('unmerged').action).toBe('kept');
    expect(results.get('gone').action).toBe('would-remove');
    expect(results.get('gone').reason).toMatch(
      /^prunable: .+; branch fix\/gone kept$/,
    );
  });

  it('changes no worktree, branch or admin entry', () => {
    expect(existsSync(wts.merged)).toBe(true);
    expect(listedPaths(repo)).toEqual(listedBefore);
    expect(listedBefore).toContain(wts.gone);
    expect(branches(repo)).toEqual(branchesBefore);
  });

  // Every checked-out file is newer than the backdated index, so a plain
  // `git status` would re-hash them and rewrite the index, resetting the clock.
  it('leaves the idle clock alone (status runs with --no-optional-locks)', () => {
    expect(idleMtimes()).toEqual(mtimesBefore);
  });

  it.runIf(process.platform === 'win32')(
    'matches worktree paths case-insensitively on Windows',
    () => {
      const drive = repo.charAt(0);
      const flipped =
        (drive === drive.toUpperCase()
          ? drive.toLowerCase()
          : drive.toUpperCase()) + repo.slice(1);
      const again = pruneWorktrees({ repoRoot: flipped, dryRun: true });
      expect(again.results.map((r) => [r.name, r.action])).toEqual(
        outcome.results.map((r) => [r.name, r.action]),
      );
    },
  );
});

describe('pruneWorktrees without a main branch', () => {
  it('returns an error naming main and removes nothing', () => {
    const repo = initRepo(makeTempDir('prune-wt-trunk-'), 'trunk');
    const wt = addWorktree(repo, '.worktrees/x', 'fix/x');
    age(wt);

    const outcome = pruneWorktrees({ repoRoot: repo });

    expect(outcome.results).toEqual([]);
    expect(outcome.errors).toEqual([
      `no local branch "main" in ${repo}. Every worktree is checked ` +
        'against it, so nothing was pruned.',
    ]);
    expect(existsSync(wt)).toBe(true);
    expect(branches(repo)).toEqual(['fix/x', 'trunk']);
  });
});

describe('pruneWorktrees with main checked out in a worktree', () => {
  it('keeps that worktree and never deletes main', () => {
    const repo = initRepo(makeTempDir('prune-wt-onmain-'));
    git(repo, 'checkout', '-q', '-b', 'other');
    const wt = path.join(repo, '.worktrees', 'onmain');
    git(repo, 'worktree', 'add', '-q', wt, 'main');
    age(wt);

    const outcome = pruneWorktrees({ repoRoot: repo });

    expect(outcome.errors).toEqual([]);
    expect(outcome.results).toEqual([
      expect.objectContaining({
        name: 'onmain',
        action: 'kept',
        reason: 'it has main checked out',
      }),
    ]);
    expect(existsSync(wt)).toBe(true);
    expect(branches(repo)).toEqual(['main', 'other']);
  });
});

describe('prune-merged-worktrees CLI', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('prune-wt-cli-'));
  }, FIXTURE_TIMEOUT);

  function runCli(cwd, args = [], extraEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: cleanEnv(extraEnv),
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  it(
    'run from inside a linked worktree, keeps that worktree and removes the other',
    () => {
      const here = addWorktree(repo, '.worktrees/here', 'fix/here');
      const other = addWorktree(repo, '.worktrees/other', 'fix/other');
      const sha = git(other, 'rev-parse', 'HEAD');

      const result = runCli(here, ['--min-idle-hours', '0']);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/).sort()).toEqual(
        [
          'kept here: the current directory is inside it',
          `removed other (branch fix/other deleted, was ${sha})`,
          'worktrees prune: removed 1, kept 1',
        ].sort(),
      );
      expect(existsSync(here)).toBe(true);
      expect(existsSync(other)).toBe(false);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    '--dry-run prints what it would remove and changes nothing',
    () => {
      const wt = addWorktree(repo, '.worktrees/a', 'fix/a');
      const sha = git(wt, 'rev-parse', 'HEAD');
      age(wt);

      const result = runCli(repo, ['--dry-run']);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `would remove a (merged, clean, idle 48.0h; would delete branch fix/a at ${sha})\n` +
          'worktrees prune (dry run): would remove 1, kept 0\n',
      );
      expect(existsSync(wt)).toBe(true);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'exits 1 and names main when the repo has no main branch',
    () => {
      const trunk = initRepo(makeTempDir('prune-wt-cli-trunk-'), 'trunk');

      const result = runCli(trunk);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no local branch "main"');
    },
    FIXTURE_TIMEOUT,
  );

  it('exits 1 when run outside a git repository', () => {
    const dir = makeTempDir('prune-wt-norepo-');

    const result = runCli(dir, [], {
      GIT_CEILING_DIRECTORIES: path.dirname(dir),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^worktrees prune: FAILED, git .*not a git repository/,
    );
  });

  it.each([
    [['--min-idle-hours', 'abc']],
    [['--min-idle-hours', '']],
    [['--min-idle-hours=-1']],
    [['--force']],
    [['extra']],
  ])('exits 2 with usage on bad arguments %j', (args) => {
    const result = runCli(repo, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'usage: node scripts/prune-merged-worktrees.mjs [--dry-run] [--min-idle-hours N]',
    );
    expect(result.stdout).toBe('');
  });
});
