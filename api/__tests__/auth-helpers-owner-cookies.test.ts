// @vitest-environment node

/**
 * Owner sign-in cookies (`buildOwnerSessionCookies` and
 * `OWNER_COOKIE_MAX_AGE` in auth-helpers.ts).
 *
 * The OAuth callback and the whoami renewal both set these cookies, so the
 * exact Set-Cookie strings are pinned here: a changed attribute has to be
 * changed on purpose, in this file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_COOKIE_MAX_AGE,
  buildOwnerSessionCookies,
} from '../_lib/auth-helpers.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.OWNER_SECRET = 'owner-secret-1234';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('OWNER_COOKIE_MAX_AGE', () => {
  it('is 400 days in seconds, the longest lifetime Chrome keeps', () => {
    expect(OWNER_COOKIE_MAX_AGE).toBe(400 * 24 * 60 * 60);
    expect(OWNER_COOKIE_MAX_AGE).toBe(34_560_000);
  });
});

describe('buildOwnerSessionCookies', () => {
  it('returns the sc-owner and sc-hint cookies with the production attributes', () => {
    expect(buildOwnerSessionCookies(false)).toEqual([
      'sc-owner=owner-secret-1234; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict; Secure',
      'sc-hint=1; Path=/; Max-Age=34560000; SameSite=Strict; Secure',
    ]);
  });

  it('drops only Secure on localhost', () => {
    expect(buildOwnerSessionCookies(true)).toEqual([
      'sc-owner=owner-secret-1234; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict',
      'sc-hint=1; Path=/; Max-Age=34560000; SameSite=Strict',
    ]);
  });

  it('keeps the owner cookie HttpOnly and the hint cookie readable by script', () => {
    const [owner, hint] = buildOwnerSessionCookies(false);
    expect(owner).toContain('HttpOnly');
    expect(hint).not.toContain('HttpOnly');
  });

  it('reads the secret from OWNER_SECRET at call time', () => {
    process.env.OWNER_SECRET = 'rotated-secret-5678';
    expect(buildOwnerSessionCookies(false)[0]).toMatch(
      /^sc-owner=rotated-secret-5678;/,
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])(
    'throws when OWNER_SECRET is %s rather than issue a cookie without a secret',
    (_label, value) => {
      if (value === undefined) delete process.env.OWNER_SECRET;
      else process.env.OWNER_SECRET = value;
      expect(() => buildOwnerSessionCookies(false)).toThrow(/OWNER_SECRET/);
    },
  );
});
