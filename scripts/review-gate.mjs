#!/usr/bin/env node
/**
 * Commit gate CLI. Logic lives in scripts/_lib/review-gate.mjs.
 *
 *   clear  `npm run review` runs it first: drop this worktree's marker, so a
 *          failed run leaves none.
 *   seal   `npm run review` runs it last: record the working tree the review
 *          passed on. Refused outside `npm run review`.
 *   check  .githooks/pre-commit runs it for Claude Code commits: exit 1 when
 *          there is no marker or a staged path differs from the sealed tree.
 *
 * Exit codes: 0 ok, 1 blocked or failed (check fails closed on any error),
 * 2 usage. Spec: docs/superpowers/specs/commit-gate-2026-10-28.md.
 */
import {
  clear,
  decideCommit,
  driftedPaths,
  markerPath,
  readMarker,
  seal,
  stagedPaths,
} from './_lib/review-gate.mjs';

const USAGE = 'usage: node scripts/review-gate.mjs <clear|seal|check>';

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
 * @type {Map<string, () => number>}
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
]);

/**
 * @param {string[]} args
 * @returns {number}
 */
function main(args) {
  const [command = '', ...rest] = args;
  const run = COMMANDS.get(command);
  if (run === undefined || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    return run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix =
      command === 'check'
        ? 'review-gate: commit blocked, the check failed:'
        : `review-gate ${command} failed:`;
    console.error(`${prefix} ${message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
