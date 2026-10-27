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
 * - it has been idle for at least MIN_IDLE_HOURS;
 * - `git status` is clean;
 * - it has no gitignored scratch files in docs/tmp/, which a removal would
 *   delete;
 * - its HEAD did not move while it was being checked.
 * Removal is `git worktree remove` without --force, then `git branch -D` on
 * its branch if that still points at the checked HEAD. git's own check before
 * removing honours status.showUntrackedFiles, so with `no` it would delete
 * untracked files: the guard is this module's explicit
 * `--untracked-files=normal` status check above, not git's.
 *
 * Worktrees outside .worktrees/ are never checked or removed, but the one
 * `git worktree prune` at the end of a real run clears the admin entry of
 * every unlocked worktree whose directory is already gone, wherever it was.
 * Spec: docs/superpowers/specs/worktree-auto-prune-2026-10-27.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

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

const HOUR_MS = 60 * 60 * 1000;

/** Commits or paths named in a kept reason; the rest are counted. */
const MAX_NAMED = 3;

/** spawnSync's 1 MB default could truncate a huge `git status`. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

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

/** A git command that could not run or exited non-zero. */
class GitError extends Error {
  constructor(args, detail) {
    super(`git ${args.join(' ')}: ${detail}`);
    this.name = 'GitError';
    this.detail = detail;
  }
}

function gitEnv() {
  const env = { ...process.env };
  for (const name of LOCAL_ENV_VARS) delete env[name];
  return env;
}

/** Run git without a shell; returns `{ status, stdout, stderr }`. */
function runGit(args) {
  // `git` from PATH, as for every git command a developer runs. Arguments go
  // in an array, so nothing is shell-parsed.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env: gitEnv(),
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  if (result.error) throw new GitError(args, result.error.message);
  return result;
}

/** Run git; stdout on exit 0, GitError (with git's stderr) otherwise. */
function git(args) {
  const { status, stdout, stderr } = runGit(args);
  if (status !== 0) {
    throw new GitError(args, stderr.trim() || `exit code ${status}`);
  }
  return stdout;
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

/**
 * Hours since the newest mtime of the worktree's admin `index` and
 * `logs/HEAD`, or null when neither exists. A clock that runs behind a file's
 * mtime reads as 0, not negative.
 */
function idleHours(wtPath) {
  const admin = git(['-C', wtPath, 'rev-parse', '--absolute-git-dir']).trim();
  const mtimes = [path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD')]
    .map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs)
    .filter((mtime) => mtime !== undefined);
  if (mtimes.length === 0) return null;
  return Math.max(0, Date.now() - Math.max(...mtimes)) / HOUR_MS;
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
 * `{ keep: reason }` when `entry` must be kept, else `{ keep: null, idle }`.
 * Cheapest checks first; `git status` on a full checkout is the slow one.
 * The HEAD re-read comes last, so a commit made during the checks is caught.
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
  const idle = idleHours(entry.path);
  if (idle === null) {
    return { keep: 'idle time unknown: no admin index or logs/HEAD' };
  }
  if (idle < minIdleHours) {
    return {
      keep: `idle ${formatHours(idle)}, under the ${minIdleHours}h minimum`,
    };
  }
  const dirty = uncommittedPaths(entry.path);
  if (dirty.length > 0) {
    return {
      keep: `uncommitted changes: ${sample(dirty, (line) => line.trim())}`,
    };
  }
  const scratch = scratchFiles(entry.path);
  if (scratch.length > 0) {
    return {
      keep: `ignored scratch files in ${SCRATCH_DIR}/: ${sample(scratch, (file) => file)}`,
    };
  }
  const head = git(['-C', entry.path, 'rev-parse', 'HEAD']).trim();
  if (head !== entry.head) return { keep: 'HEAD moved during the check' };
  return { keep: null, idle };
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
  if (pathWithin(entry.path, ctx.cwd) !== null) {
    return kept('the current directory is inside it');
  }
  if (entry.branch === BASE_BRANCH) {
    return kept(`it has ${BASE_BRANCH} checked out`);
  }

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

  const note = `merged, clean, idle ${formatHours(verdict.idle)}`;
  if (!ctx.dryRun) return removeWorktree(entry, ctx, note);
  const branchNote =
    entry.branch === null
      ? `detached HEAD at ${entry.head}, no branch to delete`
      : `would delete branch ${entry.branch} at ${entry.head}`;
  return { ...entry, action: 'would-remove', reason: `${note}; ${branchNote}` };
}

/**
 * Check every linked worktree under `<repoRoot>/.worktrees/` and remove the
 * finished ones (see the module comment). Never throws on a git failure.
 *
 * Returns `{ dryRun, results, errors }`. results has one entry per worktree
 * under .worktrees/: `{ name, path, branch, head, action, reason,
 * deletedBranchSha? }`, where action is 'removed', 'kept', or on a dry run
 * 'would-remove', and name is the path below .worktrees/. errors holds one
 * message per failed git command; a missing local main is one error and
 * stops the run before any worktree is checked.
 *
 * @param {{ repoRoot: string, minIdleHours?: number, dryRun?: boolean }} options
 */
export function pruneWorktrees({
  repoRoot,
  minIdleHours = MIN_IDLE_HOURS,
  dryRun = false,
}) {
  const root = path.resolve(repoRoot);
  const scope = path.join(root, WORKTREES_DIR);
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
    const wtPath = path.resolve(wt.path);
    const rel = pathWithin(scope, wtPath);
    if (!rel) continue; // outside .worktrees/, or .worktrees itself
    const entry = {
      name: rel.split(path.sep).join('/'),
      path: wtPath,
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

/**
 * One line per worktree: `removed <name> (branch <b> deleted, was <sha>)`,
 * `removed <name> (<reason>)`, `would remove <name> (<reason>)` or
 * `kept <name>: <reason>`.
 */
export function formatResult(result) {
  const { action, name, reason } = result;
  if (action === 'kept') return `kept ${name}: ${reason}`;
  if (action === 'would-remove') return `would remove ${name} (${reason})`;
  if (result.deletedBranchSha !== undefined) {
    return `removed ${name} (branch ${result.branch} deleted, was ${result.deletedBranchSha})`;
  }
  return `removed ${name} (${reason})`;
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
