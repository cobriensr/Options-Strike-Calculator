// @vitest-environment node

/**
 * Race and failure paths of scripts/_lib/prune-worktrees.mjs that real git
 * cannot produce on demand: another run or process changing the repo between
 * two of the module's git calls, and git commands failing. spawnSync is
 * wrapped at the node:child_process boundary. Each case intercepts one git
 * call; every other call runs real git against a scratch repo.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWorktree,
  age,
  commitFile,
  git,
  initRepo,
  makeTempDir,
  setupScratchGit,
} from './prune-worktrees.fixtures.mjs';
import { pruneWorktrees } from './prune-worktrees.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { spawnSync: realSpawnSync } =
  await vi.importActual('node:child_process');

const FIXTURE_TIMEOUT = 120_000;

setupScratchGit();

/**
 * Route the module's git calls whose args satisfy `match` to `handle`, which
 * gets a thunk that runs the real call. Every other call runs for real.
 */
function onGit(match, handle) {
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const real = () => realSpawnSync(command, args, options);
    return match(args) ? handle(real) : real();
  });
}

/** Args contain every one of `words`. */
function calls(...words) {
  return (args) => words.every((word) => args.includes(word));
}

/** A spawnSync result for a git command that exited `status`. */
function exited(status, stderr) {
  return {
    pid: 0,
    output: [null, '', stderr],
    stdout: '',
    stderr,
    status,
    signal: null,
  };
}

describe('pruneWorktrees races and git failures', () => {
  let repo = '';
  let wt = '';
  let head = '';

  /** The single result, plus the run's errors. */
  function prune() {
    const outcome = pruneWorktrees({ repoRoot: repo });
    return { ...outcome, result: outcome.results.find((r) => r.name === 'x') };
  }

  beforeEach(() => {
    repo = initRepo(makeTempDir('prune-wt-race-'));
    wt = addWorktree(repo, '.worktrees/x', 'fix/x');
    head = git(wt, 'rev-parse', 'HEAD');
    age(wt);
  }, FIXTURE_TIMEOUT);

  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it(
    'removes a merged worktree when nothing interferes (the baseline)',
    () => {
      const { result, errors } = prune();
      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'removed',
        deletedBranchSha: head,
      });
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'keeps the branch when it moves between the merge check and the delete',
    () => {
      const moved = commitFile(repo, 'later.txt', 'later\n');
      onGit(calls('worktree', 'remove'), (real) => {
        const removal = real();
        git(repo, 'update-ref', 'refs/heads/fix/x', moved);
        return removal;
      });

      const { result, errors } = prune();

      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'removed',
        reason: `branch fix/x kept: it moved to ${moved} after the merge check`,
      });
      expect(result.deletedBranchSha).toBeUndefined();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(moved);
      expect(existsSync(wt)).toBe(false);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'counts a worktree another run removed during the check as removed',
    () => {
      onGit(calls('rev-parse', '--absolute-git-dir', wt), (real) => {
        git(repo, 'worktree', 'remove', wt);
        return real(); // now fails: the directory is gone
      });

      const { result, errors } = prune();

      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'removed',
        reason: 'already removed by another run; branch fix/x kept',
      });
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'counts a worktree another run removed first as removed',
    () => {
      onGit(calls('worktree', 'remove'), () => {
        git(repo, 'worktree', 'remove', wt);
        return exited(128, `fatal: '${wt}' is not a working tree`);
      });

      const { result, errors } = prune();

      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'removed',
        reason: 'already removed by another run; branch fix/x kept',
      });
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'reports a removal that stopped partway (a locked file on Windows) as an error and keeps the branch',
    () => {
      const detail = `error: failed to delete '${wt}': Permission denied`;
      onGit(calls('worktree', 'remove'), () => {
        // git deletes .git (and the admin entry) before the file it cannot.
        rmSync(path.join(wt, '.git'));
        return exited(255, detail);
      });

      const { result, errors } = prune();

      const reason = `git worktree remove failed partway, leftover files at ${wt}: ${detail}`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      expect(existsSync(wt)).toBe(true);
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'reports a failed `git branch -D` as an error, the worktree still removed',
    () => {
      onGit(calls('branch', '-D'), () =>
        exited(1, 'error: simulated lock failure'),
      );

      const { result, errors } = prune();

      expect(result).toMatchObject({
        action: 'removed',
        reason: 'branch fix/x not deleted: error: simulated lock failure',
      });
      expect(result.deletedBranchSha).toBeUndefined();
      expect(errors).toEqual([
        `x: git -C ${repo} branch -D fix/x: error: simulated lock failure`,
      ]);
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'keeps a worktree whose check fails, and reports the git error',
    () => {
      onGit(calls('cherry'), () => exited(128, 'fatal: simulated'));

      const { result, errors } = prune();

      expect(result).toMatchObject({
        action: 'kept',
        reason: 'check failed: fatal: simulated',
      });
      expect(errors).toEqual([
        `x: git -C ${repo} cherry refs/heads/main ${head}: fatal: simulated`,
      ]);
      expect(existsSync(wt)).toBe(true);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'keeps a detached worktree whose HEAD moves during the check',
    () => {
      const detached = addWorktree(repo, '.worktrees/d');
      age(detached);
      onGit(calls('status', detached), (real) => {
        const status = real();
        git(detached, 'commit', '-q', '--allow-empty', '-m', 'moved');
        return status;
      });

      const { results, errors } = pruneWorktrees({ repoRoot: repo });

      expect(errors).toEqual([]);
      expect(results.find((r) => r.name === 'd')).toMatchObject({
        action: 'kept',
        reason: 'HEAD moved during the check',
      });
      expect(existsSync(detached)).toBe(true);
    },
    FIXTURE_TIMEOUT,
  );

  it(
    'reports a failed end-of-run `git worktree prune` as an error',
    () => {
      onGit(calls('worktree', 'prune'), () => exited(128, 'fatal: simulated'));

      const { result, errors } = prune();

      expect(result.action).toBe('removed');
      expect(errors).toEqual([
        `git -C ${repo} worktree prune: fatal: simulated`,
      ]);
    },
    FIXTURE_TIMEOUT,
  );
});
