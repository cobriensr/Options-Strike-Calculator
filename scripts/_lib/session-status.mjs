/**
 * Read-only status of the work: the main checkout, every linked worktree
 * (ahead/behind origin/main, uncommitted files, last commit, and whether it
 * is merged and so a cleanup candidate) and the CI verdict of the last few
 * commits on origin/main. The CLI wrapper is scripts/session-status.mjs.
 *
 * The parsers, tagging and formatting are pure functions over git and gh
 * output. `collectStatus` runs the git and gh calls around them: git through
 * execFile with bounded concurrency (about 30 worktrees, one `git status`
 * each), the CI verdicts through watch-deploy's `fetchPayloads` and
 * `evaluateDeploy`, polled once and never waited for.
 *
 * Nothing here changes git state. Every git call is a read, `git status` runs
 * with --no-optional-locks so it cannot refresh an index, and the one write,
 * `git fetch origin`, runs only when `fetch` is set (the --fetch flag).
 *
 * "Merged" means no commit on the branch is missing from origin/main by patch
 * (`git cherry`), so a squashed or rebased branch counts, and no merge commit
 * of its own is missing either (`git cherry` skips merge commits, which can
 * carry conflict resolutions), and the tree is clean. Ancestry alone would
 * call every squash-merged branch unmerged.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { parseArgs as parseNodeArgs } from 'node:util';
import { GitError } from './git-run.mjs';
import { parseWorktreeList } from './prune-worktrees.mjs';
import {
  UsageError,
  evaluateDeploy,
  fetchPayloads,
  repoFromRemoteUrl,
} from './watch-deploy.mjs';

export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 50;

/**
 * Longest one `gh api` call may run. watch-deploy waits 60 s for a call
 * because it has nothing else to do; a status command should not sit that
 * long on one stalled connection.
 */
export const CI_CALL_TIMEOUT_MS = 15_000;

/** The ref every worktree is compared with. */
const BASE_REF = 'origin/main';

/**
 * Worktrees inspected at once, each running a `git status` and, for a branch
 * ahead of origin/main, a `git cherry`. On the 30-worktree repo this was
 * written for, 8 keeps the run to about a second without starting dozens of
 * git processes together.
 */
const WORKTREE_CONCURRENCY = 8;

/**
 * Commits named in one `git rev-list` command line. 200 ids are about 8 KB,
 * well under the 32 KB a Windows command line allows.
 */
const HEADS_PER_CALL = 200;

/**
 * How long a commit may have no check run before it is called "no-ci".
 * GitHub creates a push's check runs within seconds; ten minutes is far past
 * any queueing delay.
 */
export const NO_CI_AFTER_SEC = 10 * 60;

/** gh calls at once; each commit is two. */
const CI_CONCURRENCY = 5;

/** A long `git status` or ref list must not fail with ENOBUFS. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** Process exit codes of scripts/session-status.mjs. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  BAD_ARGS: 2,
  UNAVAILABLE: 3,
});

export const USAGE = [
  'usage: node scripts/session-status.mjs [--no-ci] [--count <n>] [--fetch]',
  '  Prints the main checkout, every worktree and the CI verdict of the last',
  `  commits on ${BASE_REF}. Read-only.`,
  '  --no-ci      skip the recent pushes section (no gh calls)',
  `  --count <n>  commits in that section, 1 to ${MAX_COUNT} (default ${DEFAULT_COUNT})`,
  `  --fetch      run \`git fetch origin\` first; the only thing that writes`,
  '  Exit 0 printed, 1 unexpected failure, 2 bad arguments,',
  `  3 git missing, not a repository, or no ${BASE_REF}.`,
].join('\n');

/** git cannot be used here: not installed, not a repository, no base ref. */
export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

// ---------------------------------------------------------------------------
// Arguments

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ ci: boolean, count: number, fetch: boolean, help: boolean }}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: argv,
      options: {
        'no-ci': { type: 'boolean', default: false },
        fetch: { type: 'boolean', default: false },
        count: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }

  let count = DEFAULT_COUNT;
  if (values.count !== undefined) {
    count = /^\d+$/.test(values.count) ? Number(values.count) : Number.NaN;
    if (!(count >= 1 && count <= MAX_COUNT)) {
      throw new UsageError(
        `--count must be a whole number from 1 to ${MAX_COUNT}, got "${values.count}"`,
      );
    }
  }
  return {
    ci: !values['no-ci'],
    count,
    fetch: values.fetch,
    help: values.help,
  };
}

