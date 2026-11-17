// @vitest-environment node

/**
 * Tests for the ledger step of scripts/_lib/prune-worktrees.mjs: a worktree's
 * gitignored `.superpowers/` folder is copied to
 * <repo>/docs/tmp/worktree-ledgers/<name>/ before `git worktree remove` would
 * delete it. Every case runs real git against a throwaway repo (fixtures in
 * prune-worktrees.fixtures.mjs). The cases that need the filesystem or git to
 * fail or change at one exact moment wrap four node:fs calls (copyFileSync,
 * readdirSync, renameSync, unlinkSync) and spawnSync; every other call runs
 * for real.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  FIXTURE_TIMEOUT,
  addWorktree,
  adminDir,
  age,
  branches,
  commitFile,
  git,
  initRepo,
  makeTempDir,
  setupScratchGit,
  writeFiles,
} from './prune-worktrees.fixtures.mjs';
import {
  checkSettled,
  formatResult,
  formatSummary,
  pruneWorktrees,
} from './prune-worktrees.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const real = await vi.importActual('node:fs');
const { spawnSync: realSpawnSync } =
  await vi.importActual('node:child_process');

setupScratchGit();

/** A ledger with a nested folder, CRLF text and every byte value. */
const LEDGER = Object.freeze({
  'brief.md': 'goal: copy the ledger out\n',
  'reviews/round-1.md': 'verdict: continue\r\nCRLF stays\r\n',
  'data.bin': Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
});
const LEDGER_FILES = Object.keys(LEDGER).length;

/** Where the main checkout keeps the copies. */
function ledgersDir(repo) {
  return path.join(repo, 'docs', 'tmp', 'worktree-ledgers');
}

/** { 'sub/name': Buffer } for every file under `dir`. */
function readTree(dir) {
  const tree = {};
  for (const rel of readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, rel);
    if (statSync(file).isFile()) {
      tree[rel.split(path.sep).join('/')] = readFileSync(file);
    }
  }
  return tree;
}

/** `files` as readTree returns them. */
function asTree(files) {
  return Object.fromEntries(
    Object.entries(files).map(([rel, body]) => [rel, Buffer.from(body)]),
  );
}

/** A worktree whose admin dir and ledger files are all old. */
function addLedgerWorktree(repo, name, files = LEDGER, ledgerHours = 48) {
  const wt = addWorktree(repo, `.worktrees/${name}`, `fix/${name}`);
  writeFiles(path.join(wt, '.superpowers'), files, ledgerHours);
  age(wt);
  return wt;
}

function byName(outcome) {
  return new Map(outcome.results.map((result) => [result.name, result]));
}

