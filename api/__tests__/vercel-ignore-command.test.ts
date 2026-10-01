// @vitest-environment node

/**
 * Behavior test for the `vercel.json` `ignoreCommand` (Vercel's Ignored
 * Build Step). Exit 0 skips the deploy, exit 1 builds, and any other code
 * fails the build outright.
 *
 * The real command string from `vercel.json` runs under `sh` inside a
 * throwaway git repo, so the shell logic itself is pinned rather than a copy
 * of it. The regression case: a multi-commit push whose LAST commit touches
 * only ignored paths must still build when the previously deployed commit
 * can't be resolved (unset, or missing from Vercel's shallow clone).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { ignoreCommand } = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
) as { ignoreCommand: string };

/**
 * Child env without GIT_* vars: a git hook (e.g. pre-commit running tests)
 * exports GIT_DIR / GIT_INDEX_FILE, which would otherwise point the scratch
 * repo's git calls at the real repository.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'VERCEL_GIT_PREVIOUS_SHA') {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

let repo = '';
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync(
    // Test-only: Vercel's build runs `git` from PATH too; resolve it the same way.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, env: cleanEnv(), encoding: 'utf8' },
  ).trim();
}

function commit(label: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', label);
  sha[label] = git('rev-parse', 'HEAD');
}

/** Run the ignoreCommand at HEAD; returns its exit code. */
function runIgnoreCommand(previousSha?: string): number | null {
  const extra: Record<string, string> =
    previousSha === undefined ? {} : { VERCEL_GIT_PREVIOUS_SHA: previousSha };
  // Test-only: Vercel runs ignoreCommand through a PATH-resolved shell too.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return spawnSync('sh', ['-c', ignoreCommand], {
    cwd: repo,
    env: cleanEnv(extra),
  }).status;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ignore-command-'));
  git('init', '-q');
  commit('base', { 'api/handler.ts': 'v1\n', 'docs/notes.md': 'v1\n' });
  commit('api-change', { 'api/handler.ts': 'v2\n' });
  commit('docs-change', { 'docs/notes.md': 'v2\n' });
  // HEAD: touches every ignored path family and nothing deployable.
  commit('ignored-only', {
    'sidecar/app.py': 'x\n',
    'ml/model.py': 'x\n',
    'uw-stream/consumer.py': 'x\n',
    'scripts/backfill.mjs': 'x\n',
    'pine/study.pine': 'x\n',
    'README.md': 'x\n',
  });
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('vercel.json ignoreCommand', () => {
  it('builds when VERCEL_GIT_PREVIOUS_SHA is unset, even if HEAD is ignored-only', () => {
    expect(runIgnoreCommand()).toBe(1);
  });

  it('builds when the previous SHA is absent from the clone', () => {
    expect(runIgnoreCommand('deadbeef'.repeat(5))).toBe(1);
  });

  it('builds when an earlier commit in the push range touched a deployable path', () => {
    expect(runIgnoreCommand(sha.base)).toBe(1);
  });

  it('skips when every commit since the previous deploy touches only ignored paths', () => {
    expect(runIgnoreCommand(sha['api-change'])).toBe(0);
  });
});
