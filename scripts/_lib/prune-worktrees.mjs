/**
 * Remove finished worktrees under <repo>/.worktrees/. The CLI wrapper is
 * scripts/prune-merged-worktrees.mjs (`npm run worktrees:prune`).
 *
 * A worktree is removed only when all of these hold:
 * - it is not locked;
 * - the current directory is not inside it, and it does not have main
 *   checked out;
 * - it has at least one commit;
 * - every commit on its HEAD is already in the local main by patch id
 *   (`git cherry`), and no merge commit on it is missing from main
 *   (`git cherry` skips merge commits, which can carry changes of their own);
 * - it has been idle for at least MIN_IDLE_HOURS, where idle counts the admin
 *   dir's index and logs/HEAD and also the newest file in its gitignored
 *   `.superpowers/` ledger (a controller writes it for days without a git
 *   command);
 * - `git status` is clean;
 * - no rebase, merge, cherry-pick, revert or bisect is in progress in it (a
 *   stopped sequence of several picks or reverts included): a paused
 *   `rebase -i` leaves a clean tree and a HEAD that looks merged, with the
 *   commits still to replay only in the worktree's admin dir;
 * - it has no gitignored scratch files in docs/tmp/, which a removal would
 *   delete;
 * - its HEAD did not move while it was being checked;
 * - its `.superpowers/` ledger, if it holds a file, holds no link or other
 *   special file, and is copied out safely (next paragraph).
 * checkInUse, checkSettled and pruneName (the .worktrees/ scope test) are
 * exported so that scripts/_lib/session-status.mjs asks the same questions:
 * "safe to remove" has one definition.
 * The ledger (briefs, reviews and rulings of a subagent-driven session) is
 * gitignored, so `git worktree remove` would delete it. Before removing, its
 * files are copied to <repo>/docs/tmp/worktree-ledgers/<name>/, the main
 * checkout's gitignored scratch folder: into a temporary sibling folder,
 * checked file by file against the source, then renamed into place, so a half
 * copy never sits under the final name. A folder already there with exactly
 * the same files and bytes counts as the copy; any other is never touched,
 * and the copy goes to <name>-<UTC timestamp> instead. Links are never
 * followed (lstat only). Any error keeps the worktree, and so does a ledger
 * file that changed between the copy and the removal. A dry run reads the
 * ledger and writes nothing. A worktree with no ledger file is untouched by
 * all of this.
 * Removal is `git worktree remove` without --force, then any link it left
 * behind and the emptied folder (on Windows git leaves an ignored
 * node_modules junction: see clearLeftover), then `git branch -D` on its
 * branch if that still points at the checked HEAD. A folder that still holds
 * anything but links after that is reported as kept, not as removed.
 * git's own check before removing honours status.showUntrackedFiles, so with
 * `no` it would delete untracked files: the guard is this module's explicit
 * `--untracked-files=normal` status check above, not git's.
 *
 * Worktrees outside .worktrees/ are never checked or removed, but the one
 * `git worktree prune` at the end of a real run clears the admin entry of
 * every unlocked worktree whose directory is already gone, wherever it was.
 * Spec: docs/superpowers/specs/worktree-auto-prune-2026-10-27.md.
 */
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
  unlinkSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';
import {
  GitError,
  git as gitWithEnv,
  runGit as runGitWithEnv,
} from './git-run.mjs';

/**
 * Default idle floor, picked 2026-10-27: longer than a typical gap between
 * phases, shorter than the 2-3 days over which worktrees piled up.
 */
export const MIN_IDLE_HOURS = 24;

/** The folder under the repo root whose worktrees may be removed. */
const WORKTREES_DIR = '.worktrees';

/** The local base branch. An unpushed cherry-pick onto it counts as merged. */
const BASE_BRANCH = 'main';
const BASE_REF = `refs/heads/${BASE_BRANCH}`;

/** Gitignored, so clean to git, but sessions keep scratch reports there. */
const SCRATCH_DIR = 'docs/tmp';

/** A worktree's gitignored ledger: a controller's briefs, reviews, rulings. */
const LEDGER_DIR = '.superpowers';

/** Under the repo root, where a removed worktree's ledger is copied. */
const LEDGER_COPIES_DIR = `${SCRATCH_DIR}/worktree-ledgers`;

const HOUR_MS = 60 * 60 * 1000;

/** Commits or paths named in a kept reason; the rest are counted. */
const MAX_NAMED = 3;

/**
 * Env vars that tie git to one repository, index or object store: the list
 * `git rev-parse --local-env-vars` prints. A git hook exports some of them
 * (GIT_DIR, GIT_INDEX_FILE), and inherited they would aim every `-C <dir>`
 * call below at the hook's repository instead of the worktree named.
 */
