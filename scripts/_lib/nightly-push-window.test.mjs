// @vitest-environment node

/**
 * The pre-push guard for the nightly Railway service
 * (scripts/_lib/nightly-push-window.mjs, run by .githooks/pre-push through
 * scripts/nightly-push-window.mjs).
 *
 * The parsers and the window test are checked as plain functions. `main` runs
 * against a scratch repo with real git: its diffs (a new branch, a deletion,
 * a range, a rename) are what the guard exists for, so git is not faked. The
 * module reads the Dockerfile of the checkout it lives in, so these tests
 * read this repo's real nightly/Dockerfile; the scratch repo only carries the
 * paths a push would change. The last group pushes to a bare scratch remote
 * through the real hook, with a fixed clock in the hook's node process, to
 * prove the hook finds the entry, the entry reads git's stdin and git stops
 * the push on its exit code.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  imageSources,
  inBlockedWindow,
  main,
  touchedImagePaths,
} from './nightly-push-window.mjs';
import {
  cleanEnv,
  git,
  initRepo,
  makeTempDir,
  setupScratchGit,
} from './prune-worktrees.fixtures.mjs';
import { SLOW_CHILD_TIMEOUT, spawnChild } from './spawn-timeout.fixtures.mjs';

setupScratchGit();

// vitest runs from the repo root (same convention as review-gate.fixtures.mjs).
const ROOT = process.cwd();
// Forward slashes: the hook finds its entry with `dirname "$0"`, and sh's
// dirname splits on `/` only.
const HOOKS_DIR = path.join(ROOT, '.githooks').replaceAll('\\', '/');
const REAL_DOCKERFILE = readFileSync(
  path.join(ROOT, 'nightly', 'Dockerfile'),
  'utf8',
);

const INSIDE_WINDOW = new Date('2026-11-24T09:00:00Z');
const BYPASS = 'NIGHTLY_PUSH_WINDOW_OK';
const ZERO = '0'.repeat(40);

describe('inBlockedWindow', () => {
  it.each([
    ['07:14:59', false],
    ['07:15:00', true],
    ['09:00:00', true],
    ['12:29:59', true],
    ['12:30:00', false],
    ['00:00:00', false],
    ['23:59:59', false],
  ])('%s UTC is blocked: %s', (time, blocked) => {
    expect(inBlockedWindow(new Date(`2026-11-24T${time}Z`))).toBe(blocked);
  });

  it('counts milliseconds, so the edges are exact', () => {
    expect(inBlockedWindow(new Date('2026-11-24T07:14:59.999Z'))).toBe(false);
    expect(inBlockedWindow(new Date('2026-11-24T12:29:59.999Z'))).toBe(true);
  });

  it('reads the UTC clock, not the zone the date is written in', () => {
    // 07:15 at UTC-5 is 12:15 UTC, inside; 12:30 at UTC+5 is 07:30 UTC, inside.
    expect(inBlockedWindow(new Date('2026-11-24T07:15:00-05:00'))).toBe(true);
    expect(inBlockedWindow(new Date('2026-11-24T05:00:00-05:00'))).toBe(true);
    expect(inBlockedWindow(new Date('2026-11-24T08:00:00-05:00'))).toBe(false);
  });

  it('applies on every day of the week', () => {
    // 2026-11-22 is a Sunday, when the cron does not run: the window is by
    // clock only, so a manual run that day is protected too.
    expect(inBlockedWindow(new Date('2026-11-22T09:00:00Z'))).toBe(true);
  });
});

describe('imageSources', () => {
  const WATCHED = ['nightly/Dockerfile', '.dockerignore'];

  it('lists the sources of every COPY in order, then the Dockerfile and .dockerignore', () => {
    const dockerfile = [
      'FROM python:3.12-slim',
      'COPY nightly/requirements.txt ./',
      'COPY nightly/src/ ./src/',
    ].join('\n');

    expect(imageSources(dockerfile)).toEqual([
      'nightly/requirements.txt',
      'nightly/src/',
      ...WATCHED,
    ]);
  });

  it('skips a COPY --from stage and never lists a destination', () => {
    const dockerfile = [
      'COPY --from=builder /install /usr/local',
      'COPY --from=0 /a /b',
      'COPY nightly/src/ /app/src/',
    ].join('\n');

    expect(imageSources(dockerfile)).toEqual(['nightly/src/', ...WATCHED]);
  });

  it('reads a multi-source COPY with --chown and line continuations', () => {
    const dockerfile = [
      'COPY --chown=nightly:nightly \\',
      '    scripts/a.py \\',
      '    scripts/b.py \\',
      '    ./scripts/',
    ].join('\n');

    expect(imageSources(dockerfile)).toEqual([
      'scripts/a.py',
      'scripts/b.py',
      ...WATCHED,
    ]);
  });

  it('reads a one-line multi-source COPY with several flags', () => {
    const dockerfile =
      'COPY --chown=nightly:nightly --chmod=0644 ml/src/a.py ml/src/b.py ./ml/src/';

    expect(imageSources(dockerfile)).toEqual([
      'ml/src/a.py',
      'ml/src/b.py',
      ...WATCHED,
    ]);
  });

  it('skips a comment line in the middle of a continued COPY, and blank lines', () => {
    const dockerfile = [
      '# a comment before',
      'COPY scripts/a.py \\',
      '# a comment inside the instruction',
      '',
      '    scripts/b.py ./scripts/',
      '# a comment after',
    ].join('\n');

    expect(imageSources(dockerfile)).toEqual([
      'scripts/a.py',
      'scripts/b.py',
      ...WATCHED,
    ]);
  });

  it('reads CRLF line endings', () => {
    const dockerfile = 'COPY \\\r\n  scripts/a.py \\\r\n  ./scripts/\r\n';

    expect(imageSources(dockerfile)).toEqual(['scripts/a.py', ...WATCHED]);
  });

  it('takes a lower-case copy, strips a leading ./ and lists a source once', () => {
    const dockerfile = [
      'copy ./scripts/a.py ./scripts/',
      'COPY scripts/a.py ./again/',
    ].join('\n');

    expect(imageSources(dockerfile)).toEqual(['scripts/a.py', ...WATCHED]);
  });

  it('reads the JSON array form', () => {
    const dockerfile = 'COPY ["scripts/a.py", "scripts/b.py", "./scripts/"]';

    expect(imageSources(dockerfile)).toEqual([
      'scripts/a.py',
      'scripts/b.py',
      ...WATCHED,
    ]);
  });

  it('names the Dockerfile and .dockerignore even when no COPY does', () => {
    expect(imageSources('FROM scratch\nCMD ["true"]\n')).toEqual(WATCHED);
  });

  it('does not take a COPY that is only mentioned inside another instruction', () => {
    expect(imageSources('RUN echo COPY scripts/a.py ./x')).toEqual(WATCHED);
  });

  it.each([
    ['a glob', 'COPY scripts/*.py ./scripts/', 'scripts/*.py'],
    ['a build variable', 'COPY $SRC ./scripts/', '$SRC'],
    ['a heredoc', 'COPY <<EOF /app/file\nbody\nEOF', '<<EOF'],
    ['a JSON array that is not strings', 'COPY ["a", 2, "./x/"]', '["a", 2'],
  ])('refuses %s it cannot match, naming it', (_label, dockerfile, named) => {
    expect(() => imageSources(dockerfile)).toThrow(named);
  });

  it('parses the real nightly/Dockerfile: the files the image copies, not the rest of nightly/', () => {
    const sources = imageSources(REAL_DOCKERFILE);

    expect(sources).toEqual(
      expect.arrayContaining([
        'nightly/src/',
        'nightly/requirements.txt',
        'scripts/_cli_paths.py',
        'ml/src/lottery_scoring.py',
        'nightly/Dockerfile',
        '.dockerignore',
      ]),
    );
    expect(sources).not.toContain('nightly/README.md');
    expect(sources).not.toContain('nightly/tests/');
    expect(sources).not.toContain('nightly/');
    // The builder stage's /install and a destination are not sources.
    expect(sources).not.toContain('/install');
    expect(sources).not.toContain('./scripts/');
    // A continuation that leaked into a source would carry one of these.
    for (const source of sources) {
      expect(source).not.toMatch(/\s|\\|^--/);
    }
  });
});

describe('touchedImagePaths', () => {
  const SOURCES = ['nightly/src/', 'scripts/_cli_paths.py', '.dockerignore'];

  it.each([
    ['an exact file', ['scripts/_cli_paths.py'], ['scripts/_cli_paths.py']],
    [
      'a file under a directory source',
      ['nightly/src/a/b.py'],
      ['nightly/src/a/b.py'],
    ],
    ['the root .dockerignore', ['.dockerignore'], ['.dockerignore']],
    ['a file the image does not copy', ['api/x.ts', 'nightly/README.md'], []],
    ['a nightly/ path outside src/', ['nightly/tests/test_a.py'], []],
    ['a sibling that shares a name prefix', ['nightly/src-old/a.py'], []],
    [
      'a file that extends an exact source name',
      ['scripts/_cli_paths.pyc'],
      [],
    ],
    ['a nested .dockerignore', ['sub/.dockerignore'], []],
    ['nothing', [], []],
  ])('%s', (_label, changed, expected) => {
    expect(touchedImagePaths(changed, SOURCES)).toEqual(expected);
  });

  it('keeps the order of the changed list and only the matching paths', () => {
    expect(
      touchedImagePaths(
        ['z.txt', 'nightly/src/b.py', 'api/a.ts', 'nightly/src/a.py'],
        SOURCES,
      ),
    ).toEqual(['nightly/src/b.py', 'nightly/src/a.py']);
  });

  it('matches a directory source written without its trailing slash', () => {
    expect(touchedImagePaths(['nightly/src/a.py'], ['nightly/src'])).toEqual([
      'nightly/src/a.py',
    ]);
    expect(touchedImagePaths(['nightly/srcs/a.py'], ['nightly/src'])).toEqual(
      [],
    );
  });

  it('matches everything for a source that is the whole build context', () => {
    expect(touchedImagePaths(['api/x.ts'], ['.'])).toEqual(['api/x.ts']);
  });
});

/** The files a push may change, one commit: what the scratch repos start from. */
const BASE_FILES = {
  'nightly/Dockerfile': 'FROM scratch\n',
  'nightly/README.md': 'readme\n',
  'nightly/src/main.py': 'print("main")\n',
  'nightly/tests/test_main.py': 'def test_main(): ...\n',
  'scripts/_cli_paths.py': 'PATHS = ["cli"]\n',
  '.dockerignore': 'node_modules/\n',
  'api/handler.ts': 'export const handler = 1;\n',
};

