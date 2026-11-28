// @vitest-environment node

/**
 * Tests for scripts/_lib/backup-dir-from-git.mjs: the backup folder the two
 * SPX/NDX candle repair CLIs write to, found through real git in a throwaway
 * repo with a linked worktree, as the CLIs find it from their own worktree.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { backupDirFromGit } from './backup-dir-from-git.mjs';
import { GitError } from './git-run.mjs';
import { git, makeTempDir, setupScratchGit } from './scratch-git.fixtures.mjs';

setupScratchGit();

/** A repo with one commit, so a worktree can be added. */
function makeRepo() {
  const repo = makeTempDir('backup-dir-');
  git(repo, 'init', '-q');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const BACKUPS = path.join('docs', 'tmp', 'spx-candle-repair');

describe('backupDirFromGit', () => {
  it('finds the main checkout from a folder inside it', () => {
    const repo = makeRepo();
    const scripts = path.join(repo, 'scripts');
    mkdirSync(scripts);

    expect(backupDirFromGit(scripts)).toBe(path.join(repo, BACKUPS));
  });

  it('finds the main checkout, not the worktree, from a folder inside a linked worktree', () => {
    const repo = makeRepo();
    const worktree = path.join(makeTempDir('backup-dir-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'feature');
    const scripts = path.join(worktree, 'scripts');
    mkdirSync(scripts);

    expect(backupDirFromGit(scripts)).toBe(path.join(repo, BACKUPS));
  });

  it("throws git's own error when the folder is in no repository", () => {
    const empty = makeTempDir('backup-dir-none-');
    // git must not find a repository above the temp folder. Put back only this
    // var: unstubAllEnvs would also drop the file's GIT_CONFIG stubs.
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(empty);
    let thrown;
    try {
      backupDirFromGit(empty);
    } catch (err) {
      thrown = err;
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = before;
    }

    expect(thrown).toBeInstanceOf(GitError);
    expect(thrown.message).toContain('rev-parse');
  });

  it('refuses a repository whose common dir is not a .git, so nothing is written there', () => {
    // A bare repository's common dir is the repository itself.
    const bare = path.join(makeTempDir('backup-dir-bare-'), 'bare');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare');

    expect(() => backupDirFromGit(bare)).toThrow(/not a \.git directory/);
  });
});