const LOCAL_ENV_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/**
 * The env for every git call here: process.env without LOCAL_ENV_VARS, read
 * at call time. Exported for scripts/_lib/session-status.mjs, which runs git
 * asynchronously and so cannot use this module's runGit and git.
 */
export function gitEnv() {
  const env = { ...process.env };
  for (const name of LOCAL_ENV_VARS) delete env[name];
  return env;
}

/** Shared runGit, always with gitEnv(): no call here can pass another env. */
function runGit(args) {
  return runGitWithEnv(args, gitEnv());
}

/** Shared git, always with gitEnv(): no call here can pass another env. */
function git(args) {
  return gitWithEnv(args, gitEnv());
}

/** Non-empty output lines. */
function lines(text) {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** The commit `ref` points at, or null when the ref does not exist. */
function refSha(root, ref) {
  const args = [
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ];
  const { status, stdout, stderr } = runGit(args);
  if (status === 0) return stdout.trim();
  // --verify --quiet exits 1 with no output for a missing ref; anything
  // else is a real failure.
  if (status === 1 && stderr.trim() === '') return null;
  throw new GitError(args, stderr.trim() || `exit code ${status}`);
}

function newRecord(field) {
  return {
    path: field.slice('worktree '.length),
    head: null,
    branch: null,
    bare: false,
    locked: null,
    prunable: null,
  };
}

/** Apply one `key value` field of a record. Unknown keys are ignored. */
function readField(record, field) {
  const space = field.indexOf(' ');
  const key = space === -1 ? field : field.slice(0, space);
  const value = space === -1 ? '' : field.slice(space + 1);
  switch (key) {
    case 'HEAD':
      // An unborn (orphan) branch is listed as forty zeros.
      record.head = /^0+$/.test(value) ? null : value;
      break;
    case 'branch':
      record.branch = value.replace(/^refs\/heads\//, '');
      break;
    case 'bare':
      record.bare = true;
      break;
    case 'locked':
      record.locked = value;
      break;
    case 'prunable':
      record.prunable = value;
      break;
    default:
      break;
  }
}

/**
 * Parse `git worktree list --porcelain -z`: one NUL after each field, one
 * more after each record, paths unquoted. Returns, main worktree first,
 * `{ path, head, branch, bare, locked, prunable }` per worktree. head is null
 * when there is no commit yet (an unborn branch). branch is the short name,
 * or null when detached. locked and prunable are null, or git's reason (''
 * when it gave none). Throws on a field before the first `worktree` line,
 * which would mean git changed the format.
 */
export function parseWorktreeList(text) {
  const worktrees = [];
  let record = null;
  for (const field of text.split('\0')) {
    if (field === '') {
      if (record !== null) worktrees.push(record);
      record = null;
    } else if (field.startsWith('worktree ')) {
      if (record !== null) worktrees.push(record);
      record = newRecord(field);
    } else if (record === null) {
      throw new Error(
        `git worktree list: unexpected "${field}" before the first worktree line`,
      );
    } else {
      readField(record, field);
    }
  }
  if (record !== null) worktrees.push(record);
  return worktrees;
}

function listWorktrees(dir) {
  return parseWorktreeList(
    git(['-C', dir, 'worktree', 'list', '--porcelain', '-z']),
  );
}

/**
 * The main worktree of the repository containing `cwd`, which may be a
 * linked worktree. Throws a git error outside a repository.
 */
export function findRepoRoot(cwd) {
  const [main] = listWorktrees(cwd);
  if (main === undefined || main.bare) {
    throw new Error(`no main worktree for ${cwd} (bare repository?)`);
  }
  return path.resolve(main.path);
}

/**
 * `child` relative to `parent` ('' when they are the same path), or null when
 * `child` is outside `parent`. path.relative compares case-insensitively on
 * win32, so `f:\x` and `F:/x` match: git prints forward-slash paths whose
 * drive-letter case can differ from ours.
 */
function pathWithin(parent, child) {
  const rel = path.relative(parent, child);
  const outside =
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside ? null : rel;
}

/**
 * The name prune gives a worktree: its path below `<repoRoot>/.worktrees/`,
 * with forward slashes. Null when prune never checks or removes it: the main
 * worktree, `.worktrees/` itself, anything outside that folder. Exported for
 * scripts/_lib/session-status.mjs, so that "prune would remove it" has one
 * scope test.
 */
export function pruneName(repoRoot, wtPath) {
  const scope = path.join(path.resolve(repoRoot), WORKTREES_DIR);
  const rel = pathWithin(scope, path.resolve(wtPath));
  return rel ? rel.split(path.sep).join('/') : null;
}

/** A worktree whose checkout, or its .git file, has been deleted. */
function isGone(wtPath) {
  return !existsSync(path.join(wtPath, '.git'));
}

/** One decimal, truncated so 23.96h never prints as "24.0h". */
function formatHours(hours) {
  return `${(Math.floor(hours * 10) / 10).toFixed(1)}h`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** First items of a list, then "and N more". */
function sample(items, describeItem) {
  const named = items.slice(0, MAX_NAMED).map(describeItem).join(', ');
  const more = items.length - MAX_NAMED;
  return more > 0 ? `${named} and ${more} more` : named;
}

function shortSha(sha) {
  return sha.slice(0, 10);
}

/** SHAs on `head` whose patch is not in main (`+` lines of git cherry). */
function unmergedCommits(root, head) {
  return lines(git(['-C', root, 'cherry', BASE_REF, head]))
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1).trim());
}

/** A merge commit on `head` that main does not contain, or null. */
function unmergedMerge(root, head) {
  const out = git([
    '-C',
    root,
    'rev-list',
    '--merges',
    '--max-count=1',
    head,
    `^${BASE_REF}`,
  ]).trim();
  return out === '' ? null : out;
}

/** The worktree's own admin dir (.git, or .git/worktrees/<name>). */
function adminDirOf(wtPath) {
  return git(['-C', wtPath, 'rev-parse', '--absolute-git-dir']).trim();
}

/** `a.rel` before `b.rel`, whatever the folder's listing order was. */
function byRel(a, b) {
  return a.rel.localeCompare(b.rel);
}

/**
 * Every file under `top` as `{ rel, size, mtimeMs }`, `rel` with forward
 * slashes, sorted; and `odd`, the sorted `rel` of everything else that is not
 * a folder: a symlink, a junction, a device. It uses lstat only, so it never
 * enters a link: a junction in a worktree can point into the main checkout
 * (see clearLeftover). A `top` that is itself no folder reads as
 * `odd: ['']`.
 */
function walkTree(top) {
  const files = [];
  const odd = [];
  if (!lstatSync(top).isDirectory()) return { files, odd: [''] };
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of readdirSync(path.join(top, dir))) {
      const rel = dir === '' ? name : `${dir}/${name}`;
      const found = lstatSync(path.join(top, rel));
      if (found.isDirectory()) {
        pending.push(rel);
      } else if (found.isFile()) {
        files.push({ rel, size: found.size, mtimeMs: found.mtimeMs });
      } else {
        odd.push(rel);
      }
    }
  }
  return {
    files: files.sort(byRel),
    odd: odd.sort((a, b) => a.localeCompare(b)),
  };
}

