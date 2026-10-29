// @vitest-environment node

/**
 * Tests for the commit gate: scripts/_lib/review-gate.mjs, its CLI
 * scripts/review-gate.mjs, and .githooks/pre-commit. decideCommit gets a
 * table test. Everything else runs real git against throwaway repos under
 * the OS temp dir, with the repo's real hook wired in through an absolute
 * core.hooksPath, so a commit here goes through the same sh -> node -> git
 * path a Claude commit does. Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { decideCommit } from './review-gate.mjs';

// vitest runs from the repo root (same convention as check-coverage-floor).
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'scripts', 'review-gate.mjs');
// Forward slashes: the hook finds the CLI with `dirname "$0"`, and sh's
// dirname splits on `/` only.
const HOOKS_DIR = path.join(ROOT, '.githooks').replaceAll('\\', '/');
const MARKER = 'review-gate.json';
// Each hook commit spawns sh, node and several git processes: slow on
// Windows, slower under a loaded `npm run review`. The timeout only catches
// a hang, and these git calls can't hang; they only slow down. With several
// sessions sharing 16 cores at 88-100% CPU, git fixtures ran past 120s
// (2026-10-28), so the limit is 300s, as in the prune-worktrees tests.
const GIT_TIMEOUT = 300_000;
// Every hook commit and fixture here spawns git, so the whole file gets the
// limit, including it.each variants. Same mechanism as the prune-worktrees tests.
vi.setConfig({ testTimeout: GIT_TIMEOUT, hookTimeout: GIT_TIMEOUT });

const NO_MARKER = 'No passing `npm run review` is on record for this worktree';
const SEAL_REFUSED =
  'review-gate seal failed: only `npm run review` may seal the review marker';
const CHECK_FAILED = 'review-gate: commit blocked, the check failed:';
const DRIFTED =
  'review-gate: commit blocked. These staged files changed after the last passing `npm run review`:';

/** Gate inputs each test sets explicitly instead of inheriting (upper-cased). */
const DROPPED_ENV = new Set(['CLAUDECODE', 'NPM_LIFECYCLE_EVENT']);

/** Every temp dir made through makeTempDir; removed in afterAll. */
const tempDirs = [];
let gitconfig = '';

/**
 * Long-form real path: git reports long paths, and os.tmpdir() can be an 8.3
 * short name on Windows.
 */
function makeTempDir(prefix) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  gitconfig = path.join(makeTempDir('review-gate-config-'), 'gitconfig');
  writeFileSync(gitconfig, '');
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

/**
 * Child env with every gate input set explicitly. Inherited GIT_* vars are
 * dropped (a hook running these tests exports GIT_DIR / GIT_INDEX_FILE,
 * which would aim git at the real repository), and so are CLAUDECODE (set in
 * Claude Code's shells) and npm_lifecycle_event (set to "review" when
 * `npm run review` runs these tests). System and global git config are
 * replaced by an empty file. An `extra` value of undefined unsets the var.
 *
 * Names are matched upper-cased: Windows env names are case-insensitive, and
 * a vitest worker there sees them upper-cased (NPM_LIFECYCLE_EVENT=npx). Kept,
 * that copy would shadow a lower-case npm_lifecycle_event set in `extra`.
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name.startsWith('GIT_') || DROPPED_ENV.has(name)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    ...extra,
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

/**
 * Run a command; returns `{ status, stdout, stderr }` whatever its exit code.
 * Throws only when it can't be spawned.
 */
function run(cwd, command, args, extraEnv = {}) {
  // Test-only: `git` from PATH, as the module under test and the hook use.
  const result = spawnSync(command, args, {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

/** Run git for test setup; stdout (trimmed) on success, throws otherwise. */
function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** The gate CLI, as `npm run review` or the hook would run it. */
function gate(cwd, command, extraEnv = {}) {
  return run(cwd, process.execPath, [CLI, command], extraEnv);
}

/** Seal the way `npm run review` does; fails the test if sealing fails. */
function review(cwd) {
  const result = gate(cwd, 'seal', { npm_lifecycle_event: 'review' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

/** `git commit` from a Claude Code shell (CLAUDECODE=1), through the hook. */
function claudeCommit(cwd, ...args) {
  return run(cwd, 'git', ['commit', '-q', '-m', 'claude', ...args], {
    CLAUDECODE: '1',
  });
}

function write(cwd, file, body) {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function headSubject(cwd) {
  return git(cwd, 'log', '-1', '--format=%s');
}

/** This worktree's own admin dir (.git, or .git/worktrees/<name>). */
function adminDir(cwd) {
  return git(cwd, 'rev-parse', '--absolute-git-dir');
}

function markerFile(cwd) {
  return path.join(adminDir(cwd), MARKER);
}

/**
 * A repo at <base>/repo using the real hook, with a.txt and b.txt committed
 * and ignored.txt gitignored.
 */
function initRepo(base) {
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.hooksPath', HOOKS_DIR);
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b.txt', 'b\n');
  write(repo, '.gitignore', 'ignored.txt\n');
  git(repo, 'add', '-A');
  // No CLAUDECODE in setup git calls, so the hook lets this through.
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

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
