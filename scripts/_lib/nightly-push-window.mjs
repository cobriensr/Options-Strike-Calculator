/**
 * The pre-push guard for the nightly Railway service. Railway redeploys
 * `nightly` whenever a push touches a file its image is built from, and a
 * deploy while the nightly run is going (07:15-12:30 UTC) can kill the run.
 * .githooks/pre-push runs scripts/nightly-push-window.mjs, which calls `main`
 * here: inside that window a push that changes one of those files is refused.
 *
 * "A file the image is built from" is read from nightly/Dockerfile of the
 * checkout this module lives in: every COPY or ADD source that is a local
 * path and not a build-stage copy (`--from`), plus the Dockerfile and the root
 * .dockerignore, which no COPY names but which decide what the build holds.
 * Not the whole nightly/ folder: its README and tests are not in the image,
 * so pushing them is safe. An image file added to the Dockerfile is therefore
 * guarded with no change here. A source this module cannot match (a glob, a
 * variable, a heredoc) makes `imageSources` throw, which the real-Dockerfile
 * test turns into a failure in review, and `main` into a refused push.
 *
 * Only a push to main is checked: the Railway `nightly` service deploys from
 * its source branch, main, in its one environment (production), so no other
 * ref can redeploy it. That rule rests on Railway's source branch being main;
 * if the service is pointed at another branch, DEPLOY_REF must follow.
 * `main` diffs each line pushing to main, `<remote>..<local>`; when the remote
 * has no main yet, against origin/main instead (see `pushedPaths`). A
 * deletion adds nothing to the remote's tree and is allowed. When it cannot
 * tell what a push changes the push is refused inside the window: a guard
 * that waved those through would fail open on the pushes that matter. The
 * common cause, a remote commit this clone has not fetched, is told apart and
 * its message leads with `git fetch origin`; every refusal ends by naming the
 * override, NIGHTLY_PUSH_WINDOW_OK=1, the owner's last resort for a deploy
 * that has to go out now.
 *
 * Git runs with the env it is given, in the repository the hook is run for.
 * Nothing in the messages comes from the environment.
 */
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { git } from './git-run.mjs';

/**
 * The override a person sets for one push. An operational knob, not a
 * per-call-site constant: the guard has to be passable on the day a deploy
 * cannot wait, with no code change, and the hook is run by git, which gives
 * the owner no flag to pass.
 */
const BYPASS_ENV = 'NIGHTLY_PUSH_WINDOW_OK';

/**
 * The nightly cron's run, UTC: starts 07:15 (`15 7 * * 2-6` in
 * nightly/src/main.py) and ends with RUN_DEADLINE_SECONDS plus
 * WATCHDOG_GRACE_SECONDS (5 h + 900 s, nightly/src/constants.py), 12:30. The
 * test file reads both and fails when this window drifts from them.
 */
const WINDOW_START = { hour: 7, minute: 15 };
const WINDOW_END = { hour: 12, minute: 30 };

/** The one ref whose push Railway builds. */
const DEPLOY_REF = 'refs/heads/main';

const MS_PER_DAY = 86_400_000;

/** Paths in the block message before it says "and N more". */
const MAX_PATHS_SHOWN = 5;

/**
 * Not named by a COPY but part of the image's build: the Dockerfile itself, and
 * the root .dockerignore (a COPY of an ignored file fails the build).
 */
const WATCHED_BESIDES_COPY = ['nightly/Dockerfile', '.dockerignore'];

/** What a main the remote lacks is compared with. */
const NEW_BRANCH_BASE = 'origin/main';

/** nightly/Dockerfile of the checkout this file is in. */
const DOCKERFILE = new URL('../../nightly/Dockerfile', import.meta.url);

/** A COPY or ADD flag: `--chown=...`, `--chmod=...`, `--from=...`, `--link`. */
const COPY_FLAG = /^(--\S+)\s+/;

/** The instructions whose sources are files of the build context. */
const COPY_INSTRUCTION = /^(?:COPY|ADD)\s/i;

/** An ADD source that is fetched, not read from the build context. */
const REMOTE_SOURCE = /^(?:https?:\/\/|git@)/i;

/** A source this module cannot match by path: a glob, a variable, a heredoc. */
const UNMATCHABLE_SOURCE = /[*?[\]$<]/;

