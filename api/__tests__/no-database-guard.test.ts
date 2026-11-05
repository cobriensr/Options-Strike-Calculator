// @vitest-environment node

/**
 * Self-tests for the no-database guard (src/__tests__/db-guard.ts, wired in
 * src/__tests__/setup.ts). Each block is proven by provoking it on purpose.
 * The test that provokes an attempt discards its own entries, because the
 * `afterEach` in setup.ts fails any test that leaves one behind.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client, neon, Pool } from '@neondatabase/serverless';
import { _resetDb, getDb, safeDb } from '../_lib/db.js';
import * as guard from '../../src/__tests__/db-guard.js';

const { BLOCK_MESSAGE, BLOCKED_ENV_NAMES, dbAttempts, trackDbAttempts } = guard;
const DSN = 'postgres://user:hunter2@invalid.invalid/db';

// Created before the first test so the setup.ts afterEach, which runs after
// every test body, is seen calling the check.
const checkSpy = vi.spyOn(guard, 'assertNoDbAttempts');

afterEach(() => {
  vi.unstubAllEnvs();
  _resetDb();
});

afterAll(() => {
  checkSpy.mockRestore();
});

describe('the global @neondatabase/serverless mock', () => {
  it('neon() throws the block message and records the attempt', () => {
    const attempts = trackDbAttempts();
    expect(() => neon(DSN)).toThrow(BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['neon']);
    attempts.discard();
  });

  it.each([
    ['Pool', Pool],
    ['Client', Client],
  ])('new %s() throws the block message and records it', (name, Ctor) => {
    const attempts = trackDbAttempts();
    expect(() => new Ctor({ connectionString: DSN })).toThrow(BLOCK_MESSAGE);
    expect(attempts.made).toEqual([name]);
    attempts.discard();
  });

  it('never echoes the connection string', () => {
    const attempts = trackDbAttempts();
    let message = '';
    try {
      neon(DSN);
    } catch (err) {
      message = (err as Error).message;
    }
    attempts.discard();
    expect(message).toContain(BLOCK_MESSAGE);
    expect(message).not.toContain('hunter2');
  });

  it('blocks the production path: getDb() with a URL set', () => {
    const attempts = trackDbAttempts();
    vi.stubEnv('DATABASE_URL', DSN);
    _resetDb();
    expect(() => getDb()).toThrow(BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['neon']);
    attempts.discard();
  });
});

describe('a swallowed attempt', () => {
  it('is recorded even when safeDb eats the throw, and the check names it', async () => {
    const attempts = trackDbAttempts();
    const result = await safeDb(async () => {
      neon(DSN);
      return 'connected';
    }, 'fell back');
    expect(result).toBe('fell back');
    expect(attempts.made).toEqual(['neon']);

    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(`${BLOCK_MESSAGE}.*neon`),
    );
    // The check clears the log, so one attempt fails one test only.
    expect(dbAttempts).toEqual([]);
  });

  it('passes when nothing tried', () => {
    expect(() => guard.assertNoDbAttempts()).not.toThrow();
  });
});

describe('the setup.ts afterEach', () => {
  let callsWhenThePreviousTestEnded = 0;

  it('runs the check after a test (part 1: any test, note the count)', () => {
    callsWhenThePreviousTestEnded = checkSpy.mock.calls.length;
  });

  it('ran the check after the previous test (part 2)', () => {
    // Only the hook can have called it between the two bodies.
    expect(checkSpy.mock.calls.length).toBeGreaterThan(
      callsWhenThePreviousTestEnded,
    );
  });
});

describe('trackDbAttempts', () => {
  it('discards only the attempts made after it, not an earlier offender', () => {
    // 'earlier' stands for an attempt a beforeAll swallowed before this test.
    dbAttempts.push('earlier');
    const attempts = trackDbAttempts();
    expect(() => neon(DSN)).toThrow(BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['neon']);

    attempts.discard();

    expect(dbAttempts).toEqual(['earlier']);
    // Remove the sentinel this test pushed, or the afterEach would fail it.
    dbAttempts.splice(0);
  });
});

// The setup.ts afterAll cannot be observed from inside the file it guards: it
// runs after the file's own hooks. So each case runs a one-file Vitest project
// that loads the real setup.ts, under node_modules/.cache so that `vitest` and
// the Neon package resolve. The probe's own afterAll runs first (hooks run in
// stack order) and makes an attempt that a try/catch swallows, the way safeDb
// would.
describe('the setup.ts afterAll', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const vitestBin = path.join(
    path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );

  function runProbe(testSource: string) {
    const cache = path.join(repoRoot, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(path.join(cache, 'no-db-afterall-'));
    try {
      const setup = path
        .join(repoRoot, 'src', '__tests__', 'setup.ts')
        .split(path.sep)
        .join('/');
      writeFileSync(
        path.join(dir, 'vitest.config.mjs'),
        `export default { test: { globals: true, environment: 'node', ` +
          `include: ['probe.test.ts'], setupFiles: [${JSON.stringify(setup)}] } };
`,
      );
      writeFileSync(path.join(dir, 'probe.test.ts'), testSource);
      // A nested run must not think it is a worker of this one.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS',
        ),
      );
      const result = spawnSync(
        process.execPath,
        [vitestBin, 'run', '--root', dir, '--config', 'vitest.config.mjs'],
        { cwd: dir, env, encoding: 'utf8', timeout: 120_000 },
      );
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const probe = (body: string) => `
    import { neon } from '@neondatabase/serverless';
    afterAll(() => {
      try {
        ${body}
      } catch {
        // swallowed, as safeDb would
      }
    });
    it('passes on its own', () => {});
  `;

  it('fails the file for an attempt a swallowed afterAll made', () => {
    const { status, output } = runProbe(
      probe("neon('postgres://user:hunter2@invalid.invalid/db');"),
    );
    expect(status, output).not.toBe(0);
    expect(output).toContain(BLOCK_MESSAGE);
    expect(output).toContain('this test tried: neon');
    expect(output).not.toContain('hunter2');
  }, 130_000);

  it('passes the same file when nothing tried', () => {
    const { status, output } = runProbe(probe('void neon;'));
    expect(status, output).toBe(0);
  }, 130_000);
});

describe('the env scrub', () => {
  it('removes every blocked name, whether or not it was set', () => {
    for (const name of BLOCKED_ENV_NAMES) {
      vi.stubEnv(name, 'set-by-the-test');
    }
    guard.scrubDbEnv();
    for (const name of BLOCKED_ENV_NAMES) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it('covers the database URLs and the writable stores', () => {
    expect(BLOCKED_ENV_NAMES).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'DATABASE_URL_UNPOOLED',
        'POSTGRES_URL',
        'NEON_DATABASE_URL',
        'KV_REST_API_TOKEN',
        'UPSTASH_REDIS_REST_URL',
        'BLOB_READ_WRITE_TOKEN',
        'R2_SECRET_ACCESS_KEY',
      ]),
    );
  });

  it('ran at setup: a shell that exports the names does not reach tests', () => {
    // Meaningful when the shell exports them, e.g.
    //   DATABASE_URL=x BLOB_READ_WRITE_TOKEN=x npx vitest run <this file>
    // and a clean no-op check otherwise. The mutation check removes the
    // scrubDbEnv() call in setup.ts and reruns with the names exported.
    for (const name of BLOCKED_ENV_NAMES) {
      expect(process.env[name], name).toBeUndefined();
    }
  });
});
