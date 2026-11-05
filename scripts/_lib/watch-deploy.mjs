/**
 * Watch one commit's deploy: poll GitHub until every commit status (Vercel,
 * the Railway `Theta-Options - <service>` contexts) and every check run is
 * terminal, then say whether it all passed. The CLI wrapper is
 * scripts/watch-deploy.mjs.
 *
 * `evaluateDeploy` holds the decision and is a pure function over the two
 * parsed payloads. The rest is thin I/O: `gh api` through execFile, and a
 * loop that polls, prints and sleeps.
 *
 * Only the individual statuses count. The combined `state` GitHub returns
 * reads `pending` for a commit with no statuses at all, which would never
 * settle.
 */
import { execFile } from 'node:child_process';
import { git } from './git-run.mjs';

export const POLL_INTERVAL_MS = 30_000;
export const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * How long to wait, after a poll first reads "done", before polling again to
 * confirm it. GitHub Actions creates a `needs:` job only when the job it waits
 * on completes (E2E Tests' `created_at` equals App Quality Gate's
 * `completed_at`), so a poll that lands in that instant sees every check run
 * finished, nothing pending, and would call the deploy green before the
 * dependent job exists. The gap is a second or two; 10 s covers it.
 */
export const SETTLE_DELAY_MS = 10_000;

/**
 * Longest one `gh api` call may run. A call that stalls (a dead connection
 * `gh` never gives up on) would otherwise block the loop forever and with it
 * the --timeout, which is only checked between polls.
 */
const GH_CALL_TIMEOUT_MS = 60_000;

/** Process exit codes of scripts/watch-deploy.mjs. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  TIMEOUT: 2,
  BAD_ARGS: 3,
});

export const USAGE = [
  'usage: node scripts/watch-deploy.mjs <sha> [--timeout <min>] [--repo owner/name]',
  '  Polls the commit statuses (Vercel, Railway) and check runs of <sha> every',
  `  ${POLL_INTERVAL_MS / 1000} s until all are terminal. --timeout defaults to ${DEFAULT_TIMEOUT_MINUTES} minutes; --repo to origin's.`,
  '  Exit 0 all passed, 1 a failure, 2 timeout, 3 bad arguments or gh missing.',
].join('\n');

/** Bad command-line arguments, or no way to find the repo. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A GitHub payload that is not the shape the API documents. */
export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/** A `gh` call that failed; `fatal` means retrying cannot help. */
class GhError extends Error {
  /**
   * @param {string} message
   * @param {boolean} fatal
   */
  constructor(message, fatal) {
    super(message);
    this.name = 'GhError';
    this.fatal = fatal;
  }
}

// ---------------------------------------------------------------------------
// Arguments

const SHA = /^[0-9a-f]{7,40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * The value of `--flag value` or `--flag=value`: the rest of `arg` after the
 * `=`, or else the next argument, which this takes off `rest`.
 *
 * @param {string} arg the flag argument, already taken off `rest`
 * @param {string[]} rest the arguments after it
 * @param {string} flag
 * @returns {string}
 */
function takeValue(arg, rest, flag) {
  if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  const value = rest.shift();
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}

/** @param {string} value */
function parseTimeout(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new UsageError(
      `--timeout must be a positive number of minutes, got "${value}"`,
    );
  }
  return minutes;
}