// ---------------------------------------------------------------------------
// Parsers

/**
 * `git rev-list --left-right --count origin/main...<head>`: the commits only
 * in origin/main (behind), a tab, the commits only in head (ahead).
 *
 * @param {string} text
 * @returns {{ behind: number, ahead: number }}
 */
export function parseAheadBehind(text) {
  const match = /^(\d+)\s+(\d+)$/.exec(text.trim());
  if (match === null) {
    throw new Error(`git rev-list --count: unexpected output "${text.trim()}"`);
  }
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

/**
 * `git cherry origin/main <head>`: "+" for a commit whose patch is not in
 * origin/main, "-" for one that is (under another id). Merge commits are not
 * listed.
 *
 * @param {string} text
 * @returns {{ unmerged: number, equivalent: number }}
 */
export function parseCherry(text) {
  let unmerged = 0;
  let equivalent = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([+-]) \S+/.exec(line);
    if (match === null)
      throw new Error(`git cherry: unexpected line "${line}"`);
    if (match[1] === '+') unmerged += 1;
    else equivalent += 1;
  }
  return { unmerged, equivalent };
}

/**
 * The non-empty lines of `git status --porcelain`: one per changed or
 * untracked path.
 *
 * @param {string} text
 */
export function countLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/** Epoch seconds from `git log --format=%ct`. */
function parseSeconds(text) {
  const seconds = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(seconds)) {
    throw new Error(`git log: expected a commit time, got "${text.trim()}"`);
  }
  return seconds;
}

/**
 * `git log --format=%H%x09%ct%x09%s`.
 *
 * @param {string} text
 * @returns {{ sha: string, time: number, subject: string }[]}
 */
export function parseRecentCommits(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha = '', time = '', ...subject] = line.split('\t');
      if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(time)) {
        throw new Error(`git log: unexpected line "${line}"`);
      }
      return { sha, time: Number(time), subject: subject.join('\t') };
    });
}

// ---------------------------------------------------------------------------
// Tagging, naming, ordering

/**
 * What to say about one checkout. "merged" is the only cleanup candidate: its
 * work is in origin/main, its tree is clean, it is neither locked nor gone.
 * Anything else lists what needs a look. A worktree git could not read is
 * just "error".
 *
 * @param {{
 *   error: string | null,
 *   missing: boolean,
 *   locked: boolean,
 *   unborn: boolean,
 *   uncommitted: number | null,
 *   ahead: number | null,
 *   merged: boolean | null,
 * }} facts `merged`: every commit ahead is in origin/main by patch
 * @returns {{ tags: string[], cleanup: boolean }}
 */
export function tagWorktree(facts) {
  if (facts.error) return { tags: ['error'], cleanup: false };
  const tags = [];
  if (facts.missing) tags.push('missing');
  if (facts.locked) tags.push('locked');
  if (facts.unborn) tags.push('unborn');
  if (facts.uncommitted !== null && facts.uncommitted > 0) tags.push('dirty');
  if (facts.ahead !== null && facts.ahead > 0 && facts.merged === false) {
    tags.push(`ahead ${facts.ahead}`);
  }
  if (tags.length === 0) return { tags: ['merged'], cleanup: true };
  return { tags, cleanup: false };
}

/**
 * "just now", "12m ago", "5h ago", "3d ago"; "?" when unknown.
 *
 * @param {number | null} seconds
 */
