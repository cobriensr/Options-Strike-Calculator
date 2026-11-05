// @vitest-environment node

/**
 * Tests for scripts/_lib/session-status.mjs: the pure parsers, tagging and
 * formatting, then the collector with `git` and `gh` faked at the
 * child_process module and the two fs calls it makes (existsSync, statSync)
 * faked at node:fs. The faked git is a table (`world`) that each test edits.
 * prune-worktrees.mjs's checkInUse and checkSettled, which decide whether a
 * merged worktree is a cleanup candidate, are faked at their module the same
 * way. Real git, in scratch repos, runs them for real in
 * session-status.cli.test.mjs and prune-worktrees.test.mjs.
 *
 * The CI cases run the real evaluateDeploy over edits of the trimmed real
 * payloads in watch-deploy-fixtures/.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CI_CALL_TIMEOUT_MS,
  DEFAULT_COUNT,
  MAX_COUNT,
  NO_CI_AFTER_SEC,
  SetupError,
  collectStatus,
  countLines,
  formatAge,
  formatReport,
  holdLabel,
  mapLimit,
  parseAheadBehind,
  parseArgs,
  parseCherry,
  parseRecentCommits,
  sortWorktrees,
  summarizeCi,
  tagWorktree,
  worktreeName,
} from './session-status.mjs';
import { GitError } from './git-run.mjs';
import { UsageError, evaluateDeploy } from './watch-deploy.mjs';
import {
  checkInUse,
  checkSettled,
  parseWorktreeList,
} from './prune-worktrees.mjs';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: actual, existsSync: vi.fn(), statSync: vi.fn() };
});
vi.mock('./prune-worktrees.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  checkInUse: vi.fn(),
  checkSettled: vi.fn(),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'watch-deploy-fixtures');
const readJson = (name) =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const STATUS = readJson('status.json');
const CHECK_RUNS = readJson('check-runs.json');

/** A 40-hex commit id that is never all zeros (git's "no commit" marker). */
const sha = (n) => n.toString(16).padStart(40, '0');
/** A 40-hex commit id that starts with `prefix`, so its short form reads. */
const lead = (prefix) => prefix.padEnd(40, '0');

// ---------------------------------------------------------------------------
// Pure functions

