// @vitest-environment node

/**
 * Tests for the commit gate: scripts/_lib/review-gate.mjs, its CLI
 * scripts/review-gate.mjs, and .githooks/pre-commit. decideCommit gets a
 * table test. Everything else runs real git against throwaway repos under
 * the OS temp dir, with the repo's real hook wired in through an absolute
 * core.hooksPath, so a commit here goes through the same sh -> node -> git
 * path a Claude commit does. Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 *
 * The suite is split in two so vitest runs the halves on separate workers.
 * This file has decideCommit, the hook's main cases and the hook's file
 * mode; review-gate.cli.test.mjs has the hook's partial-commit and rename
 * cases, linked worktrees and the CLI. Shared helpers are in
 * review-gate.fixtures.mjs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_FAILED,
  NO_MARKER,
  ROOT,
  claudeCommit,
  git,
  headSubject,
  initRepo,
  markerFile,
  review,
  run,
  write,
} from './review-gate.fixtures.mjs';
import { decideCommit } from './review-gate.mjs';
import { makeTempDir, setupScratchGit } from './scratch-git.fixtures.mjs';

setupScratchGit();

describe('decideCommit', () => {
  it.each([
    ['nothing is staged', [], []],
    ['nothing is staged and the working tree drifted', [], ['src/edited.ts']],
    ['every staged path matches the sealed tree', ['src/reviewed.ts'], []],
    ['only unstaged paths drifted', ['src/reviewed.ts'], ['unstaged/other.ts']],
  ])('allows the commit (null) when %s', (_label, staged, drifted) => {
    expect(decideCommit({ staged, drifted })).toBeNull();
  });

  it('blocks when a staged path drifted, naming it and the fix', () => {
    const reason = decideCommit({
      staged: ['src/edited.ts'],
      drifted: ['src/edited.ts'],
    });

    expect(typeof reason).toBe('string');
    expect(reason).toContain('src/edited.ts');
    expect(reason).toContain('npm run review');
  });

  it('lists each offending path on its own indented line, in staged order', () => {
    const reason = decideCommit({
      staged: ['src/edited.ts', 'docs/new.md'],
      drifted: ['docs/new.md', 'src/edited.ts'],
    });

    expect(reason).toBe(
      [
        'commit blocked. These staged files changed after the last passing `npm run review`:',
        '  src/edited.ts',
        '  docs/new.md',
        'Run `npm run review`, then commit again.',
      ].join('\n'),
    );
  });

  it('names every staged drifted path and only those', () => {
    const reason = decideCommit({
      staged: ['src/reviewed.ts', 'src/edited.ts', 'docs/new.md'],
      drifted: ['src/edited.ts', 'docs/new.md', 'unstaged/other.ts'],
    });

    expect(reason).toContain('src/edited.ts');
    expect(reason).toContain('docs/new.md');
    expect(reason).not.toContain('src/reviewed.ts');
    expect(reason).not.toContain('unstaged/other.ts');
  });

  it('names paths with spaces and non-ASCII characters verbatim', () => {
    const reason = decideCommit({
      staged: ['docs/café notes.md'],
      drifted: ['docs/café notes.md'],
    });

    expect(reason).toContain('docs/café notes.md');
  });
});

describe('pre-commit hook', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('review-gate-'));
  });

  it('allows a commit whose staged content the last review sealed', () => {
    write(repo, 'a.txt', 'a reviewed\n');
    write(repo, 'c.txt', 'new, untracked when sealed\n');
    review(repo);
    git(repo, 'add', '--', 'a.txt', 'c.txt');

    const result = claudeCommit(repo);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(headSubject(repo)).toBe('claude');
  });

  it('blocks a staged file edited after the seal and names it', () => {
    const file = 'docs/café notes.md';
    write(repo, file, 'reviewed\n');
    review(repo);
    write(repo, file, 'edited after the review\n');
    git(repo, 'add', '--', file);

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain('npm run review');
    expect(headSubject(repo)).toBe('base');
  });

  it('checks the index git commits with -a, not the on-disk index', () => {
    review(repo);
    write(repo, 'a.txt', 'edited after the review, never staged\n');

    const result = claudeCommit(repo, '-a');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a.txt');
    expect(headSubject(repo)).toBe('base');
  });

  it('explains a sealed tree that git gc pruned, instead of a raw bad-object error', () => {
    write(repo, 'a.txt', 'a reviewed\n');
    write(repo, 'b.txt', 'b reviewed, left unstaged\n');
    review(repo);
    const { tree } = JSON.parse(readFileSync(markerFile(repo), 'utf8'));
    git(repo, 'prune', '--expire=now');
    expect(run(repo, 'git', ['cat-file', '-t', tree]).status).not.toBe(0);
    // Only a.txt is staged, so the index tree differs from the sealed one.
    // Staging both would make `git commit` write the identical tree back
    // before the hook runs, and the commit would rightly pass.
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${CHECK_FAILED} the sealed tree ${tree} is no longer in the object ` +
        'store (git gc prunes unreferenced objects after about two weeks). ' +
        `git cat-file -t ${tree}: fatal: git cat-file: could not get object ` +
        'info. Run `npm run review`, then commit again.',
    );
    expect(result.stderr).not.toContain('bad object');
    expect(headSubject(repo)).toBe('base');
  });

  it('says what git found when the sealed id names an object that is not a tree', () => {
    review(repo);
    // A valid object id, so readMarker accepts it, but a blob.
    const blob = git(repo, 'rev-parse', 'HEAD:a.txt');
    const marker = JSON.parse(readFileSync(markerFile(repo), 'utf8'));
    writeFileSync(markerFile(repo), JSON.stringify({ ...marker, tree: blob }));
    write(repo, 'a.txt', 'edited\n');
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${CHECK_FAILED} the sealed tree ${blob} is no longer in the object ` +
        'store (git gc prunes unreferenced objects after about two weeks). ' +
        `git cat-file -t ${blob} printed "blob". ` +
        'Run `npm run review`, then commit again.',
    );
    expect(headSubject(repo)).toBe('base');
  });

  it('blocks when no review has sealed this worktree', () => {
    write(repo, 'a.txt', 'never reviewed\n');
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `review-gate: commit blocked. ${NO_MARKER}`,
    );
    expect(headSubject(repo)).toBe('base');
  });

  it('allows a commit when reviewed changes are left unstaged', () => {
    write(repo, 'a.txt', 'a reviewed\n');
    write(repo, 'b.txt', 'b reviewed, left for another session\n');
    review(repo);
    git(repo, 'add', '--', 'a.txt');

    const result = claudeCommit(repo);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(headSubject(repo)).toBe('claude');
    expect(git(repo, 'status', '--porcelain')).toBe('M b.txt');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['"0"', '0'],
  ])(
    'lets the commit through without the gate when CLAUDECODE is %s',
    (_label, claudecode) => {
      write(repo, 'a.txt', 'never reviewed\n');
      git(repo, 'add', '--', 'a.txt');

      const result = run(repo, 'git', ['commit', '-q', '-m', 'owner'], {
        CLAUDECODE: claudecode,
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('owner');
    },
  );

  it.each([
    ['not JSON', '{not json', 'not valid JSON'],
    ['an empty object', '{}', 'expected { tree, head, sealedAt }'],
    ['an array', '[]', 'expected { tree, head, sealedAt }'],
    [
      'an option in place of the tree id',
      JSON.stringify({
        tree: '--output=pwned',
        head: 'a'.repeat(40),
        sealedAt: '2026-10-28T00:00:00.000Z',
      }),
      'expected { tree, head, sealedAt }',
    ],
  ])(
    'blocks on a corrupt marker (%s): fails closed',
    (_label, body, detail) => {
      review(repo);
      writeFileSync(markerFile(repo), body);
      write(repo, 'a.txt', 'edited\n');
      git(repo, 'add', '--', 'a.txt');

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${CHECK_FAILED} corrupt review marker`);
      expect(result.stderr).toContain(detail);
      expect(headSubject(repo)).toBe('base');
      expect(existsSync(path.join(repo, 'pwned'))).toBe(false);
    },
  );
});

describe('.githooks/pre-commit in this repo', () => {
  it('is executable in the index, so git runs it on Linux and macOS', () => {
    // Windows ignores the mode (core.fileMode=false); CI's ubuntu checkout
    // skips a 100644 hook with only a hint.
    const entry = git(
      ROOT,
      'ls-files',
      '--stage',
      '--',
      '.githooks/pre-commit',
    );

    expect(entry).toMatch(/^100755 [0-9a-f]+ 0\t\.githooks\/pre-commit$/);
  });
});
