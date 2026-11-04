// @vitest-environment node

/**
 * Self-tests for the no-database guard (src/__tests__/db-guard.ts, wired in
 * src/__tests__/setup.ts). Each block is proven by provoking it on purpose.
 * The test that provokes an attempt clears the log itself, because the
 * `afterEach` in setup.ts fails any test that leaves one behind.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client, neon, Pool } from '@neondatabase/serverless';
import { _resetDb, getDb, safeDb } from '../_lib/db.js';
import * as guard from '../../src/__tests__/db-guard.js';

const { BLOCK_MESSAGE, BLOCKED_ENV_NAMES, dbAttempts } = guard;
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
    expect(() => neon(DSN)).toThrow(BLOCK_MESSAGE);
    expect(dbAttempts).toEqual(['neon']);
    dbAttempts.length = 0;
  });

  it.each([
    ['Pool', Pool],
    ['Client', Client],
  ])('new %s() throws the block message and records it', (name, Ctor) => {
    expect(() => new Ctor({ connectionString: DSN })).toThrow(BLOCK_MESSAGE);
    expect(dbAttempts).toEqual([name]);
    dbAttempts.length = 0;
  });

  it('never echoes the connection string', () => {
    let message = '';
    try {
      neon(DSN);
    } catch (err) {
      message = (err as Error).message;
    }
    dbAttempts.length = 0;
    expect(message).toContain(BLOCK_MESSAGE);
    expect(message).not.toContain('hunter2');
  });

  it('blocks the production path: getDb() with a URL set', () => {
    vi.stubEnv('DATABASE_URL', DSN);
    _resetDb();
    expect(() => getDb()).toThrow(BLOCK_MESSAGE);
    expect(dbAttempts).toEqual(['neon']);
    dbAttempts.length = 0;
  });
});

describe('a swallowed attempt', () => {
  it('is recorded even when safeDb eats the throw, and the check names it', async () => {
    const result = await safeDb(async () => {
      neon(DSN);
      return 'connected';
    }, 'fell back');
    expect(result).toBe('fell back');
    expect(dbAttempts).toEqual(['neon']);

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
