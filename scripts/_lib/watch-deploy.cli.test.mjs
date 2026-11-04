// @vitest-environment node

/**
 * The paths of scripts/watch-deploy.mjs that exit 3 (bad arguments, `gh`
 * missing), run as a real process. None of them reaches the network: the
 * arguments are rejected first, and the gh check runs against a PATH with no
 * gh on it. The decision logic and the polling loop are in
 * watch-deploy.test.mjs.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'watch-deploy.mjs');
const SHA = '01452ce77b5c747b5283df230820dcfbae151182';

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(args, env = process.env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

/** The environment with PATH pointing at an empty directory: no gh, no git. */
function envWithoutTools() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  env.PATH = mkdtempSync(path.join(tmpdir(), 'watch-deploy-empty-path-'));
  return env;
}

describe('watch-deploy CLI: exit 3', () => {
  it.each([
    ['no arguments', []],
    ['a sha that is not hex', ['not-a-sha']],
    ['an unknown flag', [SHA, '--wait']],
    ['a timeout that is not a number', [SHA, '--timeout', 'soon']],
    ['a timeout of zero', [SHA, '--timeout', '0']],
    ['a repo that is not owner/name', [SHA, '--repo', 'options']],
  ])('exits 3 with the usage for %s', (_label, args) => {
    const result = run(args);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: node scripts/watch-deploy.mjs');
  });

  it('names what was wrong with the arguments', () => {
    const result = run([SHA, '--timeout', 'soon']);
    expect(result.stderr).toContain('--timeout');
  });

  it('exits 3 and says gh is missing when it is not on PATH', () => {
    const result = run([SHA, '--repo', 'o/n'], envWithoutTools());

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('`gh`');
  });

  it('prints the usage and exits 0 for --help', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: node scripts/watch-deploy.mjs');
    expect(result.stderr).toBe('');
  });
});
