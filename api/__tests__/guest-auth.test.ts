// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Mock the underlying botid/server entrypoint that api-helpers.ts wraps.
// Keeping this at module level (not the api-helpers re-export) means the
// real parseCookies + isOwner stay intact for the pure-function tests below.
// Use vi.hoisted so the mock var lives above the hoisted vi.mock call.
const { checkBotIdMock } = vi.hoisted(() => ({
  checkBotIdMock: vi.fn<() => Promise<{ isBot: boolean }>>(async () => ({
    isBot: false,
  })),
}));
vi.mock('botid/server', () => ({
  checkBotId: checkBotIdMock,
}));

import {
  GUEST_COOKIE,
  GUEST_HINT_COOKIE,
  buildGuestClearCookies,
  buildGuestSetCookies,
  getConfiguredGuestKeys,
  guardOwnerOrGuestEndpoint,
  isGuest,
  isOwnerOrGuest,
  isValidGuestKey,
  rejectIfNotOwnerOrGuest,
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

  it('emits Secure on prod for both cookies', () => {
    const [auth, hint] = buildGuestClearCookies(false);
    expect(auth).toContain('Secure');
    expect(hint).toContain('Secure');
  });
});

describe('rejectIfNotOwnerOrGuest', () => {
  it('returns false (does not reject) for an owner cookie', () => {
    process.env.OWNER_SECRET = 'owner-secret';
    const res = mockResponse();
    const rejected = rejectIfNotOwnerOrGuest(
      mockRequest({ headers: { cookie: 'sc-owner=owner-secret' } }),
      res,
    );
    expect(rejected).toBe(false);
    expect(res._status).toBe(200); // untouched
    expect(res._json).toBeNull();
  });

  it('returns false for a valid guest cookie', () => {
    process.env.GUEST_ACCESS_KEYS = 'guest-key-abc';
    const res = mockResponse();
    const rejected = rejectIfNotOwnerOrGuest(
      mockRequest({ headers: { cookie: 'sc-guest=guest-key-abc' } }),
      res,
    );
    expect(rejected).toBe(false);
    expect(res._status).toBe(200);
  });

  it('rejects with 401 + no-store when neither cookie matches', () => {
    process.env.OWNER_SECRET = 'owner-secret';
    process.env.GUEST_ACCESS_KEYS = 'guest-key-abc';
    const res = mockResponse();
    const rejected = rejectIfNotOwnerOrGuest(
      mockRequest({ headers: { cookie: 'sc-guest=wrong-key' } }),
      res,
    );
    expect(rejected).toBe(true);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Not authenticated' });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });
});

describe('guardOwnerOrGuestEndpoint', () => {
  beforeEach(() => {
    checkBotIdMock.mockReset().mockResolvedValue({ isBot: false });
  });

  it('returns false and lets the handler run for a valid owner cookie', async () => {
    process.env.OWNER_SECRET = 'owner-secret';
    const res = mockResponse();
    const done = vi.fn();
    const rejected = await guardOwnerOrGuestEndpoint(
      mockRequest({ headers: { cookie: 'sc-owner=owner-secret' } }),
      res,
      done,
    );
    expect(rejected).toBe(false);
    expect(done).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it('returns false for a valid guest cookie', async () => {
    process.env.GUEST_ACCESS_KEYS = 'guest-key-abc';
    const res = mockResponse();
    const done = vi.fn();
    const rejected = await guardOwnerOrGuestEndpoint(
      mockRequest({ headers: { cookie: 'sc-guest=guest-key-abc' } }),
      res,
      done,
    );
    expect(rejected).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });

  it('returns 403 + done({status:403}) when botid flags the request', async () => {
    // Real checkBot short-circuits on !VERCEL or isOwner, so we need both:
    // VERCEL=1 (run the real botid path) + a non-owner request.
    process.env.VERCEL = '1';
    process.env.GUEST_ACCESS_KEYS = 'guest-key-abc';
    checkBotIdMock.mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    const done = vi.fn();
    const rejected = await guardOwnerOrGuestEndpoint(
      mockRequest({ headers: { cookie: 'sc-guest=guest-key-abc' } }),
      res,
      done,
    );
    expect(rejected).toBe(true);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(done).toHaveBeenCalledWith({ status: 403 });
  });

  it('returns 401 + done({status:401}) when neither cookie is valid', async () => {
    process.env.OWNER_SECRET = 'owner-secret';
    process.env.GUEST_ACCESS_KEYS = 'guest-key-abc';
    const res = mockResponse();
    const done = vi.fn();
    const rejected = await guardOwnerOrGuestEndpoint(
      mockRequest({ headers: {} }),
      res,
      done,
    );
    expect(rejected).toBe(true);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Not authenticated' });
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(done).toHaveBeenCalledWith({ status: 401 });
  });
});
