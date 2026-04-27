// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest } from './helpers';

import {
  GUEST_COOKIE,
  GUEST_HINT_COOKIE,
  buildGuestClearCookies,
  buildGuestSetCookies,
  getConfiguredGuestKeys,
  isGuest,
  isOwnerOrGuest,
  isValidGuestKey,
} from '../_lib/guest-auth.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GUEST_ACCESS_KEYS;
  delete process.env.OWNER_SECRET;
  delete process.env.VERCEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('getConfiguredGuestKeys', () => {
  it('returns an empty array when GUEST_ACCESS_KEYS is unset', () => {
    expect(getConfiguredGuestKeys()).toEqual([]);
  });

  it('splits, trims, and drops empty entries', () => {
    process.env.GUEST_ACCESS_KEYS = ' alpha , bravo,, charlie ,';
    expect(getConfiguredGuestKeys()).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

describe('isValidGuestKey', () => {
  it('rejects when env var is unset', () => {
    expect(isValidGuestKey('anything-goes-here-12345')).toBe(false);
  });

  it('accepts an exact match against any configured key', () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234,bravo-key-5678';
    expect(isValidGuestKey('alpha-key-1234')).toBe(true);
    expect(isValidGuestKey('bravo-key-5678')).toBe(true);
  });

  it('rejects keys that do not match any entry', () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234,bravo-key-5678';
    expect(isValidGuestKey('charlie-key-9999')).toBe(false);
    expect(isValidGuestKey('alpha-key-12345')).toBe(false); // length differs
    expect(isValidGuestKey('')).toBe(false);
  });
});

describe('isGuest', () => {
  it('returns false when cookie header is missing', () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-secret-key';
    expect(isGuest(mockRequest({ headers: {} }))).toBe(false);
  });

  it('returns false when sc-guest cookie is empty', () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-secret-key';
    expect(isGuest(mockRequest({ headers: { cookie: 'sc-guest=' } }))).toBe(
      false,
    );
  });

  it('returns true when sc-guest matches a configured key', () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-secret-key';
    expect(
      isGuest(
        mockRequest({ headers: { cookie: 'sc-guest=shared-secret-key' } }),
      ),
    ).toBe(true);
  });

  it('returns false when sc-guest does not match', () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-secret-key';
    expect(
      isGuest(
        mockRequest({ headers: { cookie: 'sc-guest=different-key-value' } }),
      ),
    ).toBe(false);
  });
});

describe('isOwnerOrGuest', () => {
  it('returns true for a valid owner cookie even without guest config', () => {
    process.env.OWNER_SECRET = 'owner-secret-value';
    expect(
      isOwnerOrGuest(
        mockRequest({ headers: { cookie: 'sc-owner=owner-secret-value' } }),
      ),
    ).toBe(true);
  });

  it('returns true for a valid guest cookie even without owner config', () => {
    process.env.GUEST_ACCESS_KEYS = 'guest-only-key-here';
    expect(
      isOwnerOrGuest(
        mockRequest({ headers: { cookie: 'sc-guest=guest-only-key-here' } }),
      ),
    ).toBe(true);
  });

  it('returns false when neither cookie is present and valid', () => {
    process.env.OWNER_SECRET = 'owner-secret';
    process.env.GUEST_ACCESS_KEYS = 'guest-key';
    expect(isOwnerOrGuest(mockRequest({ headers: {} }))).toBe(false);
  });
});

describe('buildGuestSetCookies', () => {
  it('emits HttpOnly + SameSite=Strict + 30-day Max-Age + Secure on prod', () => {
    const [auth, hint] = buildGuestSetCookies('the-key', false);
    expect(auth).toContain(`${GUEST_COOKIE}=the-key`);
    expect(auth).toContain('HttpOnly');
    expect(auth).toContain('SameSite=Strict');
    expect(auth).toContain('Max-Age=2592000');
    expect(auth).toContain('Secure');
    expect(hint).toContain(`${GUEST_HINT_COOKIE}=1`);
    expect(hint).not.toContain('HttpOnly');
    expect(hint).toContain('Secure');
  });

  it('omits Secure on local dev', () => {
    const [auth, hint] = buildGuestSetCookies('the-key', true);
    expect(auth).not.toContain('Secure');
    expect(hint).not.toContain('Secure');
  });
});

describe('buildGuestClearCookies', () => {
  it('expires both cookies with Max-Age=0', () => {
    const [auth, hint] = buildGuestClearCookies(true);
    expect(auth).toContain('Max-Age=0');
    expect(auth).toContain(`${GUEST_COOKIE}=`);
    expect(hint).toContain('Max-Age=0');
    expect(hint).toContain(`${GUEST_HINT_COOKIE}=`);
  });
});
