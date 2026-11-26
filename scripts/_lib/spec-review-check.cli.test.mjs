// @vitest-environment node

/**
 * Tests for scripts/spec-review-check.mjs, the check .githooks/pre-commit runs
 * on the spec and plan docs a Claude commit adds: the real CLI, run with node
 * in throwaway repos that hold a hand-written review log, and the real hook
 * that calls it, run through git (the "pre-commit hook" block). Pure parsing
 * and deciding are in spec-review-log.test.mjs. Shared helpers are in
 * review-gate.fixtures.mjs. Design:
 * docs/superpowers/specs/2026-11-21-spec-review-gate-design.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRIFTED,
  claudeCommit,
  git,
  headSubject,
  initRepo,
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

    const result = run(outside, process.execPath, [CLI, SPEC], {
      // Keep git from finding a repository above the temp dir.
      GIT_CEILING_DIRECTORIES: path.dirname(outside),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit blocked, the check failed:');
    expect(result.stderr).toContain('git rev-parse --git-common-dir');
  });

  describe('pre-commit hook', () => {
    /** The first line of the message every block of this gate starts with. */
    const BLOCKED = 'spec-review gate: commit blocked';
    const REVIEWED = [
      entry('start', 'a1', 'specs/a.md'),
      entry('done', 'a1', '-'),
    ];

    /** Add `file` to the index of `cwd`, its name read as it is, not as a glob. */
    function stage(cwd, file, body = 'a doc\n') {
      write(cwd, file, body);
      git(cwd, '--literal-pathspecs', 'add', '--', file);
    }

    /**
     * The hook on its own, with the staged files as they are: `git hook run`
     * starts it the way a commit does but writes nothing, so a test can put a
     * merge marker in the git dir without making the commit a merge. (`sh` is
     * not on every shell's PATH on Windows; git finds its own.)
     */
    function claudeHook(cwd) {
      return run(cwd, 'git', ['hook', 'run', 'pre-commit'], {
        CLAUDECODE: '1',
      });
    }

    it('blocks a commit that adds a spec with no review on record', () => {
      writeLog(repo, [entry('start', 'a1', 'specs/a.md')]);
      stage(repo, SPEC);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BLOCKED);
      expect(result.stderr).toContain(`\n  ${SPEC}\n`);
      expect(headSubject(repo)).toBe('base');
    });

    it('blocks, rather than passes, when git cannot list the added docs', () => {
      // The two pathspec settings contradict each other, so only a git call
      // that has a pathspec dies: the hook's listing, not the review gate's own
      // diff, so an empty listing would let the spec step go quiet.
      writeLog(repo, [entry('start', 'a1', 'specs/a.md')]);
      stage(repo, SPEC);
      review(repo);

      const result = run(repo, 'git', ['commit', '-q', '-m', 'claude'], {
        CLAUDECODE: '1',
        GIT_GLOB_PATHSPECS: '1',
        GIT_NOGLOB_PATHSPECS: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pathspec settings are incompatible');
      expect(headSubject(repo)).toBe('base');
    });

    // A pathspec setting in the environment changes how git reads the hook's listing: literal or
    // no-glob made it list nothing, so an unreviewed doc committed with no message; glob made `*`
    // stop at a slash, so a doc in a subfolder escaped. The listing carries its own pathspec
    // magic and turns the literal setting off for itself, so each setting blocks.
    it.each([
      ['GIT_LITERAL_PATHSPECS', SPEC],
      ['GIT_NOGLOB_PATHSPECS', SPEC],
      ['GIT_NOGLOB_PATHSPECS', PLAN],
      ['GIT_GLOB_PATHSPECS', SPEC],
      ['GIT_ICASE_PATHSPECS', SPEC],
    ])('blocks an unreviewed doc under %s=1 (%s)', (setting, doc) => {
      writeLog(repo, [entry('start', 'a1', 'specs/other.md')]);
      stage(repo, doc);
      review(repo);

      const result = run(repo, 'git', ['commit', '-q', '-m', 'claude'], {
        CLAUDECODE: '1',
        [setting]: '1',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BLOCKED);
      expect(result.stderr).toContain(`\n  ${doc}\n`);
      expect(headSubject(repo)).toBe('base');
    });

    it.each([
      'GIT_GLOB_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_LITERAL_PATHSPECS',
    ])(
      'blocks a doc in a subfolder of specs/ under %s=1, as it does with no setting',
      (setting) => {
        // The key rule has no name for a nested doc, so the check says so.
        const nested = 'docs/superpowers/specs/sub/deep.md';
        writeLog(repo, REVIEWED);
        stage(repo, nested);
        review(repo);

        const result = run(repo, 'git', ['commit', '-q', '-m', 'claude'], {
          CLAUDECODE: '1',
          [setting]: '1',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(BLOCKED);
        expect(result.stderr).toContain(`\n  ${nested}\n`);
        expect(headSubject(repo)).toBe('base');
      },
    );

    it.each([
      'GIT_LITERAL_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
    ])('still lets a reviewed doc through under %s=1', (setting) => {
      writeLog(repo, REVIEWED);
      stage(repo, SPEC);
      review(repo);

      const result = run(repo, 'git', ['commit', '-q', '-m', 'claude'], {
        CLAUDECODE: '1',
        [setting]: '1',
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('claude');
    });

    it('blocks a commit that adds a plan with no review on record', () => {
      writeLog(repo, REVIEWED);
      stage(repo, PLAN);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BLOCKED);
      expect(result.stderr).toContain(`\n  ${PLAN}\n`);
      expect(headSubject(repo)).toBe('base');
    });

    it('lets through a commit that adds a spec with a review on record', () => {
      writeLog(repo, REVIEWED);
      stage(repo, SPEC);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('claude');
    });

    it('lists only the added docs that lack a review, one argument each', () => {
      // One reviewed doc and one not: a single argument holding both paths
      // would be keyed by its first doc and pass.
      writeLog(repo, REVIEWED);
      stage(repo, SPEC);
      stage(repo, PLAN);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`\n  ${PLAN}\n`);
      expect(result.stderr).not.toContain(`  ${SPEC}`);
    });

    it('names a doc whose file name has a space whole, and blocks it', () => {
      const odd = 'docs/superpowers/specs/my spec.md';
      writeLog(repo, REVIEWED);
      stage(repo, odd);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`\n  ${odd}\n`);
      expect(result.stderr).toContain(`No review or waiver can name ${odd}:`);
    });

    it.each(['specs', 'plans'])(
      'checks a doc under %s/ whose name is in upper case, as the hooks key it',
      (folder) => {
        // docKey and the bash hooks lower-case the path, so X.MD is x.md.
        const upper = `docs/superpowers/${folder}/X.MD`;
        writeLog(repo, REVIEWED);
        stage(repo, upper);
        review(repo);

        const result = claudeCommit(repo);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(BLOCKED);
        expect(result.stderr).toContain(`\n  ${upper}\n`);
        expect(headSubject(repo)).toBe('base');
      },
    );

    it('hands the check a glob character in a doc name as it is', () => {
      // a1.md has a review. The shell would read a[1].md as a pattern, and
      // match a1.md, if the hook let it.
      const reviewed = 'docs/superpowers/specs/a1.md';
      const odd = 'docs/superpowers/specs/a[1].md';
      writeLog(repo, [
        entry('start', 'a1', 'specs/a1.md'),
        entry('done', 'a1', '-'),
      ]);
      stage(repo, reviewed);
      stage(repo, odd);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`\n  ${odd}\n`);
      expect(result.stderr).not.toContain(`  ${reviewed}`);
    });

    it('does not check a doc that was committed before and is changed now', () => {
      // No log at all: had the check run, it would have blocked on that.
      stage(repo, SPEC);
      git(repo, 'commit', '-q', '-m', 'doc');
      stage(repo, SPEC, 'an "As built" note\n');
      review(repo);

      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('claude');
    });

    it('blocks a doc moved into the doc folder from elsewhere', () => {
      stage(repo, 'docs/tmp/a.md');
      git(repo, 'commit', '-q', '-m', 'draft');
      mkdirSync(path.join(repo, 'docs', 'superpowers', 'specs'), {
        recursive: true,
      });
      git(repo, 'mv', 'docs/tmp/a.md', SPEC);
      writeLog(repo, [entry('start', 'a1', 'specs/other.md')]);
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BLOCKED);
      expect(result.stderr).toContain(`\n  ${SPEC}\n`);
    });

    it('blocks a doc renamed inside the doc folders, as a new doc', () => {
      // Both sides of a move sit in the pathspec, so git would report one
      // rename, which is not an addition, unless the hook turns that off.
      writeLog(repo, REVIEWED);
      stage(repo, SPEC);
      git(repo, 'commit', '-q', '-m', 'doc');
      git(repo, 'mv', SPEC, 'docs/superpowers/specs/c.md');
      review(repo);

      const result = claudeCommit(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(BLOCKED);
      expect(result.stderr).toContain('\n  docs/superpowers/specs/c.md\n');
      expect(headSubject(repo)).toBe('doc');
    });

    it('does not check a file under the doc folders that is not markdown', () => {
      stage(repo, 'docs/superpowers/specs/notes.txt');
      review(repo);

      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('checks nothing, and needs no log, when the commit adds no doc', () => {
      stage(repo, 'a.txt', 'changed\n');
      review(repo);

      const result = claudeCommit(repo);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('claude');
    });

    it('leaves a commit that is not Claude Code to git, as before', () => {
      stage(repo, SPEC);

      const result = run(repo, 'git', ['commit', '-q', '-m', 'owner']);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(headSubject(repo)).toBe('owner');
    });

    describe.each([
      ['MERGE_HEAD', 'file'],
      ['CHERRY_PICK_HEAD', 'file'],
      ['REVERT_HEAD', 'file'],
      ['rebase-merge', 'folder'],
      ['rebase-apply', 'folder'],
    ])('while %s is in the git dir', (name, kind) => {
      /** Make `name` in the git dir of `cwd`, as git does mid-operation. */
      function markReplay(cwd) {
        const marker = path.join(adminDir(cwd), name);
        if (kind === 'folder') mkdirSync(marker);
        else writeFileSync(marker, `${git(cwd, 'rev-parse', 'HEAD')}\n`);
      }

      it('skips the check, which blocks the same staged doc without it', () => {
        writeLog(repo, REVIEWED);
        stage(repo, PLAN);
        review(repo);
        const before = claudeHook(repo);
        markReplay(repo);

        const during = claudeHook(repo);

        expect(before.status).toBe(1);
        expect(before.stderr).toContain(BLOCKED);
        expect(during.stderr).not.toContain('spec-review gate');
        expect(during.status).toBe(0);
      });
    });

    it('still runs the review gate while a marker is in the git dir', () => {
      // A hook that left the whole commit gate for a marker would pass the
      // marker tests above, since they seal the tree. Here a staged file
      // drifts after the seal, and the gate has to say so.
      writeLog(repo, REVIEWED);
      stage(repo, PLAN);
      review(repo);
      stage(repo, 'a.txt', 'changed after the review\n');
      writeFileSync(
        path.join(adminDir(repo), 'MERGE_HEAD'),
        `${git(repo, 'rev-parse', 'HEAD')}\n`,
      );

      const result = claudeHook(repo);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${DRIFTED}\n  a.txt\n`);
      expect(result.stderr).not.toContain('spec-review gate');
    });

    it('reads the markers in the git dir of a linked worktree, not .git', () => {
      const worktree = path.join(makeTempDir('spec-review-wt-'), 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree);
      writeLog(repo, REVIEWED);
      stage(worktree, PLAN);
      review(worktree);
      const before = claudeHook(worktree);
      writeFileSync(
        path.join(adminDir(worktree), 'MERGE_HEAD'),
        `${git(worktree, 'rev-parse', 'HEAD')}\n`,
      );

      const during = claudeHook(worktree);

      expect(before.status).toBe(1);
      expect(before.stderr).toContain(BLOCKED);
      // Both of the check's blocks start with BLOCKED: this one must be the
      // unreviewed doc, found in the main checkout's log, not a missing log.
      expect(before.stderr).not.toContain('There is no review log');
      expect(during.stderr).not.toContain('spec-review gate');
      expect(during.status).toBe(0);
    });

    describe('a commit from a linked worktree, through the hook', () => {
      /** A linked worktree of `repo`, with its own folder. */
      function linkedWorktree() {
        const worktree = path.join(makeTempDir('spec-review-wt-'), 'wt');
        git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree);
        return worktree;
      }

      it('passes a doc that the main checkout log has reviewed', () => {
        // git exports GIT_DIR to a hook in a linked worktree, and the log is
        // found from the common dir: the CLI-only worktree case above runs
        // without that environment.
        const worktree = linkedWorktree();
        writeLog(repo, REVIEWED);
        stage(worktree, SPEC);
        review(worktree);

        const result = claudeCommit(worktree);

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(headSubject(worktree)).toBe('claude');
      });

      it('blocks a doc that the main checkout log has not reviewed, naming the doc', () => {
        const worktree = linkedWorktree();
        writeLog(repo, REVIEWED);
        stage(worktree, PLAN);
        review(worktree);

        const result = claudeCommit(worktree);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(BLOCKED);
        expect(result.stderr).toContain(`\n  ${PLAN}\n`);
        expect(result.stderr).not.toContain('There is no review log');
        expect(headSubject(worktree)).toBe('base');
      });
    });
  });
});
