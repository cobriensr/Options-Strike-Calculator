/**
 * Time limits for a test that runs a child node process with spawnSync. Not
 * itself a test file; vitest only collects *.test.mjs.
 *
 * A synchronous spawn blocks the test worker, so vitest cannot interrupt it:
 * it can only fail the test after the spawn returns, with "Test timed out"
 * and nothing about the child. The child's own limit (`timeout` on the spawn)
 * therefore has to fire first, and the test timeout has to sit above it, so
 * the failure that surfaces is the child's, with its stderr in the assertion.
 * Both come from here so they cannot drift apart: a test timeout at or below
 * the spawn's hides the child's failure (greek-nope-backfill.cli.test.mjs ran
 * a 60 s spawn under vitest's default 15 s test timeout, and failed as "Test
 * timed out in 15000ms" under load on 2026-11-17).
 */

/**
 * What a child gets before spawnSync kills it. A Windows spawn under a full
 * suite run on a loaded machine can take tens of seconds.
 */
export const CHILD_TIMEOUT = 60_000;

/**
 * The test timeout for a test that spawns one child: the child's limit plus a
 * margin for the fixture work and the assertions around the spawn.
 */
export const CHILD_TEST_TIMEOUT = CHILD_TIMEOUT + 30_000;
