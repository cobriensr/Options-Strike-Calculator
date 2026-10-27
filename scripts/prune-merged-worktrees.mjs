#!/usr/bin/env node
/**
 * Remove finished worktrees under .worktrees/: every commit already in the
 * local main, clean, and idle for at least --min-idle-hours (default 24).
 * The full keep rules are in scripts/_lib/prune-worktrees.mjs. Worktrees
 * outside .worktrees/ are never checked or removed, but the closing
 * `git worktree prune` of a real run clears the admin entry of any unlocked
 * worktree whose directory is already gone, wherever it was.
 *
 *   node scripts/prune-merged-worktrees.mjs [--dry-run] [--min-idle-hours N]
 *   npm run worktrees:prune -- [--dry-run] [--min-idle-hours N]
 *
 * Runs from anywhere in the repo, a linked worktree included: the root is
 * the main worktree git reports, and the worktree holding the current
 * directory is kept. Prints one line per worktree under .worktrees/, then a
 * summary; git failures go to stderr. Exits 1 if a git command failed, 2 on
 * bad arguments.
 */
import { parseArgs } from 'node:util';
import {
  MIN_IDLE_HOURS,
  findRepoRoot,
  formatResult,
  formatSummary,
  pruneWorktrees,
} from './_lib/prune-worktrees.mjs';

const USAGE =
  'usage: node scripts/prune-merged-worktrees.mjs [--dry-run] [--min-idle-hours N]';

/** Throws on an unknown flag, a positional, or a bad --min-idle-hours. */
function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'min-idle-hours': { type: 'string' },
    },
  });
  const raw = values['min-idle-hours'];
  if (raw === undefined) {
    return { dryRun: values['dry-run'], minIdleHours: MIN_IDLE_HOURS };
  }
  const minIdleHours = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(minIdleHours) || minIdleHours < 0) {
    throw new Error(`--min-idle-hours must be a number >= 0, got "${raw}"`);
  }
  return { dryRun: values['dry-run'], minIdleHours };
}

function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`worktrees prune: ${err.message}\n${USAGE}`);
    return 2;
  }

  let repoRoot;
  try {
    repoRoot = findRepoRoot(process.cwd());
  } catch (err) {
    console.error(`worktrees prune: FAILED, ${err.message}`);
    return 1;
  }

  const outcome = pruneWorktrees({ repoRoot, ...options });
  for (const result of outcome.results) console.log(formatResult(result));
  for (const error of outcome.errors) console.error(`error: ${error}`);
  console.log(formatSummary(outcome));
  return outcome.errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
