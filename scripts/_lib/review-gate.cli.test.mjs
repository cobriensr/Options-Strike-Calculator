// @vitest-environment node

/**
 * Commit-gate tests, second half: the hook's partial-commit and rename
 * cases, per-worktree markers, and the review-gate CLI. review-gate.test.mjs
 * has the first half and the overview; the two are split so vitest runs
 * them on separate workers. Shared helpers are in review-gate.fixtures.mjs.
 * Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLI,
  DRIFTED,
  MARKER,
  NO_MARKER,
  SEAL_REFUSED,
  claudeCommit,
  gate,
  git,
  headSubject,
  initRepo,
  markerFile,
  review,
  run,
  write,
} from './review-gate.fixtures.mjs';
import {
  adminDir,
  makeTempDir,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';

setupScratchGit();

// The same describe name and repo setup as in review-gate.test.mjs, so these
// tests keep their `pre-commit hook > …` path.
describe('pre-commit hook', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-'));
  });

  describe('a partial commit (`git commit -- <path>`)', () => {
    // a.txt is staged and sealed as reviewed, then edited again on disk.
    beforeEach(() => {
      write(repo, 'a.txt', 'a reviewed and staged\n');
      git(repo, 'add', '--', 'a.txt');
      review(repo);
      write(repo, 'a.txt', 'edited after the review, never staged\n');
    });

    it('checks the next-index git builds from the working tree, and blocks', () => {
      const result = claudeCommit(repo, '--', 'a.txt');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  a.txt\n`);
      expect(headSubject(repo)).toBe('base');
    });

    it('while a plain commit of the staged, reviewed content is allowed', () => {
      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a reviewed and staged');
    });
  });

  // One test per diff: each fails if `--no-renames` is dropped from that
  // diff alone, because rename detection would hide the deleted path there.
  describe('--no-renames', () => {
    it('in stagedPaths: a reviewed copy staged with an unreviewed deletion blocks', () => {
      // With rename detection, staged would be [z.txt] and drifted [a.txt]:
      // no overlap, and the unreviewed deletion of a.txt would commit.
      write(repo, 'z.txt', readFileSync(path.join(repo, 'a.txt'), 'utf8'));
      review(repo);
      git(repo, 'rm', '-q', '--', 'a.txt');
      git(repo, 'add', '--', 'z.txt');

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  a.txt\n`);
      expect(result.stderr).not.toContain('  z.txt');
      expect(headSubject(repo)).toBe('base');
    });

    it('in driftedPaths: an unreviewed deletion that reads as a rename from the sealed tree blocks', () => {
      // HEAD has identical x.txt and y.txt. Review saw y.txt deleted; the
      // commit deletes x.txt instead. Sealed tree [x] vs index [y] is a
      // rename x -> y, so with rename detection drifted would be [y.txt],
      // staged is [x.txt], and the unreviewed deletion would commit.
      write(repo, 'x.txt', 'same content\n');
      write(repo, 'y.txt', 'same content\n');
      git(repo, 'add', '--', 'x.txt', 'y.txt');
      git(repo, 'commit', '-q', '-m', 'twins');
      rmSync(path.join(repo, 'y.txt'));
      review(repo);
      git(repo, 'checkout', '--', 'y.txt');
      git(repo, 'rm', '-q', '--', 'x.txt');

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  x.txt\n`);
      expect(result.stderr).not.toContain('  y.txt');
      expect(headSubject(repo)).toBe('twins');
    });
  });
});

describe('linked worktrees', () => {
  let repo = '';
  let linked = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-wt-'));
    linked = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD');
  });

  it('keeps a separate marker in each worktree admin dir', () => {
    const mainMarker = path.join(repo, '.git', MARKER);
    const linkedMarker = path.join(repo, '.git', 'worktrees', 'linked', MARKER);
    expect(markerFile(repo)).toBe(mainMarker);
    expect(markerFile(linked)).toBe(linkedMarker);

    review(repo);
    expect(existsSync(mainMarker)).toBe(true);
    expect(existsSync(linkedMarker)).toBe(false);

    write(linked, 'a.txt', 'edited in the linked worktree\n');
    git(linked, 'add', '--', 'a.txt');
    const blocked = claudeCommit(linked);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(NO_MARKER);

    const mainBody = readFileSync(mainMarker, 'utf8');
    review(linked);
    expect(existsSync(linkedMarker)).toBe(true);
    expect(readFileSync(mainMarker, 'utf8')).toBe(mainBody);

    const cleared = gate(linked, 'clear');
    expect(cleared.status).toBe(0);
    expect(existsSync(linkedMarker)).toBe(false);
    expect(readFileSync(mainMarker, 'utf8')).toBe(mainBody);
  });

  it('commits in a sealed linked worktree while the unsealed main stays blocked', () => {
    write(linked, 'a.txt', 'reviewed in the linked worktree\n');
    review(linked);
    git(linked, 'add', '--', 'a.txt');

    const result = claudeCommit(linked);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(headSubject(linked)).toBe('claude');

    write(repo, 'b.txt', 'edited in main\n');
    git(repo, 'add', '--', 'b.txt');
    const blocked = claudeCommit(repo);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(NO_MARKER);
  });
});

describe('review-gate CLI', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-cli-'));
  });

  function leftoverTempIndexes() {
    return readdirSync(adminDir(repo)).filter((name) =>
      name.startsWith('review-gate-index'),
    );
  }

  it('seal records the whole working tree and HEAD without touching the real index', () => {
    write(repo, 'a.txt', 'modified, unstaged\n');
    write(repo, 'c.txt', 'untracked\n');
    write(repo, 'ignored.txt', 'gitignored\n');
    const before = Date.now();

    const result = gate(repo, 'seal', { npm_lifecycle_event: 'review' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const marker = JSON.parse(readFileSync(markerFile(repo), 'utf8'));
    expect(Object.keys(marker).sort()).toEqual(['head', 'sealedAt', 'tree']);
    expect(marker.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'cat-file', '-t', marker.tree)).toBe('tree');
    expect(git(repo, 'ls-tree', '-r', '--name-only', marker.tree)).toBe(
      ['.gitignore', 'a.txt', 'b.txt', 'c.txt'].join('\n'),
    );
    expect(git(repo, 'show', `${marker.tree}:a.txt`)).toBe(
      'modified, unstaged',
    );
    const sealedAt = Date.parse(marker.sealedAt);
    expect(sealedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(sealedAt).toBeLessThanOrEqual(Date.now());
    expect(result.stdout).toContain(marker.tree);
    // The real index is untouched: nothing staged, c.txt still untracked.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('M a.txt\n?? c.txt');
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it.each([
    ['unset', undefined, 'npm_lifecycle_event is unset'],
    ['"test"', 'test', 'npm_lifecycle_event is "test"'],
    ['"review:fast"', 'review:fast', 'npm_lifecycle_event is "review:fast"'],
  ])('seal refuses when npm_lifecycle_event is %s', (_label, event, detail) => {
    const result = gate(repo, 'seal', { npm_lifecycle_event: event });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SEAL_REFUSED);
    expect(result.stderr).toContain(detail);
    expect(existsSync(markerFile(repo))).toBe(false);
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it('seal removes its temp index and writes no marker when git add fails', () => {
    // An embedded repo with no commit makes `git add -A` exit 128.
    const nested = path.join(repo, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    write(nested, 'n.txt', 'n\n');

    const result = gate(repo, 'seal', { npm_lifecycle_event: 'review' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review-gate seal failed: git add -A');
    expect(result.stderr).toContain("'nested/' does not have a commit");
    expect(existsSync(markerFile(repo))).toBe(false);
    expect(leftoverTempIndexes()).toEqual([]);
  });

  it('clear removes the marker, and succeeds when there is none', () => {
    review(repo);
    expect(existsSync(markerFile(repo))).toBe(true);

    const first = gate(repo, 'clear');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(existsSync(markerFile(repo))).toBe(false);

    const second = gate(repo, 'clear');
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
  });

  it('a cleared marker blocks the next commit', () => {
    write(repo, 'a.txt', 'reviewed\n');
    review(repo);
    gate(repo, 'clear');
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NO_MARKER);
  });

  it.each([
    ['an unknown subcommand', ['bogus']],
    ['no subcommand', []],
    ['an extra argument', ['check', 'extra']],
  ])('prints usage and exits 2 for %s', (_label, args) => {
    const result = run(repo, process.execPath, [CLI, ...args]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'usage: node scripts/review-gate.mjs <clear|seal|check>',
    );
  });
});