/** A directory link: a junction on Windows, which needs no privilege. */
function linkDir(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('formatResult with a ledger', () => {
  const base = {
    name: 'a',
    path: '/repo/.worktrees/a',
    branch: 'fix/a',
    head: 'f00d',
  };

  it.each([
    [
      'copied',
      { dest: '/d/a', files: 3, state: 'copied' },
      '3 files copied to /d/a',
    ],
    [
      'copied, one file',
      { dest: '/d/a', files: 1, state: 'copied' },
      '1 file copied to /d/a',
    ],
    [
      'already there',
      { dest: '/d/a', files: 3, state: 'identical' },
      'identical copy of 3 files already at /d/a',
    ],
    [
      'planned',
      { dest: '/d/a', files: 3, state: 'would-copy' },
      'would copy 3 files to /d/a',
    ],
  ])('names where the ledger went when it is %s', (_label, ledger, note) => {
    const removed = {
      ...base,
      action: 'removed',
      reason: 'merged',
      deletedBranchSha: 'f00d',
      ledger,
    };
    expect(formatResult(removed)).toBe(
      `removed a (branch fix/a deleted, was f00d; ledger: ${note})`,
    );
    expect(formatResult({ ...removed, deletedBranchSha: undefined })).toBe(
      `removed a (merged; ledger: ${note})`,
    );
    expect(formatResult({ ...removed, action: 'would-remove' })).toBe(
      `would remove a (merged; ledger: ${note})`,
    );
    expect(formatResult({ ...removed, action: 'kept', reason: 'locked' })).toBe(
      `kept a: locked; ledger: ${note}`,
    );
  });

  it('prints a result without a ledger as it always did', () => {
    expect(
      formatResult({
        ...base,
        action: 'removed',
        reason: 'merged',
        deletedBranchSha: 'f00d',
      }),
    ).toBe('removed a (branch fix/a deleted, was f00d)');
  });

  it('counts ledger errors apart from git errors in the summary', () => {
    const summary = (errors, ledgerErrors) =>
      formatSummary({
        dryRun: false,
        results: [{ action: 'kept' }],
        errors,
        ledgerErrors,
      });
    expect(summary(['a', 'b', 'c'], 1)).toBe(
      'worktrees prune: removed 0, kept 1, 2 git errors, 1 ledger error',
    );
    expect(summary(['a', 'b'], 2)).toBe(
      'worktrees prune: removed 0, kept 1, 2 ledger errors',
    );
    // A caller with no ledger errors to report passes none.
    expect(summary(['a'], undefined)).toBe(
      'worktrees prune: removed 0, kept 1, 1 git error',
    );
  });
});

describe('pruneWorktrees copies the ledger out', () => {
  let repo = '';
  let outcome;
  let results;
  let outsideTarget = '';
  const wts = {};

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-ledger-'));

    wts.copied = addLedgerWorktree(repo, 'copied');

    // A folder with a file that a link must never lead a copy to.
    outsideTarget = makeTempDir('prune-ledger-target-');
    writeFileSync(path.join(outsideTarget, 'secret.txt'), 'outside\n');

    // A link inside the ledger.
    wts.linked = addLedgerWorktree(repo, 'linked');
    linkDir(outsideTarget, path.join(wts.linked, '.superpowers', 'shared'));

    // A nested worktree name must not put its copy inside another's.
    wts.nested = addLedgerWorktree(repo, 'group/feat');

    // A ledger file written an hour ago: the git clocks say idle, the ledger
    // says someone is still at work.
    wts.recent = addLedgerWorktree(repo, 'recent', {
      'old.md': 'old\n',
      'late.md': 'late\n',
    });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(
      path.join(wts.recent, '.superpowers', 'late.md'),
      hourAgo,
      hourAgo,
    );

    wts.none = addWorktree(repo, '.worktrees/none', 'fix/none');
    age(wts.none);

    // A ledger folder with no file in it has nothing to lose.
    wts.hollow = addWorktree(repo, '.worktrees/hollow', 'fix/hollow');
    mkdirSync(path.join(wts.hollow, '.superpowers', 'empty', 'deeper'), {
      recursive: true,
    });
    age(wts.hollow);

    outcome = pruneWorktrees({ repoRoot: repo });
    results = byName(outcome);
  }, FIXTURE_TIMEOUT);

  it('copies the files byte for byte, removes the worktree and says where the ledger went', () => {
    const dest = path.join(ledgersDir(repo), 'copied');
    expect(outcome.errors).toEqual([]);
    expect(results.get('copied')).toMatchObject({
      action: 'removed',
      deletedBranchSha: expect.any(String),
      ledger: { dest, files: LEDGER_FILES, state: 'copied' },
    });
    expect(readTree(dest)).toEqual(asTree(LEDGER));
    expect(existsSync(wts.copied)).toBe(false);
    expect(branches(repo)).not.toContain('fix/copied');
    expect(formatResult(results.get('copied'))).toBe(
      `removed copied (branch fix/copied deleted, was ${results.get('copied').deletedBranchSha}; ledger: 3 files copied to ${dest})`,
    );
  });

  it('gives each copied file the mtime of the file it came from', () => {
    const dest = path.join(ledgersDir(repo), 'copied');
    const wanted = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000) * 1000;
    for (const rel of Object.keys(LEDGER)) {
      // Whole minutes of slack: the fixture takes that long on a loaded box.
      expect(
        Math.abs(statSync(path.join(dest, rel)).mtimeMs - wanted),
        rel,
      ).toBeLessThan(10 * 60 * 1000);
    }
  });

  it('leaves no temporary folder beside the copies', () => {
    expect(
      readdirSync(ledgersDir(repo)).filter((name) => name.startsWith('.')),
    ).toEqual([]);
  });

  it('flattens a nested worktree name to one folder', () => {
    const dest = path.join(ledgersDir(repo), 'group__feat');
    expect(results.get('group/feat')).toMatchObject({
      action: 'removed',
      ledger: { dest, files: LEDGER_FILES, state: 'copied' },
    });
    expect(readTree(dest)).toEqual(asTree(LEDGER));
    expect(existsSync(path.join(ledgersDir(repo), 'group'))).toBe(false);
  });

  it('keeps a worktree whose ledger holds a link, never following it', () => {
    expect(results.get('linked')).toMatchObject({
      action: 'kept',
      reason: 'ledger holds a link or special file: .superpowers/shared',
    });
    expect(results.get('linked').ledger).toBeUndefined();
    // Nothing of it was copied, not the link and not what it points at.
    expect(existsSync(path.join(ledgersDir(repo), 'linked'))).toBe(false);
    expect(readdirSync(ledgersDir(repo)).join('|')).not.toContain('linked');
    expect(existsSync(wts.linked)).toBe(true);
    expect(readFileSync(path.join(outsideTarget, 'secret.txt'), 'utf8')).toBe(
      'outside\n',
    );
    // Keeping it for a link is a decision, not a failure.
    expect(outcome.errors).toEqual([]);
  });

  it('keeps a worktree whose newest ledger file is recent, though its git clocks are old', () => {
    expect(results.get('recent')).toMatchObject({
      action: 'kept',
      reason: expect.stringMatching(/^idle 1\.\dh, under the 24h minimum$/),
    });
    expect(existsSync(wts.recent)).toBe(true);
    expect(existsSync(path.join(ledgersDir(repo), 'recent'))).toBe(false);
  });

  it('prints a worktree with no ledger exactly as it always did', () => {
    const none = results.get('none');
    expect(none.ledger).toBeUndefined();
    expect(none).toMatchObject({ action: 'removed' });
    expect(formatResult(none)).toBe(
      `removed none (branch fix/none deleted, was ${none.deletedBranchSha})`,
    );
    expect(existsSync(path.join(ledgersDir(repo), 'none'))).toBe(false);
    expect(existsSync(wts.none)).toBe(false);
  });

  it('treats a ledger folder holding no file as no ledger', () => {
    const hollow = results.get('hollow');
    expect(hollow.ledger).toBeUndefined();
    expect(hollow.action).toBe('removed');
    expect(existsSync(path.join(ledgersDir(repo), 'hollow'))).toBe(false);
  });
});

