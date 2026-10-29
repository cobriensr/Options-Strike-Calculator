/**
 * Commit gate: Claude can't commit content that the last passing
 * `npm run review` didn't see. The CLI is scripts/review-gate.mjs:
 * `npm run review` runs `clear` first and `seal` last, and
 * .githooks/pre-commit runs `check`.
 *
 * The marker is `$(git rev-parse --git-path review-gate.json)`: per worktree
 * and inside the git dir, so it never shows in `git status`. It records the
 * tree object of the whole working tree (tracked, modified and untracked,
 * minus gitignored) as review saw it.
 *
 * Every git call inherits process.env on purpose. Inside the pre-commit hook,
 * git exports GIT_INDEX_FILE (a temp index for `git commit -a` or
 * `git commit -- <paths>`) and, in a linked worktree, GIT_DIR. The check has
 * to read that index, the one being committed, not the on-disk one.
 *
 * Node builtins only: the hook runs this in worktrees with no node_modules.
 * Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** @typedef {{ tree: string, head: string, sealedAt: string }} Marker */

/** The marker's file name inside this worktree's git dir. */
export const MARKER_FILE = 'review-gate.json';

/** spawnSync's 1 MB default could truncate a long path list. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** A full SHA-1 or SHA-256 object id. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A git command that could not run or exited non-zero. */
class GitError extends Error {
  /**
   * @param {string[]} args
   * @param {string} detail
   */
  constructor(args, detail) {
    super(`git ${args.join(' ')}: ${detail}`);
    this.name = 'GitError';
  }
}

/**
 * Run git in the current directory without a shell; stdout on exit 0,
 * GitError (with git's stderr) otherwise.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function git(args, env = process.env) {
  // `git` from PATH, as for every git command a developer runs. Arguments go
  // in an array, so nothing is shell-parsed.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  if (result.error) throw new GitError(args, result.error.message);
  if (result.status !== 0) {
    throw new GitError(
      args,
      result.stderr.trim() || `exit code ${result.status}`,
    );
  }
  return result.stdout;
}

/**
 * `git rev-parse --git-path <name>`, made absolute. Git prints it relative
 * to the current directory in the main worktree and absolute in a linked
 * one.
 *
 * @param {string} name
 * @returns {string}
 */
function gitPath(name) {
  return path.resolve(
    git(['rev-parse', '--git-path', name]).replace(/\r?\n$/, ''),
  );
}

/**
 * Paths from `-z` output: NUL-separated and unquoted, so spaces and
 * non-ASCII names come through verbatim.
 *
 * @param {string} text
 * @returns {string[]}
 */
function nulSeparated(text) {
  return text.split('\0').filter((entry) => entry !== '');
}

/** @returns {string} Absolute path of this worktree's marker. */
export function markerPath() {
  return gitPath(MARKER_FILE);
}

/** Delete this worktree's marker; a no-op when there is none. */
export function clear() {
  rmSync(markerPath(), { force: true });
}

/**
 * Record the working tree that `npm run review` just passed on. The tree
 * comes from a copy of the worktree's index (which keeps git's stat cache,
 * so unchanged files aren't re-hashed) with `git add -A` run into it. The
 * real index is never touched, and the copy is deleted even on failure.
 *
 * Refuses unless npm runs it as part of the `review` script, so an agent
 * can't write the marker without running the review.
 *
 * @returns {Marker}
 */
