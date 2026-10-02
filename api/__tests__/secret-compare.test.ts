// @vitest-environment node

/**
 * api/_lib/secret-compare.ts — the shared constant-time secret compare
 * (CLAUDE.md R2) — and proof that the cron auth path delegates to it.
 *
 * Unit tables run against the REAL module (vi.importActual). The guard
 * tests at the bottom swap in delegating spies so they can force the
 * helper's answer and show cronGuard / isCronAuthenticated obey it.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type * as SecretCompare from '../_lib/secret-compare.js';
import { mockRequest, mockResponse } from './helpers';

// Spy on timingSafeEqual (delegating) to prove the compare never takes a
// length-dependent early exit.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// Delegating spies for the guard tests; unit tests use the real module.
vi.mock('../_lib/secret-compare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SecretCompare>();
  return {
    secretEquals: vi.fn(actual.secretEquals),
    bearerMatches: vi.fn(actual.bearerMatches),
  };
});

// cron-instrumentation's heavy neighbours, stubbed so isCronAuthenticated
// can be imported.
vi.mock('../_lib/api-helpers.js', () => ({ cronGuard: vi.fn() }));
vi.mock('../_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

import { timingSafeEqual } from 'node:crypto';
import { bearerMatches } from '../_lib/secret-compare.js';
import { cronGuard } from '../_lib/cron-helpers.js';
import { isCronAuthenticated } from '../_lib/cron-instrumentation.js';

let real: typeof SecretCompare;
beforeAll(async () => {
  real = await vi.importActual<typeof SecretCompare>(
    '../_lib/secret-compare.js',
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('secretEquals', () => {
  it.each([
    ['s3cret-value', 's3cret-value', true, 'equal'],
    ['s3cret-valuX', 's3cret-value', false, 'unequal, same length'],
    ['s3cret', 's3cret-value', false, 'presented is a prefix (shorter)'],
    ['s3cret-value-extra', 's3cret-value', false, 'presented is longer'],
    ['S3CRET-VALUE', 's3cret-value', false, 'case differs'],
    ['clé-secrète-✓', 'clé-secrète-✓', true, 'equal non-ASCII'],
    ['clé-secrète-✓', 'cle-secrete-v', false, 'non-ASCII vs ASCII lookalike'],
  ])('%j vs %j → %s (%s)', (presented, expected, want) => {
    expect(real.secretEquals(presented, expected)).toBe(want);
  });

  it.each<[unknown, unknown, string]>([
    ['', 'secret', 'empty presented'],
    ['secret', '', 'empty expected'],
    ['', '', 'both empty'],
    [undefined, 'secret', 'undefined presented'],
    ['secret', undefined, 'undefined expected (unset env var)'],
    [null, 'secret', 'null presented'],
    [['secret'], 'secret', 'array presented (multi-value header)'],
    [42, '42', 'number presented'],
  ])('%j vs %j → false, never throws (%s)', (presented, expected) => {
    expect(() => real.secretEquals(presented, expected)).not.toThrow();
    expect(real.secretEquals(presented, expected)).toBe(false);
  });

  it('compares fixed-length digests even when the lengths differ (no length early-exit)', () => {
    expect(real.secretEquals('a', 'a-much-longer-secret-value')).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [left, right] = vi.mocked(timingSafeEqual).mock.calls[0]! as [
      Buffer,
      Buffer,
    ];
    expect(left).toHaveLength(32);
    expect(right).toHaveLength(32);
  });
});

describe('bearerMatches', () => {
  const SECRET = 'cron-secret-123';

  it('accepts exactly "Bearer <secret>"', () => {
    expect(real.bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each<[unknown, string]>([
    [undefined, 'missing header'],
    ['', 'empty header'],
    ['Bearer', 'bare scheme, no token'],
    ['Bearer ', 'scheme + space, no token'],
    [SECRET, 'token without the Bearer prefix'],
    [`bearer ${SECRET}`, 'lowercase scheme'],
    [`Bearer  ${SECRET}`, 'double space'],
    [`Bearer ${SECRET} `, 'trailing whitespace'],
    [` Bearer ${SECRET}`, 'leading whitespace'],
    [`Basic ${SECRET}`, 'different scheme'],
    [`Bearer ${SECRET}x`, 'token with a suffix'],
    [[`Bearer ${SECRET}`], 'array header'],
  ])('rejects %j (%s)', (header) => {
    expect(real.bearerMatches(header, SECRET)).toBe(false);
  });

  it.each<[string | undefined, string]>([
    [undefined, 'unset secret'],
    ['', 'empty secret'],
  ])('rejects every header when the secret is %j (%s)', (secret) => {
    expect(real.bearerMatches('Bearer ', secret)).toBe(false);
    expect(real.bearerMatches('Bearer undefined', secret)).toBe(false);
  });
});

describe('cron auth path delegates to bearerMatches', () => {
  const SECRET = 'guard-secret';
  const authed = (authorization?: string) =>
    mockRequest({
      method: 'GET',
      headers: authorization ? { authorization } : {},
    });

  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: SECRET, UW_API_KEY: 'uw' };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('cronGuard passes the Authorization header and CRON_SECRET to bearerMatches', () => {
    const res = mockResponse();
    const guard = cronGuard(authed(`Bearer ${SECRET}`), res, {
      marketHours: false,
    });
    expect(guard).toMatchObject({ apiKey: 'uw' });
    expect(bearerMatches).toHaveBeenCalledWith(`Bearer ${SECRET}`, SECRET);
  });

  it("cronGuard obeys the helper's verdict (a forced false rejects the right secret with 401)", () => {
    vi.mocked(bearerMatches).mockReturnValueOnce(false);
    const res = mockResponse();
    expect(
      cronGuard(authed(`Bearer ${SECRET}`), res, { marketHours: false }),
    ).toBeNull();
    expect(res._status).toBe(401);
  });

  it('cronGuard still answers 401, without consulting the helper, when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    expect(
      cronGuard(authed(`Bearer ${SECRET}`), res, { marketHours: false }),
    ).toBeNull();
    expect(res._status).toBe(401);
    expect(bearerMatches).not.toHaveBeenCalled();
  });

  it('isCronAuthenticated returns exactly what bearerMatches decides', () => {
    expect(isCronAuthenticated(authed(`Bearer ${SECRET}`))).toBe(true);
    expect(bearerMatches).toHaveBeenLastCalledWith(`Bearer ${SECRET}`, SECRET);

    vi.mocked(bearerMatches).mockReturnValueOnce(true);
    expect(isCronAuthenticated(authed('Bearer wrong'))).toBe(true);

    expect(isCronAuthenticated(authed())).toBe(false);
    expect(bearerMatches).toHaveBeenLastCalledWith(undefined, SECRET);
  });
});