// Its own fixture, so that each hook stays well inside its timeout when the
// machine is loaded: every worktree here costs a few dozen git calls.
describe('pruneWorktrees never overwrites a copy', () => {
  let repo = '';
  let results;
  let outsideTarget = '';
  let mirror = '';
  const wts = {};
  const placed = {};
  const mtimesBefore = {};

  /** mtimes of every file under a copy, by relative path. */
  function mtimes(dir) {
    return Object.fromEntries(
      Object.keys(readTree(dir)).map((rel) => [
        rel,
        statSync(path.join(dir, rel)).mtimeMs,
      ]),
    );
  }

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-ledger-keep-'));
    const copies = ledgersDir(repo);

    // The hand copies the controller made: the ledger as it is.
    wts.identical = addLedgerWorktree(repo, 'identical');
    writeFiles(path.join(copies, 'identical'), LEDGER, 120);
    mtimesBefore.identical = mtimes(path.join(copies, 'identical'));

    // A copy that is not the same: one file differs, one is extra, one is gone.
    for (const [name, files] of Object.entries({
      bytes: { ...LEDGER, 'brief.md': 'goal: something else\n' },
      extra: { ...LEDGER, 'stray.md': 'not in the ledger\n' },
      missing: { 'brief.md': LEDGER['brief.md'] },
    })) {
      wts[name] = addLedgerWorktree(repo, name);
      writeFiles(path.join(copies, name), files, 120);
      placed[name] = readTree(path.join(copies, name));
    }

    // A copy with every file and a link besides is not the same copy.
    outsideTarget = makeTempDir('prune-ledger-target-');
    writeFileSync(path.join(outsideTarget, 'secret.txt'), 'outside\n');
    wts.linkin = addLedgerWorktree(repo, 'linkin');
    writeFiles(path.join(copies, 'linkin'), LEDGER, 120);
    linkDir(outsideTarget, path.join(copies, 'linkin', 'shared'));

    // The plain name taken by a file, and by a link to a folder that holds
    // exactly the ledger: neither is a copy, and a link is not read through.
    wts.asfile = addLedgerWorktree(repo, 'asfile');
    writeFileSync(path.join(copies, 'asfile'), 'a file, not a folder\n');
    wts.aslink = addLedgerWorktree(repo, 'aslink');
    mirror = makeTempDir('prune-ledger-mirror-');
    writeFiles(mirror, LEDGER, 120);
    linkDir(mirror, path.join(copies, 'aslink'));

    // A link at the plain name whose target is gone: still taken.
    wts.dangling = addLedgerWorktree(repo, 'dangling');
    linkDir(path.join(mirror, 'no such folder'), path.join(copies, 'dangling'));

    results = byName(pruneWorktrees({ repoRoot: repo }));
  }, FIXTURE_TIMEOUT);

  it('skips the copy when an identical one is already there, and removes the worktree', () => {
    const dest = path.join(ledgersDir(repo), 'identical');
    expect(results.get('identical')).toMatchObject({
      action: 'removed',
      ledger: { dest, files: LEDGER_FILES, state: 'identical' },
    });
    expect(existsSync(wts.identical)).toBe(false);
    // Untouched: same bytes, same mtimes, nothing added beside it.
    expect(readTree(dest)).toEqual(asTree(LEDGER));
    expect(mtimes(dest)).toEqual(mtimesBefore.identical);
    expect(
      readdirSync(ledgersDir(repo)).filter((name) =>
        name.startsWith('identical'),
      ),
    ).toEqual(['identical']);
    expect(formatResult(results.get('identical'))).toContain(
      `; ledger: identical copy of 3 files already at ${dest})`,
    );
  });

  it.each(['bytes', 'extra', 'missing'])(
    'copies to a timestamped folder when a different copy is there (%s), leaving it alone',
    (name) => {
      const original = path.join(ledgersDir(repo), name);
      const { ledger, action } = results.get(name);
      expect(action).toBe('removed');
      expect(ledger).toMatchObject({ files: LEDGER_FILES, state: 'copied' });
      expect(path.dirname(ledger.dest)).toBe(ledgersDir(repo));
      expect(path.basename(ledger.dest)).toMatch(
        new RegExp(`^${name}-\\d{8}T\\d{6}Z$`),
      );
      expect(readTree(ledger.dest)).toEqual(asTree(LEDGER));
      // The folder that was there is exactly as it was.
      expect(readTree(original)).toEqual(placed[name]);
      expect(existsSync(wts[name])).toBe(false);
    },
  );

  it('does not take a copy with a link in it for the same copy', () => {
    const { ledger } = results.get('linkin');
    expect(ledger.state).toBe('copied');
    expect(path.basename(ledger.dest)).toMatch(/^linkin-\d{8}T\d{6}Z$/);
    expect(readTree(ledger.dest)).toEqual(asTree(LEDGER));
    const link = path.join(ledgersDir(repo), 'linkin', 'shared');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outsideTarget, 'secret.txt'), 'utf8')).toBe(
      'outside\n',
    );
  });

  it('takes neither a file nor a link at the plain name for a copy, and leaves both alone', () => {
    const copies = ledgersDir(repo);
    for (const name of ['asfile', 'aslink', 'dangling']) {
      const { action, ledger } = results.get(name);
      expect(action, name).toBe('removed');
      expect(ledger.state, name).toBe('copied');
      expect(path.basename(ledger.dest), name).toMatch(
        new RegExp(`^${name}-\\d{8}T\\d{6}Z$`),
      );
      expect(readTree(ledger.dest), name).toEqual(asTree(LEDGER));
    }
    expect(readFileSync(path.join(copies, 'asfile'), 'utf8')).toBe(
      'a file, not a folder\n',
    );
    expect(lstatSync(path.join(copies, 'aslink')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(copies, 'dangling')).isSymbolicLink()).toBe(
      true,
    );
    // What the link points at was not added to.
    expect(readTree(mirror)).toEqual(asTree(LEDGER));
  });
});