/** @param {string} value */
function parseRepo(value) {
  if (!REPO.test(value)) {
    throw new UsageError(`--repo must look like owner/name, got "${value}"`);
  }
  return value;
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ sha: string | null, timeoutMinutes: number, repo: string | null, help: boolean }}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  const parsed = {
    sha: /** @type {string | null} */ (null),
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    repo: /** @type {string | null} */ (null),
    help: false,
  };

  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      parsed.timeoutMinutes = parseTimeout(takeValue(arg, rest, '--timeout'));
    } else if (arg === '--repo' || arg.startsWith('--repo=')) {
      parsed.repo = parseRepo(takeValue(arg, rest, '--repo'));
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (parsed.sha !== null) {
      throw new UsageError(`unexpected argument ${arg}`);
    } else if (SHA.test(arg)) {
      parsed.sha = arg;
    } else {
      throw new UsageError(
        `<sha> must be 7 to 40 hex characters, got "${arg}"`,
      );
    }
  }

  if (!parsed.help && parsed.sha === null) {
    throw new UsageError('missing <sha>');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Repo from the origin remote

const SCP_REMOTE = /^[\w.-]+@github\.com:([\w.-]+)\/([\w.-]+)$/;

/**
 * owner and name from a GitHub remote url, in the https, ssh:// and scp
 * (`git@github.com:o/n.git`) spellings; null for anything else. Credentials
 * in the url are dropped, not returned.
 *
 * @param {string} remoteUrl
 * @returns {string | null}
 */
export function repoFromRemoteUrl(remoteUrl) {
  const text = remoteUrl.trim();
  let parts;
  const scp = SCP_REMOTE.exec(text);
  if (scp) {
    parts = [scp[1], scp[2]];
  } else {
    try {
      const url = new URL(text);
      if (url.hostname !== 'github.com') return null;
      parts = url.pathname.split('/').filter(Boolean);
    } catch {
      return null;
    }
  }
  if (parts.length !== 2) return null;
  const [owner = '', rawName = ''] = parts;
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  const repo = `${owner}/${name}`;
  return REPO.test(repo) ? repo : null;
}

/**
 * owner/name of the `origin` remote of the repo in the current directory.
 *
 * @returns {string}
 * @throws {UsageError}
 */
export function resolveRepo() {
  let remote;
  try {
    remote = git(['remote', 'get-url', 'origin'], process.env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `cannot read the origin remote (${reason}); pass --repo owner/name`,
      { cause: err },
    );
  }
  const repo = repoFromRemoteUrl(remote);
  if (repo === null) {
    throw new UsageError(
      'the origin remote is not a GitHub repository; pass --repo owner/name',
    );
  }
  return repo;
}

// ---------------------------------------------------------------------------
// The decision

/** Check run conclusions that are not a failure. */
const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const VERCEL_CONTEXT = /^vercel\b/i;
const CANCELED = /cancel/i;
const CANCELED_NOTE = 'non-failing: superseded by a newer commit';

/**
 * @typedef {{
 *   kind: 'status' | 'check',
 *   name: string,
 *   outcome: 'ok' | 'pending' | 'failed',
 *   label: string,
 *   description: string,
 *   note: string,
 *   url: string,
 * }} Item
 */

/**
 * @param {unknown} payload
 * @param {string} key
 * @param {string} what
 * @returns {unknown[]}
 */
function arrayOf(payload, key, what) {
  const value =
    payload !== null && typeof payload === 'object'
      ? /** @type {Record<string, unknown>} */ (payload)[key]
      : undefined;
  if (!Array.isArray(value)) {
    throw new PayloadError(`unexpected ${what} payload: no "${key}" array`);
  }
  return value;
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Record<string, unknown>} entry one of `statuses`
 * @returns {Item}
 */
function statusItem(entry) {
  const name = str(entry.context);
  const state = str(entry.state);
  const description = str(entry.description);
  if (name === '' || state === '') {
    throw new PayloadError(
      'unexpected status payload: an entry has no context or state',
    );
  }

  let outcome = 'failed';
  let label = state;
  let note = '';
  if (state === 'success') {
    outcome = 'ok';
  } else if (state === 'pending') {
    outcome = 'pending';
  } else if (
    (state === 'failure' || state === 'error') &&
    VERCEL_CONTEXT.test(name) &&
    CANCELED.test(description)
  ) {
    outcome = 'ok';
    label = 'canceled';
    note = CANCELED_NOTE;
  }
  return {
    kind: 'status',
    name,
    outcome: /** @type {Item['outcome']} */ (outcome),
    label,
    description,
    note,
    url: str(entry.target_url),
  };
}

/**
 * @param {Record<string, unknown>} entry one of `check_runs`
 * @returns {Item}
 */
function checkItem(entry) {
  const name = str(entry.name);
  const status = str(entry.status);
  if (name === '' || status === '') {
    throw new PayloadError(
      'unexpected check-runs payload: an entry has no name or status',
    );
  }

  let outcome = 'failed';
  let label = str(entry.conclusion) || 'no conclusion';
  if (status !== 'completed') {
    outcome = 'pending';
    label = status;
  } else if (OK_CONCLUSIONS.has(label)) {
    outcome = 'ok';
  }
  return {
    kind: 'check',
    name,
    outcome: /** @type {Item['outcome']} */ (outcome),
    label,
    description: '',
    note: '',
    url: str(entry.html_url),
  };
}

/** statuses before check runs, then by name: stable whatever order GitHub sends. */
function compareItems(a, b) {
  if (a.kind !== b.kind) return a.kind === 'status' ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.label === b.label) return 0;
  return a.label < b.label ? -1 : 1;
}

/**
 * @param {Item} item
 * @param {number} nameWidth
 */
