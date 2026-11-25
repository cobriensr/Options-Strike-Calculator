#!/usr/bin/env node
/**
 * Spec review check CLI, the backstop of the spec review gate:
 *
 *   node scripts/spec-review-check.mjs <doc path>...
 *
 * .githooks/pre-commit runs it for a Claude Code commit that adds docs under
 * docs/superpowers/specs/ or docs/superpowers/plans/, with the added paths.
 * It reads the review log in the main checkout's .claude/state/ (found through
 * `git rev-parse --git-common-dir`, so a worktree finds it too) and blocks a
 * doc whose key has neither a finished spec-reviewer run nor an owner waiver.
 * The log's format, the rule and the messages are in
 * scripts/_lib/spec-review-log.mjs.
 *
 * Exit codes: 0 every doc has a review or a waiver, 1 a doc is blocked, there
 * is no log, or anything else went wrong (it fails closed, as the review gate
 * does), 2 no paths given. Messages go to stderr.
 * Design: docs/superpowers/specs/2026-11-21-spec-review-gate-design.md, "The
 * pre-commit backstop".
 *
 * Node builtins and this repo's own scripts/_lib modules only: the hook runs
 * this file in worktrees that have no node_modules.
 */
import { readFileSync } from 'node:fs';
import { git } from './_lib/git-run.mjs';
import {
  blockMessage,
  logPathFor,
  missingLogMessage,
  parseLog,
  unreviewed,
} from './_lib/spec-review-log.mjs';

const USAGE = 'usage: node scripts/spec-review-check.mjs <doc path>...';

/**
 * The log's text, or null when there is no log. Any other failure to read it
 * (a folder in its place, no permission) throws.
 *
 * @param {string} logPath
 * @returns {string | null}
 */
function readLog(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * @param {string[]} paths The docs the commit adds.
 * @returns {number}
 */
function check(paths) {
  const commonDir = git(['rev-parse', '--git-common-dir'], process.env).trim();
  const logPath = logPathFor(commonDir, process.cwd());
  const text = readLog(logPath);
  if (text === null) {
    console.error(missingLogMessage(logPath, paths));
    return 1;
  }
  const blocked = unreviewed(paths, parseLog(text));
  if (blocked.length === 0) return 0;
  console.error(blockMessage(blocked));
  return 1;
}

/**
 * @param {string[]} args
 * @returns {number}
 */
function main(args) {
  if (args.length === 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    return check(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `spec-review gate: commit blocked, the check failed: ${message}`,
    );
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