describe('parseArgs', () => {
  it('defaults to CI on, five commits, no fetch', () => {
    expect(parseArgs([])).toEqual({
      ci: true,
      count: DEFAULT_COUNT,
      fetch: false,
      help: false,
    });
    expect(DEFAULT_COUNT).toBe(5);
  });

  it('reads --no-ci, --fetch and --help', () => {
    expect(parseArgs(['--no-ci']).ci).toBe(false);
    expect(parseArgs(['--fetch']).fetch).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it.each([
    [['--count', '3'], 3],
    [['--count=3'], 3],
    [['--count', String(MAX_COUNT)], MAX_COUNT],
    [['--count', '1'], 1],
  ])('reads the commit count from %j', (argv, count) => {
    expect(parseArgs(argv).count).toBe(count);
  });

  it.each([
    ['an unknown flag', ['--wait']],
    ['a positional argument', ['origin']],
    ['--count with no value', ['--count']],
    ['a count of zero', ['--count', '0']],
    ['a negative count', ['--count', '-2']],
    ['a fractional count', ['--count', '2.5']],
    ['a count that is not a number', ['--count', 'many']],
    ['a count over the maximum', ['--count', String(MAX_COUNT + 1)]],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it('names the flag that was wrong', () => {
    expect(() => parseArgs(['--count', 'many'])).toThrow(/--count/);
    expect(() => parseArgs(['--wait'])).toThrow(/--wait/);
  });
});

describe('parseAheadBehind', () => {
  it('reads "behind<TAB>ahead" as git rev-list --left-right --count prints it', () => {
    expect(parseAheadBehind('3\t5\n')).toEqual({ behind: 3, ahead: 5 });
    expect(parseAheadBehind('0\t0\n')).toEqual({ behind: 0, ahead: 0 });
  });

  it('accepts a space between the numbers', () => {
    expect(parseAheadBehind('12 7')).toEqual({ behind: 12, ahead: 7 });
  });

  it.each(['', '5\n', 'a\tb\n', '1\t2\t3\n'])(
    'throws on malformed output %j',
    (text) => {
      expect(() => parseAheadBehind(text)).toThrow(/rev-list/);
    },
  );
});

describe('parseCherry', () => {
  it('counts "+" (not in origin/main by patch) and "-" (equivalent there)', () => {
    const text = `+ ${sha(1)}\n- ${sha(2)}\n- ${sha(3)}\n`;
    expect(parseCherry(text)).toEqual({ unmerged: 1, equivalent: 2 });
  });

  it('is zero for empty output', () => {
    expect(parseCherry('')).toEqual({ unmerged: 0, equivalent: 0 });
    expect(parseCherry('\n\n')).toEqual({ unmerged: 0, equivalent: 0 });
  });

  it('throws on a line that is neither', () => {
    expect(() => parseCherry('? abc\n')).toThrow(/cherry/);
  });
});

describe('countLines', () => {
  it('counts the non-empty lines of git status --porcelain', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('\n')).toBe(0);
    expect(countLines(' M a.ts\n?? b.ts\nA  c.ts\n')).toBe(3);
  });
});

describe('parseRecentCommits', () => {
  it('reads sha, commit time and subject, keeping tabs inside the subject', () => {
    const text = `${sha(1)}\t1700000000\tfeat: one\n${sha(2)}\t1700000100\tfix: a\tb\n`;
    expect(parseRecentCommits(text)).toEqual([
      { sha: sha(1), time: 1700000000, subject: 'feat: one' },
      { sha: sha(2), time: 1700000100, subject: 'fix: a\tb' },
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseRecentCommits('')).toEqual([]);
  });

  it('throws on a line that is not sha, time and subject', () => {
    expect(() => parseRecentCommits('nonsense\n')).toThrow(/git log/);
  });
});

describe('git worktree list --porcelain -z, as the parser reads it', () => {
  // The null semantics session-status depends on, pinned here because the
  // parser belongs to prune-worktrees.mjs.
  const text = [
    ['worktree F:/r', `HEAD ${sha(1)}`, 'branch refs/heads/main'],
    ['worktree F:/r/.worktrees/a', `HEAD ${sha(2)}`, 'detached'],
    [
      'worktree F:/r/.worktrees/b',
      `HEAD ${sha(3)}`,
      'branch refs/heads/feat/b',
      'locked on usb',
    ],
    [
      'worktree F:/r/.worktrees/c',
      `HEAD ${sha(4)}`,
      'branch refs/heads/feat/c',
      'locked',
      'prunable gitdir file points to non-existent location',
    ],
    [
      'worktree F:/r/.worktrees/d',
      `HEAD ${'0'.repeat(40)}`,
      'branch refs/heads/o',
    ],
  ]
    .map((fields) => `${fields.join('\0')}\0\0`)
    .join('');
  const [main, detached, locked, lockedGone, unborn] = parseWorktreeList(text);

  it('reads the branch, or null for a detached HEAD', () => {
    expect(main.branch).toBe('main');
    expect(detached.branch).toBeNull();
    expect(detached.head).toBe(sha(2));
  });

  it('reads locked as null, or git reason ("" when it gave none)', () => {
    expect(main.locked).toBeNull();
    expect(locked.locked).toBe('on usb');
    expect(lockedGone.locked).toBe('');
  });

  it('reads prunable as null, or git reason', () => {
    expect(locked.prunable).toBeNull();
    expect(lockedGone.prunable).toMatch(/non-existent/);
  });

  it('reads an unborn branch as head null', () => {
    expect(unborn.head).toBeNull();
    expect(unborn.branch).toBe('o');
  });
});

describe('tagWorktree', () => {
  const clean = {
    error: null,
    missing: false,
    locked: false,
    unborn: false,
    uncommitted: 0,
    ahead: 0,
    notInBase: 0,
    hold: null,
  };

  it.each([
    ['merged and clean', {}, ['merged'], true],
    [
      'ahead by commits whose patches are all in origin/main (rebase, cherry-pick)',
      { ahead: 4 },
      ['merged'],
      true,
    ],
    [
      'ahead with every commit missing from origin/main',
      { ahead: 2, notInBase: 2 },
      ['ahead 2'],
      false,
    ],
    [
      'ahead with some commits missing from origin/main',
      { ahead: 8, notInBase: 3 },
      ['ahead 8 (3 not in main)'],
      false,
    ],
    ['dirty', { uncommitted: 3 }, ['dirty'], false],
    [
      'dirty and ahead',
      { uncommitted: 1, ahead: 2, notInBase: 2 },
      ['dirty', 'ahead 2'],
      false,
    ],
    ['merged but locked', { locked: true }, ['locked'], false],
    ['merged but dirty', { uncommitted: 1, ahead: 1 }, ['dirty'], false],
    ['folder gone', { missing: true, uncommitted: null }, ['missing'], false],
    [
      'folder gone with commits only on its branch',
      { missing: true, uncommitted: null, ahead: 3, notInBase: 3 },
      ['missing', 'ahead 3'],
      false,
    ],
    [
      'locked and dirty',
      { locked: true, uncommitted: 2 },
      ['locked', 'dirty'],
      false,
    ],
    [
      'no commits yet',
      { unborn: true, ahead: null, notInBase: null },
      ['unborn'],
      false,
    ],
    ['a git failure', { error: 'boom' }, ['error'], false],
  ])('%s', (_label, facts, tags, cleanup) => {
    expect(tagWorktree({ ...clean, ...facts })).toEqual({ tags, cleanup });
  });

  it('never calls an uncommitted tree merged, whatever origin/main holds', () => {
    const { cleanup } = tagWorktree({ ...clean, uncommitted: 1 });
    expect(cleanup).toBe(false);
  });

  it('keeps the merged fact but is no cleanup candidate while prune would keep it', () => {
    expect(tagWorktree({ ...clean, hold: 'active 2h' })).toEqual({
      tags: ['merged (active 2h)'],
      cleanup: false,
    });
  });

  it('shows the hold only on a worktree that is otherwise merged and clean', () => {
    const hold = 'docs/tmp files';
    expect(tagWorktree({ ...clean, hold, uncommitted: 1 }).tags).toEqual([
      'dirty',
    ]);
    expect(tagWorktree({ ...clean, hold, locked: true }).tags).toEqual([
      'locked',
    ]);
    expect(
      tagWorktree({ ...clean, hold, ahead: 2, notInBase: 1 }).tags,
    ).toEqual(['ahead 2 (1 not in main)']);
  });
});

describe('holdLabel', () => {
  it.each([
    [
      { kind: 'cwd', keep: 'the current directory is inside it' },
      'current directory',
    ],
    [
      { kind: 'base-branch', keep: 'it has main checked out' },
      'main checked out',
    ],
    [
      { kind: 'idle', keep: 'idle 2.2h, under the 24h minimum', idle: 2.2 },
      'active 2h',
    ],
    [{ kind: 'idle', keep: 'idle 0.0h', idle: 0.004 }, 'active <1m'],
    [{ kind: 'idle', keep: 'idle 0.6h', idle: 0.6 }, 'active 36m'],
    [{ kind: 'idle', keep: 'idle 23.9h', idle: 23.9 }, 'active 23h'],
    [
      { kind: 'idle-unknown', keep: 'idle time unknown: no admin index' },
      'idle time unknown',
    ],
    [
      { kind: 'in-progress', keep: 'rebase in progress', operation: 'rebase' },
      'rebase in progress',
    ],
    [
      { kind: 'in-progress', keep: 'bisect in progress', operation: 'bisect' },
      'bisect in progress',
    ],
    [
      {
        kind: 'scratch',
        keep: 'ignored scratch files in docs/tmp/: docs/tmp/a',
      },
      'docs/tmp files',
    ],
  ])('%j reads %s', (verdict, label) => {
    expect(holdLabel(verdict)).toBe(label);
  });

  it('falls back to the whole reason for a kind it does not know', () => {
    expect(holdLabel({ kind: 'new-check', keep: 'a new reason' })).toBe(
      'a new reason',
    );
  });
});

describe('formatAge', () => {
  it.each([
    [null, '?'],
    [-30, 'just now'],
    [0, 'just now'],
    [59, 'just now'],
    [60, '1m ago'],
    [59 * 60 + 59, '59m ago'],
    [3600, '1h ago'],
    [23 * 3600 + 3599, '23h ago'],
    [86_400, '1d ago'],
    [86_400 * 40, '40d ago'],
  ])('%j seconds is %s', (seconds, text) => {
    expect(formatAge(seconds)).toBe(text);
  });
});

describe('worktreeName', () => {
  it.each([
    ['F:/dev/repo/.worktrees/foo', 'F:/dev/repo', 'foo'],
    ['F:\\dev\\repo\\.worktrees\\foo', 'F:/dev/repo', 'foo'],
    ['F:/dev/repo/.worktrees/a/b', 'F:/dev/repo/', 'a/b'],
    ['f:/dev/Repo/.worktrees/foo', 'F:/dev/repo', 'foo'],
    ['/home/me/repo/.worktrees/foo', '/home/me/repo', 'foo'],
    ['F:/elsewhere/foo', 'F:/dev/repo', 'F:/elsewhere/foo'],
    [
      'F:/dev/repo/.worktreesx/foo',
      'F:/dev/repo',
      'F:/dev/repo/.worktreesx/foo',
    ],
  ])('%s under %s is %s', (wtPath, main, name) => {
    expect(worktreeName(wtPath, main)).toBe(name);
  });

  it('is case-sensitive on a path that is not a drive path', () => {
    expect(worktreeName('/home/me/Repo/.worktrees/foo', '/home/me/repo')).toBe(
      '/home/me/Repo/.worktrees/foo',
    );
  });
});

describe('sortWorktrees', () => {
  const row = (name, lastCommitSec, cleanup) => ({
    name,
    lastCommitSec,
    cleanup,
  });

  it('puts cleanup candidates last, newest commit first within each group', () => {
    const sorted = sortWorktrees([
      row('old-merged', 100, true),
      row('active-old', 200, false),
      row('new-merged', 900, true),
      row('active-new', 800, false),
    ]);
    expect(sorted.map((r) => r.name)).toEqual([
      'active-new',
      'active-old',
      'new-merged',
      'old-merged',
    ]);
  });

  it('breaks ties by name and puts an unknown commit time last in its group', () => {
    const sorted = sortWorktrees([
      row('b', 5, false),
      row('unknown', null, false),
      row('a', 5, false),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['a', 'b', 'unknown']);
  });

  it('does not change its input', () => {
    const input = [row('x', 1, true), row('y', 2, false)];
    sortWorktrees(input);
    expect(input.map((r) => r.name)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// CI verdicts, through the real evaluateDeploy

/** A copy of the real payloads, edited by `edit`. */
function snapshot(edit) {
  const result = {
    status: structuredClone(STATUS),
    checkRuns: structuredClone(CHECK_RUNS),
  };
  edit?.(result);
  return result;
}

const patchCheck = (snap, name, patch) =>
  Object.assign(
    snap.checkRuns.check_runs.find((r) => r.name === name),
    patch,
  );
const patchStatus = (snap, context, patch) =>
  Object.assign(
    snap.status.statuses.find((s) => s.context === context),
    patch,
  );

describe('summarizeCi', () => {
  /** A commit an hour old, unless `ageSec` says otherwise. */
  const summarize = (edit, ageSec = 3600, options) =>
    summarizeCi(evaluateDeploy(snapshot(edit)), ageSec, options);

  it('is success when everything passed or was skipped', () => {
    expect(summarize()).toEqual({ verdict: 'success', details: [] });
  });

  it('is failure and names the failing items', () => {
    const result = summarize((s) =>
      patchCheck(s, 'E2E Tests', { conclusion: 'failure' }),
    );
    expect(result).toEqual({
      verdict: 'failure',
      details: ['failing: E2E Tests'],
    });
  });

  it('counts a cancelled check run as a failure', () => {
    const result = summarize((s) =>
      patchCheck(s, 'E2E Tests', { conclusion: 'cancelled' }),
    );
    expect(result.verdict).toBe('failure');
  });

  it('is pending and names what it waits on', () => {
    const result = summarize((s) =>
      patchCheck(s, 'App Quality Gate', {
        status: 'in_progress',
        conclusion: null,
      }),
    );
    expect(result).toEqual({
      verdict: 'pending',
      details: ['waiting on App Quality Gate'],
    });
  });

  const noCheckRuns = (s) => {
    s.checkRuns.check_runs = [];
  };

  it('is pending while a fresh commit has no check run yet', () => {
    const result = summarize(noCheckRuns, 30);
    expect(result).toEqual({
      verdict: 'pending',
      details: ['no check runs reported yet'],
    });
  });

  it('is no-ci once a commit with no check run is older than ten minutes', () => {
    // An earlier commit of a multi-commit push never gets a workflow run.
    expect(summarize(noCheckRuns, NO_CI_AFTER_SEC).verdict).toBe('pending');
    const result = summarize(noCheckRuns, NO_CI_AFTER_SEC + 1);
    expect(result.verdict).toBe('no-ci');
    expect(result.details.join(' ')).toMatch(/newest commit of a push/);
  });

  it('never calls the tip of origin/main no-ci, however old the commit: its check runs may not exist yet', () => {
    // Made an hour ago, pushed a minute ago: committer time says "old".
    const result = summarize(noCheckRuns, 3600, { isTip: true });
    expect(result).toEqual({
      verdict: 'pending',
      details: ['no check runs reported yet'],
    });
    expect(summarize(noCheckRuns, 3600, { isTip: false }).verdict).toBe(
      'no-ci',
    );
  });

  it('stays pending, however old, while check runs exist and one still runs', () => {
    const result = summarize(
      (s) =>
        patchCheck(s, 'App Quality Gate', {
          status: 'in_progress',
          conclusion: null,
        }),
      86_400,
    );
    expect(result.verdict).toBe('pending');
  });

  it('stays pending while a status is pending, however old the commit', () => {
    const result = summarize((s) => {
      s.checkRuns.check_runs = [];
      patchStatus(s, 'Vercel', { state: 'pending' });
    }, 86_400);
    expect(result.verdict).toBe('pending');
  });

  it('is failure, not pending, once one item has failed and others still run', () => {
    const result = summarize((s) => {
      patchCheck(s, 'E2E Tests', { conclusion: 'failure' });
      patchCheck(s, 'App Quality Gate', {
        status: 'in_progress',
        conclusion: null,
      });
    });
    expect(result.verdict).toBe('failure');
    expect(result.details).toEqual([
      'failing: E2E Tests',
      'waiting on App Quality Gate',
    ]);
  });

  it('is canceled-superseded when a newer commit replaced the Vercel deploy', () => {
    const result = summarize((s) =>
      patchStatus(s, 'Vercel', {
        state: 'error',
        description: 'Deployment canceled by a newer deployment',
      }),
    );
    expect(result).toEqual({
      verdict: 'canceled-superseded',
      details: ['superseded: Vercel'],
    });
  });

  it('does not let a superseded deploy hide a failure', () => {
    const result = summarize((s) => {
      patchStatus(s, 'Vercel', {
        state: 'error',
        description: 'Canceled by a newer deployment',
      });
      patchCheck(s, 'E2E Tests', { conclusion: 'timed_out' });
    });
    expect(result.verdict).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// mapLimit

describe('mapLimit', () => {
  it('returns the results in input order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => n * 10);
    expect(out).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` calls at once, and uses the full limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (n) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        running -= 1;
        return n;
      },
    );
    expect(out).toHaveLength(20);
    expect(peak).toBe(3);
  });

  it('handles an empty list and a limit above the list length', async () => {
    await expect(mapLimit([], 4, async (n) => n)).resolves.toEqual([]);
    await expect(mapLimit([7], 4, async (n) => n)).resolves.toEqual([7]);
  });

  it('rejects when a call rejects', async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('bad item');
        return n;
      }),
    ).rejects.toThrow('bad item');
  });
});

// ---------------------------------------------------------------------------
// formatReport

const NOW_MS = Date.UTC(2026, 10, 4, 18, 0, 0);
const NOW_SEC = NOW_MS / 1000;

function wtRow(over) {
  return {
    name: 'wt',
    path: 'F:/r/.worktrees/wt',
    branch: 'feat/wt',
    head: sha(2),
    ahead: 0,
    behind: 0,
    uncommitted: 0,
    lastCommitSec: NOW_SEC - 3600,
    tags: ['merged'],
    cleanup: true,
    error: null,
    ...over,
  };
}

function report(over = {}) {
  return {
    nowMs: NOW_MS,
    base: {
      ref: 'origin/main',
      sha: lead('abcdef12'),
      updatedAtMs: NOW_MS - 12 * 60_000,
      source: 'FETCH_HEAD',
    },
    fetchError: null,
    main: {
      path: 'F:/r',
      branch: 'main',
      ahead: 0,
      behind: 3,
      uncommitted: 2,
      error: null,
    },
    worktrees: [],
    recent: null,
    ...over,
  };
}

describe('formatReport', () => {
  it('prints the whole report as aligned plain text', () => {
    const text = formatReport(
      report({
        worktrees: [
          wtRow({
            name: 'phase7c',
            branch: 'feat/phase7c',
            ahead: 2,
            behind: 0,
            uncommitted: 3,
            lastCommitSec: NOW_SEC - 90,
            tags: ['dirty', 'ahead 2'],
            cleanup: false,
          }),
          wtRow({
            name: 'old',
            branch: null,
            ahead: 4,
            behind: 120,
            lastCommitSec: NOW_SEC - 5 * 86_400,
          }),
        ],
        recent: [
          {
            sha: lead('aaaaaaa1'),
            subject: 'feat(scripts): Show status',
            verdict: 'success',
            details: [],
          },
          {
            sha: lead('bbbbbbb2'),
            subject: 'fix: a thing',
            verdict: 'failure',
            details: ['failing: E2E Tests'],
          },
        ],
      }),
    );

    expect(text).toBe(
      [
        'origin/main  abcdef12  last fetched 12m ago (FETCH_HEAD)',
        '',
        'MAIN CHECKOUT',
        '  path         F:/r',
        '  branch       main',
        '  vs origin    0 ahead, 3 behind',
        '  uncommitted  2 files',
        '',
        'WORKTREES (2) - cleanup candidates: 1',
        '  NAME     BRANCH        AHEAD/BEHIND  UNCOMMITTED  LAST COMMIT  TAG',
        '  phase7c  feat/phase7c  +2/-0         3            1m ago       dirty, ahead 2',
        '  old      (detached)    +4/-120       0            5d ago       merged',
        '',
        'RECENT PUSHES (origin/main, newest first)',
        '  aaaaaaa1  success  feat(scripts): Show status',
        '  bbbbbbb2  failure  fix: a thing',
        '    failing: E2E Tests',
      ].join('\n'),
    );
  });

  it('says how the origin/main ref is aged in each case', () => {
    const line = (base) => formatReport(report({ base })).split('\n')[0];
    const fetched = {
      ref: 'origin/main',
      sha: lead('1234abcd'),
      updatedAtMs: NOW_MS - 3 * 3_600_000,
      source: 'FETCH_HEAD',
    };
    expect(line(fetched)).toBe(
      'origin/main  1234abcd  last fetched 3h ago (FETCH_HEAD)',
    );
    expect(line({ ...fetched, source: 'reflog' })).toBe(
      'origin/main  1234abcd  last moved 3h ago (reflog; no FETCH_HEAD)',
    );
    expect(line({ ...fetched, updatedAtMs: null, source: null })).toBe(
      'origin/main  1234abcd  age unknown (no FETCH_HEAD or reflog)',
    );
  });

  it('warns when git fetch failed', () => {
    const text = formatReport(report({ fetchError: 'could not resolve host' }));
    expect(text).toContain(
      'warning: git fetch origin failed: could not resolve host',
    );
  });

  it('omits the recent pushes section when there is none', () => {
    const text = formatReport(report({ recent: null }));
    expect(text).not.toContain('RECENT PUSHES');
  });

  it('says so when there are no linked worktrees', () => {
    const text = formatReport(report({ worktrees: [] }));
    expect(text).toContain('WORKTREES (0)\n  none');
  });

  it('prints a worktree that failed, with its reason', () => {
    const text = formatReport(
      report({
        worktrees: [
          wtRow({
            name: 'broken',
            ahead: null,
            behind: null,
            uncommitted: null,
            lastCommitSec: null,
            tags: ['error'],
            cleanup: false,
            error: 'git status: fatal: bad index file',
          }),
        ],
      }),
    );
    expect(text).toMatch(/broken\s+feat\/wt\s+\?\s+\?\s+\?\s+error/);
    expect(text).toContain('error: git status: fatal: bad index file');
  });

  it('shows a lone file as "1 file" and counts the cleanup candidates', () => {
    const one = formatReport(
      report({
        main: {
          path: 'F:/r',
          branch: 'main',
          ahead: 1,
          behind: 0,
          uncommitted: 1,
          error: null,
        },
        worktrees: [wtRow({ name: 'a' }), wtRow({ name: 'b' })],
      }),
    );
    expect(one).toContain('uncommitted  1 file\n');
    expect(one).toContain('WORKTREES (2) - cleanup candidates: 2');
  });

  it('prints unknown CI with its reason under the commit', () => {
    const text = formatReport(
      report({
        recent: [
          {
            sha: lead('ccccccc3'),
            subject: 'chore: x',
            verdict: 'unknown',
            details: ['gh: HTTP 502'],
          },
        ],
      }),
    );
    expect(text).toContain('ccccccc3  unknown  chore: x');
    expect(text).toContain('gh: HTTP 502');
  });

  it('prints a main checkout that failed, with its reason', () => {
    const text = formatReport(
      report({
        main: {
          path: 'F:/r',
          branch: 'main',
          ahead: null,
          behind: null,
          uncommitted: null,
          error: 'git status: boom',
        },
      }),
    );
    expect(text).toContain('error        git status: boom');
  });
});

// ---------------------------------------------------------------------------
// collectStatus, with git and gh faked

/** What the faked `git` throws: exit code and stderr, as execFile reports. */
class Failure extends Error {
  constructor(stderr, code = 128) {
    super(stderr);
    this.stderr = stderr;
    this.exitCode = code;
  }
}

const ROOT = 'F:/dev/repo';
const GOOD_REMOTE = 'https://github.com/o/n.git';
const SUBJECTS = ['one', 'two', 'three', 'four', 'five', 'six'];

/** One `git worktree list --porcelain -z` record. */
function record({ wtPath, head, branch, detached, locked, prunable }) {
  const fields = [`worktree ${wtPath}`, `HEAD ${head}`];
  if (branch) fields.push(`branch refs/heads/${branch}`);
  if (detached) fields.push('detached');
  if (locked !== undefined)
    fields.push(locked === '' ? 'locked' : `locked ${locked}`);
  if (prunable !== undefined) fields.push(`prunable ${prunable}`);
  return `${fields.join('\0')}\0\0`;
}

/**
 * The faked repository. `checkouts` is the main checkout first, then the
 * linked worktrees; every other field is what one git command answers.
 * Tests edit it, never the fake.
 */
let world;
/** Every call the fakes saw, as `[file, ...args]`. */
let calls;
/** The paths existsSync should call missing. */
let gone;

function freshWorld() {
  const wt = (name, over) => ({
    wtPath: `${ROOT}/.worktrees/${name}`,
    ...over,
  });
  return {
    checkouts: [
      { wtPath: ROOT, head: sha(1), branch: 'main' },
      wt('rebased', { head: sha(2), branch: 'feat/rebased' }),
      wt('wip', { head: sha(3), branch: 'feat/wip' }),
      wt('dirty', { head: sha(4), branch: 'feat/dirty' }),
      wt('detached', { head: sha(5), detached: true }),
      wt('locked', { head: sha(6), branch: 'feat/locked', locked: 'on usb' }),
      wt('gone', {
        head: sha(7),
        branch: 'feat/gone',
        prunable: 'gitdir file points to non-existent location',
      }),
      wt('merge-commit', { head: sha(8), branch: 'feat/mc' }),
      wt('unborn', { head: '0'.repeat(40), branch: 'orphan' }),
      { wtPath: 'F:/other/place', head: sha(9), branch: 'feat/elsewhere' },
    ],
    // [behind, ahead] against origin/main, by head.
    counts: {
      [sha(1)]: [3, 0],
      [sha(2)]: [5, 2],
      [sha(3)]: [0, 2],
      [sha(4)]: [1, 0],
      [sha(5)]: [9, 0],
      [sha(6)]: [0, 0],
      [sha(7)]: [0, 1],
      [sha(8)]: [0, 3],
      [sha(9)]: [0, 0],
    },
    times: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [sha(n), 1_700_000_000 + n]),
    ),
    // `git status --porcelain` lines, by checkout path.
    status: {
      [ROOT]: [' M a.ts', '?? b.ts'],
      [`${ROOT}/.worktrees/dirty`]: ['?? x', ' M y', 'A  z'],
    },
    // `git cherry` and `git rev-list --merges --count`, by head.
    cherry: {
      [sha(2)]: `- ${sha(20)}\n- ${sha(21)}\n`,
      [sha(3)]: `+ ${sha(22)}\n- ${sha(23)}\n`,
      [sha(7)]: `+ ${sha(24)}\n`,
      [sha(8)]: `- ${sha(25)}\n- ${sha(26)}\n- ${sha(27)}\n`,
    },
    merges: { [sha(8)]: 1 },
    remote: GOOD_REMOTE,
    baseSha: sha(0xfeed),
    commonDir: 'F:/dev/repo/.git',
    fetchHeadMtimeMs: Date.UTC(2026, 10, 4, 17, 48, 0),
    reflogSeconds: Date.UTC(2026, 10, 4, 15, 0, 0) / 1000,
    fetch: '',
    // Recent commits on origin/main, newest first.
    log: SUBJECTS.map((subject, i) => ({
      sha: sha(0x100 + i),
      time: 1_700_100_000 - i * 60,
      subject,
    })),
    // gh payloads by commit sha; anything absent is a clean pass.
    gh: {},
    // What checkInUse and checkSettled answer, by worktree path; absent is
    // "free to remove": no hold, idle two days.
    inUse: {},
    settled: {},
  };
}

/** The answer of the faked git. Throws Failure for a git error. */
function fakeGit(allArgs) {
  const args = allArgs.filter((a) => a !== '--no-optional-locks');
  let dir = null;
  let rest = args;
  if (args[0] === '-C') {
    dir = args[1];
    rest = args.slice(2);
  }
  const [cmd, ...more] = rest;
  const joined = more.join(' ');
  const byHead = (table, head, label) => {
    const value = table[head];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Failure(`unscripted ${label} ${head}`);
    return value;
  };

  switch (cmd) {
    case 'worktree':
      if (world.listing instanceof Failure) throw world.listing;
      return world.listing ?? world.checkouts.map(record).join('');
    case 'fetch':
      if (world.fetch instanceof Failure) throw world.fetch;
      return world.fetch;
    case 'rev-parse':
      if (more.includes('--git-common-dir')) return `${world.commonDir}\n`;
      if (more.some((a) => a.startsWith('origin/main'))) {
        if (world.baseSha === null) throw new Failure('', 1);
        return `${world.baseSha}\n`;
      }
      throw new Failure(`unscripted rev-parse ${joined}`);
    case 'reflog':
      if (world.reflogSeconds === null) throw new Failure('no reflog', 128);
      return `${world.reflogSeconds}\n`;
    case 'remote':
      if (world.remote instanceof Failure) throw world.remote;
      return `${world.remote}\n`;
    case 'status': {
      const lines = world.status[dir] ?? [];
      if (lines instanceof Error) throw lines;
      return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    }
    case 'rev-list': {
      if (more.includes('--timestamp')) {
        // --ignore-missing: a commit absent from the table is left out.
        return more
          .filter((a) => world.times[a] !== undefined)
          .map((a) => `${world.times[a]} ${a}`)
          .join('\n');
      }
      if (more.includes('--merges')) {
        const head = more.find((a) => /^[0-9a-f]{40}$/.test(a));
        const count = world.merges[head] ?? 0;
        if (count instanceof Error) throw count;
        return `${count}\n`;
      }
      if (more.includes('--count')) {
        const head = more.at(-1).replace('origin/main...', '');
        const [behind, ahead] = byHead(world.counts, head, 'counts');
        return `${behind}\t${ahead}\n`;
      }
      throw new Failure(`unscripted rev-list ${joined}`);
    }
    case 'cherry':
      return byHead(world.cherry, more.at(-1), 'cherry');
    case 'for-each-ref': {
      if (world.forEachRef instanceof Failure) throw world.forEachRef;
      // <sha> <ahead> <behind> for every branch tip, as git >= 2.41 prints it.
      return world.checkouts
        .filter((c) => c.branch && world.counts[c.head] !== undefined)
        .map((c) => {
          const [behind, ahead] = world.counts[c.head];
          return `${c.head} ${ahead} ${behind}`;
        })
        .join('\n');
    }
    case 'log': {
      const limit = Number(
        more.find((a) => a.startsWith('--max-count=')).split('=')[1],
      );
      return world.log
        .slice(0, limit)
        .map((c) => `${c.sha}\t${c.time}\t${c.subject}`)
        .join('\n');
    }
    default:
      throw new Failure(`unscripted git ${cmd} ${joined}`);
  }
}

/** The answer of the faked gh: the JSON for `gh api repos/o/n/commits/...`. */
function fakeGh(args) {
  const match = /commits\/([0-9a-f]{40})\/(status|check-runs)/.exec(args[1]);
  if (!match) throw new Failure(`unscripted gh ${args.join(' ')}`);
  const [, commit, kind] = match;
  const entry = world.gh[commit] ?? snapshot();
  if (entry instanceof Error) throw entry;
  if (typeof entry === 'string') return entry;
  return JSON.stringify(kind === 'status' ? entry.status : entry.checkRuns);
}

function installFakes() {
  vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
    calls.push([file, ...args]);
    queueMicrotask(() => {
      try {
        const out = file === 'gh' ? fakeGh(args) : fakeGit(args);
        callback(null, out, '');
      } catch (err) {
        if (err.code === 'ENOENT') {
          callback(err, '', '');
        } else if (err instanceof Failure) {
          callback(
            Object.assign(new Error(`Command failed: ${file}`), {
              code: err.exitCode,
            }),
            '',
            err.stderr,
          );
        } else {
          callback(
            Object.assign(new Error('Command failed'), { code: 1 }),
            '',
            err.message,
          );
        }
      }
    });
  });
  vi.mocked(checkInUse).mockImplementation(
    (entry) => world.inUse[entry.path] ?? { keep: null },
  );
  vi.mocked(checkSettled).mockImplementation((wtPath) => {
    const verdict = world.settled[wtPath] ?? { keep: null, idle: 48 };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  vi.mocked(existsSync).mockImplementation((p) => !gone.has(String(p)));
  vi.mocked(statSync).mockImplementation((p) => {
    if (String(p).endsWith('FETCH_HEAD') && world.fetchHeadMtimeMs !== null) {
      return { mtimeMs: world.fetchHeadMtimeMs };
    }
    return undefined; // throwIfNoEntry: false
  });
}

const ENOENT = () =>
  Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

const OPTIONS = { ci: false, count: 5, fetch: false };

/** The row for the worktree called `name`. */
async function rowOf(name) {
  const { worktrees } = await collectStatus(OPTIONS);
  const found = worktrees.find((w) => w.name === name);
  if (!found) {
    throw new Error(`no row ${name}: ${worktrees.map((w) => w.name)}`);
  }
  return found;
}

const gitCalls = () =>
  calls.filter(([file]) => file === 'git').map((c) => c.slice(1));
const ghCalls = () => calls.filter(([file]) => file === 'gh');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  calls = [];
  gone = new Set([`${ROOT}/.worktrees/gone`]);
  world = freshWorld();
  vi.mocked(execFile).mockReset();
  vi.mocked(checkInUse).mockReset();
  vi.mocked(checkSettled).mockReset();
  vi.mocked(existsSync).mockReset();
  vi.mocked(statSync).mockReset();
  installFakes();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectStatus: the main checkout', () => {
  it('reports its path, branch, ahead/behind origin/main and uncommitted count', async () => {
    const { main } = await collectStatus(OPTIONS);
    expect(main).toMatchObject({
      path: ROOT,
      branch: 'main',
      ahead: 0,
      behind: 3,
      uncommitted: 2,
      error: null,
    });
  });

  it('is not repeated among the worktrees', async () => {
    const { worktrees } = await collectStatus(OPTIONS);
    expect(worktrees.map((w) => w.path)).not.toContain(ROOT);
  });
});

describe('collectStatus: worktrees', () => {
  it('lists every linked worktree, named by the path below .worktrees/', async () => {
    const { worktrees } = await collectStatus(OPTIONS);
    expect(worktrees.map((w) => w.name).sort()).toEqual(
      [
        'F:/other/place',
        'detached',
        'dirty',
        'gone',
        'locked',
        'merge-commit',
        'rebased',
        'unborn',
        'wip',
      ].sort(),
    );
  });

  it('tags a branch whose commits are all patch-equivalent in origin/main as merged', async () => {
    // Two commits ahead by ancestry, both "-" in git cherry: squashed or
    // rebased into origin/main under other ids.
    const row = await rowOf('rebased');
    expect(row).toMatchObject({
      ahead: 2,
      behind: 5,
      tags: ['merged'],
      cleanup: true,
      uncommitted: 0,
    });
  });

  it('tags a branch with a commit missing from origin/main as ahead, and says how many are', async () => {
    // Two commits ahead by ancestry, one "+" and one "-" in git cherry.
    const row = await rowOf('wip');
    expect(row).toMatchObject({
      ahead: 2,
      tags: ['ahead 2 (1 not in main)'],
      cleanup: false,
    });
  });

  it('gives the plain ahead count when every commit ahead is missing from origin/main', async () => {
    const row = await rowOf('gone');
    expect(row.tags).toEqual(['missing', 'ahead 1']);
  });

  it('counts the commits not in origin/main from the "+" lines of git cherry, not the raw rev-list count', async () => {
    // 8 commits ahead, 5 of them cherry-picked into origin/main under other ids.
    world.counts[sha(3)] = [0, 8];
    world.cherry[sha(3)] = `+ ${sha(30)}\n+ ${sha(31)}\n+ ${sha(32)}\n${[
      40, 41, 42, 43, 44,
    ]
      .map((n) => `- ${sha(n)}\n`)
      .join('')}`;
    const row = await rowOf('wip');
    expect(row.tags).toEqual(['ahead 8 (3 not in main)']);
  });

  it('does not call a branch merged while a merge commit of its own is missing from origin/main', async () => {
    // git cherry skips merge commits, so every line is "-" here; the one
    // merge commit is the only commit not in origin/main.
    const row = await rowOf('merge-commit');
    expect(row).toMatchObject({
      ahead: 3,
      tags: ['ahead 3 (1 not in main)'],
      cleanup: false,
    });
  });

  it('adds the merge commits of its own to the "+" lines', async () => {
    // 5 commits ahead: one "+", one "-" and two merge commits of its own,
    // and one commit that is neither (a plain commit, shown "-").
    world.counts[sha(3)] = [0, 5];
    world.merges[sha(3)] = 2;
    const row = await rowOf('wip');
    expect(row.tags).toEqual(['ahead 5 (3 not in main)']);
  });

  it('tags an uncommitted tree dirty and counts the files', async () => {
    const row = await rowOf('dirty');
    expect(row).toMatchObject({
      uncommitted: 3,
      tags: ['dirty'],
      cleanup: false,
    });
  });

  it('tags a detached HEAD that is in origin/main and clean as merged', async () => {
    const row = await rowOf('detached');
    expect(row).toMatchObject({
      branch: null,
      ahead: 0,
      behind: 9,
      tags: ['merged'],
      cleanup: true,
    });
  });

  it('tags a locked worktree locked, not merged, though it is clean and in origin/main', async () => {
    const row = await rowOf('locked');
    expect(row).toMatchObject({ tags: ['locked'], cleanup: false, ahead: 0 });
  });

  it('tags a worktree whose folder is gone missing, without running status in it', async () => {
    const row = await rowOf('gone');
    expect(row).toMatchObject({
      tags: ['missing', 'ahead 1'],
      cleanup: false,
      uncommitted: null,
      ahead: 1,
    });
    const statusPaths = calls
      .filter((c) => c.includes('status'))
      .map((c) => c[c.indexOf('-C') + 1]);
    expect(statusPaths).not.toContain(`${ROOT}/.worktrees/gone`);
  });

  it('tags a worktree whose folder is gone though git does not call it prunable', async () => {
    world.checkouts.find((c) => c.wtPath.endsWith('/gone')).prunable =
      undefined;
    const row = await rowOf('gone');
    expect(row.tags).toContain('missing');
  });

  it('tags a branch with no commits yet unborn and runs no git on it', async () => {
    const row = await rowOf('unborn');
    expect(row).toMatchObject({
      tags: ['unborn'],
      cleanup: false,
      ahead: null,
      lastCommitSec: null,
    });
    expect(calls.flat()).not.toContain('0'.repeat(40));
  });

  it('names a worktree outside .worktrees/ by its full path', async () => {
    const row = await rowOf('F:/other/place');
    expect(row.branch).toBe('feat/elsewhere');
  });

  it('reports the age of the last commit', async () => {
    const row = await rowOf('wip');
    expect(row.lastCommitSec).toBe(1_700_000_003);
  });

  it('sorts cleanup candidates last', async () => {
    const { worktrees } = await collectStatus(OPTIONS);
    const flags = worktrees.map((w) => w.cleanup);
    expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
    expect(flags.at(-1)).toBe(true);
    expect(flags[0]).toBe(false);
  });

  it('checks the patches and the merge commits of a branch ahead, and of no other', async () => {
    await collectStatus(OPTIONS);
    const ahead = [sha(2), sha(3), sha(7), sha(8)].sort();
    const mergeChecks = gitCalls().filter((a) => a.includes('--merges'));
    expect(
      mergeChecks.map((a) => a.find((x) => /^[0-9a-f]{40}$/.test(x))).sort(),
    ).toEqual(ahead);
    const cherryChecks = gitCalls().filter((a) => a.includes('cherry'));
    expect(cherryChecks.map((a) => a.at(-1)).sort()).toEqual(ahead);
  });

  it('shows a branch whose merge-commit count git cannot give as error', async () => {
    world.merges[sha(3)] = new Failure('fatal: bad revision', 128);
    const { worktrees } = await collectStatus(OPTIONS);
    const row = worktrees.find((w) => w.name === 'wip');
    expect(row.tags).toEqual(['error']);
    expect(row.error).toMatch(/bad revision/);
  });

  it.each([['many'], ['']])(
    'shows a branch whose merge-commit count is "%s", not a number, as error rather than merged',
    async (output) => {
      world.merges[sha(3)] = output;
      const row = await rowOf('wip');
      expect(row.tags).toEqual(['error']);
      expect(row.error).toMatch(/unexpected output/);
      expect(row.cleanup).toBe(false);
    },
  );

  it('shows a worktree whose git fails as error and still reports the others', async () => {
    world.status[`${ROOT}/.worktrees/dirty`] = new Failure(
      'fatal: bad index file',
    );
    const { worktrees } = await collectStatus(OPTIONS);
    const broken = worktrees.find((w) => w.name === 'dirty');
    expect(broken.tags).toEqual(['error']);
    expect(broken.cleanup).toBe(false);
    expect(broken.error).toMatch(/bad index file/);
    expect(worktrees.find((w) => w.name === 'wip').tags).toEqual([
      'ahead 2 (1 not in main)',
    ]);
  });

  it('shows the main checkout as an error, not a crash, when its status fails', async () => {
    world.status[ROOT] = new Failure('fatal: bad index file');
    const { main, worktrees } = await collectStatus(OPTIONS);
    expect(main.error).toMatch(/bad index file/);
    expect(worktrees.length).toBeGreaterThan(0);
  });

  it('lists nothing but the main checkout in a repo without linked worktrees', async () => {
    world.checkouts = world.checkouts.slice(0, 1);
    const { worktrees } = await collectStatus(OPTIONS);
    expect(worktrees).toEqual([]);
  });
});

describe('collectStatus: cleanup candidates', () => {
  const REBASED = `${ROOT}/.worktrees/rebased`;
  const DETACHED = `${ROOT}/.worktrees/detached`;
  const ELSEWHERE = 'F:/other/place';

  it('is a plain merged candidate when prune would remove it', async () => {
    expect(await rowOf('rebased')).toMatchObject({
      tags: ['merged'],
      cleanup: true,
    });
  });

  it.each([
    [
      'was active in the last day',
      { keep: 'idle 2.2h, under the 24h minimum', kind: 'idle', idle: 2.2 },
      'merged (active 2h)',
    ],
    [
      'has ignored scratch files in docs/tmp/',
      {
        keep: 'ignored scratch files in docs/tmp/: docs/tmp/a.log',
        kind: 'scratch',
      },
      'merged (docs/tmp files)',
    ],
    [
      'has a rebase stopped in it',
      { keep: 'rebase in progress', kind: 'in-progress', operation: 'rebase' },
      'merged (rebase in progress)',
    ],
    [
      'has no idle time to read',
      {
        keep: 'idle time unknown: no admin index or logs/HEAD',
        kind: 'idle-unknown',
      },
      'merged (idle time unknown)',
    ],
  ])(
    'keeps the merged fact but no candidate for a worktree that %s',
    async (_why, verdict, tag) => {
      world.settled[REBASED] = verdict;
      const row = await rowOf('rebased');
      expect(row).toMatchObject({ tags: [tag], cleanup: false });
      // Still a plain candidate next to it.
      expect(await rowOf('detached')).toMatchObject({
        tags: ['merged'],
        cleanup: true,
      });
    },
  );

  it('keeps a worktree that holds the current directory out of the candidates', async () => {
    world.inUse[REBASED] = {
      keep: 'the current directory is inside it',
      kind: 'cwd',
    };
    expect(await rowOf('rebased')).toMatchObject({
      tags: ['merged (current directory)'],
      cleanup: false,
    });
  });

  it('keeps a worktree with main checked out out of the candidates, without reading its files', async () => {
    world.inUse[REBASED] = {
      keep: 'it has main checked out',
      kind: 'base-branch',
    };
    expect(await rowOf('rebased')).toMatchObject({
      tags: ['merged (main checked out)'],
      cleanup: false,
    });
    expect(vi.mocked(checkSettled).mock.calls.map(([p]) => p)).not.toContain(
      REBASED,
    );
  });

  it('keeps a merged worktree outside .worktrees/ out of the candidates, since prune never touches it', async () => {
    expect(await rowOf(ELSEWHERE)).toMatchObject({
      tags: ['merged (outside .worktrees/)'],
      cleanup: false,
    });
    // The scope test comes first: prune's checks are not run for it.
    expect(vi.mocked(checkInUse).mock.calls.map(([e]) => e.path)).not.toContain(
      ELSEWHERE,
    );
    expect(vi.mocked(checkSettled).mock.calls.map(([p]) => p)).not.toContain(
      ELSEWHERE,
    );
  });

  it('counts only the candidates, and sorts the held ones with the active rows', async () => {
    world.settled[REBASED] = { keep: 'idle 1.0h', kind: 'idle', idle: 1 };
    const report = await collectStatus(OPTIONS);
    const candidates = report.worktrees.filter((w) => w.cleanup);
    expect(candidates.map((w) => w.name)).toEqual(['detached']);
    expect(report.worktrees.at(-1)).toMatchObject({
      name: 'detached',
      cleanup: true,
    });
    expect(report.worktrees.map((w) => w.name)).toContain('rebased');
    expect(formatReport(report)).toContain(
      'WORKTREES (9) - cleanup candidates: 1',
    );
    expect(formatReport(report)).toMatch(/rebased .* merged \(active 1h\)\n/);
  });

  it('asks prune only about a worktree that is otherwise a candidate, once, and not to read its status again', async () => {
    await collectStatus(OPTIONS);
    // rebased and detached are merged and clean, and under .worktrees/;
    // every other row, and the main checkout, is dirty, ahead, locked, gone
    // or unborn, is the main one, or (the one elsewhere) is outside
    // .worktrees/, which prune never checks.
    const settled = vi.mocked(checkSettled).mock.calls;
    expect(settled.map(([wtPath]) => wtPath).sort()).toEqual(
      [REBASED, DETACHED].sort(),
    );
    for (const [, options] of settled) {
      expect(options).toEqual({ statusKnownClean: true });
    }
    expect(
      vi
        .mocked(checkInUse)
        .mock.calls.map(([entry]) => entry.path)
        .sort(),
    ).toEqual([REBASED, DETACHED].sort());
  });

  it('asks about the directory the command runs in', async () => {
    await collectStatus(OPTIONS);
    const asked = vi.mocked(checkInUse).mock.calls;
    expect(asked).toHaveLength(2);
    for (const [, cwd] of asked) expect(cwd).toBe(process.cwd());
  });

  it('hands prune the worktree path and branch', async () => {
    await collectStatus(OPTIONS);
    const entries = vi.mocked(checkInUse).mock.calls.map(([entry]) => entry);
    expect(entries.find((e) => e.path === REBASED)).toMatchObject({
      branch: 'feat/rebased',
    });
    expect(entries.find((e) => e.path === DETACHED)).toMatchObject({
      branch: null,
    });
  });

  it('shows a worktree whose prune check fails as error and still reports the others', async () => {
    world.settled[REBASED] = new Error(
      'git rev-parse: fatal: not a git repository',
    );
    const rebased = await rowOf('rebased');
    expect(rebased).toMatchObject({ tags: ['error'], cleanup: false });
    expect(rebased.error).toMatch(/not a git repository/);
    expect(await rowOf('detached')).toMatchObject({
      tags: ['merged'],
      cleanup: true,
    });
  });
});

describe('collectStatus: few git calls', () => {
  const callsOf = (...words) =>
    gitCalls().filter((args) => words.every((w) => args.includes(w)));

  it('reads every commit time in one rev-list, naming each distinct head once', async () => {
    await collectStatus(OPTIONS);
    const [only, ...more] = callsOf('--timestamp');
    expect(more).toEqual([]);
    const named = only.filter((a) => /^[0-9a-f]{40}$/.test(a));
    expect(named.sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => sha(n)).sort(),
    );
  });

  it('splits the commit times over several calls when there are very many heads', async () => {
    const extra = Array.from({ length: 450 }, (_, i) => 1000 + i);
    for (const n of extra) {
      world.checkouts.push({
        wtPath: `${ROOT}/.worktrees/many-${n}`,
        head: sha(n),
        branch: `feat/many-${n}`,
      });
      world.counts[sha(n)] = [0, 0];
      world.times[sha(n)] = 1_700_000_000 + n;
    }

    const { worktrees } = await collectStatus(OPTIONS);

    const timestampCalls = callsOf('--timestamp');
    expect(timestampCalls.length).toBeGreaterThan(1);
    for (const args of timestampCalls) {
      expect(
        args.filter((a) => /^[0-9a-f]{40}$/.test(a)).length,
      ).toBeLessThanOrEqual(200);
    }
    const named = timestampCalls.flatMap((args) =>
      args.filter((a) => /^[0-9a-f]{40}$/.test(a)),
    );
    expect(new Set(named).size).toBe(9 + 450);
    expect(worktrees.find((w) => w.name === 'many-1449').lastCommitSec).toBe(
      1_700_001_449,
    );
  });

  it('leaves the time unknown, without failing, for a commit git no longer has', async () => {
    delete world.times[sha(7)];
    const { worktrees } = await collectStatus(OPTIONS);
    const gone = worktrees.find((w) => w.name === 'gone');
    expect(gone.lastCommitSec).toBeNull();
    expect(gone.tags).toEqual(['missing', 'ahead 1']);
  });

  it('counts ahead/behind of every branch tip in one for-each-ref, and counts a detached HEAD alone', async () => {
    await collectStatus(OPTIONS);
    expect(callsOf('for-each-ref')).toHaveLength(1);
    const counted = callsOf('--left-right', '--count').map((args) =>
      args.at(-1),
    );
    expect(counted).toEqual([`origin/main...${sha(5)}`]);
  });

  it('counts each commit on its own when git is too old for ahead-behind', async () => {
    world.forEachRef = new Failure(
      'fatal: unknown field name: ahead-behind:origin/main',
    );
    const { worktrees, main } = await collectStatus(OPTIONS);

    const counted = callsOf('--left-right', '--count').map((args) =>
      args.at(-1).replace('origin/main...', ''),
    );
    expect(counted.sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => sha(n)).sort(),
    );
    expect(main).toMatchObject({ ahead: 0, behind: 3 });
    expect(worktrees.find((w) => w.name === 'rebased')).toMatchObject({
      ahead: 2,
      behind: 5,
      tags: ['merged'],
    });
  });

  it('asks about a commit shared by several worktrees once', async () => {
    world.checkouts.push({
      wtPath: `${ROOT}/.worktrees/wip-copy`,
      head: sha(3),
      branch: 'feat/wip-copy',
    });
    const { worktrees } = await collectStatus(OPTIONS);

    expect(callsOf('cherry').filter((a) => a.at(-1) === sha(3))).toHaveLength(
      1,
    );
    const copy = worktrees.find((w) => w.name === 'wip-copy');
    expect(copy.tags).toEqual(['ahead 2 (1 not in main)']);
  });

  it('shares a failure of such a lookup among the worktrees that asked', async () => {
    world.cherry[sha(3)] = new Failure('fatal: bad revision', 128);
    world.checkouts.push({
      wtPath: `${ROOT}/.worktrees/wip-copy`,
      head: sha(3),
      branch: 'feat/wip-copy',
    });
    const { worktrees } = await collectStatus(OPTIONS);
    for (const name of ['wip', 'wip-copy']) {
      const row = worktrees.find((w) => w.name === name);
      expect(row.tags).toEqual(['error']);
      expect(row.error).toMatch(/bad revision/);
    }
  });
});

describe('collectStatus: read-only', () => {
  /**
   * Every git command it may run without --fetch, down to the verb where the
   * command also has writing verbs (worktree add, reflog expire, remote add).
   */
  const READ_ONLY = new Set([
    'worktree list',
    'reflog show',
    'remote get-url',
    'rev-parse',
    'rev-list',
    'for-each-ref',
    'cherry',
    'log',
    'status',
  ]);
  const WITH_VERBS = new Set(['worktree', 'reflog', 'remote']);

  /** The git command of a call, past -C <dir> and --no-optional-locks. */
  function subcommand(args) {
    const rest = args.filter((a) => a !== '--no-optional-locks');
    const [command, verb] = rest[0] === '-C' ? rest.slice(2) : rest;
    return WITH_VERBS.has(command) ? `${command} ${verb}` : command;
  }

  it('runs only read-only git commands by default, down to the verb', async () => {
    // No FETCH_HEAD: the age of origin/main comes from the reflog.
    world.fetchHeadMtimeMs = null;
    await collectStatus({ ...OPTIONS, ci: true });
    const used = new Set(gitCalls().map(subcommand));
    expect([...used].filter((c) => !READ_ONLY.has(c))).toEqual([]);
    expect([...used].sort()).toEqual([...READ_ONLY].sort());
  });

  it('never fetches without --fetch', async () => {
    await collectStatus({ ci: true, count: 5, fetch: false });
    expect(gitCalls().some((a) => a.includes('fetch'))).toBe(false);
  });

  it('runs every git status with --no-optional-locks, so it cannot refresh an index', async () => {
    await collectStatus(OPTIONS);
    const statuses = gitCalls().filter((a) => subcommand(a) === 'status');
    expect(statuses.length).toBeGreaterThan(5);
    for (const args of statuses) expect(args[0]).toBe('--no-optional-locks');
  });

  it('lists untracked files in every git status, whatever the repository config says', async () => {
    await collectStatus(OPTIONS);
    const statuses = gitCalls().filter((a) => subcommand(a) === 'status');
    expect(statuses.length).toBeGreaterThan(5);
    for (const args of statuses)
      expect(args).toContain('--untracked-files=normal');
  });

  it('counts submodule changes in every git status, as prune does, whatever the repository config says', async () => {
    await collectStatus(OPTIONS);
    const statuses = gitCalls().filter((a) => subcommand(a) === 'status');
    expect(statuses.length).toBeGreaterThan(5);
    for (const args of statuses)
      expect(args).toContain('--ignore-submodules=none');
  });
});

describe('collectStatus: the environment of git', () => {
  it('runs every git call without the variables a git hook exports, and with the rest', async () => {
    // A hook exports GIT_DIR and GIT_INDEX_FILE: inherited, they would aim
    // every `-C <dir>` call at the hook's repository.
    vi.stubEnv('GIT_DIR', '/hook/repo/.git');
    vi.stubEnv('GIT_INDEX_FILE', '/hook/repo/.git/index');
    vi.stubEnv('SESSION_STATUS_TEST_KEEP', 'yes');
    try {
      await collectStatus({ ...OPTIONS, ci: true });
      const envs = vi
        .mocked(execFile)
        .mock.calls.filter(([file]) => file === 'git')
        .map(([, , options]) => options.env);
      expect(envs.length).toBeGreaterThan(10);
      for (const env of envs) {
        expect(env).toBeDefined();
        expect(env).not.toHaveProperty('GIT_DIR');
        expect(env).not.toHaveProperty('GIT_INDEX_FILE');
        expect(env.SESSION_STATUS_TEST_KEEP).toBe('yes');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('collectStatus: --fetch', () => {
  it('runs `git fetch origin` once, before it reads origin/main', async () => {
    await collectStatus({ ...OPTIONS, fetch: true });
    const all = gitCalls();
    const fetches = all.filter((a) => a.includes('fetch'));
    expect(fetches).toEqual([['fetch', 'origin']]);
    const fetchAt = all.findIndex((a) => a[0] === 'fetch');
    const baseAt = all.findIndex((a) => a.includes('--git-common-dir'));
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(baseAt);
  });

  it('carries on with the old ref and reports the error when the fetch fails', async () => {
    world.fetch = new Failure(
      'fatal: unable to access: could not resolve host',
    );
    const result = await collectStatus({ ...OPTIONS, fetch: true });
    expect(result.fetchError).toMatch(/could not resolve host/);
    expect(result.worktrees.length).toBeGreaterThan(0);
  });

  it('reports no fetch error when it works, or when it did not run', async () => {
    expect(
      (await collectStatus({ ...OPTIONS, fetch: true })).fetchError,
    ).toBeNull();
    expect((await collectStatus(OPTIONS)).fetchError).toBeNull();
  });
});

describe('collectStatus: how stale origin/main is', () => {
  it('uses the FETCH_HEAD mtime of the shared git dir', async () => {
    const { base } = await collectStatus(OPTIONS);
    expect(base).toEqual({
      ref: 'origin/main',
      sha: world.baseSha,
      updatedAtMs: world.fetchHeadMtimeMs,
      source: 'FETCH_HEAD',
    });
    const looked = vi.mocked(statSync).mock.calls.map(([p]) => String(p));
    expect(looked).toContain('F:/dev/repo/.git/FETCH_HEAD');
  });

  it('falls back to the time the ref last moved when there is no FETCH_HEAD', async () => {
    world.fetchHeadMtimeMs = null;
    const { base } = await collectStatus(OPTIONS);
    expect(base.source).toBe('reflog');
    expect(base.updatedAtMs).toBe(world.reflogSeconds * 1000);
  });

  it('says the age is unknown when neither exists', async () => {
    world.fetchHeadMtimeMs = null;
    world.reflogSeconds = null;
    const { base } = await collectStatus(OPTIONS);
    expect(base).toMatchObject({ updatedAtMs: null, source: null });
  });
});

describe('collectStatus: git is not usable here', () => {
  it('throws SetupError when git is not installed', async () => {
    const spawnFailure = ENOENT();
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      callback(spawnFailure, '', '');
    });
    const error = await collectStatus(OPTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toMatch(/git.*not installed/);
    expect(error.cause).toBe(spawnFailure);
  });

  it('throws SetupError outside a git repository', async () => {
    world.listing = new Failure(
      'fatal: not a git repository (or any of the parent directories): .git',
    );
    const error = await collectStatus(OPTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toMatch(/not a git repository/);
    expect(error.cause).toBeInstanceOf(GitError);
    expect(error.cause.detail).toMatch(/not a git repository/);
  });

  it('throws SetupError, naming the fix, when origin/main does not exist', async () => {
    world.baseSha = null;
    const error = await collectStatus(OPTIONS).catch((e) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toMatch(/origin\/main/);
    expect(error.message).toMatch(/--fetch/);
    expect(error.cause).toBeInstanceOf(GitError);
  });

  it('lets an unexpected git failure through as itself, not as a setup problem', async () => {
    world.listing = new Failure('fatal: unable to read the index', 128);
    const error = await collectStatus(OPTIONS).catch((e) => e);
    expect(error).not.toBeInstanceOf(SetupError);
    expect(error.message).toMatch(/unable to read the index/);
  });
});

describe('collectStatus: recent pushes and CI', () => {
  const OPTIONS_CI = { ci: true, count: 5, fetch: false };

  it('reports the last five commits of origin/main, newest first, each with a verdict', async () => {
    const { recent } = await collectStatus(OPTIONS_CI);
    expect(recent).toHaveLength(5);
    expect(recent.map((r) => r.subject)).toEqual(SUBJECTS.slice(0, 5));
    expect(recent.map((r) => r.sha)).toEqual(
      world.log.slice(0, 5).map((c) => c.sha),
    );
    expect(recent.every((r) => r.verdict === 'success')).toBe(true);
  });

  it('gives each commit the verdict the watch-deploy logic reaches for its payloads', async () => {
    const [c1, c2, c3, c4, c5] = world.log.map((c) => c.sha);
    world.gh[c2] = snapshot((s) =>
      patchCheck(s, 'E2E Tests', { conclusion: 'failure' }),
    );
    world.gh[c3] = snapshot((s) =>
      patchCheck(s, 'App Quality Gate', {
        status: 'in_progress',
        conclusion: null,
      }),
    );
    world.gh[c4] = snapshot((s) =>
      patchStatus(s, 'Vercel', {
        state: 'error',
        description: 'Deployment canceled by a newer deployment',
      }),
    );

    const { recent } = await collectStatus(OPTIONS_CI);

    expect(recent.map((r) => [r.sha, r.verdict])).toEqual([
      [c1, 'success'],
      [c2, 'failure'],
      [c3, 'pending'],
      [c4, 'canceled-superseded'],
      [c5, 'success'],
    ]);
  });

  it('calls a commit with no check run "no-ci" when it is old, and "pending" when it is fresh', async () => {
    const [fresh, old] = world.log.slice(0, 2).map((c) => c.sha);
    const empty = snapshot((s) => {
      s.checkRuns.check_runs = [];
    });
    world.gh[fresh] = empty;
    world.gh[old] = empty;
    world.log[0].time = NOW_MS / 1000 - 30;

    const { recent } = await collectStatus(OPTIONS_CI);

    expect(recent.slice(0, 2).map((r) => r.verdict)).toEqual([
      'pending',
      'no-ci',
    ]);
  });

  it('never calls the tip of origin/main "no-ci", though its commit time is old: it may have just been pushed', async () => {
    const [tip, next] = world.log.slice(0, 2).map((c) => c.sha);
    const empty = snapshot((s) => {
      s.checkRuns.check_runs = [];
    });
    world.gh[tip] = empty;
    world.gh[next] = empty;
    // Made an hour ago, pushed a minute ago.
    world.log[0].time = NOW_MS / 1000 - 3600;

    const { recent } = await collectStatus(OPTIONS_CI);

    expect(recent[0]).toMatchObject({
      sha: tip,
      verdict: 'pending',
      details: ['no check runs reported yet'],
    });
    expect(recent[1].verdict).toBe('no-ci');
  });

  it('shows unknown, with the reason, for a commit whose gh call fails, and still reports the rest', async () => {
    const failing = world.log[1].sha;
    world.gh[failing] = new Failure('gh: HTTP 502: Bad Gateway', 1);

    const { recent } = await collectStatus(OPTIONS_CI);

    expect(recent[1].verdict).toBe('unknown');
    expect(recent[1].details.join(' ')).toMatch(/HTTP 502/);
    expect(recent.filter((r) => r.verdict === 'success')).toHaveLength(4);
  });

  it('shows unknown for every commit when gh is not installed', async () => {
    const real = vi.mocked(execFile).getMockImplementation();
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      if (file === 'gh') callback(ENOENT(), '', '');
      else real(file, args, options, callback);
    });

    const { recent } = await collectStatus(OPTIONS_CI);

    expect(recent).toHaveLength(5);
    expect(recent.every((r) => r.verdict === 'unknown')).toBe(true);
    expect(recent[0].details.join(' ')).toMatch(/gh.*not installed/);
  });

  it.each([
    ['a payload that is not JSON', '<html>Bad gateway</html>'],
    ['JSON of the wrong shape', '{"unexpected":true}'],
  ])('shows unknown for %s', async (_label, body) => {
    world.gh[world.log[0].sha] = body;
    const { recent } = await collectStatus(OPTIONS_CI);
    expect(recent[0].verdict).toBe('unknown');
    expect(recent[0].details.length).toBeGreaterThan(0);
    expect(recent[1].verdict).toBe('success');
  });

  it('shows unknown when origin is not a GitHub remote, without calling gh', async () => {
    world.remote = 'https://gitlab.example.com/o/n.git';
    const { recent } = await collectStatus(OPTIONS_CI);
    expect(recent.every((r) => r.verdict === 'unknown')).toBe(true);
    expect(recent[0].details.join(' ')).toMatch(/not a GitHub/);
    expect(ghCalls()).toEqual([]);
  });

  it('shows unknown when the origin remote cannot be read', async () => {
    world.remote = new Failure("error: No such remote 'origin'", 2);
    const { recent } = await collectStatus(OPTIONS_CI);
    expect(recent.every((r) => r.verdict === 'unknown')).toBe(true);
    expect(ghCalls()).toEqual([]);
  });

  it('asks gh for the status and the check runs of each commit, in one poll, with a short timeout', async () => {
    await collectStatus(OPTIONS_CI);
    const endpoints = ghCalls().map((c) => c[2]);
    expect(endpoints).toHaveLength(10);
    for (const { sha: commit } of world.log.slice(0, 5)) {
      expect(endpoints).toContain(
        `repos/o/n/commits/${commit}/status?per_page=100`,
      );
      expect(endpoints).toContain(
        `repos/o/n/commits/${commit}/check-runs?per_page=100`,
      );
    }
    const timeouts = vi
      .mocked(execFile)
      .mock.calls.filter(([file]) => file === 'gh')
      .map(([, , options]) => options.timeout);
    expect(new Set(timeouts)).toEqual(new Set([CI_CALL_TIMEOUT_MS]));
    expect(CI_CALL_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('--no-ci skips the section: no log, no remote lookup, no gh', async () => {
    const result = await collectStatus({ ci: false, count: 5, fetch: false });
    expect(result.recent).toBeNull();
    expect(ghCalls()).toEqual([]);
    const subcommands = gitCalls().map((a) =>
      a.find((x) => !x.startsWith('-')),
    );
    expect(subcommands).not.toContain('remote');
    expect(
      gitCalls().filter((a) => a[0] === 'log' && !a.includes('-1')),
    ).toEqual([]);
  });

  it('--count N reports N commits and polls gh for just those', async () => {
    const { recent } = await collectStatus({
      ci: true,
      count: 3,
      fetch: false,
    });
    expect(recent).toHaveLength(3);
    expect(ghCalls()).toHaveLength(6);
    expect(gitCalls().some((a) => a.includes('--max-count=3'))).toBe(true);
  });

  it('reports fewer commits than --count when origin/main has fewer', async () => {
    world.log = world.log.slice(0, 2);
    const { recent } = await collectStatus({
      ci: true,
      count: 5,
      fetch: false,
    });
    expect(recent).toHaveLength(2);
  });
});