describe('checkSettled and the ledger', () => {
  let repo = '';
  const wts = {};

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-ledger-settled-'));
    wts.old = addLedgerWorktree(repo, 'old');
    wts.fresh = addLedgerWorktree(repo, 'fresh', LEDGER, 0);
    wts.one = addLedgerWorktree(repo, 'one', {
      'a.md': 'a\n',
      'sub/b.md': 'b\n',
    });
    const when = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(path.join(wts.one, '.superpowers', 'sub', 'b.md'), when, when);

    // A link to a folder holding a file written just now: reading the ledger
    // must not look through it.
    const target = makeTempDir('prune-ledger-settled-target-');
    writeFileSync(path.join(target, 'fresh.txt'), 'now\n');
    wts.linked = addLedgerWorktree(repo, 'linked');
    linkDir(target, path.join(wts.linked, '.superpowers', 'shared'));

    // The whole ledger folder is a link: git status would see an untracked
    // file, so these are asked with the status known clean.
    wts.toplink = addWorktree(repo, '.worktrees/toplink', 'fix/toplink');
    linkDir(target, path.join(wts.toplink, '.superpowers'));
    age(wts.toplink);

    wts.manylinks = addLedgerWorktree(repo, 'manylinks');
    for (const name of ['l1', 'l2', 'l3', 'l4']) {
      linkDir(target, path.join(wts.manylinks, '.superpowers', name));
    }

    // A link in a ledger written just now: idle comes first.
    wts.freshlinked = addLedgerWorktree(repo, 'freshlinked', LEDGER, 0);
    linkDir(target, path.join(wts.freshlinked, '.superpowers', 'shared'));
  }, FIXTURE_TIMEOUT);

  it('passes a worktree whose ledger is as old as its git clocks', () => {
    expect(checkSettled(wts.old).keep).toBeNull();
  });

  it('holds a worktree whose ledger was written just now as idle', () => {
    expect(checkSettled(wts.fresh)).toMatchObject({
      keep: expect.stringMatching(/^idle 0\.\dh, under the 24h minimum$/),
      kind: 'idle',
    });
  });

  it('goes by the newest ledger file, in a subfolder too', () => {
    const verdict = checkSettled(wts.one);
    expect(verdict.kind).toBe('idle');
    expect(verdict.idle).toBeGreaterThanOrEqual(3);
    expect(verdict.idle).toBeLessThan(4);
  });

  it('holds a worktree whose ledger holds a link, and never reads through it', () => {
    // Read through the link, the file written just now would make it idle.
    expect(checkSettled(wts.linked)).toEqual({
      keep: 'ledger holds a link or special file: .superpowers/shared',
      kind: 'ledger-link',
    });
  });

  it('holds a worktree whose ledger folder is itself a link', () => {
    expect(checkSettled(wts.toplink, { statusKnownClean: true })).toEqual({
      keep: 'ledger holds a link or special file: .superpowers',
      kind: 'ledger-link',
    });
  });

  it('names the first few links and counts the rest', () => {
    expect(checkSettled(wts.manylinks, { statusKnownClean: true })).toEqual({
      keep: 'ledger holds a link or special file: .superpowers/l1, .superpowers/l2, .superpowers/l3 and 1 more',
      kind: 'ledger-link',
    });
  });

  it('asks about the idle clock before the links', () => {
    expect(checkSettled(wts.freshlinked).kind).toBe('idle');
  });
});

