// @vitest-environment node

/**
 * Tests for scripts/_lib/git-run.mjs, the git runner shared by the commit
 * gate and prune-worktrees. Real git against a throwaway repo, with git
 * config isolated from the developer's. The spawn failure is real too: a
 * PATH with no git on it, not a mock.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GIT_TIMEOUT_MS, GitError, git, runGit } from './git-run.mjs';
import {
  FIXTURE_TIMEOUT,
  cleanEnv,
  makeTempDir,
  git as scratchGit,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { spawnSync: realSpawnSync } =
  await vi.importActual('node:child_process');

setupScratchGit();

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
});

/** spawnSync's own maxBuffer when none is passed. */
const SPAWN_SYNC_DEFAULT_BUFFER = 1024 * 1024;

/** What `fn` threw; fails the test when it returns instead. */
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw, but it returned');
}

/** `err` is the GitError for `args`, carrying `detail`. */
function expectGitError(err, args, detail) {
  expect(err).toBeInstanceOf(GitError);
  expect(err.name).toBe('GitError');
  expect(err.detail).toBe(detail);
  expect(err.message).toBe(`git ${args.join(' ')}: ${detail}`);
}

/** `err` is runGit's refusal of a missing env for `git --version`. */
function expectMissingEnv(err) {
  expect(err).toBeInstanceOf(TypeError);
  expect(err.message).toBe('runGit: env is required (git --version)');
}

/**
 * Run `fn` with `vars` stubbed into process.env, then put back only those
 * vars (stubbing undefined deletes one). unstubAllEnvs would also drop the
 * file's GIT_CONFIG stubs.
 */
function withEnv(vars, fn) {
  const before = Object.keys(vars).map((name) => [name, process.env[name]]);
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  try {
    return fn();
  } finally {
    for (const [name, value] of before) vi.stubEnv(name, value);
  }
}

let repo = '';

beforeAll(() => {
  repo = makeTempDir('git-run-');
  scratchGit(repo, 'init', '-q');
});

/** Store `body` as a blob in the scratch repo; returns its object id. */
function writeBlob(name, body) {
  const file = path.join(repo, name);
  writeFileSync(file, body);
  return scratchGit(repo, 'hash-object', '-w', file);
}

/** Args for a ref lookup that fails: exit 128 with stderr, or exit 1 silently. */
function missingRef(...flags) {
  return ['-C', repo, 'rev-parse', '--verify', ...flags, 'no-such-ref'];
}

/** An env whose PATH is an empty directory, so git can't be found. */
function envWithoutGit() {
  return { PATH: makeTempDir('git-run-empty-path-') };
}

describe('git', () => {
  it("returns git's stdout, untrimmed, on exit 0", () => {
    const id = writeBlob('small.txt', 'hello\n');
    expect(git(['-C', repo, 'cat-file', 'blob', id], cleanEnv())).toBe(
      'hello\n',
    );
  });

  it("returns output larger than spawnSync's 1 MB default buffer, whole", () => {
    const body = 'x'.repeat(2 * SPAWN_SYNC_DEFAULT_BUFFER);
    const id = writeBlob('large.txt', body);
    const out = git(['-C', repo, 'cat-file', 'blob', id], cleanEnv());
    // Length only: a failed toBe would print 2 MB.
    expect(out.length).toBe(body.length);
  });

  it('runs git with the env it is given', () => {
    const env = cleanEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gitrun.probe',
      GIT_CONFIG_VALUE_0: 'from-env',
    });
    expect(git(['-C', repo, 'config', '--get', 'gitrun.probe'], env)).toBe(
      'from-env\n',
    );
  });

  it("throws a GitError with git's stderr when git exits non-zero", () => {
    const args = missingRef();
    expectGitError(
      thrownBy(() => git(args, cleanEnv())),
      args,
      'fatal: Needed a single revision',
    );
  });

  it('throws a GitError naming the exit code when git fails silently', () => {
    const args = missingRef('--quiet');
    expectGitError(
      thrownBy(() => git(args, cleanEnv())),
      args,
      'exit code 1',
    );
  });

  it('returns the stdout of an exit listed in okStatuses, and still throws on one that is not', () => {
    // `config --get` exits 1 when the key is unset: an answer, not a failure.
    const unset = ['-C', repo, 'config', '--get', 'gitrun.unset'];
    expect(git(unset, cleanEnv(), { okStatuses: [0, 1] })).toBe('');
    const args = missingRef();
    expectGitError(
      thrownBy(() => git(args, cleanEnv(), { okStatuses: [0, 1] })),
      args,
      'fatal: Needed a single revision',
    );
  });

  it("writes the input option to git's stdin", () => {
    const body = 'a\0b\n';
    const expected = writeBlob('git-stdin.txt', body);
    const args = ['-C', repo, 'hash-object', '--stdin'];
    expect(git(args, cleanEnv(), { input: body })).toBe(`${expected}\n`);
  });

  it('throws a GitError when git cannot be spawned', () => {
    const args = ['--version'];
    expectGitError(
      thrownBy(() => git(args, envWithoutGit())),
      args,
      'spawnSync git ENOENT',
    );
  });

  it('throws a TypeError when env is missing, instead of using process.env', () => {
    expectMissingEnv(thrownBy(() => git(['--version'], undefined)));
  });
});