/** The worktree's `.superpowers/` as walkTree reads it, or null if it has none. */
function readLedger(wtPath) {
  const top = path.join(wtPath, LEDGER_DIR);
  return lstatSync(top, { throwIfNoEntry: false }) === undefined
    ? null
    : walkTree(top);
}

/** A ledger path as a session knows it: relative to the worktree. */
function ledgerPath(rel) {
  return rel === '' ? LEDGER_DIR : `${LEDGER_DIR}/${rel}`;
}

/**
 * Hours since the newest mtime of the admin dir's `index` and `logs/HEAD`, or
 * of any file in the worktree's `.superpowers/` ledger; null when neither
 * admin file exists, which no ledger can make up for. A clock that runs
 * behind a file's mtime reads as 0, not negative.
 */
function idleHours(admin, wtPath) {
  const mtimes = [path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD')]
    .map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs)
    .filter((mtime) => mtime !== undefined);
  if (mtimes.length === 0) return null;
  for (const file of readLedger(wtPath)?.files ?? []) mtimes.push(file.mtimeMs);
  const newest = mtimes.reduce((a, b) => Math.max(a, b));
  return Math.max(0, Date.now() - newest) / HOUR_MS;
}

/**
 * `git status --porcelain` lines. --no-optional-locks stops status from
 * refreshing the index, which would reset the idle clock. The explicit
 * untracked and submodule modes override any config that would hide changes.
 */
function uncommittedPaths(wtPath) {
  return lines(
    git([
      '--no-optional-locks',
      '-C',
      wtPath,
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--ignore-submodules=none',
    ]),
  );
}

/** Gitignored files under docs/tmp/, which `git worktree remove` deletes. */
function scratchFiles(wtPath) {
  return lines(
    git([
      '-C',
      wtPath,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      SCRATCH_DIR,
    ]),
  );
}

/**
 * What git leaves in a worktree's admin dir while a command is stopped: the
 * file or folder, and the command. Any of them can sit with a clean tree and
 * a HEAD already in main (a `rebase -i` stopped at `break` is at the commit
 * it rebases onto), the work still to do kept only here.
 */
const IN_PROGRESS = Object.freeze([
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  // The queue of a cherry-pick or revert of several commits. A stop on an
  // empty pick or revert leaves it alone (a revert writes no REVERT_HEAD
  // then), and so does a commit made in the middle of the sequence.
  ['sequencer', 'cherry-pick or revert'],
  ['BISECT_LOG', 'bisect'],
]);