export function formatAge(seconds) {
  if (seconds === null) return '?';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Forward slashes, no trailing slash. */
function slashes(p) {
  let out = p.replaceAll('\\', '/');
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * The path below `<main>/.worktrees/`, or the whole path for a worktree
 * kept elsewhere. Drive-letter paths compare without regard to case, as
 * Windows does.
 *
 * @param {string} wtPath
 * @param {string} mainPath
 */
export function worktreeName(wtPath, mainPath) {
  const full = slashes(wtPath);
  const prefix = `${slashes(mainPath)}/.worktrees/`;
  const windows = /^[a-z]:/i.test(full);
  const inside = windows
    ? full.toLowerCase().startsWith(prefix.toLowerCase())
    : full.startsWith(prefix);
  return inside ? full.slice(prefix.length) : full;
}

/** Order for `Array.sort` on `a.name`, `b.name`. */
function byName(a, b) {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * Cleanup candidates last. Within a group the newest last commit first (an
 * unknown time last), then by name.
 *
 * @template {{ name: string, lastCommitSec: number | null, cleanup: boolean }} Row
 * @param {Row[]} rows
 * @returns {Row[]}
 */
export function sortWorktrees(rows) {
  return [...rows].sort((a, b) => {
    if (a.cleanup !== b.cleanup) return a.cleanup ? 1 : -1;
    if (a.lastCommitSec !== b.lastCommitSec) {
      if (a.lastCommitSec === null) return 1;
      if (b.lastCommitSec === null) return -1;
      return b.lastCommitSec - a.lastCommitSec;
    }
    return byName(a, b);
  });
}

// ---------------------------------------------------------------------------
// CI verdict

/**
 * One commit's verdict from `evaluateDeploy`'s result. A single poll, so a
 * commit with something already failing reads "failure" even while other
 * checks still run (the failure will stand). "canceled-superseded" is a
 * commit whose only exception is a Vercel deploy that a newer commit
 * replaced; it hides nothing, since failure and pending win over it.
 *
 * "no-ci" is a commit with no check run that is older than NO_CI_AFTER_SEC.
 * GitHub runs the push workflows for the newest commit of a push only, so an
 * earlier commit of a multi-commit push never gets one, and watch-deploy's
 * "no check runs reported yet" would read "pending" for it forever.
 *
 * @param {ReturnType<typeof evaluateDeploy>} evaluation
 * @param {number} commitAgeSec seconds since the commit was made
 * @returns {{ verdict: 'success' | 'failure' | 'pending' | 'canceled-superseded' | 'no-ci', details: string[] }}
 */
export function summarizeCi(evaluation, commitAgeSec) {
  const details = [];
  if (evaluation.failing.length > 0) {
    details.push(`failing: ${evaluation.failing.join(', ')}`);
  }
  if (evaluation.pending.length > 0) {
    details.push(`waiting on ${evaluation.pending.join(', ')}`);
  } else if (evaluation.verdict === 'pending') {
    details.push('no check runs reported yet');
  }

  if (evaluation.failing.length > 0) return { verdict: 'failure', details };
  if (evaluation.verdict === 'pending') {
    const never =
      evaluation.checkNames.length === 0 &&
      evaluation.pending.length === 0 &&
      commitAgeSec > NO_CI_AFTER_SEC;
    return never
      ? {
          verdict: 'no-ci',
          details: ['no check runs: CI runs on the newest commit of a push'],
        }
      : { verdict: 'pending', details };
  }
  if (evaluation.canceled.length > 0) {
    return {
      verdict: 'canceled-superseded',
      details: [`superseded: ${evaluation.canceled.join(', ')}`],
    };
  }
  return { verdict: 'success', details };
}

// ---------------------------------------------------------------------------
// Formatting

/** Columns left-aligned, two spaces apart; the last column is not padded. */
function renderTable(headers, rows) {
  const all = headers === null ? rows : [headers, ...rows];
  const widths = all[0].map((_, col) =>
    Math.max(...all.map((row) => String(row[col]).length)),
  );
  return all.map((row) =>
    `  ${row.map((cell, col) => String(cell).padEnd(widths[col])).join('  ')}`.trimEnd(),
  );
}

/** Each row's line, then its detail lines indented under it. */
function withDetails(lines, details) {
  return lines.flatMap((line, i) => [
    line,
    ...(details[i] ?? []).map((detail) => `    ${detail}`),
  ]);
}

function keyValues(pairs) {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`);
}

const orQuestion = (value) => (value === null ? '?' : String(value));

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** How old the origin/main ref is, and where that came from. */
function describeBase(base, nowMs) {
  if (base.updatedAtMs === null) {
    return 'age unknown (no FETCH_HEAD or reflog)';
  }
  const age = formatAge((nowMs - base.updatedAtMs) / 1000);
  return base.source === 'FETCH_HEAD'
    ? `last fetched ${age} (FETCH_HEAD)`
    : `last moved ${age} (reflog; no FETCH_HEAD)`;
}

function mainLines(main) {
  const counts =
    main.ahead === null || main.behind === null
      ? '?'
      : `${main.ahead} ahead, ${main.behind} behind`;
  const pairs = [
    ['path', main.path],
    ['branch', main.branch ?? '(detached)'],
    ['vs origin', counts],
    [
      'uncommitted',
      main.uncommitted === null ? '?' : plural(main.uncommitted, 'file'),
    ],
  ];
  if (main.error) pairs.push(['error', main.error]);
  return keyValues(pairs);
}

function worktreeLines(worktrees, nowMs) {
  if (worktrees.length === 0) return ['  none'];
  const nowSec = nowMs / 1000;
  const rows = worktrees.map((wt) => [
    wt.name,
    wt.branch ?? '(detached)',
    wt.ahead === null ? '?' : `+${wt.ahead}/-${orQuestion(wt.behind)}`,
    orQuestion(wt.uncommitted),
    formatAge(wt.lastCommitSec === null ? null : nowSec - wt.lastCommitSec),
    wt.tags.join(', '),
  ]);
  const lines = renderTable(
    ['NAME', 'BRANCH', 'AHEAD/BEHIND', 'UNCOMMITTED', 'LAST COMMIT', 'TAG'],
    rows,
  );
  const details = [
    [],
    ...worktrees.map((wt) => (wt.error ? [`error: ${wt.error}`] : [])),
  ];
  return withDetails(lines, details);
}

function recentLines(recent) {
  if (recent.length === 0) return ['  none'];
  const rows = recent.map((c) => [c.sha.slice(0, 8), c.verdict, c.subject]);
  return withDetails(
    renderTable(null, rows),
    recent.map((c) => c.details),
  );
}

/**
 * The report as plain aligned text, no trailing newline.
 *
 * @param {Awaited<ReturnType<typeof collectStatus>>} report
 */
export function formatReport(report) {
  const { base, main, worktrees, recent, nowMs } = report;
  const lines = [
    `${base.ref}  ${base.sha.slice(0, 8)}  ${describeBase(base, nowMs)}`,
  ];
  if (report.fetchError !== null) {
    lines.push(`warning: git fetch origin failed: ${report.fetchError}`);
  }

  lines.push('', 'MAIN CHECKOUT', ...mainLines(main));

  const candidates = worktrees.filter((wt) => wt.cleanup).length;
  const note = candidates > 0 ? ` - cleanup candidates: ${candidates}` : '';
  lines.push('', `WORKTREES (${worktrees.length})${note}`);
  lines.push(...worktreeLines(worktrees, nowMs));

  if (recent !== null) {
    lines.push('', `RECENT PUSHES (${base.ref}, newest first)`);
    lines.push(...recentLines(recent));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Running git

/**
 * Run `git <args>` in the current directory; resolves to stdout. Rejects with
 * SetupError when git is not installed, GitError (stderr in `detail`)
 * otherwise.
 *
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function git(args) {
  return new Promise((resolve, reject) => {
    // `git` from PATH, as for every git command a developer runs. Arguments
    // go in an array, so nothing is shell-parsed.
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      'git',
      args,
      { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
        } else if (error.code === 'ENOENT') {
          reject(new SetupError('git is not installed or not on PATH'));
        } else {
          reject(new GitError(args, String(stderr).trim() || error.message));
        }
      },
    );
  });
}

/** Why a call failed, short: git's own stderr when it has one. */
function reason(err) {
  return err.detail ?? (err instanceof Error ? err.message : String(err));
}

/**
 * `fn` over `items`, at most `limit` at once; results in input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Collecting

/** Whether every commit ahead of origin/main is in it by patch. */
async function patchesAreInBase(head) {
  const { unmerged } = parseCherry(await git(['cherry', BASE_REF, head]));
  if (unmerged > 0) return false;
  const merge = await git([
    'rev-list',
    '--merges',
    '--max-count=1',
    head,
    `^${BASE_REF}`,
  ]);
  return merge.trim() === '';
}

/**
 * The commit time of every head, in epoch seconds, from one `git rev-list`
 * (a few, past HEADS_PER_CALL). --ignore-missing leaves out a commit git no
 * longer has, as of a long-deleted worktree, instead of failing the call.
 *
 * @param {string[]} heads distinct commit ids
 * @returns {Promise<Map<string, number>>}
 */
async function commitTimes(heads) {
  const times = new Map();
  for (let i = 0; i < heads.length; i += HEADS_PER_CALL) {
    const out = await git([
      'rev-list',
      '--ignore-missing',
      '--no-walk',
      '--timestamp',
      ...heads.slice(i, i + HEADS_PER_CALL),
    ]);
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue;
      const match = /^(\d+) ([0-9a-f]{40})$/.exec(line.trim());
      if (match === null) {
        throw new Error(`git rev-list --timestamp: unexpected line "${line}"`);
      }
      times.set(match[2], Number(match[1]));
    }
  }
  return times;
}

/**
 * Ahead/behind origin/main of every local branch tip, from one
 * `git for-each-ref`. The count belongs to the commit, so a worktree on a
 * branch (or detached at its tip) needs no call of its own. git older than
 * 2.41 does not know the `ahead-behind` field: the call fails, this returns
 * nothing, and each commit is counted on its own instead.
 *
 * @returns {Promise<Map<string, { ahead: number, behind: number }>>}
 */
async function branchAheadBehind() {
  const counts = new Map();
  let out;
  try {
    out = await git([
      'for-each-ref',
      `--format=%(objectname) %(ahead-behind:${BASE_REF})`,
      'refs/heads',
    ]);
  } catch (err) {
    if (err instanceof SetupError) throw err;
    return counts;
  }
  for (const line of out.split('\n')) {
    const match = /^([0-9a-f]{40}) (\d+) (\d+)$/.exec(line.trim());
    if (match !== null) {
      counts.set(match[1], {
        ahead: Number(match[2]),
        behind: Number(match[3]),
      });
    }
  }
  return counts;
}

/**
 * What git knows about each commit, for one run. Several worktrees can sit
 * on the same commit; a count or a merged check is made once and shared.
 *
 * @param {Map<string, number>} times
 * @param {Map<string, { ahead: number, behind: number }>} branchCounts
 */
function makeLookups(times, branchCounts) {
  const counts = new Map(
    [...branchCounts].map(([head, found]) => [head, Promise.resolve(found)]),
  );
  const merged = new Map();
  return {
    /** @param {string} head */
    time: (head) => times.get(head) ?? null,
    /** @param {string} head */
    counts(head) {
      let found = counts.get(head);
      if (found === undefined) {
        found = git([
          'rev-list',
          '--left-right',
          '--count',
          `${BASE_REF}...${head}`,
        ]).then(parseAheadBehind);
        counts.set(head, found);
      }
      return found;
    },
    /** @param {string} head */
    merged(head) {
      let found = merged.get(head);
      if (found === undefined) {
        found = patchesAreInBase(head);
        merged.set(head, found);
      }
      return found;
    },
  };
}

/** `git status --porcelain` in a checkout; read-only (see the module doc). */
function statusCount(wtPath) {
  return git([
    '--no-optional-locks',
    '-C',
    wtPath,
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ]).then(countLines);
}

/**
 * Ahead, behind and whether the commits ahead are in origin/main by patch.
 * A head with nothing ahead is merged without asking git.
 */
async function headFacts(head, lookups) {
  const { ahead, behind } = await lookups.counts(head);
  const merged = ahead === 0 || (await lookups.merged(head));
  return { ahead, behind, merged };
}

/**
 * Everything about one checkout. A git failure becomes `error`, not a throw,
 * so one broken worktree cannot hide the others.
 *
 * @param {{ path: string, head: string | null, branch: string | null, locked: string | null, prunable: string | null }} entry
 * @param {string} mainPath
 * @param {ReturnType<typeof makeLookups>} lookups
 */
async function inspectCheckout(entry, mainPath, lookups) {
  const { head } = entry;
  const missing = entry.prunable !== null || !existsSync(entry.path);
  const row = {
    name: worktreeName(entry.path, mainPath),
    path: entry.path,
    branch: entry.branch,
    head,
    ahead: null,
    behind: null,
    uncommitted: null,
    lastCommitSec: head === null ? null : lookups.time(head),
    error: null,
  };
  let merged = null;
  try {
    const [facts, uncommitted] = await Promise.all([
      head === null ? null : headFacts(head, lookups),
      missing ? null : statusCount(entry.path),
    ]);
    if (facts !== null) {
      ({ ahead: row.ahead, behind: row.behind, merged } = facts);
    }
    row.uncommitted = uncommitted;
  } catch (err) {
    row.error = reason(err);
  }

  const { tags, cleanup } = tagWorktree({
    error: row.error,
    missing,
    locked: entry.locked !== null,
    unborn: head === null,
    uncommitted: row.uncommitted,
    ahead: row.ahead,
    merged,
  });
  return { ...row, tags, cleanup };
}

/** Newest time FETCH_HEAD was written, or undefined when it cannot be read. */
function fetchHeadMtime(commonDir) {
  try {
    return statSync(`${commonDir}/FETCH_HEAD`, { throwIfNoEntry: false })
      ?.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * When origin/main was last brought up to date. FETCH_HEAD is written by
 * every `git fetch`, even one that changed nothing, so its mtime is the last
 * fetch; the reflog only knows when the ref last moved, which can be days
 * ago on a quiet branch. FETCH_HEAD lives in the shared git dir, so any
 * worktree sees the same one.
 */
async function baseFreshness() {
  const commonDir = await git([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).then(
    (out) => out.trim(),
    () => null,
  );
  const mtime = commonDir === null ? undefined : fetchHeadMtime(commonDir);
  if (mtime !== undefined) return { updatedAtMs: mtime, source: 'FETCH_HEAD' };

  const moved = await git([
    'reflog',
    'show',
    '--format=%ct',
    '--max-count=1',
    `refs/remotes/${BASE_REF}`,
  ]).then(
    (out) => parseSeconds(out) * 1000,
    () => null,
  );
  return moved === null
    ? { updatedAtMs: null, source: null }
    : { updatedAtMs: moved, source: 'reflog' };
}

/** `owner/name` of origin, or why it could not be had. */
async function githubRepo() {
  try {
    const repo = repoFromRemoteUrl(await git(['remote', 'get-url', 'origin']));
    if (repo !== null) return { repo, problem: null };
    return {
      repo: null,
      problem: 'the origin remote is not a GitHub repository',
    };
  } catch (err) {
    return {
      repo: null,
      problem: `cannot read the origin remote: ${reason(err)}`,
    };
  }
}

/** One commit's verdict. A failed gh call or odd payload is "unknown". */
async function ciFor(repo, problem, commit) {
  if (repo === null) return { verdict: 'unknown', details: [problem] };
  try {
    const payloads = await fetchPayloads(repo, commit.sha, CI_CALL_TIMEOUT_MS);
    const ageSec = Date.now() / 1000 - commit.time;
    return summarizeCi(evaluateDeploy(payloads), ageSec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { verdict: 'unknown', details: [message] };
  }
}

/** The last `count` commits of origin/main with one CI poll each. */
async function collectRecent(count) {
  const log = await git([
    'log',
    `--max-count=${count}`,
    '--format=%H%x09%ct%x09%s',
    BASE_REF,
  ]);
  const commits = parseRecentCommits(log);
  const { repo, problem } = await githubRepo();
  return mapLimit(commits, CI_CONCURRENCY, async (commit) => ({
    sha: commit.sha,
    subject: commit.subject,
    time: commit.time,
    ...(await ciFor(repo, problem, commit)),
  }));
}

/** The linked and main worktrees, main first. */
async function listWorktrees() {
  let text;
  try {
    text = await git(['worktree', 'list', '--porcelain', '-z']);
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.detail)) {
      throw new SetupError(`not a git repository: ${err.detail}`, {
        cause: err,
      });
    }
    throw err;
  }
  return parseWorktreeList(text);
}

/** The commit origin/main points at. */
async function resolveBase() {
  try {
    return (
      await git(['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`])
    ).trim();
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError(
      `no ${BASE_REF} ref here; run \`git fetch origin\` or pass --fetch`,
      { cause: err },
    );
  }
}