/** A git object id: SHA-1 or SHA-256. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** "07:15 UTC". */
function clock({ hour, minute }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)} UTC`;
}

function msOfDay({ hour, minute }) {
  return (hour * 60 + minute) * 60_000;
}

/**
 * True from 07:15:00.000 UTC up to, not including, 12:30:00.000 UTC, on any
 * day of the week.
 *
 * @param {Date} now
 */
export function inBlockedWindow(now) {
  const sinceMidnight =
    ((now.getTime() % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return (
    sinceMidnight >= msOfDay(WINDOW_START) &&
    sinceMidnight < msOfDay(WINDOW_END)
  );
}

/**
 * The Dockerfile's instructions with line continuations joined. Comment lines
 * and blank lines are dropped, inside a continued instruction too, as Docker
 * does.
 *
 * @param {string} dockerfileText
 * @returns {string[]}
 */
function instructions(dockerfileText) {
  const joined = [];
  let pending = '';
  for (const raw of dockerfileText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    joined.push(`${pending}${line}`.trim());
    pending = '';
  }
  if (pending.trim() !== '') joined.push(pending.trim());
  return joined;
}

/**
 * The local sources of one COPY or ADD instruction, or none for another
 * instruction, a `--from` copy out of a build stage, and an ADD of a URL or a
 * git repository.
 *
 * @param {string} instruction
 * @returns {string[]}
 */
function copySources(instruction) {
  const keyword = COPY_INSTRUCTION.exec(instruction);
  if (keyword === null) return [];

  let rest = instruction.slice(keyword[0].length).trim();
  let fromStage = false;
  for (
    let flag = COPY_FLAG.exec(rest);
    flag !== null;
    flag = COPY_FLAG.exec(rest)
  ) {
    if (flag[1].startsWith('--from=')) fromStage = true;
    rest = rest.slice(flag[0].length);
  }
  if (fromStage) return [];

  const args = rest.startsWith('[') ? jsonArgs(rest) : rest.split(/\s+/);
  // The last argument is the destination.
  return args
    .slice(0, -1)
    .filter((source) => !REMOTE_SOURCE.test(source))
    .map(normalizeSource);
}

/** The JSON array form, `COPY ["a", "b", "dst/"]`. */
function jsonArgs(rest) {
  let parsed;
  try {
    parsed = JSON.parse(rest);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
    throw new Error(
      `unsupported COPY/ADD source in nightly/Dockerfile: ${rest}`,
    );
  }
  return parsed;
}

/** Without a leading `./`; the whole build context is `.`. */
function normalizeSource(source) {
  if (UNMATCHABLE_SOURCE.test(source)) {
    throw new Error(
      `unsupported COPY/ADD source in nightly/Dockerfile: ${source}`,
    );
  }
  const bare = source.replace(/^(?:\.\/)+/, '');
  return bare === '' ? '.' : bare;
}

/**
 * Every file or directory the nightly image is built from: the local source of
 * each COPY or ADD that does not read from a build stage, in file order, then
 * nightly/Dockerfile and .dockerignore. A directory source ends with `/` as
 * the Dockerfile writes it. Throws when an instruction names a source that
 * cannot be matched by path (a glob, a variable, a heredoc).
 *
 * @param {string} dockerfileText
 * @returns {string[]}
 */
export function imageSources(dockerfileText) {
  const sources = instructions(dockerfileText).flatMap(copySources);
  return [...new Set([...sources, ...WATCHED_BESIDES_COPY])];
}

/** True when `file` is `source`, or sits under it when `source` is a directory. */
function covers(source, file) {
  if (source === '.' || file === source) return true;
  const directory = source.endsWith('/') ? source : `${source}/`;
  return file.startsWith(directory);
}

/**
 * The changed paths that are one of the image's sources (an exact file), or
 * sit under one that is a directory (a prefix match). Keeps the order of
 * `changed`.
 *
 * @param {string[]} changed
 * @param {string[]} sources
 * @returns {string[]}
 */
export function touchedImagePaths(changed, sources) {
  return changed.filter((file) =>
    sources.some((source) => covers(source, file)),
  );
}

/**
 * One line of git's pre-push stdin,
 * `<local ref> <local oid> <remote ref> <remote oid>`.
 *
 * @param {string} line
 * @returns {{ localOid: string, remoteRef: string, remoteOid: string }}
 */
function parsePushLine(line) {
  const fields = line.trim().split(/\s+/);
  const [, localOid, remoteRef, remoteOid] = fields;
  // The ids go into a git command line: only a real object id may.
  if (
    fields.length !== 4 ||
    !OBJECT_ID.test(localOid) ||
    !OBJECT_ID.test(remoteOid)
  ) {
    throw new Error(`unexpected pre-push line: ${line}`);
  }
  return { localOid, remoteRef, remoteOid };
}

const isZeroOid = (oid) => /^0+$/.test(oid);

/**
 * The remote's main is a commit this clone does not have: someone else pushed
 * to it and this clone has not fetched since. The diff cannot be made, and
 * the fix is `git fetch`, not the override.
 */
class UnfetchedRemoteError extends Error {
  /** @param {string} oid */
  constructor(oid) {
    super(`the remote's main is at ${oid}, a commit this clone does not have`);
    this.name = 'UnfetchedRemoteError';
  }
}