let commitSeq = 0;

/**
 * The scratch repo's base: BASE_FILES in one commit on top of initRepo's.
 * Returns the repo and that commit.
 */
function seededRepo(prefix) {
  const repo = initRepo(makeTempDir(prefix));
  writeFiles(repo, BASE_FILES);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base files');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function writeFiles(repo, files) {
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(repo, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

/**
 * A commit on `parent` (detached) that writes `changes` (path -> body, or null
 * to delete the file) and moves each [from, to] pair; returns its SHA. Each
 * commit has its own message: fixture commits share one date, so two with the
 * same parent, tree and message would be one commit.
 */
function commitOn(repo, parent, changes, moves = []) {
  git(repo, 'checkout', '-q', '--detach', parent);
  for (const [file, body] of Object.entries(changes)) {
    if (body === null) rmSync(path.join(repo, file));
    else writeFiles(repo, { [file]: body });
  }
  for (const [from, to] of moves) {
    mkdirSync(path.dirname(path.join(repo, to)), { recursive: true });
    git(repo, 'mv', from, to);
  }
  git(repo, 'add', '-A');
  commitSeq += 1;
  git(repo, 'commit', '-q', '--allow-empty', '-m', `case ${commitSeq}`);
  return git(repo, 'rev-parse', 'HEAD');
}

/** One stdin line of git's pre-push hook. */
function pushLine(local, remote, ref = 'refs/heads/feature') {
  return `${ref} ${local} ${ref} ${remote}`;
}

describe('main', () => {
  let repo;
  let base;
  let lonelyRepo;
  let lonelyHead;

  beforeAll(() => {
    ({ repo, base } = seededRepo('npw-main-'));
    // What `git fetch` leaves: the remote-tracking ref a new branch is diffed
    // against. No remote is needed for that.
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    // A repo that never fetched: no origin/main at all.
    lonelyRepo = initRepo(makeTempDir('npw-lonely-'));
    lonelyHead = git(lonelyRepo, 'rev-parse', 'HEAD');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Run main on the given stdin lines the way the hook does, in the scratch
   * repo (GIT_DIR is how git itself points a hook at its repository). Returns
   * the exit code and everything main wrote to stderr.
   */
  async function runMain(
    lines,
    { now = INSIDE_WINDOW, env = {}, gitDir = path.join(repo, '.git') } = {},
  ) {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main({
      stdin: Readable.from([lines.map((line) => `${line}\n`).join('')]),
      env: cleanEnv({ GIT_DIR: gitDir, ...env }, [BYPASS]),
      now,
    });
    const output = errors.mock.calls.map((call) => call.join(' ')).join('\n');
    return { code, output };
  }

  describe('inside the window', () => {
    it.each([
      ['nightly/Dockerfile', { 'nightly/Dockerfile': 'FROM changed\n' }],
      ['.dockerignore', { '.dockerignore': 'changed\n' }],
      ['a new file under nightly/src/', { 'nightly/src/jobs/step.py': 'x\n' }],
      ['an exact file the image copies', { 'scripts/_cli_paths.py': 'new\n' }],
      ['the deletion of an image file', { 'scripts/_cli_paths.py': null }],
    ])('blocks a push that changes only %s', async (file, changes) => {
      const tip = commitOn(repo, base, changes);

      const { code, output } = await runMain([pushLine(tip, base)]);

      expect(code).toBe(1);
      expect(output).toContain(Object.keys(changes)[0]);
    });

    it.each([
      ['nightly/README.md', { 'nightly/README.md': 'edited\n' }],
      ['nightly/tests/', { 'nightly/tests/test_new.py': 'x\n' }],
      ['api/', { 'api/other.ts': 'x\n' }],
      ['nothing at all', {}],
    ])('allows a push that changes only %s', async (_label, changes) => {
      const tip = commitOn(repo, base, changes);

      const { code, output } = await runMain([pushLine(tip, base)]);

      expect(code).toBe(0);
      expect(output).toBe('');
    });

    it('allows a push with no ref lines', async () => {
      expect(await runMain([])).toEqual({ code: 0, output: '' });
    });

    it('diffs remote..local, the whole range and not only the last commit', async () => {
      const first = commitOn(repo, base, { 'nightly/src/main.py': 'edit\n' });
      const tip = commitOn(repo, first, { 'api/handler.ts': 'edit\n' });

      const { code, output } = await runMain([pushLine(tip, base)]);

      expect(code).toBe(1);
      expect(output).toContain('nightly/src/main.py');
    });

    it('does not count what the remote already has', async () => {
      const first = commitOn(repo, base, { 'nightly/src/main.py': 'edit\n' });
      const tip = commitOn(repo, first, { 'api/handler.ts': 'edit\n' });

      const { code, output } = await runMain([pushLine(tip, first)]);

      expect(code).toBe(0);
      expect(output).toBe('');
    });

    it('blocks the move of an image file out of its path, as a rename shows only the new name', async () => {
      const tip = commitOn(repo, base, {}, [
        ['scripts/_cli_paths.py', 'docs/moved_cli_paths.py'],
      ]);

      const { code, output } = await runMain([pushLine(tip, base)]);

      expect(code).toBe(1);
      expect(output).toContain('scripts/_cli_paths.py');
    });

    it('allows a branch deletion without looking at the remote sha', async () => {
      // The remote sha is not an object here: a diff would fail and block.
      const unknown = 'f'.repeat(40);

      expect(await runMain([pushLine(ZERO, unknown)])).toEqual({
        code: 0,
        output: '',
      });
    });

    it('diffs a new branch against origin/main, not against its parent', async () => {
      const first = commitOn(repo, base, { 'nightly/Dockerfile': 'edit\n' });
      const tip = commitOn(repo, first, { 'api/handler.ts': 'edit\n' });

      const { code, output } = await runMain([pushLine(tip, ZERO)]);

      expect(code).toBe(1);
      expect(output).toContain('nightly/Dockerfile');
    });

    it('allows a new branch that changes no image file', async () => {
      const tip = commitOn(repo, base, { 'api/new-branch.ts': 'x\n' });

      expect(await runMain([pushLine(tip, ZERO)])).toEqual({
        code: 0,
        output: '',
      });
    });

    it('does not count what origin/main gained after a new branch forked', async () => {
      const gained = commitOn(repo, base, { 'nightly/src/gained.py': 'x\n' });
      const tip = commitOn(repo, base, { 'api/side.ts': 'x\n' });
      git(repo, 'update-ref', 'refs/remotes/origin/main', gained);

      try {
        expect(await runMain([pushLine(tip, ZERO)])).toEqual({
          code: 0,
          output: '',
        });
      } finally {
        git(repo, 'update-ref', 'refs/remotes/origin/main', base);
      }
    });

    it('checks every pushed ref, and one clean ref does not hide a blocked one', async () => {
      const clean = commitOn(repo, base, { 'api/clean.ts': 'x\n' });
      const dirty = commitOn(repo, base, {
        'nightly/src/a.py': 'a\n',
        'nightly/src/b.py': 'b\n',
      });
      const alsoDirty = commitOn(repo, base, { 'nightly/src/a.py': 'a2\n' });

      const { code, output } = await runMain([
        pushLine(ZERO, base, 'refs/heads/gone'),
        pushLine(clean, base, 'refs/heads/clean'),
        pushLine(dirty, base, 'refs/heads/dirty'),
        pushLine(alsoDirty, base, 'refs/heads/also-dirty'),
      ]);

      expect(code).toBe(1);
      expect(output).toContain('nightly/src/b.py');
      // a.py is in two refs and listed once.
      expect(output.split('nightly/src/a.py')).toHaveLength(2);
      expect(output).not.toContain('api/clean.ts');
    });

    it('names the window end and the bypass, and prints no environment value', async () => {
      const tip = commitOn(repo, base, { 'nightly/Dockerfile': 'edit\n' });

      const { code, output } = await runMain([pushLine(tip, base)], {
        env: { SECRET_TOKEN: 'sekret-value-42' },
      });

      expect(code).toBe(1);
      expect(output).toContain('12:30 UTC');
      expect(output).toContain(`${BYPASS}=1`);
      expect(output).not.toContain('sekret-value-42');
    });

    it('names at most five paths and counts the rest', async () => {
      const changes = Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((n) => [`nightly/src/f${n}.py`, `${n}\n`]),
      );
      const tip = commitOn(repo, base, changes);

      const { code, output } = await runMain([pushLine(tip, base)]);

      expect(code).toBe(1);
      for (const n of [1, 2, 3, 4, 5]) {
        expect(output).toContain(`nightly/src/f${n}.py`);
      }
      expect(output).not.toContain('nightly/src/f6.py');
      expect(output).not.toContain('nightly/src/f7.py');
      expect(output).toContain('2 more');
    });
  });

  describe('when it cannot tell what a push changes', () => {
    it('blocks a remote sha the repo does not have, naming the sha and the bypass', async () => {
      const unknown = 'f'.repeat(40);
      const tip = commitOn(repo, base, { 'api/handler.ts': 'edit\n' });

      const { code, output } = await runMain([pushLine(tip, unknown)]);

      expect(code).toBe(1);
      expect(output).toContain('could not check');
      expect(output).toContain(unknown);
      expect(output).toContain(`${BYPASS}=1`);
    });

    it('blocks a new branch when there is no origin/main to diff against', async () => {
      const { code, output } = await runMain([pushLine(lonelyHead, ZERO)], {
        gitDir: path.join(lonelyRepo, '.git'),
      });

      expect(code).toBe(1);
      expect(output).toContain('could not check');
      expect(output).toContain('origin/main');
    });

    it.each([
      ['a line that is not a push line', 'not a push line'],
      ['a line with too few fields', `refs/heads/x ${'a'.repeat(40)}`],
      [
        'a sha that is not hex',
        'refs/heads/x --output=/x refs/heads/x ' + 'a'.repeat(40),
      ],
    ])('blocks %s', async (_label, line) => {
      const { code, output } = await runMain([line]);

      expect(code).toBe(1);
      expect(output).toContain('unexpected pre-push line');
    });

    it('lets the bypass through', async () => {
      const tip = commitOn(repo, base, { 'api/handler.ts': 'edit\n' });

      expect(
        await runMain([pushLine(tip, 'f'.repeat(40)), 'not a push line'], {
          env: { [BYPASS]: '1' },
        }),
      ).toEqual({ code: 0, output: '' });
    });
  });

  describe('outside the window, or with the bypass', () => {
    it.each(['2026-11-24T12:30:00Z', '2026-11-24T07:14:59Z'])(
      'allows an image push at %s without running git or reading the lines',
      async (at) => {
        const tip = commitOn(repo, base, { 'nightly/Dockerfile': 'edit\n' });

        // Lines that would each block inside the window, one of them junk.
        expect(
          await runMain(
            [pushLine(tip, base), pushLine(tip, 'f'.repeat(40)), 'junk'],
            { now: new Date(at) },
          ),
        ).toEqual({ code: 0, output: '' });
      },
    );

    it(`allows a blocked push when ${BYPASS}=1`, async () => {
      const tip = commitOn(repo, base, { 'nightly/Dockerfile': 'edit\n' });

      expect(
        await runMain([pushLine(tip, base)], { env: { [BYPASS]: '1' } }),
      ).toEqual({ code: 0, output: '' });
    });

    it.each(['0', 'true', 'yes', ''])(
      `still blocks when ${BYPASS} is %j: only 1 is the bypass`,
      async (value) => {
        const tip = commitOn(repo, base, { 'nightly/Dockerfile': 'edit\n' });

        const { code } = await runMain([pushLine(tip, base)], {
          env: { [BYPASS]: value },
        });

        expect(code).toBe(1);
      },
    );
  });
});

describe('.githooks/pre-push in this repo', () => {
  const HOOK = path.join(ROOT, '.githooks', 'pre-push');

  it('is a sh script that execs the entry with git stdin passed through', () => {
    const lines = readFileSync(HOOK, 'utf8').split('\n');

    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines).toContain(
      'exec node "$(dirname "$0")/../scripts/nightly-push-window.mjs"',
    );
  });

  it('is executable in the index, so git runs it on Linux and macOS', () => {
    // Windows ignores the mode (core.fileMode=false); CI's ubuntu checkout
    // skips a 100644 hook with only a hint, and the guard would never run.
    const entry = git(ROOT, 'ls-files', '--stage', '--', '.githooks/pre-push');

    expect(entry).toMatch(/^100755 [0-9a-f]+ 0\t\.githooks\/pre-push$/);
  });
});

describe('git push through the real hook', () => {
  /**
   * The hook's node process gets a fixed clock: a preload that makes
   * `new Date()` and Date.now() answer FIXED_NOW_MS. The only way to run the
   * unchanged entry inside or outside the window whatever the time of day.
   */
  const CLOCK_PRELOAD =
    'const t=Number(process.env.FIXED_NOW_MS);const D=Date;' +
    'globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[t]))}' +
    'static now(){return t}};';
  const NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(CLOCK_PRELOAD)}`;

  let work;
  let base;
  let branchSeq = 0;

  beforeAll(() => {
    ({ repo: work, base } = seededRepo('npw-work-'));
    const remoteParent = makeTempDir('npw-remote-');
    git(remoteParent, 'init', '--bare', '-q', '-b', 'main', 'remote.git');
    git(work, 'remote', 'add', 'origin', path.join(remoteParent, 'remote.git'));
    // No hooks yet (they are passed per push below), so this goes through,
    // and it leaves refs/remotes/origin/main for the pushes that follow.
    git(work, 'push', '-q', 'origin', 'main');
  });

  /** A new branch at a commit on base that writes `changes`; returns its name. */
  function newBranch(changes) {
    branchSeq += 1;
    const name = `case-${branchSeq}`;
    git(work, 'branch', '-f', name, commitOn(work, base, changes));
    return name;
  }

  /** `git push origin <branch>` through .githooks, at the clock's time. */
  function hookedPush(branch, { at = INSIDE_WINDOW, env = {} } = {}) {
    return spawnChild(
      'git',
      ['-c', `core.hooksPath=${HOOKS_DIR}`, 'push', 'origin', branch],
      {
        cwd: work,
        env: cleanEnv(
          { NODE_OPTIONS, FIXED_NOW_MS: String(at.getTime()), ...env },
          [BYPASS],
        ),
        encoding: 'utf8',
        timeout: SLOW_CHILD_TIMEOUT,
        windowsHide: true,
      },
    );
  }

  function remoteTip(branch) {
    return git(work, 'ls-remote', '--heads', 'origin', branch);
  }

  it('stops a new branch that changes an image file, and the branch never arrives', () => {
    const branch = newBranch({ 'nightly/src/new_step.py': 'x\n' });

    const result = hookedPush(branch);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nightly/src/new_step.py');
    expect(result.stderr).toContain(`${BYPASS}=1`);
    expect(remoteTip(branch)).toBe('');
  });

  it('lets the same push through with the bypass', () => {
    const branch = newBranch({ 'nightly/src/new_step.py': 'x\n' });

    const result = hookedPush(branch, { env: { [BYPASS]: '1' } });

    expect(result.status).toBe(0);
    expect(remoteTip(branch)).toContain(`refs/heads/${branch}`);
  });

  it('lets the same push through outside the window', () => {
    const branch = newBranch({ 'nightly/src/new_step.py': 'x\n' });

    const result = hookedPush(branch, {
      at: new Date('2026-11-24T13:00:00Z'),
    });

    expect(result.status).toBe(0);
    expect(remoteTip(branch)).toContain(`refs/heads/${branch}`);
  });

  it('lets a push that changes no image file through inside the window', () => {
    const branch = newBranch({ 'api/other.ts': 'x\n' });

    const result = hookedPush(branch);

    expect(result.status).toBe(0);
    expect(remoteTip(branch)).toContain(`refs/heads/${branch}`);
  });

  it('stops an update of a branch already on the remote (remote..local)', () => {
    const branch = newBranch({ 'api/first.ts': 'x\n' });
    expect(hookedPush(branch).status).toBe(0);
    const pushed = remoteTip(branch);
    git(
      work,
      'branch',
      '-f',
      branch,
      commitOn(work, branch, {
        'scripts/_cli_paths.py': 'changed\n',
      }),
    );

    const result = hookedPush(branch);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/_cli_paths.py');
    expect(remoteTip(branch)).toBe(pushed);
  });
});
