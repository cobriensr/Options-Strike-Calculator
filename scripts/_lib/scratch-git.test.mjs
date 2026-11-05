// @vitest-environment node

/**
 * Tests for the pinned commit clock in scratch-git.fixtures.mjs.
 *
 * Why it exists: git names a commit by its parent, tree, message, identity
 * and second. A fixture that makes two commits meant to differ, with the
 * same parent, tree and message, gets one SHA if both land in the same
 * second. On Windows the dozen git spawns between two fixture commits take
 * more than a second, so the fixture passed locally; on a fast Linux runner
 * it did not (main's CI, 2026-11-04). The fixtures now stamp every commit
 * with one frozen date, so that collision happens on every machine, every
 * run, and a weak fixture fails where it is written.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PINNED_COMMIT_DATE,
  cleanEnv,
  git,
  makeTempDir,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';

setupScratchGit();

/** Longer than git's one-second commit-time resolution. */
const OVER_ONE_SECOND_MS = 1100;

/** A repo with one commit on `main`. */
function initRepo() {
  const repo = makeTempDir('scratch-git-pin-');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '--', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

/** On a new branch off main, commit x.txt with `message`; returns the SHA. */
function commitOnNewBranch(repo, branch, message) {
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  git(repo, 'add', '--', 'x.txt');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('the pinned commit clock', () => {
  it('stamps author and committer with one date', () => {
    const env = cleanEnv();
    expect(env.GIT_AUTHOR_DATE).toBe(PINNED_COMMIT_DATE);
    expect(env.GIT_COMMITTER_DATE).toBe(PINNED_COMMIT_DATE);
    expect(PINNED_COMMIT_DATE).toMatch(/^\d+ \+0000$/);
  });

  it('replaces a date the caller inherited from a hook or a shell', () => {
    vi.stubEnv('GIT_AUTHOR_DATE', '2001-01-01T00:00:00 +0000');
    vi.stubEnv('GIT_COMMITTER_DATE', '2001-01-01T00:00:00 +0000');
    try {
      const env = cleanEnv();
      expect(env.GIT_AUTHOR_DATE).toBe(PINNED_COMMIT_DATE);
      expect(env.GIT_COMMITTER_DATE).toBe(PINNED_COMMIT_DATE);
    } finally {
      vi.stubEnv('GIT_AUTHOR_DATE', undefined);
      vi.stubEnv('GIT_COMMITTER_DATE', undefined);
    }
  });

  it('lets a test set its own date, and unset the pin', () => {
    const own = '1700000000 +0000';
    const env = cleanEnv({
      GIT_AUTHOR_DATE: own,
      GIT_COMMITTER_DATE: undefined,
    });
    expect(env.GIT_AUTHOR_DATE).toBe(own);
    expect(env).not.toHaveProperty('GIT_COMMITTER_DATE');
  });

  it('gives two identical commits made over a second apart one SHA', async () => {
    const repo = initRepo();
    const first = commitOnNewBranch(repo, 'first', 'same message');
    await new Promise((resolve) => setTimeout(resolve, OVER_ONE_SECOND_MS));
    const second = commitOnNewBranch(repo, 'second', 'same message');

    expect(second).toBe(first);
  });

  it('gives commits that differ in message different SHAs', () => {
    const repo = initRepo();
    const first = commitOnNewBranch(repo, 'first', 'adds x');
    const second = commitOnNewBranch(repo, 'second', 'also adds x');

    expect(second).not.toBe(first);
  });
});
