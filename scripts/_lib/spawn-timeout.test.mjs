// @vitest-environment node

/**
 * Tests for scripts/_lib/spawn-timeout.fixtures.mjs: the time limits of the
 * tests that run a child node process, and spawnChild, which gives the child
 * its limit and turns a killed or unstartable child into an error that names
 * it. The children here are real node processes, with limits cut to a fraction
 * of a second.
 */

import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_TIMEOUT_MS } from './git-run.mjs';
import { FIXTURE_TIMEOUT } from './scratch-git.fixtures.mjs';
import {
  CHILD_TEST_TIMEOUT,
  CHILD_TIMEOUT,
  SLOW_CHILD_TIMEOUT,
  spawnChild,
} from './spawn-timeout.fixtures.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { spawnSync: realSpawnSync } =
  await vi.importActual('node:child_process');

// One test lets a child run for STARTED_LIMIT before the kill, which is most of
// vitest's default 15 s.
vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT });

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
});

/**
 * How long a test that needs the child to have written to stderr lets it run
 * before the kill: node can take seconds to start on a loaded machine.
 */
const STARTED_LIMIT = 10_000;

/**
 * A child that writes the value of the JavaScript expression `text` to
 * stderr, then sits idle for 30 s (it is killed long before, and it is the
 * node process itself, so nothing outlives it). An expression, so that a long
 * text is built in the child and does not sit in its arguments.
 */
function stalling(text) {
  return ['-e', `process.stderr.write(${text}); setTimeout(() => {}, 30000)`];
}

/** What `fn` threw; fails the test when it returns instead. */
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw, but it returned');
}

describe('the limits', () => {
  it('give a test more time than its child', () => {
    expect(CHILD_TEST_TIMEOUT).toBeGreaterThan(CHILD_TIMEOUT);
    expect(SLOW_CHILD_TIMEOUT).toBeGreaterThan(CHILD_TIMEOUT);
  });

  // Each limit sits inside the next, so the innermost one to fire is the one
  // that names what stalled: a git call (GIT_TIMEOUT_MS) inside a CLI child
  // that runs it (SLOW_CHILD_TIMEOUT) inside the hook or test that waits on the
  // child (FIXTURE_TIMEOUT). With two of them equal, a git stall inside a CLI
  // could be reported as the CLI, or as the hook.
  it('nest strictly: a git call, inside a slow CLI child, inside a hook', () => {
    expect(GIT_TIMEOUT_MS).toBeLessThan(SLOW_CHILD_TIMEOUT);
    expect(SLOW_CHILD_TIMEOUT).toBeLessThan(FIXTURE_TIMEOUT);
  });

  it('leave the CLI child room to report a git call that timed out', () => {
    // The CLI has to catch the GitError, print it and exit before its own
    // limit: a margin well over a loaded machine's process start.
    expect(SLOW_CHILD_TIMEOUT - GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(FIXTURE_TIMEOUT - SLOW_CHILD_TIMEOUT).toBeGreaterThanOrEqual(60_000);
  });
});

describe('spawnChild', () => {
  it('gives the child CHILD_TIMEOUT unless the caller sets its own limit', () => {
    const limits = [];
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      limits.push(options.timeout);
      return realSpawnSync(command, args, options);
    });

    spawnChild(process.execPath, ['-e', ''], {});
    spawnChild(process.execPath, ['-e', ''], { timeout: SLOW_CHILD_TIMEOUT });

    expect(limits).toEqual([CHILD_TIMEOUT, SLOW_CHILD_TIMEOUT]);
  });

  it('returns a child that exited non-zero as it is, with its output', () => {
    const result = spawnChild(
      process.execPath,
      ['-e', "console.log('out'); console.error('err'); process.exit(3)"],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('throws when the child outlasts its limit, naming the child, the limit and the tail of its stderr so far', () => {
    const err = thrownBy(() =>
      spawnChild(process.execPath, stalling("'x'.repeat(5000) + 'THE END'"), {
        encoding: 'utf8',
        timeout: STARTED_LIMIT,
      }),
    );

    expect(err.message).toMatch(/^child process timed out after 10 s: node/);
    expect(err.message).toContain('-e process.stderr.write(');
    expect(err.message).toContain("'x'.repeat(5000) + 'THE END'");
    // The end of what the child wrote, not all 5000 characters of it.
    expect(err.message).toContain('stderr so far:\nxxx');
    expect(err.message).toContain('xxxTHE END');
    expect(err.message.length).toBeLessThan(900);
    expect(err.cause).toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('says nothing about stderr when the child wrote none', () => {
    const err = thrownBy(() =>
      spawnChild(process.execPath, stalling("''"), {
        encoding: 'utf8',
        timeout: 500,
      }),
    );

    expect(err.message).toMatch(/^child process timed out after 0\.5 s/);
    expect(err.message).not.toContain('stderr so far');
  });

  it('throws, naming the command, when the child cannot be started', () => {
    const err = thrownBy(() =>
      spawnChild('no-such-command-for-spawn-child', ['--flag'], {
        encoding: 'utf8',
      }),
    );

    expect(err.message).toMatch(
      /^child process could not run \(.*ENOENT.*\): no-such-command-for-spawn-child --flag/,
    );
    expect(err.cause).toMatchObject({ code: 'ENOENT' });
  });
});