describe('runGit', () => {
  it('returns a non-zero exit as { status, stdout, stderr } without throwing', () => {
    expect(runGit(missingRef('--quiet'), cleanEnv())).toMatchObject({
      status: 1,
      stdout: '',
      stderr: '',
    });
  });

  it('returns a failure with stderr (exit 128) without throwing', () => {
    const result = runGit(missingRef(), cleanEnv());
    expect(result).toMatchObject({ status: 128, stdout: '' });
    expect(result.stderr).toContain('fatal: Needed a single revision');
  });

  it('runs git with the env it is given in place of process.env, not merged into it', () => {
    const leaked = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gitrun.probe',
      GIT_CONFIG_VALUE_0: 'leaked',
    };
    const result = withEnv(leaked, () =>
      runGit(['-C', repo, 'config', '--get', 'gitrun.probe'], cleanEnv()),
    );
    // `config --get` exits 1 when the key is unset.
    expect(result).toMatchObject({ status: 1, stdout: '' });
  });

  it("writes the input option to git's stdin, NUL bytes included", () => {
    // `hash-object --stdin` prints the id of the blob it was fed.
    const body = 'a\0b\n';
    const expected = writeBlob('stdin.txt', body);
    const result = runGit(['-C', repo, 'hash-object', '--stdin'], cleanEnv(), {
      input: body,
    });
    expect(result).toMatchObject({ status: 0, stdout: `${expected}\n` });
  });

  it('gives git an empty stdin when there is no input option', () => {
    const emptyBlob = writeBlob('empty.txt', '');
    const result = runGit(['-C', repo, 'hash-object', '--stdin'], cleanEnv());
    expect(result).toMatchObject({ status: 0, stdout: `${emptyBlob}\n` });
  });

  it('throws a GitError when git cannot be spawned', () => {
    const args = ['--version'];
    expectGitError(
      thrownBy(() => runGit(args, envWithoutGit())),
      args,
      'spawnSync git ENOENT',
    );
  });

  it('throws a TypeError when env is missing, instead of using process.env', () => {
    expectMissingEnv(thrownBy(() => runGit(['--version'], undefined)));
  });
});

describe('the time limit on every git call', () => {
  /** An alias that runs a child for 3 s: git has nothing to answer until then. */
  const STALL = ['-c', 'alias.stall=!node -e "setTimeout(() => {}, 3000)"'];

  /**
   * Run the next spawn for real and keep the limit the module asked for. With
   * `cutTo`, run it with that limit instead, so a stall does not take the
   * real one to show. A call that must finish gets no `cutTo`: under load even
   * `git --version` can take longer than a fraction of a second.
   */
  function watchNextSpawn({ cutTo } = {}) {
    const seen = { limit: undefined };
    vi.mocked(spawnSync).mockImplementationOnce((command, args, options) => {
      seen.limit = options.timeout;
      const own =
        cutTo === undefined ? options : { ...options, timeout: cutTo };
      return realSpawnSync(command, args, own);
    });
    return seen;
  }

  it('is set, far above a healthy call and under the fixture timeout, so a stall in a hook names itself', () => {
    expect(GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(GIT_TIMEOUT_MS).toBeLessThan(FIXTURE_TIMEOUT);
  });

  it.each([
    ['git', git],
    ['runGit', runGit],
  ])('is passed to spawnSync by %s', (_name, run) => {
    const seen = watchNextSpawn();

    run(['--version'], cleanEnv());

    expect(seen.limit).toBeGreaterThan(0);
    expect(seen.limit).toBe(GIT_TIMEOUT_MS);
  });

  it.each([
    ['git', git],
    ['runGit', runGit],
  ])(
    'makes %s throw a GitError that says it timed out and after how long, and names the command',
    (_name, run) => {
      watchNextSpawn({ cutTo: 500 });
      const args = [...STALL, 'stall'];

      expectGitError(
        thrownBy(() => run(args, cleanEnv())),
        args,
        `timed out after ${GIT_TIMEOUT_MS / 1000} s`,
      );
    },
  );

  it('leaves a git that ran and failed as it was, not as a timeout', () => {
    const err = thrownBy(() => git(missingRef(), cleanEnv()));

    expect(err.detail).toBe('fatal: Needed a single revision');
    expect(err.detail).not.toContain('timed out');
  });
});
