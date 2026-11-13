// @vitest-environment node

/**
 * Owner sign-in cookies (`buildOwnerSessionCookies`, `OWNER_COOKIE_MAX_AGE`
 * and `isLocalDeployment` in auth-helpers.ts).
 *
 * The OAuth callback and the whoami renewal both set these cookies, so the
 * exact Set-Cookie strings are pinned here: a changed attribute has to be
 * changed on purpose, in this file. `isLocalDeployment` is the one rule the
 * owner and guest cookie handlers share for dropping `Secure`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_COOKIE_MAX_AGE,
  buildOwnerSessionCookies,
  isLocalDeployment,
} from '../_lib/auth-helpers.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.OWNER_SECRET = 'owner-secret-1234';
  delete process.env.APP_URL;
  delete process.env.VERCEL_ENV;
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

describe('isLocalDeployment', () => {
  it.each([
    ['http://localhost:3000', true],
    ['https://localhost', true],
    ['http://127.0.0.1:3000', true],
    ['https://strike.example.com', false],
    // The hostname is parsed, not searched for a substring.
    ['https://localhost.example.com', false],
    ['https://example.com/?next=localhost', false],
    ['https://localhost@example.com', false],
  ])('APP_URL %s -> %s', (appUrl, expected) => {
    process.env.APP_URL = appUrl;
    expect(isLocalDeployment()).toBe(expected);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
    ['a host with no scheme', 'localhost:3000'],
  ])('is false (Secure stays on) when APP_URL is %s', (_label, value) => {
    if (value === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = value;
    expect(isLocalDeployment()).toBe(false);
  });

  it('is false in production even when APP_URL points at localhost', () => {
    process.env.APP_URL = 'http://localhost:3000';
    process.env.VERCEL_ENV = 'production';
    expect(isLocalDeployment()).toBe(false);
  });

  it.each(['development', 'preview'])(
    'follows APP_URL when VERCEL_ENV is %s',
    (env) => {
      process.env.VERCEL_ENV = env;
      process.env.APP_URL = 'http://localhost:3000';
      expect(isLocalDeployment()).toBe(true);
      process.env.APP_URL = 'https://strike.example.com';
      expect(isLocalDeployment()).toBe(false);
    },
  );

  it('reads the environment at call time', () => {
    process.env.APP_URL = 'http://localhost:3000';
    expect(isLocalDeployment()).toBe(true);
    process.env.VERCEL_ENV = 'production';
    expect(isLocalDeployment()).toBe(false);
  });
});