/** The command stopped in the worktree with this admin dir, or null. */
function operationInProgress(admin) {
  const found = IN_PROGRESS.find(([marker]) =>
    existsSync(path.join(admin, marker)),
  );
  return found === undefined ? null : found[1];
}

/**
 * Whether a session is working in the worktree right now, from what the
 * caller knows without reading its files: the current directory, and which
 * branch it has out. `entry` is `{ path, branch }`.
 *
 * Returns `{ keep, kind }` with kind 'cwd' or 'base-branch', or
 * `{ keep: null }` when nothing says it is in use.
 */
export function checkInUse(entry, cwd) {
  if (pathWithin(entry.path, cwd) !== null) {
    return { keep: 'the current directory is inside it', kind: 'cwd' };
  }
  if (entry.branch === BASE_BRANCH) {
    return { keep: `it has ${BASE_BRANCH} checked out`, kind: 'base-branch' };
  }
  return { keep: null };
}

/**
 * The checks on a worktree that hold whatever commits it has: idle for at
 * least `minIdleHours` (the git clocks and the newest file in its
 * `.superpowers/` ledger, read without following a link), a clean
 * `git status`, no stopped rebase, merge, cherry-pick, revert or bisect, no
 * gitignored scratch files. Cheapest first; `git status` on a full checkout
 * is the slow one.
 *
 * Returns `{ keep: null, idle }` (idle in hours) when all pass, else
 * `{ keep, kind }`: the reason, and the kind 'idle-unknown', 'idle' (with
 * `idle`), 'dirty', 'in-progress' (with `operation`) or 'scratch'.
 *
 * `statusKnownClean` skips the `git status` run, for a caller that has just
 * read the status itself.
 *
 * @param {string} wtPath
 * @param {{ minIdleHours?: number, statusKnownClean?: boolean }} [options]
 */
export function checkSettled(
  wtPath,
  { minIdleHours = MIN_IDLE_HOURS, statusKnownClean = false } = {},
) {
  const admin = adminDirOf(wtPath);
  const idle = idleHours(admin, wtPath);
  if (idle === null) {
    return {
      keep: 'idle time unknown: no admin index or logs/HEAD',
      kind: 'idle-unknown',
    };
  }
  if (idle < minIdleHours) {
    return {
      keep: `idle ${formatHours(idle)}, under the ${minIdleHours}h minimum`,
      kind: 'idle',
      idle,
    };
  }
  if (!statusKnownClean) {
    const dirty = uncommittedPaths(wtPath);
    if (dirty.length > 0) {
      return {
        keep: `uncommitted changes: ${sample(dirty, (line) => line.trim())}`,
        kind: 'dirty',
      };
    }
  }
  const operation = operationInProgress(admin);
  if (operation !== null) {
    return {
      keep: `${operation} in progress`,
      kind: 'in-progress',
      operation,
    };
  }
  const scratch = scratchFiles(wtPath);
  if (scratch.length > 0) {
    return {
      keep: `ignored scratch files in ${SCRATCH_DIR}/: ${sample(scratch, (file) => file)}`,
      kind: 'scratch',
    };
  }
  return { keep: null, idle };
}

/**
 * `{ keep: reason }` when `entry` must be kept, else `{ keep: null, idle }`.
 * The commit checks first, then checkSettled. The HEAD re-read comes last,
 * so a commit made during the checks is caught.
 */
function checkWorktree(entry, { root, minIdleHours }) {
  if (entry.head === null) return { keep: 'no commits yet' };
  const unmerged = unmergedCommits(root, entry.head);
  if (unmerged.length > 0) {
    return {
      keep: `${plural(unmerged.length, 'commit')} not in ${BASE_BRANCH}: ${sample(unmerged, shortSha)}`,
    };
  }
  const merge = unmergedMerge(root, entry.head);
  if (merge !== null) {
    return { keep: `merge commit not in ${BASE_BRANCH}: ${shortSha(merge)}` };
  }
  const settled = checkSettled(entry.path, { minIdleHours });
  if (settled.keep !== null) return settled;
  const head = git(['-C', entry.path, 'rev-parse', 'HEAD']).trim();
  if (head !== entry.head) return { keep: 'HEAD moved during the check' };
  return { keep: null, idle: settled.idle };
}

/** Its checkout is already deleted; `git worktree prune` clears the entry. */
function alreadyGone(entry, { dryRun }, why) {
  const branchNote =
    entry.branch === null ? '' : `; branch ${entry.branch} kept`;
  return {
    ...entry,
    action: dryRun ? 'would-remove' : 'removed',
    reason: `${why}${branchNote}`,
  };
}

/**
 * Delete the branch of a removed worktree, unless it no longer points at the
 * HEAD that passed the checks. Only the run whose `git worktree remove`
 * succeeded gets here, so a failure is a plain error.
 */
