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