describe('pruneWorktrees dry run with a ledger', () => {
  let repo = '';
  let outcome;
  let results;
  let before;
  const wts = {};

  /** Every path under docs/ with its mtime: what a dry run must not change. */
  function docsSnapshot() {
    const docs = path.join(repo, 'docs');
    if (!existsSync(docs)) return null;
    return readdirSync(docs, { recursive: true })
      .map((rel) => [rel, statSync(path.join(docs, rel)).mtimeMs])
      .sort(([a], [b]) => a.localeCompare(b));
  }

  beforeAll(() => {
    repo = initRepo(makeTempDir('prune-ledger-dry-'));
    wts.fresh = addLedgerWorktree(repo, 'fresh');
    wts.same = addLedgerWorktree(repo, 'same');
    writeFiles(path.join(ledgersDir(repo), 'same'), LEDGER, 120);
    wts.diff = addLedgerWorktree(repo, 'diff');
    writeFiles(path.join(ledgersDir(repo), 'diff'), { 'brief.md': 'x\n' }, 120);
    wts.linked = addLedgerWorktree(repo, 'linked');
    const target = makeTempDir('prune-ledger-dry-target-');
    linkDir(target, path.join(wts.linked, '.superpowers', 'shared'));
    wts.none = addWorktree(repo, '.worktrees/none', 'fix/none');
    age(wts.none);

    before = docsSnapshot();
    outcome = pruneWorktrees({ repoRoot: repo, dryRun: true });
    results = byName(outcome);
  }, FIXTURE_TIMEOUT);

  it('says what it would copy and where, and what is already there', () => {
    const copies = ledgersDir(repo);
    expect(outcome.errors).toEqual([]);
    expect(results.get('fresh')).toMatchObject({
      action: 'would-remove',
      ledger: {
        dest: path.join(copies, 'fresh'),
        files: LEDGER_FILES,
        state: 'would-copy',
      },
    });
    expect(formatResult(results.get('fresh'))).toContain(
      `; ledger: would copy 3 files to ${path.join(copies, 'fresh')})`,
    );
    expect(results.get('same')).toMatchObject({
      action: 'would-remove',
      ledger: {
        dest: path.join(copies, 'same'),
        files: LEDGER_FILES,
        state: 'identical',
      },
    });
    const diff = results.get('diff').ledger;
    expect(diff.state).toBe('would-copy');
    expect(path.basename(diff.dest)).toMatch(/^diff-\d{8}T\d{6}Z$/);
  });

  it('keeps a worktree with a link in its ledger, as a real run would', () => {
    expect(results.get('linked')).toMatchObject({
      action: 'kept',
      reason: 'ledger holds a link or special file: .superpowers/shared',
    });
  });

  it('prints a worktree with no ledger as it always did', () => {
    const none = results.get('none');
    expect(none.ledger).toBeUndefined();
    expect(formatResult(none)).toMatch(
      /^would remove none \(merged, clean, idle 48\.0h; would delete branch fix\/none at \w+\)$/,
    );
  });

  it('writes nothing: no copy, no temporary folder, no folder at all', () => {
    expect(docsSnapshot()).toEqual(before);
    for (const wt of Object.values(wts)) expect(existsSync(wt)).toBe(true);
  });
});