/**
 * Gather the report. Throws SetupError when git cannot be used here, and
 * lets any other failure of the listing calls through.
 *
 * @param {{ ci: boolean, count: number, fetch: boolean }} options
 */
export async function collectStatus({ ci, count, fetch }) {
  const entries = await listWorktrees();
  const [mainEntry, ...others] = entries;
  if (mainEntry === undefined) throw new SetupError('git lists no worktree');

  let fetchError = null;
  if (fetch) {
    fetchError = await git(['fetch', 'origin']).then(
      () => null,
      (err) => reason(err),
    );
  }
  const baseSha = await resolveBase();

  const heads = [
    ...new Set(entries.map((e) => e.head).filter((h) => h !== null)),
  ];
  const checkouts = Promise.all([commitTimes(heads), branchAheadBehind()]).then(
    ([times, counts]) => {
      const lookups = makeLookups(times, counts);
      return Promise.all([
        inspectCheckout(mainEntry, mainEntry.path, lookups),
        mapLimit(others, WORKTREE_CONCURRENCY, (entry) =>
          inspectCheckout(entry, mainEntry.path, lookups),
        ),
      ]);
    },
  );
  const [freshness, [mainRow, rows], recent] = await Promise.all([
    baseFreshness(),
    checkouts,
    ci ? collectRecent(count) : null,
  ]);

  return {
    nowMs: Date.now(),
    base: { ref: BASE_REF, sha: baseSha, ...freshness },
    fetchError,
    main: {
      path: mainRow.path,
      branch: mainRow.branch,
      ahead: mainRow.ahead,
      behind: mainRow.behind,
      uncommitted: mainRow.uncommitted,
      error: mainRow.error,
    },
    worktrees: sortWorktrees(rows),
    recent,
  };
}
