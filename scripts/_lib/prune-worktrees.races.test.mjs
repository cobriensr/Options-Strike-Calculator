// @vitest-environment node

/**
 * Race and failure paths of scripts/_lib/prune-worktrees.mjs that real git
 * cannot produce on demand: another run or process changing the repo between
 * two of the module's git calls, git commands failing, and what a removal
 * leaves behind (on Windows, a node_modules junction). spawnSync is wrapped at
 * the node:child_process boundary and the delete calls at node:fs. Each case
 * intercepts one git call or one delete; every other call runs for real
 * against a scratch repo.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_TIMEOUT,
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    readdirSync: vi.fn(actual.readdirSync),
    rmSync: vi.fn(actual.rmSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const { spawnSync: realSpawnSync } =
  await vi.importActual('node:child_process');

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
    vi.mocked(readdirSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(rmdirSync).mockReset();
    vi.mocked(unlinkSync).mockReset();
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
    'strips GIT_DIR and GIT_INDEX_FILE from every git call, so a hook env cannot redirect it',
    () => {
      // A git hook exports these. Inherited, they would aim every
      // `-C <dir>` call at this decoy repo instead of the worktree named.
      const decoyGitDir = path.join(
        initRepo(makeTempDir('prune-wt-decoy-')),
        '.git',
      );
      const before = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      vi.stubEnv('GIT_DIR', decoyGitDir);
      vi.stubEnv('GIT_INDEX_FILE', path.join(decoyGitDir, 'index'));
      try {
        const { result, errors } = prune();

        // Checked before the finally: a call handed process.env itself holds
        // a reference, and the restore below would delete the stubs from it.
        const { calls } = vi.mocked(spawnSync).mock;
        expect(calls.length).toBeGreaterThan(0);
        for (const [, args, options] of calls) {
          const call = `git ${args.join(' ')}`;
          expect(options?.env, call).toBeDefined();
          expect(options.env, call).not.toHaveProperty('GIT_DIR');
          expect(options.env, call).not.toHaveProperty('GIT_INDEX_FILE');
        }
        expect(errors).toEqual([]);
        expect(result).toMatchObject({
          action: 'removed',
          deletedBranchSha: head,
        });
      } finally {
        // Only these two: unstubAllEnvs would also drop the file's
        // GIT_CONFIG stubs. Stubbing undefined deletes the var.
        vi.stubEnv('GIT_DIR', before.GIT_DIR);
        vi.stubEnv('GIT_INDEX_FILE', before.GIT_INDEX_FILE);
      }
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

  describe('what a removal leaves behind', () => {
    // On Windows, `git worktree remove` exits 0 and prints nothing, but leaves
    // an ignored node_modules junction and its folder behind (the real-git
    // case is in prune-worktrees.test.mjs). Here real git removes the
    // worktree and the fixture puts the leftover back, so every platform runs
    // these.
    let target = '';
    const DEEP = path.join('nested', 'deep', 'sentinel.txt');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';

    const link = () => path.join(wt, 'node_modules');
    const isLink = (file) =>
      lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink();

    /** Real removal, then `leave()` puts what is left at the worktree path. */
    function leaveAfterRemoval(leave) {
      onGit(calls('worktree', 'remove'), (real) => {
        const removal = real();
        leave();
        return removal;
      });
    }

    function leaveLink() {
      mkdirSync(wt);
      symlinkSync(target, link(), linkType);
    }

    /** What a leftover link points at must never be entered or deleted. */
    function expectTargetIntact() {
      expect(readFileSync(path.join(target, 'top.txt'), 'utf8')).toBe('top\n');
      expect(readFileSync(path.join(target, DEEP), 'utf8')).toBe('deep\n');
    }

    function failOnce(mock, code, message) {
      mock.mockImplementationOnce(() => {
        throw Object.assign(new Error(`${code}: ${message}`), { code });
      });
    }

    beforeEach(() => {
      target = makeTempDir('prune-wt-link-target-');
      mkdirSync(path.join(target, 'nested', 'deep'), { recursive: true });
      writeFileSync(path.join(target, 'top.txt'), 'top\n');
      writeFileSync(path.join(target, DEEP), 'deep\n');
    });

    it('removes a leftover link and its folder, and leaves what the link points at alone', () => {
      leaveAfterRemoval(leaveLink);

      const { result, errors } = prune();

      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'removed',
        deletedBranchSha: head,
      });
      expect(existsSync(wt)).toBe(false);
      expectTargetIntact();
      // Non-recursive calls only: nothing here may walk through the link.
      expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
      expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(link());
      expect(vi.mocked(rmdirSync)).toHaveBeenCalledWith(wt);
    });

    it('removes a leftover link but keeps the folder, and says so, when a file is left beside it', () => {
      leaveAfterRemoval(() => {
        leaveLink();
        writeFileSync(path.join(wt, 'stuck.txt'), 'stuck\n');
      });

      const { result, errors } = prune();

      const reason = `git worktree remove left files at ${wt}: stuck.txt`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(result.deletedBranchSha).toBeUndefined();
      expect(errors).toEqual([`x: ${reason}`]);
      expect(isLink(link())).toBeUndefined();
      expect(readFileSync(path.join(wt, 'stuck.txt'), 'utf8')).toBe('stuck\n');
      expectTargetIntact();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    });

    it('keeps the folder, and says so, when only something other than a link is left', () => {
      leaveAfterRemoval(() => {
        mkdirSync(path.join(wt, 'real', 'deeper'), { recursive: true });
        writeFileSync(path.join(wt, 'real', 'deeper', 'a.txt'), 'a\n');
      });

      const { result, errors } = prune();

      const reason = `git worktree remove left files at ${wt}: real`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      // A real folder is not a link: it is neither entered nor deleted.
      expect(
        readFileSync(path.join(wt, 'real', 'deeper', 'a.txt'), 'utf8'),
      ).toBe('a\n');
      expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
      expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    });

    it('keeps the folder, and says so, when a real folder holds a link', () => {
      leaveAfterRemoval(() => {
        mkdirSync(path.join(wt, 'sub'), { recursive: true });
        symlinkSync(target, path.join(wt, 'sub', 'node_modules'), linkType);
      });

      const { result, errors } = prune();

      const reason = `git worktree remove left files at ${wt}: sub`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      // The real folder is not entered, so the link inside it is not deleted.
      expect(isLink(path.join(wt, 'sub', 'node_modules'))).toBe(true);
      expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
      expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
      expectTargetIntact();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    });

    it('does not enter the worktree path when that is itself a link', () => {
      leaveAfterRemoval(() => symlinkSync(target, wt, linkType));

      const { result, errors } = prune();

      const reason = `git worktree remove left ${wt}, which is not a folder`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      expect(isLink(wt)).toBe(true);
      expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
      expectTargetIntact();
    });

    it('keeps the folder, and says so, when the link cannot be deleted', () => {
      leaveAfterRemoval(leaveLink);
      failOnce(vi.mocked(unlinkSync), 'EPERM', 'operation not permitted');

      const { result, errors } = prune();

      const reason = `git worktree remove left files at ${wt}: could not delete node_modules (EPERM: operation not permitted)`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      expect(isLink(link())).toBe(true);
      expectTargetIntact();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    });

    it('keeps the folder, and says so, when the folder cannot be read', () => {
      leaveAfterRemoval(leaveLink);
      failOnce(vi.mocked(readdirSync), 'EACCES', 'permission denied');

      const { result, errors } = prune();

      const reason = `git worktree remove left ${wt}: could not clear it (EACCES: permission denied)`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      expect(isLink(link())).toBe(true);
      expectTargetIntact();
    });

    it('keeps the folder, and says so, when the emptied folder cannot be deleted', () => {
      leaveAfterRemoval(leaveLink);
      failOnce(vi.mocked(rmdirSync), 'EBUSY', 'resource busy or locked');

      const { result, errors } = prune();

      const reason = `git worktree remove left ${wt}: could not delete the folder (EBUSY: resource busy or locked)`;
      expect(result).toMatchObject({ action: 'kept', reason });
      expect(errors).toEqual([`x: ${reason}`]);
      expect(isLink(link())).toBeUndefined();
      expectTargetIntact();
      expect(git(repo, 'rev-parse', 'refs/heads/fix/x')).toBe(head);
    });
  });

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
