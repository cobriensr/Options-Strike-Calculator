#!/usr/bin/env node
/**
 * Commit gate CLI. Logic lives in scripts/_lib/review-gate.mjs.
 *
 *   run    `npm run review` is this: take the machine-wide gate lock (waiting
 *          its turn behind any other gate on this machine), then run the
 *          `review:steps` script, which is the chain below, and give the lock
 *          back. Exits with the chain's code.
 *   clear  `review:steps` runs it first: drop this worktree's marker, so a
 *          failed run leaves none.
 *   seal   `review:steps` runs it last: record the working tree the review
 *          passed on. Refused outside `npm run review`.
 *   check  .githooks/pre-commit runs it for Claude Code commits: exit 1 when
 *          there is no marker or a staged path differs from the sealed tree.
 *
 * Exit codes: 0 ok, 1 blocked or failed (check fails closed on any error; run
 * never runs the chain without the lock), 2 usage or a missing `review:steps`.
 * Specs: docs/superpowers/specs/commit-gate-2026-10-28.md and
 * docs/superpowers/specs/gate-lock-2026-11-21.md.
 *
 * Node builtins and this repo's own scripts/_lib modules only: the hook runs
 * this file in worktrees that have no node_modules.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { acquireGateLock, gatePipeName } from './_lib/gate-lock.mjs';
import { runGate } from './_lib/gate-runner.mjs';
import { git } from './_lib/git-run.mjs';
import {
  clear,
  decideCommit,
  driftedPaths,
  markerPath,
  readMarker,
  seal,
  stagedPaths,
} from './_lib/review-gate.mjs';

const USAGE = 'usage: node scripts/review-gate.mjs <clear|seal|check|run>';

/** A bad invocation or setup the caller can fix: exit 2, not a failure of the gate. */
class UsageError extends Error {}

/**
 * The `review:steps` script: from the package.json npm names in
 * `npm_package_json` (it is set when npm runs `review`), else from the one in
 * the working directory.
 *
 * @returns {string}
 */
function readStepsCmd() {
  const file =
    process.env.npm_package_json || path.join(process.cwd(), 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`, { cause: err });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`, {
      cause: err,
    });
  }
  const steps = data?.scripts?.['review:steps'];
  if (typeof steps !== 'string' || steps.trim() === '') {
    throw new UsageError(`no "review:steps" script in ${file}`);
  }
  return steps;
}

/**
 * Take the gate lock, run the chain under it, and return its exit code. Any
 * failure before the chain starts, the lock's own (the 120 min wait cap among
 * them) included, throws, so the chain never runs without the lock.
 *
 * @returns {Promise<number>}
 */
async function runChain() {
  // Read the script first: a repo with no `review:steps` fails at once, not
  // after a turn in the queue.
  const stepsCmd = readStepsCmd();
  const commonDir = git(['rev-parse', '--git-common-dir'], process.env).trim();
  const worktree = git(['rev-parse', '--show-toplevel'], process.env).trim();
  const lock = await acquireGateLock({
    pipeName: gatePipeName(commonDir, process.cwd()),
    holder: { worktree },
    onWait: ({ line }) => console.error(line),
  });
  return runGate({
    stepsCmd,
    shell: process.env.npm_config_script_shell || true,
    lock,
  });
}

/** @returns {number} */
function check() {
  const marker = readMarker();
  if (marker === null) {
    console.error(
      'review-gate: commit blocked. No passing `npm run review` is on record ' +
        `for this worktree (${markerPath()} does not exist). ` +
        'Run `npm run review`, then commit again.',
    );
    return 1;
  }
  const reason = decideCommit({
    staged: stagedPaths(),
    drifted: driftedPaths(marker.tree),
  });
  if (reason === null) return 0;
  console.error(`review-gate: ${reason}`);
  return 1;
}

/**
 * A Map, so `toString` and other prototype keys are not commands.
 *
 * @type {Map<string, () => number | Promise<number>>}
 */
const COMMANDS = new Map([
  [
    'clear',
    () => {
      clear();
      return 0;
    },
  ],
  [
    'seal',
    () => {
      const { tree, head } = seal();
      console.log(`review-gate: sealed tree ${tree} (HEAD ${head})`);
      return 0;
    },
  ],
  ['check', check],
  ['run', runChain],
]);

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function main(args) {
  const [command = '', ...rest] = args;
  const run = COMMANDS.get(command);
  if (run === undefined || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    return await run();
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err))
      // The lock's own messages carry the prefix already.
      .replace(/^review-gate: /, '');
    if (err instanceof UsageError) {
      console.error(`review-gate ${command}: ${message}`);
      return 2;
    }
    const prefix =
      command === 'check'
        ? 'review-gate: commit blocked, the check failed:'
        : `review-gate ${command} failed:`;
    console.error(`${prefix} ${message}`);
    return 1;
  }
}

/** Resolve once what was written to `stream` has been handed to the OS. */
function flushed(stream) {
  return new Promise((resolve) => stream.write('', resolve));
}

const command = process.argv[2];
const code = await main(process.argv.slice(2));
if (command === 'run') {
  // After a give-up on a chain that would not die, its ChildProcess handle
  // still holds the event loop open, so `run` ends the process itself, once
  // everything it printed has gone out.
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
process.exitCode = code;