/**
 * Whether this repository holds `oid` as a commit. `rev-parse --verify
 * --quiet` exits 1 for an object it lacks, and any other failure (no
 * repository) is a GitError from the runner.
 *
 * @param {string} oid
 * @param {NodeJS.ProcessEnv} env
 */
function hasCommit(oid, env) {
  const found = git(
    ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`],
    env,
    {
      okStatuses: [0, 1],
    },
  );
  return found.trim() !== '';
}

/**
 * Paths that differ across `range`. `--no-renames` lists both names of a
 * rename: git's default shows only the new one, which would hide the
 * removal of an image file that moved somewhere else. `-z` keeps odd file
 * names unquoted.
 *
 * @param {string} range
 * @param {NodeJS.ProcessEnv} env
 */
function changedPaths(range, env) {
  const out = git(['diff', '--name-only', '--no-renames', '-z', range], env);
  return out.split('\0').filter((file) => file !== '');
}

/**
 * Every path the push would change in the remote's main. Only the lines whose
 * remote ref is DEPLOY_REF count (a line is still read and checked for form,
 * whatever its ref):
 *
 * - main exists on the remote: `<remote>..<local>`, the commits that would be
 *   added, which is what Railway sees in a push to main. Throws
 *   UnfetchedRemoteError when the remote commit is not in this clone.
 * - the remote has no main: `origin/main...<local>`, the changes since the
 *   local history left origin/main. Three dots, not two: with two, whatever
 *   main gained since the fork would count as this push's.
 * - a deletion: nothing.
 *
 * @param {string} stdinText
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function pushedPaths(stdinText, env) {
  const changed = [];
  for (const line of stdinText.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const { localOid, remoteRef, remoteOid } = parsePushLine(line);
    if (remoteRef !== DEPLOY_REF || isZeroOid(localOid)) continue;
    if (isZeroOid(remoteOid)) {
      changed.push(...changedPaths(`${NEW_BRANCH_BASE}...${localOid}`, env));
      continue;
    }
    if (!hasCommit(remoteOid, env)) throw new UnfetchedRemoteError(remoteOid);
    changed.push(...changedPaths(`${remoteOid}..${localOid}`, env));
  }
  return changed;
}

function overrideAdvice() {
  return `Push after ${clock(WINDOW_END)}, or set ${BYPASS_ENV}=1 for this one push.`;
}

/** @param {string[]} paths */
function blockedMessage(paths) {
  const shown = paths.slice(0, MAX_PATHS_SHOWN).map((file) => `  ${file}`);
  if (paths.length > MAX_PATHS_SHOWN) {
    shown.push(`  and ${paths.length - MAX_PATHS_SHOWN} more`);
  }
  return [
    'nightly-push-window: push refused. It changes files the nightly image is built from:',
    ...shown,
    `Railway would redeploy nightly while its run is going (${clock(WINDOW_START)} to ${clock(WINDOW_END)}) and could kill it.`,
    overrideAdvice(),
  ].join('\n');
}

/** @param {unknown} err */
function unverifiedMessage(err) {
  if (err instanceof UnfetchedRemoteError) {
    return [
      'nightly-push-window: origin has commits this clone has not fetched; run `git fetch origin`, rebase, and push again.',
      `(${err.message}, so the push cannot be checked, and it is inside the nightly run window, ${clock(WINDOW_START)} to ${clock(WINDOW_END)}.)`,
      `Last resort, to push as it is: set ${BYPASS_ENV}=1 for this one push.`,
    ].join('\n');
  }
  const why = err instanceof Error ? err.message : String(err);
  return [
    `nightly-push-window: could not check this push (${why}).`,
    `It is refused because it is inside the nightly run window (${clock(WINDOW_START)} to ${clock(WINDOW_END)}) and may touch the image.`,
    overrideAdvice(),
  ].join('\n');
}

/**
 * The hook's decision: 0 lets the push go, 1 refuses it (the reason is on
 * stderr). The bypass and the time are checked first, so a push outside the
 * window or with the override reads neither git's stdin nor the repository.
 *
 * @param {object} input
 * @param {import('node:stream').Readable} input.stdin git's pre-push lines.
 * @param {NodeJS.ProcessEnv} input.env Read for the bypass, and handed to git.
 * @param {Date} input.now
 * @returns {Promise<0 | 1>}
 */
export async function main({ stdin, env, now }) {
  if (env[BYPASS_ENV] === '1' || !inBlockedWindow(now)) return 0;

  let touched;
  try {
    const sources = imageSources(readFileSync(DOCKERFILE, 'utf8'));
    const changed = pushedPaths(await text(stdin), env);
    touched = touchedImagePaths(changed, sources);
  } catch (err) {
    console.error(unverifiedMessage(err));
    return 1;
  }

  if (touched.length === 0) return 0;
  console.error(blockedMessage(touched));
  return 1;
}