function deleteBranch(entry, ctx, removed) {
  const { branch } = entry;
  try {
    const sha = refSha(ctx.root, `refs/heads/${branch}`);
    if (sha === null) {
      return { ...removed, reason: `branch ${branch} was already deleted` };
    }
    if (sha !== entry.head) {
      return {
        ...removed,
        reason: `branch ${branch} kept: it moved to ${sha} after the merge check`,
      };
    }
    git(['-C', ctx.root, 'branch', '-D', branch]);
    return { ...removed, deletedBranchSha: sha };
  } catch (err) {
    ctx.errors.push(`${entry.name}: ${err.message}`);
    return {
      ...removed,
      reason: `branch ${branch} not deleted: ${err.detail ?? err.message}`,
    };
  }
}

/**
 * Clear what `git worktree remove` left of a worktree it reported removing.
 * On Windows git exits 0 and prints nothing, yet leaves an ignored
 * node_modules junction and its folder (git 2.55.0.windows.5), after dropping
 * the worktree: no later run would list the folder, and the name could not be
 * reused.
 *
 * Only links are deleted, and never followed: a junction's target is the main
 * checkout's node_modules. So every call is non-recursive: lstat to tell a link
 * from anything else, unlink on the link itself, rmdir on the folder once it
 * is empty. Never `rmSync` or any call that can walk through a link.
 *
 * Returns null when the folder is gone or was emptied and removed, else why
 * it is kept: the caller reports that instead of a clean removal.
 */
function clearLeftover(wtPath) {
  const stuck = [];
  try {
    const folder = lstatSync(wtPath, { throwIfNoEntry: false });
    if (folder === undefined) return null;
    if (!folder.isDirectory()) {
      return `git worktree remove left ${wtPath}, which is not a folder`;
    }
    for (const name of readdirSync(wtPath)) {
      const file = path.join(wtPath, name);
      try {
        const kind = lstatSync(file, { throwIfNoEntry: false });
        if (kind === undefined) continue;
        if (kind.isSymbolicLink()) unlinkSync(file);
        else stuck.push(name);
      } catch (err) {
        stuck.push(`could not delete ${name} (${err.message})`);
      }
    }
    if (stuck.length === 0) {
      try {
        rmdirSync(wtPath);
      } catch (err) {
        return `git worktree remove left ${wtPath}: could not delete the folder (${err.message})`;
      }
      return null;
    }
  } catch (err) {
    return `git worktree remove left ${wtPath}: could not clear it (${err.message})`;
  }
  return `git worktree remove left files at ${wtPath}: ${sample(stuck, (item) => item)}`;
}

/**
 * Why `copy` is not a copy of `files`, which were read from `source`: a link
 * or special file in it, a file missing or extra, or a file whose bytes
 * differ. Null when it holds exactly those files with the same bytes. Reads
 * `copy` without following a link.
 */
function treeDifference(source, files, copy) {
  const found = walkTree(copy);
  if (found.odd.length > 0) {
    return `a link or special file: ${sample(found.odd, (rel) => rel || '.')}`;
  }
  const have = new Set(found.files.map((file) => file.rel));
  const want = new Set(files.map((file) => file.rel));
  const missing = files.filter((file) => !have.has(file.rel));
  if (missing.length > 0) return `missing ${sample(missing, (f) => f.rel)}`;
  const extra = found.files.filter((file) => !want.has(file.rel));
  if (extra.length > 0) return `unexpected ${sample(extra, (f) => f.rel)}`;
  const differing = files.filter(
    (file) =>
      !readFileSync(path.join(source, file.rel)).equals(
        readFileSync(path.join(copy, file.rel)),
      ),
  );
  if (differing.length > 0) {
    return `bytes differ in ${sample(differing, (f) => f.rel)}`;
  }
  return null;
}

