// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Everything in api-helpers stays real except the two members the limiter
// tests watch: the limiter itself, and isOwner (wrapped, so the owner tests
// still run the real check and the limiter tests can see it was not reached).
vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    rejectIfRateLimited: vi.fn(),
    isOwner: vi.fn(actual.isOwner),
  };
});

import handler, { WHOAMI_PER_MINUTE } from '../auth/whoami.js';
import { isOwner, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { metrics } from '../_lib/sentry.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GUEST_ACCESS_KEYS;
  delete process.env.OWNER_SECRET;
  vi.mocked(rejectIfRateLimited).mockReset().mockResolvedValue(false);
  vi.mocked(isOwner).mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('GET /api/auth/whoami', () => {
  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it("returns mode='public' when no auth cookies are present", async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'public' });
  });

  it("returns mode='public' when only stale hint cookies are present", async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-hint=1; sc-guest-hint=1' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'public' });
  });

  it("returns mode='guest' when sc-guest matches a configured key", async () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234,bravo-key-5678';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-guest=alpha-key-1234; sc-guest-hint=1' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'guest' });
  });

  it("returns mode='public' when sc-guest does not match any configured key", async () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-guest=stale-revoked-key; sc-guest-hint=1' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'public' });
  });

  it("returns mode='owner' when sc-owner matches OWNER_SECRET", async () => {
    process.env.OWNER_SECRET = 'super-secret-owner-token-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-owner=super-secret-owner-token-1234' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'owner' });
  });

  it("prefers 'owner' over 'guest' when both cookies are valid", async () => {
    process.env.OWNER_SECRET = 'owner-secret-9876';
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: {
          cookie: 'sc-owner=owner-secret-9876; sc-guest=alpha-key-1234',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'owner' });
  });

  it('sets Cache-Control: no-store', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });
});