export function seal() {
  const event = process.env.npm_lifecycle_event;
  if (event !== 'review') {
    const got = event === undefined ? 'unset' : JSON.stringify(event);
    throw new Error(
      'only `npm run review` may seal the review marker ' +
        `(npm_lifecycle_event is ${got}, expected "review"). ` +
        'Run `npm run review`.',
    );
  }

  const tempIndex = gitPath(`review-gate-index-${process.pid}.tmp`);
  let tree;
  try {
    copyFileSync(gitPath('index'), tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    git(['add', '-A'], env);
    tree = git(['write-tree'], env).trim();
  } finally {
    rmSync(tempIndex, { force: true });
  }

  /** @type {Marker} */
  const marker = {
    tree,
    head: git(['rev-parse', '--verify', 'HEAD']).trim(),
    sealedAt: new Date().toISOString(),
  };
  writeFileSync(markerPath(), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/**
 * @param {unknown} value
 * @returns {value is Marker}
 */
function isMarker(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const { tree, head, sealedAt } = /** @type {Record<string, unknown>} */ (
    value
  );
  return (
    typeof tree === 'string' &&
    OBJECT_ID.test(tree) &&
    typeof head === 'string' &&
    OBJECT_ID.test(head) &&
    typeof sealedAt === 'string'
  );
}

/**
 * This worktree's marker, or null when there is none. Throws on a marker it
 * can't trust, so the check fails closed. The tree id must be a bare object
 * id because it goes into git's argv.
 *
 * @returns {Marker | null}
 */
export function readMarker() {
  const file = markerPath();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  const rewrite = 'Run `npm run review` to rewrite it.';
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `corrupt review marker ${file}: not valid JSON (${detail}). ${rewrite}`,
      { cause: err },
    );
  }
  if (!isMarker(data)) {
    throw new Error(
      `corrupt review marker ${file}: expected { tree, head, sealedAt } ` +
        `with object ids for tree and head. ${rewrite}`,
    );
  }
  return { tree: data.tree, head: data.head, sealedAt: data.sealedAt };
}

/**
 * Paths this commit changes: the index being committed vs HEAD.
 * `--no-renames` lists both sides of a rename, so a deleted path can't hide
 * behind its new name.
 *
 * @returns {string[]}
 */
export function stagedPaths() {
  return nulSeparated(
    git(['diff', '--cached', '--no-renames', '--name-only', '-z']),
  );
}

/**
 * Throw a fix-it message when the sealed tree is gone. Nothing references
 * it, so `git gc` prunes it once it is older than gc.pruneExpire (two weeks
 * by default), and the drift diff would otherwise fail on a raw
 * `fatal: bad object`. The message carries what git actually said, because
 * the CLI prints only the message, and a corrupt object store shouldn't read
 * as a routine prune.
 *
 * @param {string} tree The marker's tree id.
 */
function assertSealedTreeExists(tree) {
  /** @type {string} */
  let found;
  /** @type {unknown} */
  let cause;
  try {
    const type = git(['cat-file', '-t', tree]).trim();
    if (type === 'tree') return;
    found = `git cat-file -t ${tree} printed "${type}"`;
  } catch (err) {
    cause = err;
    found = err instanceof Error ? err.message : String(err);
  }
  throw new Error(
    `the sealed tree ${tree} is no longer in the object store ` +
      '(git gc prunes unreferenced objects after about two weeks). ' +
      `${found}. Run \`npm run review\`, then commit again.`,
    { cause },
  );
}

/**
 * Paths whose content in the index being committed differs from the sealed
 * tree. This includes reviewed changes that aren't staged. Throws when the
 * sealed tree has been pruned.
 *
 * @param {string} tree The marker's tree id.
 * @returns {string[]}
 */
export function driftedPaths(tree) {
  assertSealedTreeExists(tree);
  return nulSeparated(
    git(['diff', '--cached', '--no-renames', '--name-only', '-z', tree, '--']),
  );
}

/**
 * Decide whether a commit may go ahead, by the per-file rule (owner
 * decision, 2026-10-28):
 *
 * - Block when any staged path is also in `drifted`: the content about to be
 *   committed for that path isn't what the last passing `npm run review` saw.
 * - Allow drift in paths that aren't staged. Reviewed changes left unstaged,
 *   such as another session's work in the same checkout, don't block.
 * - The block reason lists every offending path (staged and drifted, and only
 *   those), one per line with no cap, and tells Claude to re-run
 *   `npm run review`. The CLI prints it to stderr after `review-gate: `, and
 *   git shows it in Claude's tool result.
 *
 * @param {{ staged: string[], drifted: string[] }} paths `staged`: what the
 *   commit changes (index vs HEAD). `drifted`: where the index differs from
 *   the tree the last review sealed.
 * @returns {string | null} null to allow the commit, or the block reason
 *   shown to Claude.
 */
export function decideCommit({ staged, drifted }) {
  const driftedSet = new Set(drifted);
  const offending = staged.filter((file) => driftedSet.has(file));
  if (offending.length === 0) return null;
  const list = offending.map((file) => `  ${file}`).join('\n');
  return (
    'commit blocked. These staged files changed after the last passing `npm run review`:\n' +
    `${list}\n` +
    'Run `npm run review`, then commit again.'
  );
}