function formatItem(item, nameWidth) {
  const parts = [
    `${item.kind === 'status' ? 'status' : 'check '} ${item.name.padEnd(nameWidth)}  ${item.label}`,
  ];
  if (item.description !== '') parts.push(item.description);
  if (item.note !== '') parts.push(`[${item.note}]`);
  if (item.outcome === 'failed' && item.url !== '') parts.push(item.url);
  return parts.join('  ');
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Decide from the two payloads whether the deploy is finished and how it went.
 *
 * Done means no check run is queued or in progress, no status is pending, and
 * at least one check run exists. It waits for everything to settle even when
 * something has already failed, so the verdict names every failure. A check
 * run counts as a failure unless it concluded success, skipped or neutral
 * (cancelled and timed_out fail). A Vercel status in failure or error whose
 * description says it was canceled is a deploy a newer commit superseded:
 * reported as canceled, not failing, and named in `canceled`.
 *
 * @param {{ status: unknown, checkRuns: unknown }} payloads parsed JSON of
 *   `commits/<sha>/status` and `commits/<sha>/check-runs`
 * @returns {{
 *   done: boolean,
 *   verdict: 'success' | 'failure' | 'pending',
 *   lines: string[],
 *   summary: string,
 *   pending: string[],
 *   failing: string[],
 *   canceled: string[],
 *   checkNames: string[],
 * }}
 * @throws {PayloadError}
 */
export function evaluateDeploy({ status, checkRuns }) {
  const statuses = arrayOf(status, 'statuses', 'status');
  const runs = arrayOf(checkRuns, 'check_runs', 'check-runs');
  const items = [
    ...statuses.map((entry) =>
      statusItem(/** @type {Record<string, unknown>} */ (entry ?? {})),
    ),
    ...runs.map((entry) =>
      checkItem(/** @type {Record<string, unknown>} */ (entry ?? {})),
    ),
  ].sort(compareItems);

  const nameWidth = Math.max(0, ...items.map((item) => item.name.length));
  const lines = items.map((item) => formatItem(item, nameWidth));
  const pendingItems = items.filter((item) => item.outcome === 'pending');
  const failingItems = items.filter((item) => item.outcome === 'failed');
  const pending = pendingItems.map((item) => item.name);
  const failing = failingItems.map((item) => item.name);
  const canceled = items
    .filter((item) => item.note === CANCELED_NOTE)
    .map((item) => item.name);
  const checkNames = items
    .filter((item) => item.kind === 'check')
    .map((item) => item.name);

  const done = runs.length > 0 && pending.length === 0;
  if (!done) {
    const reasons = [];
    if (pending.length > 0) reasons.push(`waiting on ${pending.join(', ')}`);
    if (runs.length === 0) reasons.push('no check runs reported yet');
    return {
      done,
      verdict: 'pending',
      lines,
      summary: `verdict: pending (${reasons.join('; ')})`,
      pending,
      failing,
      canceled,
      checkNames,
    };
  }
  if (failingItems.length > 0) {
    const what = failingItems.map((item) => `${item.name}: ${item.label}`);
    return {
      done,
      verdict: 'failure',
      lines,
      summary: `verdict: failure (${what.join(', ')})`,
      pending,
      failing,
      canceled,
      checkNames,
    };
  }
  const total = `${count(statuses.length, 'status', 'statuses')}, ${count(runs.length, 'check run', 'check runs')}`;
  return {
    done,
    verdict: 'success',
    lines,
    summary: `verdict: success (${total})`,
    pending,
    failing,
    canceled,
    checkNames,
  };
}

// ---------------------------------------------------------------------------
// gh

/**
 * Stderr that retrying cannot fix: not logged in, no such commit or repo, no
 * permission. A rate limit (also an HTTP 403) does pass with time.
 *
 * @param {string} text
 */
function isFatalGhError(text) {
  if (/gh auth login/i.test(text)) return true;
  return /HTTP (?:401|403|404|422)\b/.test(text) && !/rate limit/i.test(text);
}

/**
 * Run `gh <args>`; resolves to stdout.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function runGh(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // `gh` from PATH, as for every gh command a developer runs. Arguments go
    // in an array, so nothing is shell-parsed.
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      'gh',
      args,
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
        } else if (error.code === 'ENOENT') {
          reject(
            new GhError('the `gh` CLI is not installed or not on PATH', true),
          );
        } else if (error.killed) {
          // execFile killed the child at the timeout. Whatever it printed
          // before then says nothing about the cause, so never read it as a
          // fatal 4xx: the next poll tries again.
          reject(
            new GhError(
              `gh ${args.join(' ')} timed out after ${timeoutMs / 1000}s`,
              false,
            ),
          );
        } else {
          const text = String(stderr).trim() || error.message;
          reject(new GhError(text, isFatalGhError(text)));
        }
      },
    );
  });
}

/**
 * True when `gh` can run at all. The CLI calls it before `resolveRepo` so a
 * missing `gh` fails at once with its own message, not after a `git remote`
 * lookup or an unrelated "pass --repo" error. `runGh` still handles ENOENT,
 * because `gh` can vanish between this check and a poll, and `watchDeploy` is
 * callable without it.
 *
 * @returns {Promise<boolean>}
 */
export function ghAvailable() {
  return new Promise((resolve) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- as in runGh
    execFile('gh', ['--version'], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * `gh api <endpoint>`, parsed.
 *
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function ghJson(endpoint, timeoutMs) {
  const stdout = await runGh(['api', endpoint], timeoutMs);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GhError(
      `gh api ${endpoint} returned a payload that is not JSON`,
      false,
    );
  }
}

/**
 * The two payloads `evaluateDeploy` reads, for one commit. Rejects with a
 * GhError (its message says why) when either `gh` call fails. scripts/
 * session-status.mjs calls it with a shorter `timeoutMs` than a watch needs.
 *
 * @param {string} repo owner/name
 * @param {string} sha
 * @param {number} [timeoutMs] longest one `gh api` call may run
 */
export async function fetchPayloads(repo, sha, timeoutMs = GH_CALL_TIMEOUT_MS) {
  const base = `repos/${repo}/commits/${sha}`;
  const [status, checkRuns] = await Promise.all([
    ghJson(`${base}/status?per_page=100`, timeoutMs),
    ghJson(`${base}/check-runs?per_page=100`, timeoutMs),
  ]);
  return { status, checkRuns };
}

// ---------------------------------------------------------------------------
// The loop

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll until the deploy is terminal or the timeout passes, printing the
 * statuses and check runs whenever they change and a verdict line at the
 * end. Progress and retry notes go to stderr.
 *
 * A poll that reads "done" is not trusted at once: a job that `needs:` another
 * does not exist until that one completes (see SETTLE_DELAY_MS). The verdict
 * waits for a second poll, SETTLE_DELAY_MS later, that is also done and shows
 * the same check runs. Anything else goes back to polling.
 *
 * Returns the exit code: 0 all passed, 1 a failure, 2 timeout, 3 `gh` missing
 * or an error retrying cannot fix (not logged in, unknown commit).
 *
 * @param {{ repo: string, sha: string, timeoutMinutes: number }} options
 * @returns {Promise<number>}
 */
export async function watchDeploy({ repo, sha, timeoutMinutes }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMinutes * 60_000;
  let printed = null;
  // The check runs the last poll found done, until a later poll confirms them.
  let unconfirmed = null;

  for (;;) {
    let result = null;
    let failure = null;
    try {
      result = evaluateDeploy(await fetchPayloads(repo, sha));
    } catch (err) {
      if (err instanceof GhError && err.fatal) {
        console.error(`watch-deploy: ${err.message}`);
        return EXIT.BAD_ARGS;
      }
      failure = err instanceof Error ? err.message : String(err);
      console.error(
        `watch-deploy: ${failure}; retrying in ${POLL_INTERVAL_MS / 1000}s`,
      );
    }

    let wait = POLL_INTERVAL_MS;
    if (result !== null) {
      const table = result.lines.join('\n');
      if (table !== printed) {
        console.log(table);
        printed = table;
      }
      if (result.done) {
        const checks = result.checkNames.join('\n');
        if (checks === unconfirmed) {
          console.log(result.summary);
          return result.verdict === 'success' ? EXIT.OK : EXIT.FAILED;
        }
        unconfirmed = checks;
        wait = SETTLE_DELAY_MS;
        console.error(
          `watch-deploy: everything is finished; checking again in ${SETTLE_DELAY_MS / 1000}s in case a dependent job has yet to start`,
        );
      } else {
        unconfirmed = null;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const waiting = result.pending.join(', ') || 'the first check run';
        console.error(
          `watch-deploy: ${elapsed}s elapsed, waiting on ${waiting}`,
        );
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log(timeoutLine(timeoutMinutes, failure, result));
      return EXIT.TIMEOUT;
    }
    await sleep(Math.min(wait, remaining));
  }
}

/**
 * The verdict line when the timeout passes: what is still pending, or that
 * the last poll got no answer.
 *
 * @param {number} timeoutMinutes
 * @param {string | null} failure why the last poll failed, if it did
 * @param {ReturnType<typeof evaluateDeploy> | null} result the last poll's result
 */
function timeoutLine(timeoutMinutes, failure, result) {
  const head = `verdict: timeout after ${timeoutMinutes} min`;
  if (result === null) {
    return `${head}, no answer from GitHub (last error: ${failure})`;
  }
  if (result.done) {
    return `${head}, every check run had finished but the set was not confirmed (a dependent job may be yet to start)`;
  }
  const waiting = result.pending.join(', ') || 'the first check run';
  const failed =
    result.failing.length > 0
      ? `; already failing: ${result.failing.join(', ')}`
      : '';
  return `${head}, still waiting on ${waiting}${failed}`;
}