// A request that carries a credential cookie is rate-limited per client before
// either cookie is checked. A request with no credential cookie is the common
// public visit and never reaches the limiter.
describe('GET /api/auth/whoami rate limit', () => {
  const OWNER_SECRET = 'owner-secret-9876';
  const GUEST_KEY = 'alpha-key-1234';

  // What the real limiter does when it rejects: it writes the 429 itself and
  // returns true, so the handler must send nothing more.
  function limiterRejects(): void {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(429)
        .json({ error: 'Too many requests. Try again in 30 seconds.' });
      return true;
    });
  }

  it('limits a request carrying sc-owner', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    limiterRejects();
    const done = vi.fn();
    vi.spyOn(metrics, 'request').mockReturnValue(done);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}; sc-hint=1` },
      }),
      res,
    );
    expect(res._status).toBe(429);
    expect(res._json).not.toHaveProperty('mode');
    expect(isOwner).not.toHaveBeenCalled();
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({ status: 429 });
  });

  it('limits a request carrying sc-guest', async () => {
    process.env.GUEST_ACCESS_KEYS = GUEST_KEY;
    limiterRejects();
    const done = vi.fn();
    vi.spyOn(metrics, 'request').mockReturnValue(done);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-guest=${GUEST_KEY}; sc-guest-hint=1` },
      }),
      res,
    );
    expect(res._status).toBe(429);
    expect(res._json).not.toHaveProperty('mode');
    expect(isOwner).not.toHaveBeenCalled();
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({ status: 429 });
  });

  it.each([
    ['no cookie header', {}],
    ['only the hint cookies', { cookie: 'sc-hint=1; sc-guest-hint=1' }],
    ['an empty sc-owner value', { cookie: 'sc-owner=; sc-hint=1' }],
    ['an empty sc-guest value', { cookie: 'sc-guest=; sc-guest-hint=1' }],
    ['only unrelated cookies', { cookie: 'theme=dark; lang=en' }],
  ])(
    'does not consult the limiter without a credential cookie: %s',
    async (_label, headers) => {
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers }), res);
      expect(rejectIfRateLimited).not.toHaveBeenCalled();
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ mode: 'public' });
    },
  );

  it('does not consult the limiter for a non-GET request', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._status).toBe(405);
    expect(rejectIfRateLimited).not.toHaveBeenCalled();
  });

  it.each([
    ['sc-owner', 'sc-owner=a-presented-value'],
    ['sc-guest', 'sc-guest=a-presented-value'],
    ['both', 'sc-owner=a-presented-value; sc-guest=a-presented-value'],
  ])(
    'limiter key and budget, before the cookie check: %s',
    async (_label, cookie) => {
      const req = mockRequest({ method: 'GET', headers: { cookie } });
      const res = mockResponse();
      await handler(req, res);
      expect(WHOAMI_PER_MINUTE).toBe(30);
      expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
      expect(rejectIfRateLimited).toHaveBeenCalledWith(
        req,
        res,
        'auth-whoami',
        30,
      );
      const limiterOrder =
        vi.mocked(rejectIfRateLimited).mock.invocationCallOrder[0];
      const ownerOrder = vi.mocked(isOwner).mock.invocationCallOrder[0];
      expect(limiterOrder).toBeDefined();
      expect(ownerOrder).toBeDefined();
      expect(limiterOrder).toBeLessThan(ownerOrder ?? 0);
    },
  );

  it('owner renewal under the limit', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.APP_URL = 'https://example.com';
    delete process.env.VERCEL_ENV;
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}; sc-hint=1` },
      }),
      res,
    );
    expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'owner' });
    expect(res._headers['Set-Cookie']).toEqual([
      `sc-owner=${OWNER_SECRET}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict; Secure`,
      'sc-hint=1; Path=/; Max-Age=34560000; SameSite=Strict; Secure',
    ]);
  });
});

// The endpoint also renews the owner sign-in: a request that already passes
// the owner check gets the sc-owner and sc-hint cookies re-issued with a fresh
// lifetime. Every other answer sets no cookie at all.
describe('GET /api/auth/whoami owner renewal', () => {
  const OWNER_SECRET = 'owner-secret-9876';
  const PRODUCTION_COOKIES = [
    `sc-owner=${OWNER_SECRET}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict; Secure`,
    'sc-hint=1; Path=/; Max-Age=34560000; SameSite=Strict; Secure',
  ];

  beforeEach(() => {
    process.env.APP_URL = 'https://example.com';
    delete process.env.VERCEL_ENV;
  });

  it('re-issues both owner cookies, 400-day lifetime, for a signed-in owner', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}; sc-hint=1` },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ mode: 'owner' });
    expect(res._headers['Set-Cookie']).toEqual(PRODUCTION_COOKIES);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('renews an owner whose sc-hint cookie is gone', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'owner' });
    expect(res._headers['Set-Cookie']).toEqual(PRODUCTION_COOKIES);
  });

  it('renews an owner who also carries a valid guest cookie', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: {
          cookie: `sc-owner=${OWNER_SECRET}; sc-guest=alpha-key-1234`,
        },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'owner' });
    expect(res._headers['Set-Cookie']).toEqual(PRODUCTION_COOKIES);
  });

  it('omits Secure on a localhost APP_URL, as the OAuth callback does', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.APP_URL = 'http://localhost:3000';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._headers['Set-Cookie']).toEqual([
      `sc-owner=${OWNER_SECRET}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict`,
      'sc-hint=1; Path=/; Max-Age=34560000; SameSite=Strict',
    ]);
  });

  it('keeps Secure in production even when APP_URL points at localhost', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.APP_URL = 'http://localhost:3000';
    process.env.VERCEL_ENV = 'production';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._headers['Set-Cookie']).toEqual(PRODUCTION_COOKIES);
  });

  it('keeps Secure when APP_URL is unset', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    delete process.env.APP_URL;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._headers['Set-Cookie']).toEqual(PRODUCTION_COOKIES);
  });

  it('sets no cookie for a guest', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-guest=alpha-key-1234; sc-guest-hint=1' },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'guest' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie for a public request', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._json).toEqual({ mode: 'public' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie when only stale hint cookies are present', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-hint=1; sc-guest-hint=1' },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'public' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie for a wrong owner cookie', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-owner=not-the-secret; sc-hint=1' },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'public' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie for a wrong owner cookie that carries a valid guest cookie', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    process.env.GUEST_ACCESS_KEYS = 'alpha-key-1234';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: 'sc-owner=not-the-secret; sc-guest=alpha-key-1234' },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'guest' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie for an owner cookie when OWNER_SECRET is unset', async () => {
    delete process.env.OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._json).toEqual({ mode: 'public' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('sets no cookie on a non-GET request that carries a valid owner cookie', async () => {
    process.env.OWNER_SECRET = OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );
    expect(res._status).toBe(405);
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });
});
