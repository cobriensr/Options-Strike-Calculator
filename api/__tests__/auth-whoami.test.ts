// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

import handler from '../auth/whoami.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GUEST_ACCESS_KEYS;
  delete process.env.OWNER_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
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