describe('pruneWorktrees when the ledger step fails', () => {
  let repo = '';
  let wt = '';
  let ledgerFile = '';

  /** Run on the one worktree, `x`. */
  function prune() {
    const outcome = pruneWorktrees({ repoRoot: repo });
    return { ...outcome, result: outcome.results.find((r) => r.name === 'x') };
  }

  /** The copies folder's entries (it exists once a copy was started). */
  function entries() {
    return readdirSync(ledgersDir(repo));
  }

  beforeEach(() => {
    repo = initRepo(makeTempDir('prune-ledger-fail-'));
    wt = addLedgerWorktree(repo, 'x');
    ledgerFile = path.join(wt, '.superpowers', 'brief.md');
  }, FIXTURE_TIMEOUT);

  afterEach(() => {
    vi.mocked(copyFileSync).mockReset();
    vi.mocked(readdirSync).mockReset();
    vi.mocked(renameSync).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(unlinkSync).mockReset();
  });

  /**
   * Hand the real result of each git call whose args satisfy `match` to
   * `handle`, and return what it returns. Every other call is untouched.
   */
  function onGit(match, handle) {
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const result = realSpawnSync(command, args, options);
      return match(args) ? handle(result) : result;
    });
  }

  /** The `git rev-parse HEAD` that reads a worktree's HEAD. */
  function readsHead(args) {
    return args.at(-2) === 'rev-parse' && args.at(-1) === 'HEAD';
  }

  /** Make readdirSync fail on `target`, as a permission error would. */
  function failReaddirOf(target, when = () => true) {
    vi.mocked(readdirSync).mockImplementation((dir, options) => {
      if (dir === target && when()) {
        throw Object.assign(new Error('EACCES: permission denied, scandir'), {
          code: 'EACCES',
        });
      }
      return real.readdirSync(dir, options);
    });
  }

  /** Fail the copy of one file, as a permission error would. */
  function failCopyOf(name) {
    vi.mocked(copyFileSync).mockImplementation((from, to, flags) => {
      if (path.basename(from) === name) {
        throw Object.assign(new Error(`EACCES: permission denied, ${name}`), {
          code: 'EACCES',
        });
      }
      return real.copyFileSync(from, to, flags);
    });
  }

  it('keeps the worktree, records the error and leaves no folder when a copy fails', () => {
    failCopyOf('data.bin');

    const { result, errors } = prune();

    expect(result).toMatchObject({
      action: 'kept',
      reason: 'ledger copy failed: EACCES: permission denied, data.bin',
    });
    expect(errors).toEqual([
      'x: ledger copy failed: EACCES: permission denied, data.bin',
    ]);
    expect(existsSync(wt)).toBe(true);
    expect(readTree(path.join(wt, '.superpowers'))).toEqual(asTree(LEDGER));
    expect(branches(repo)).toContain('fix/x');
    // Neither a final-name folder nor the half copy it was built in.
    expect(entries()).toEqual([]);
  });

  it('names a half copy it could not delete', () => {
    failCopyOf('data.bin');
    vi.mocked(unlinkSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      });
    });

    const { result, errors } = prune();

    const [left] = entries();
    expect(entries()).toHaveLength(1);
    expect(left).toMatch(/^\.x\.copying-/);
    const leftover = path.join(ledgersDir(repo), left);
    expect(result.action).toBe('kept');
    expect(result.reason).toContain('ledger copy failed: EACCES');
    expect(result.reason).toContain(`partial copy left at ${leftover}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(leftover);
    expect(existsSync(path.join(ledgersDir(repo), 'x'))).toBe(false);
  });

  it('keeps the worktree when the copy does not match the ledger', () => {
    vi.mocked(copyFileSync).mockImplementation((from, to, flags) => {
      real.copyFileSync(from, to, flags);
      if (path.basename(from) === 'data.bin') writeFileSync(to, 'cut short');
    });

    const { result, errors } = prune();

    expect(result).toMatchObject({
      action: 'kept',
      reason:
        'ledger copy failed: the copy does not match the ledger: bytes differ in data.bin',
    });
    expect(errors).toHaveLength(1);
    expect(existsSync(wt)).toBe(true);
    expect(entries()).toEqual([]);
  });

  it('keeps the worktree when the finished copy cannot be moved into place', () => {
    vi.mocked(renameSync).mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), {
        code: 'EBUSY',
      });
    });

    const { result, errors } = prune();

    expect(result).toMatchObject({
      action: 'kept',
      reason: 'ledger copy failed: EBUSY: resource busy or locked',
    });
    expect(errors).toHaveLength(1);
    expect(existsSync(wt)).toBe(true);
    expect(entries()).toEqual([]);
  });

  // copyFileSync keeps the mtime on Windows and not on Linux or macOS, so the
  // test makes it the Linux way: every copy is stamped with the current time.
  it('gives each copied file the mtime of its source even where a copy gets a new one', () => {
    vi.mocked(copyFileSync).mockImplementation((from, to, flags) => {
      real.copyFileSync(from, to, flags);
      const now = new Date();
      utimesSync(to, now, now);
    });
    const written = Object.fromEntries(
      Object.keys(LEDGER).map((rel) => [
        rel,
        statSync(path.join(wt, '.superpowers', rel)).mtimeMs,
      ]),
    );

    const { result, errors } = prune();

    expect(errors).toEqual([]);
    expect(result.action).toBe('removed');
    for (const [rel, mtimeMs] of Object.entries(written)) {
      // Within a millisecond: a Date holds no finer time.
      expect(
        Math.abs(
          statSync(path.join(result.ledger.dest, rel)).mtimeMs - mtimeMs,
        ),
        rel,
      ).toBeLessThan(2);
    }
  });

  it('never replaces a folder that appeared at the final name while it copied', () => {
    const dest = path.join(ledgersDir(repo), 'x');
    let first = true;
    vi.mocked(copyFileSync).mockImplementation((from, to, flags) => {
      if (first) {
        first = false;
        mkdirSync(dest);
      }
      return real.copyFileSync(from, to, flags);
    });

    const { result, errors } = prune();

    expect(result).toMatchObject({
      action: 'kept',
      reason: `ledger copy failed: ${dest} appeared during the copy and was not replaced`,
    });
    expect(errors).toHaveLength(1);
    expect(existsSync(wt)).toBe(true);
    expect(readdirSync(dest)).toEqual([]);
    expect(entries()).toEqual(['x']);
  });

  it('keeps the worktree when a ledger file changes between the copy and the removal', () => {
    let edited = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      real.renameSync(from, to);
      if (!edited) {
        edited = true;
        writeFileSync(ledgerFile, 'edited after the copy\n');
      }
    });
    const dest = path.join(ledgersDir(repo), 'x');

    const first = prune();

    expect(first.errors).toEqual([]);
    expect(first.result).toMatchObject({
      action: 'kept',
      reason: 'ledger changed after the copy: .superpowers/brief.md',
      ledger: { dest, files: LEDGER_FILES, state: 'copied' },
    });
    expect(existsSync(wt)).toBe(true);
    expect(branches(repo)).toContain('fix/x');
    // What was copied is what the ledger held when it was copied.
    expect(readTree(dest)).toEqual(asTree(LEDGER));

    // Once the edit has aged, the next run copies the ledger as it is now to a
    // new folder, and the first copy stays.
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(ledgerFile, old, old);
    const second = prune();

    expect(second.errors).toEqual([]);
    expect(second.result.action).toBe('removed');
    expect(path.basename(second.result.ledger.dest)).toMatch(
      /^x-\d{8}T\d{6}Z$/,
    );
    expect(readTree(second.result.ledger.dest)).toEqual({
      ...asTree(LEDGER),
      'brief.md': Buffer.from('edited after the copy\n'),
    });
    expect(readTree(dest)).toEqual(asTree(LEDGER));
  });

  it.each([
    [
      'a file is rewritten, longer, with its old mtime',
      'brief.md',
      () => {
        const { mtime } = statSync(ledgerFile);
        writeFileSync(ledgerFile, 'a much longer brief than the one copied\n');
        utimesSync(ledgerFile, mtime, mtime);
      },
    ],
    [
      'a file is rewritten with as many bytes and a new mtime',
      'brief.md',
      () => writeFileSync(ledgerFile, 'goal: copy the ledger OUT\n'),
    ],
    [
      'a file is added',
      'late.md',
      () => writeFiles(path.join(wt, '.superpowers'), { 'late.md': 'x\n' }, 0),
    ],
    ['a file is deleted', 'brief.md', () => real.unlinkSync(ledgerFile)],
    [
      'a link appears',
      'shared',
      () =>
        linkDir(
          makeTempDir('prune-ledger-late-'),
          path.join(wt, '.superpowers', 'shared'),
        ),
    ],
  ])(
    'keeps the worktree when, after the copy, %s',
    (_label, changed, change) => {
      let done = false;
      vi.mocked(renameSync).mockImplementation((from, to) => {
        real.renameSync(from, to);
        if (!done) {
          done = true;
          change();
        }
      });

      const { result, errors } = prune();

      expect(errors).toEqual([]);
      expect(result).toMatchObject({
        action: 'kept',
        reason: `ledger changed after the copy: .superpowers/${changed}`,
        ledger: { state: 'copied' },
      });
      expect(existsSync(wt)).toBe(true);
    },
  );

  it('says the ledger was copied when the removal itself then fails, and skips the copy next time', () => {
    // An admin modules/ dir makes git refuse to remove the worktree.
    const modules = path.join(adminDir(wt), 'modules');
    mkdirSync(modules);
    const dest = path.join(ledgersDir(repo), 'x');

    const first = prune();

    expect(first.result).toMatchObject({
      action: 'kept',
      ledger: { dest, files: LEDGER_FILES, state: 'copied' },
    });
    expect(first.result.reason).toMatch(
      /^git worktree remove failed: .*submodules cannot be moved or removed/,
    );
    expect(
      formatResult(first.result).endsWith(
        `; ledger: 3 files copied to ${dest}`,
      ),
    ).toBe(true);
    expect(first.errors).toHaveLength(1);
    expect(readTree(dest)).toEqual(asTree(LEDGER));

    rmdirSync(modules);
    const second = prune();

    expect(second.errors).toEqual([]);
    expect(second.result).toMatchObject({
      action: 'removed',
      ledger: { dest, files: LEDGER_FILES, state: 'identical' },
    });
    expect(entries()).toEqual(['x']);
  });

  it('keeps a detached worktree whose HEAD moved during the copy, with its new commit reachable', () => {
    // Detached, a commit made now belongs to no branch: removing the
    // worktree would leave it for gc.
    git(wt, 'checkout', '-q', '--detach');
    age(wt);
    let late = '';
    vi.mocked(renameSync).mockImplementation((from, to) => {
      real.renameSync(from, to);
      late = commitFile(wt, 'late.txt', 'late\n', 'late commit');
    });

    const { result, errors } = prune();

    expect(errors).toEqual([]);
    expect(result).toMatchObject({
      action: 'kept',
      reason: 'HEAD moved during the ledger copy',
      ledger: { state: 'copied' },
    });
    expect(existsSync(wt)).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(late);
    expect(git(repo, 'cat-file', '-t', late)).toBe('commit');
  });

  it('records a failed HEAD re-read after the copy as a git error and keeps the worktree', () => {
    let reads = 0;
    onGit(readsHead, (result) => {
      // The first read is the one in the checks; the second follows the copy.
      reads += 1;
      return reads === 2
        ? { ...result, status: 128, stdout: '', stderr: 'fatal: bad HEAD\n' }
        : result;
    });

    const outcome = prune();

    expect(reads).toBe(2);
    expect(outcome.result).toMatchObject({
      action: 'kept',
      reason: 'HEAD check failed: fatal: bad HEAD',
      ledger: { state: 'copied' },
    });
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(
      /^x: HEAD check failed: git .*rev-parse HEAD: fatal: bad HEAD$/,
    );
    expect(formatSummary(outcome)).toBe(
      'worktrees prune: removed 0, kept 1, 1 git error',
    );
    expect(existsSync(wt)).toBe(true);
  });

  it('still refuses a link that appears after the checks, before copying anything', () => {
    let first = true;
    onGit(readsHead, (result) => {
      // The first read comes after checkSettled and before the plan.
      if (first) {
        first = false;
        linkDir(
          makeTempDir('prune-ledger-late-'),
          path.join(wt, '.superpowers', 'shared'),
        );
      }
      return result;
    });

    const { result, errors } = prune();

    expect(result).toMatchObject({
      action: 'kept',
      reason: 'ledger holds a link or special file: .superpowers/shared',
    });
    expect(result.ledger).toBeUndefined();
    expect(errors).toEqual([]);
    expect(existsSync(ledgersDir(repo))).toBe(false);
  });

  it('records a ledger it cannot read again before the removal and keeps the worktree', () => {
    let armed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      real.renameSync(from, to);
      armed = true;
    });
    failReaddirOf(path.join(wt, '.superpowers'), () => {
      const fail = armed;
      armed = false;
      return fail;
    });

    const outcome = prune();

    const reason = 'ledger re-check failed: EACCES: permission denied, scandir';
    expect(outcome.result).toMatchObject({
      action: 'kept',
      reason,
      ledger: {
        dest: path.join(ledgersDir(repo), 'x'),
        files: LEDGER_FILES,
        state: 'copied',
      },
    });
    expect(outcome.errors).toEqual([`x: ${reason}`]);
    expect(formatSummary(outcome)).toBe(
      'worktrees prune: removed 0, kept 1, 1 ledger error',
    );
    expect(existsSync(wt)).toBe(true);
  });

  it('records a copies folder it cannot read while planning, and starts no copy', () => {
    const dest = path.join(ledgersDir(repo), 'x');
    writeFiles(dest, { 'brief.md': 'an older copy\n' }, 120);
    failReaddirOf(dest);

    const outcome = prune();

    const reason = 'ledger copy failed: EACCES: permission denied, scandir';
    expect(outcome.result).toMatchObject({ action: 'kept', reason });
    expect(outcome.result.ledger).toBeUndefined();
    expect(outcome.errors).toEqual([`x: ${reason}`]);
    expect(formatSummary(outcome)).toBe(
      'worktrees prune: removed 0, kept 1, 1 ledger error',
    );
    // Not even a temporary folder: it failed before the copy began.
    expect(entries()).toEqual(['x']);
    expect(existsSync(wt)).toBe(true);
  });

  it('counts a worktree that another run removed while the copies folder was read as removed too', () => {
    const dest = path.join(ledgersDir(repo), 'x');
    writeFiles(dest, { 'brief.md': 'an older copy\n' }, 120);
    failReaddirOf(dest, () => {
      real.rmSync(wt, { recursive: true, force: true });
      return true;
    });

    const { result, errors } = prune();

    expect(errors).toEqual([]);
    expect(result).toMatchObject({
      action: 'removed',
      reason: 'already removed by another run; branch fix/x kept',
    });
    expect(entries()).toEqual(['x']);
  });

  it('counts a worktree that another run removed during the copy as removed, not as a failed copy', () => {
    let first = true;
    vi.mocked(copyFileSync).mockImplementation((from, to, flags) => {
      if (first) {
        first = false;
        real.rmSync(wt, { recursive: true, force: true });
      }
      return real.copyFileSync(from, to, flags);
    });

    const { result, errors } = prune();

    expect(errors).toEqual([]);
    expect(result).toMatchObject({
      action: 'removed',
      reason: 'already removed by another run; branch fix/x kept',
    });
    expect(result.ledger).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(branches(repo)).toContain('fix/x');
  });

  it('keeps the worktree when the folder for the copies cannot be made', () => {
    // A file where docs/ should be, so docs/tmp/worktree-ledgers/ cannot exist.
    writeFileSync(path.join(repo, 'docs'), 'a file, not a folder\n');

    const { result, errors } = prune();

    expect(result.action).toBe('kept');
    expect(result.reason).toMatch(/^ledger copy failed: /);
    expect(errors).toEqual([`x: ${result.reason}`]);
    expect(existsSync(wt)).toBe(true);
  });
});
