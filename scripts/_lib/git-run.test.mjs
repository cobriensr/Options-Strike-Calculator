// @vitest-environment node

/**
 * Tests for scripts/_lib/git-run.mjs, the git runner shared by the commit
 * gate and prune-worktrees. Real git against a throwaway repo, with git
 * config isolated from the developer's. The spawn failure is real too: a
 * PATH with no git on it, not a mock.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GitError, git, runGit } from './git-run.mjs';
import {
  cleanEnv,
  makeTempDir,
  git as scratchGit,
  setupScratchGit,
} from './scratch-git.fixtures.mjs';

setupScratchGit();

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