/** `20261116T215301Z`: the suffix of a copy that cannot take the plain name. */
function utcStamp() {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * What to do with the ledger of a worktree that passed every check, from
 * reading it and what the copies folder already holds; writes nothing.
 *
 * - `{ none: true }`: no ledger, or one with no file in it.
 * - `{ keep }`: a link or special file in it, never followed or copied.
 * - `{ state: 'identical', files, dest }`: the folder `dest` already holds
 *   exactly these files with these bytes, so there is nothing to copy.
 * - `{ state: 'copy', files, source, copies, tmp, dest }`: copy `files` from
 *   `source` into the temporary folder `tmp` beside `dest`, then rename it
 *   to `dest`: <name>, or <name>-<UTC timestamp> when a different copy
 *   already has that name. Never a merge into, or replacement of, a folder
 *   that exists. A worktree name with a `/` is flattened to `__`, or its copy
 *   would land inside the copy of another worktree.
 */
function planLedger(entry, root) {
  const ledger = readLedger(entry.path);
  if (ledger === null) return { none: true };
  const { files, odd } = ledger;
  if (odd.length > 0) {
    return {
      keep: `ledger holds a link or special file: ${sample(odd, ledgerPath)}`,
    };
  }
  if (files.length === 0) return { none: true };

  const source = path.join(entry.path, LEDGER_DIR);
  const copies = path.join(root, ...LEDGER_COPIES_DIR.split('/'));
  const folder = entry.name.split('/').join('__');
  const named = path.join(copies, folder);
  // lstat: a link at that name, even a dangling one, is something else's.
  // treeDifference reads a file or link there as different, never entering it.
  const there = lstatSync(named, { throwIfNoEntry: false });
  if (there !== undefined && treeDifference(source, files, named) === null) {
    return { state: 'identical', files, dest: named };
  }
  return {
    state: 'copy',
    files,
    source,
    copies,
    tmp: path.join(copies, `.${folder}.copying-${process.pid}-${Date.now()}`),
    dest: there === undefined ? named : `${named}-${utcStamp()}`,
  };
}

/** The result field for a ledger, as a dry run says it: planned, not done. */
function previewLedger(plan) {
  if (plan.state === undefined) return undefined;
  return {
    dest: plan.dest,
    files: plan.files.length,
    state: plan.state === 'copy' ? 'would-copy' : 'identical',
  };
}

/**
 * `planLedger`, with a failure turned into a keep: the error is recorded as
 * every other failure is, and the worktree stays.
 */
function prepareLedger(entry, ctx) {
  try {
    return planLedger(entry, ctx.root);
  } catch (err) {
    return ledgerFailure(entry, ctx, 'copy', err);
  }
}

/** `{ keep }` for a failed ledger step, and the error in the run's errors. */
function ledgerFailure(entry, ctx, step, err, ledger) {
  const reason = `ledger ${step} failed: ${err.message}`;
  ctx.errors.push(`${entry.name}: ${reason}`);
  return { keep: reason, ledger };
}

/**
 * Delete a folder this module made, and what it holds. Every call is
 * non-recursive and a link is only ever unlinked, never entered, so nothing
 * outside the folder can be reached: the same rule as clearLeftover.
 */
function removeCopyTree(dir) {
  for (const name of readdirSync(dir)) {
    const item = path.join(dir, name);
    if (lstatSync(item).isDirectory()) removeCopyTree(item);
    else unlinkSync(item);
  }
  rmdirSync(dir);
}

/**
 * Copy the planned files into the empty temporary folder `tmp`, each with
 * the mtime of its source: a ledger's dates say when its work happened.
 */
function copyFiles({ files, source, tmp }) {
  for (const file of files) {
    const to = path.join(tmp, file.rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(source, file.rel), to);
    const when = new Date(file.mtimeMs);
    utimesSync(to, when, when);
  }
}

/**
 * Make `plan.dest` a verified copy of the ledger: build it in `plan.tmp`,
 * check every file against its source, and only then rename it into place.
 * On any failure the temporary folder is deleted, and one that cannot be is
 * named in the error. Throws.
 */
function placeCopy(plan) {
  mkdirSync(plan.copies, { recursive: true });
  // Not recursive, so a name that is taken fails here, before the folder
  // below is treated as ours to delete.
  mkdirSync(plan.tmp);
  try {
    copyFiles(plan);
    const difference = treeDifference(plan.source, plan.files, plan.tmp);
    if (difference !== null) {
      throw new Error(`the copy does not match the ledger: ${difference}`);
    }
    // rename replaces an empty folder on POSIX, so look first. The window
    // left is only another run copying the same worktree at the same moment.
    if (lstatSync(plan.dest, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `${plan.dest} appeared during the copy and was not replaced`,
      );
    }
    renameSync(plan.tmp, plan.dest);
  } catch (err) {
    let left = null;
    try {
      removeCopyTree(plan.tmp);
    } catch (cleanup) {
      left = cleanup.message;
    }
    const note =
      left === null ? '' : `; partial copy left at ${plan.tmp} (${left})`;
    throw new Error(`${err.message}${note}`, { cause: err });
  }
}

/**
 * The ledger files that differ between `before` (as planned) and `ledger`
 * (as read now, null when the folder is gone): added, removed, resized or
 * written again, and any link that appeared. Sorted.
 */
function ledgerChanges(before, ledger) {
  const now = new Map((ledger?.files ?? []).map((file) => [file.rel, file]));
  const changed = [...(ledger?.odd ?? [])];
  for (const file of before) {
    const seen = now.get(file.rel);
    if (
      seen === undefined ||
      seen.size !== file.size ||
      seen.mtimeMs !== file.mtimeMs
    ) {
      changed.push(file.rel);
    }
    now.delete(file.rel);
  }
  changed.push(...now.keys());
  return changed.sort((a, b) => a.localeCompare(b));
}

/**
 * Put the ledger out of the way of `git worktree remove`: copy it per `plan`
 * (a planLedger result that is not `keep`), then read it again, right before
 * the removal, and stop if anything in it changed since the plan.
 *
 * Returns `{}` for a worktree with no ledger, else `{ ledger }` (what
 * happened to it, for the result line) and, when the worktree must stay,
 * `keep` (the reason). A failure is recorded in ctx.errors.
 */
function archiveLedger(entry, ctx, plan) {
  if (plan.none) return {};
  const ledger = {
    dest: plan.dest,
    files: plan.files.length,
    state: plan.state === 'copy' ? 'copied' : 'identical',
  };
  if (plan.state === 'copy') {
    try {
      placeCopy(plan);
    } catch (err) {
      return ledgerFailure(entry, ctx, 'copy', err);
    }
  }
  try {
    const changed = ledgerChanges(plan.files, readLedger(entry.path));
    if (changed.length > 0) {
      const names = sample(changed, ledgerPath);
      return { keep: `ledger changed after the copy: ${names}`, ledger };
    }
  } catch (err) {
    return ledgerFailure(entry, ctx, 're-check', err, ledger);
  }
  return { ledger };
}

/** `result` with the ledger's outcome on it, when there was a ledger. */
function withLedger(result, ledger) {
  return ledger === undefined ? result : { ...result, ledger };
}

/** Copy the ledger out, then remove the worktree if that went well. */
function removeWithLedger(entry, ctx, note, plan) {
  const archived = archiveLedger(entry, ctx, plan);
  if (archived.keep !== undefined) {
    const kept = { ...entry, action: 'kept', reason: archived.keep };
    return withLedger(kept, archived.ledger);
  }
  return withLedger(removeWorktree(entry, ctx, note), archived.ledger);
}

/** Remove one eligible worktree, then its branch. */
function removeWorktree(entry, ctx, note) {
  try {
    git(['-C', ctx.root, 'worktree', 'remove', entry.path]);
  } catch (err) {
    const detail = err.detail ?? err.message;
    if (!existsSync(entry.path)) {
      return alreadyGone(entry, ctx, 'already removed by another run');
    }
    if (isGone(entry.path)) {
      // git deleted the .git file and the admin entry, then stopped at a
      // file it could not delete (locked, on Windows). The leftover directory
      // is no longer a worktree, so no later run will list it: report it now.
      const reason = `git worktree remove failed partway, leftover files at ${entry.path}: ${detail}`;
      ctx.errors.push(`${entry.name}: ${reason}`);
      return { ...entry, action: 'kept', reason };
    }
    ctx.errors.push(`${entry.name}: ${err.message}`);
    return {
      ...entry,
      action: 'kept',
      reason: `git worktree remove failed: ${detail}`,
    };
  }
  // git exited 0, yet may have left the folder: see clearLeftover.
  const leftover = clearLeftover(entry.path);
  if (leftover !== null) {
    ctx.errors.push(`${entry.name}: ${leftover}`);
    return { ...entry, action: 'kept', reason: leftover };
  }
  const removed = { ...entry, action: 'removed', reason: note };
  if (entry.branch === null) {
    return {
      ...removed,
      reason: `detached HEAD at ${entry.head}, no branch to delete`,
    };
  }
  return deleteBranch(entry, ctx, removed);
}

function pruneOne(entry, wt, ctx) {
  const kept = (reason) => ({ ...entry, action: 'kept', reason });
  if (wt.locked !== null) {
    return kept(wt.locked === '' ? 'locked' : `locked: ${wt.locked}`);
  }
  if (wt.prunable !== null) {
    const why = wt.prunable === '' ? 'prunable' : `prunable: ${wt.prunable}`;
    return alreadyGone(entry, ctx, why);
  }
  if (isGone(entry.path)) {
    return alreadyGone(entry, ctx, 'already removed by another run');
  }
  const inUse = checkInUse(entry, ctx.cwd);
  if (inUse.keep !== null) return kept(inUse.keep);

  let verdict;
  try {
    verdict = checkWorktree(entry, ctx);
  } catch (err) {
    // Another run removed it while we were checking.
    if (isGone(entry.path)) {
      return alreadyGone(entry, ctx, 'already removed by another run');
    }
    ctx.errors.push(`${entry.name}: ${err.message}`);
    return kept(`check failed: ${err.detail ?? err.message}`);
  }
  if (verdict.keep !== null) return kept(verdict.keep);
  return finishPrune(entry, ctx, verdict.idle);
}

/**
 * A worktree that passed every check: look at its ledger, then remove it (the
 * ledger is copied out first), or on a dry run say what would happen.
 */
function finishPrune(entry, ctx, idle) {
  const note = `merged, clean, idle ${formatHours(idle)}`;
  const plan = prepareLedger(entry, ctx);
  if (plan.keep !== undefined) {
    return { ...entry, action: 'kept', reason: plan.keep };
  }
  if (!ctx.dryRun) return removeWithLedger(entry, ctx, note, plan);
  const branchNote =
    entry.branch === null
      ? `detached HEAD at ${entry.head}, no branch to delete`
      : `would delete branch ${entry.branch} at ${entry.head}`;
  const planned = {
    ...entry,
    action: 'would-remove',
    reason: `${note}; ${branchNote}`,
  };
  return withLedger(planned, previewLedger(plan));
}

/**
 * Check every linked worktree under `<repoRoot>/.worktrees/` and remove the
 * finished ones (see the module comment). Never throws on a git failure.
 *
 * Returns `{ dryRun, results, errors }`. results has one entry per worktree
 * under .worktrees/: `{ name, path, branch, head, action, reason,
 * deletedBranchSha?, ledger? }`, where action is 'removed', 'kept', or on a
 * dry run 'would-remove', and name is the path below .worktrees/. `ledger`
 * is there only for a worktree whose `.superpowers/` held a file and was not
 * kept for a link: `{ dest, files, state }`, where state is 'copied',
 * 'identical' (a copy was already at dest), or on a dry run 'would-copy' or
 * 'identical'. errors holds one message per failed git command, failed copy
 * of a ledger, or failed clean-up of a removed worktree's folder; a missing
 * local main is one error and stops the run before any worktree is checked.
 *
 * @param {{ repoRoot: string, minIdleHours?: number, dryRun?: boolean }} options
 */
export function pruneWorktrees({
  repoRoot,
  minIdleHours = MIN_IDLE_HOURS,
  dryRun = false,
}) {
  const root = path.resolve(repoRoot);
  const ctx = {
    root,
    minIdleHours,
    dryRun,
    cwd: process.cwd(),
    errors: [],
  };
  const done = (results) => ({ dryRun, results, errors: ctx.errors });

  let worktrees;
  try {
    worktrees = listWorktrees(root);
    if (refSha(root, BASE_REF) === null) {
      ctx.errors.push(
        `no local branch "${BASE_BRANCH}" in ${root}. Every worktree is ` +
          'checked against it, so nothing was pruned.',
      );
      return done([]);
    }
  } catch (err) {
    ctx.errors.push(err.message);
    return done([]);
  }

  const results = [];
  for (const wt of worktrees) {
    const name = pruneName(root, wt.path);
    if (name === null) continue; // outside .worktrees/, or .worktrees itself
    const entry = {
      name,
      path: path.resolve(wt.path),
      branch: wt.branch,
      head: wt.head,
    };
    results.push(pruneOne(entry, wt, ctx));
  }

  if (!dryRun) {
    // Clears the admin entry of every unlocked worktree whose directory is
    // gone, including any outside .worktrees/.
    try {
      git(['-C', root, 'worktree', 'prune']);
    } catch (err) {
      ctx.errors.push(err.message);
    }
  }
  return done(results);
}

/** What happened to a worktree's ledger, in a few words. */
function ledgerNote({ dest, files, state }) {
  if (state === 'identical') {
    return `identical copy of ${plural(files, 'file')} already at ${dest}`;
  }
  if (state === 'would-copy') {
    return `would copy ${plural(files, 'file')} to ${dest}`;
  }
  return `${plural(files, 'file')} copied to ${dest}`;
}

/**
 * One line per worktree: `removed <name> (branch <b> deleted, was <sha>)`,
 * `removed <name> (<reason>)`, `would remove <name> (<reason>)` or
 * `kept <name>: <reason>`. A worktree with a ledger gets `; ledger: <what
 * happened>` at the end of the reason (inside the parentheses of a removal):
 * `3 files copied to <dest>`, `identical copy of 3 files already at <dest>`
 * or, on a dry run, `would copy 3 files to <dest>`.
 */
export function formatResult(result) {
  const { action, name, reason } = result;
  const ledger =
    result.ledger === undefined ? '' : `; ledger: ${ledgerNote(result.ledger)}`;
  if (action === 'kept') return `kept ${name}: ${reason}${ledger}`;
  if (action === 'would-remove') {
    return `would remove ${name} (${reason}${ledger})`;
  }
  if (result.deletedBranchSha !== undefined) {
    return `removed ${name} (branch ${result.branch} deleted, was ${result.deletedBranchSha}${ledger})`;
  }
  return `removed ${name} (${reason}${ledger})`;
}

/** `worktrees prune[ (dry run)]: removed N, kept M[, K git errors]` */
export function formatSummary({ dryRun, results, errors }) {
  const kept = results.filter((result) => result.action === 'kept').length;
  const removed = results.length - kept;
  const label = dryRun ? 'worktrees prune (dry run)' : 'worktrees prune';
  const verb = dryRun ? 'would remove' : 'removed';
  const errorNote =
    errors.length > 0 ? `, ${plural(errors.length, 'git error')}` : '';
  return `${label}: ${verb} ${removed}, kept ${kept}${errorNote}`;
}
