// @vitest-environment node

/**
 * Tests for scripts/spec-review-check.mjs, the check .githooks/pre-commit runs
 * on the spec and plan docs a Claude commit adds: the real CLI, run with node
 * in throwaway repos that hold a hand-written review log. Pure parsing and
 * deciding are in spec-review-log.test.mjs. Shared helpers are in
 * review-gate.fixtures.mjs. Design:
 * docs/superpowers/specs/2026-11-21-spec-review-gate-design.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { git, initRepo, run, write } from './review-gate.fixtures.mjs';
import { makeTempDir, setupScratchGit } from './scratch-git.fixtures.mjs';

setupScratchGit();

const CLI = path.join(process.cwd(), 'scripts', 'spec-review-check.mjs');

const SPEC = 'docs/superpowers/specs/a.md';
const PLAN = 'docs/superpowers/plans/b.md';

/** The log's place for a repo whose main checkout is `repo`. */
function logFile(repo) {
  return path.join(repo, '.claude', 'state', 'spec-reviews.tsv');
}

/** Write the review log of `repo`, one tab-separated line per entry. */
function writeLog(repo, lines) {
  const file = logFile(repo);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    lines.map((fields) => fields.join('\t')).join('\n') + '\n',
  );
}

/** A log entry: epoch, event, session, agent, key, path. */
function entry(event, agent, key) {
  return ['1700000000', event, 's1', agent, key, '-'];
}

/** The check, the way the pre-commit hook runs it. */
function check(cwd, ...paths) {
  return run(cwd, process.execPath, [CLI, ...paths]);
}

describe('spec-review-check', () => {
  let repo = '';

  beforeEach(() => {
    repo = initRepo(makeTempDir('spec-review-check-'));
    // The log lives in the repo's own .claude/, which no gate may seal.
    write(repo, '.gitignore', 'ignored.txt\n.claude/\n');
  });

  it('blocks when there is no review log, naming the log', () => {
    const result = check(repo, SPEC);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('There is no review log at');
    expect(result.stderr).toContain(logFile(repo));
    expect(result.stderr).toContain(`\n  ${SPEC}\n`);
    expect(result.stdout).toBe('');
  });

  it('blocks a doc that has no review on record, and names it and the waiver', () => {
    writeLog(repo, [entry('start', 'a1', 'specs/a.md')]);

    const result = check(repo, SPEC);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit blocked');
    expect(result.stderr).toContain(`\n  ${SPEC}\n`);
    expect(result.stderr).toContain('waive review specs/a.md');
    expect(result.stderr).not.toContain('There is no review log');
  });

  it('passes a doc with a finished review on record', () => {
    writeLog(repo, [
      entry('start', 'a1', 'specs/a.md'),
      entry('done', 'a1', '-'),
    ]);

    const result = check(repo, SPEC);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('passes a doc the owner waived', () => {
    writeLog(repo, [entry('waive', '-', 'specs/a.md')]);

    const result = check(repo, SPEC);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('lists only the docs that lack a review when it is given several', () => {
    writeLog(repo, [
      entry('start', 'a1', 'specs/a.md'),
      entry('done', 'a1', '-'),
    ]);

    const result = check(repo, SPEC, PLAN);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`\n  ${PLAN}\n`);
    expect(result.stderr).not.toContain(`  ${SPEC}`);
  });

  it('blocks a doc whose log has a block and a release but no review', () => {
    writeLog(repo, [
      entry('block', '-', 'specs/a.md'),
      entry('block', '-', 'specs/a.md'),
      entry('release', '-', 'specs/a.md'),
    ]);

    const result = check(repo, SPEC);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`\n  ${SPEC}\n`);
  });

  it('reads a log that ends its lines in CRLF', () => {
    const file = logFile(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${entry('start', 'a1', 'specs/a.md').join('\t')}\r\n${entry('done', 'a1', '-').join('\t')}\r\n`,
    );

    expect(check(repo, SPEC).status).toBe(0);
  });

  it('blocks, rather than passes, when the log cannot be read', () => {
    // A folder where the log should be: readable by nothing.
    mkdirSync(logFile(repo), { recursive: true });

    const result = check(repo, SPEC);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit blocked, the check failed:');
  });

  it('finds the main checkout log from a worktree', () => {
    const worktree = path.join(makeTempDir('spec-review-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree);
    writeLog(repo, [
      entry('start', 'a1', 'specs/a.md'),
      entry('done', 'a1', '-'),
    ]);

    const reviewed = check(worktree, SPEC);
    const missing = check(worktree, PLAN);

    expect(reviewed.stderr).toBe('');
    expect(reviewed.status).toBe(0);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`\n  ${PLAN}\n`);
  });

  it('finds the log from a subfolder of the repository', () => {
    write(repo, 'sub/keep.txt', 'x\n');
    writeLog(repo, [entry('waive', '-', 'specs/a.md')]);

    const result = check(path.join(repo, 'sub'), SPEC);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits 2 with a usage line when given no paths', () => {
    writeLog(repo, [entry('waive', '-', 'specs/a.md')]);

    const result = check(repo);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'usage: node scripts/spec-review-check.mjs',
    );
    expect(result.stdout).toBe('');
  });

  it('blocks outside a git repository, since any error blocks', () => {
    const outside = makeTempDir('spec-review-nogit-');

    const result = check(outside, SPEC);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit blocked, the check failed:');
    expect(result.stderr).toContain('git rev-parse --git-common-dir');
  });
});
