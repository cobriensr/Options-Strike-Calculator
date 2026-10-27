// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The state nonce is consumed with one atomic GETDEL; '1' is what
// getAuthUrl stores.
const mockRedis = vi.hoisted(() => ({
  getdel: vi.fn().mockResolvedValue('1'),
}));

vi.mock('../_lib/schwab.js', () => ({
  storeInitialTokens: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  redis: mockRedis,
}));

// Spy on Sentry captures only; the isolation scope and metrics stay real.
const mockSentryCapture = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('../_lib/sentry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/sentry.js')>();
  return { ...actual, Sentry: { ...actual.Sentry, ...mockSentryCapture } };
});

vi.mock('../_lib/api-helpers.js', () => ({
  OWNER_COOKIE: 'sc-owner',
  OWNER_COOKIE_MAX_AGE: 604800,
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

import handler from '../auth/callback.js';
import { storeInitialTokens } from '../_lib/schwab.js';

describe('GET /api/auth/callback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.APP_URL = 'https://example.com';
    vi.restoreAllMocks();
    // Call history only; the default answers above stay.
    vi.clearAllMocks();
    mockRedis.getdel.mockReset().mockResolvedValue('1');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 400 when code is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ query: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain(
      'authorization code',
    );
  });

  it('returns 400 when code is not a string', async () => {
    const res = mockResponse();
    await handler(mockRequest({ query: { code: ['a', 'b'] } }), res);
    expect(res._status).toBe(400);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])(
    'returns 500 when OWNER_SECRET is %s, before any token exchange',
    async (_label, value) => {
      if (value === undefined) delete process.env.OWNER_SECRET;
      else process.env.OWNER_SECRET = value;
      const res = mockResponse();
      await handler(
        mockRequest({
          query: { code: 'auth-code-123', state: 'valid-state' },
          headers: { host: 'example.com' },
        }),
        res,
      );
      expect(res._status).toBe(500);
      expect((res._json as { error: string }).error).toContain('OWNER_SECRET');
      expect(storeInitialTokens).not.toHaveBeenCalled();
      expect(res._headers['Set-Cookie']).toBeUndefined();
    },
  );

  it('returns 400 when state parameter is missing', async () => {
    process.env.OWNER_SECRET = 'secret';
    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123' },
        headers: { host: 'example.com' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('state');
  });

  it('returns 400 when state is invalid or expired', async () => {
    process.env.OWNER_SECRET = 'secret';
    mockRedis.getdel.mockResolvedValueOnce(null);
    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123', state: 'unknown-nonce' },
        headers: { host: 'example.com' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('state');
    expect(mockRedis.getdel).toHaveBeenCalledWith('oauth:state:unknown-nonce');
    expect(storeInitialTokens).not.toHaveBeenCalled();
  });

  it('consumes the state once: a second callback with the same state is rejected', async () => {
    process.env.OWNER_SECRET = 'secret';
    vi.mocked(storeInitialTokens).mockResolvedValue({ success: true });
    // A store that models GETDEL: the first read takes the nonce.
    const store = new Map([['oauth:state:replayed', '1']]);
    mockRedis.getdel.mockImplementation((key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    });
    const request = () =>
      mockRequest({ query: { code: 'auth-code-123', state: 'replayed' } });

    const first = mockResponse();
    await handler(request(), first);
    const second = mockResponse();
    await handler(request(), second);

    expect(first._status).toBe(200);
    expect(second._status).toBe(400);
    expect(second._json).toEqual({
      error: 'Invalid or expired state parameter',
    });
    expect(second._headers['Set-Cookie']).toBeUndefined();
    expect(storeInitialTokens).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'not_owner',
      403,
      'warning',
      'This Schwab login is not authorized for this app',
    ],
    [
      'owner_hash_missing',
      500,
      'error',
      'Owner account check is not configured',
    ],
    ['owner_check_failed', 500, 'error', 'Owner account check failed'],
  ] as const)(
    '%s → %i with an opaque body, no Set-Cookie, and a Sentry %s naming the kind',
    async (type, status, level, error) => {
      process.env.OWNER_SECRET = 'owner-cookie-secret';
      vi.mocked(storeInitialTokens).mockResolvedValue({
        error: { type, message: 'owner-check-detail' },
      });

      const res = mockResponse();
      await handler(
        mockRequest({ query: { code: 'auth-code-123', state: 'valid-state' } }),
        res,
      );

      expect(res._status).toBe(status);
      expect(res._json).toEqual({ error });
      // No session for a refused login, and nothing of the cookie secret.
      expect(res._headers['Set-Cookie']).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain('owner-cookie-secret');
      // The detail goes to Sentry, not to the client.
      expect(JSON.stringify(res._json)).not.toContain('owner-check-detail');
      expect(mockSentryCapture.captureMessage).toHaveBeenCalledTimes(1);
      expect(mockSentryCapture.captureMessage).toHaveBeenCalledWith(
        `schwab.auth.${type}`,
        {
          level,
          fingerprint: [`schwab.auth.${type}`],
          extra: { detail: 'owner-check-detail' },
        },
      );
      expect(mockSentryCapture.captureException).not.toHaveBeenCalled();
    },
  );

  it('returns 500 when APP_URL is not configured', async () => {
    process.env.OWNER_SECRET = 'secret';
    delete process.env.APP_URL;

    const res = mockResponse();
    await handler(
      mockRequest({ query: { code: 'auth-code-123', state: 'valid-state' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toContain('APP_URL');
  });

  it('returns 500 with an opaque message when token exchange fails', async () => {
    process.env.OWNER_SECRET = 'secret';
    vi.mocked(storeInitialTokens).mockResolvedValue({
      error: { type: 'token_error', message: 'Exchange failed' },
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123', state: 'valid-state' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    // Raw Schwab error body must NOT leak to the client — opaque message only.
    const body = (res._json as { error: string }).error;
    expect(body).toBe('Token exchange failed');
    expect(body).not.toContain('Exchange failed');
  });

  it('a login whose tokens could not be stored fails visibly: 500, no cookie, one capture', async () => {
    process.env.OWNER_SECRET = 'secret';
    mockSentryCapture.captureMessage.mockClear();
    mockSentryCapture.captureException.mockClear();
    vi.mocked(storeInitialTokens).mockResolvedValue({
      error: {
        type: 'token_error',
        message: 'Token exchange succeeded but the tokens could not be stored',
      },
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123', state: 'valid-state' },
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Token exchange failed' });
    // No owner session for a login that wasn't persisted.
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(mockSentryCapture.captureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture.captureException).not.toHaveBeenCalled();
  });

  it('sets owner cookie and returns HTML on success', async () => {
    process.env.OWNER_SECRET = 'my-secret';
    process.env.APP_URL = 'https://myapp.vercel.app';
    vi.mocked(storeInitialTokens).mockResolvedValue({ success: true });

    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123', state: 'valid-state' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Check cookie was set — Set-Cookie is an array (owner + hint cookies)
    const cookies = res._headers['Set-Cookie'] as unknown as string[];
    const ownerCookie = cookies.find((c: string) => c.startsWith('sc-owner='));
    expect(ownerCookie).toBeDefined();
    expect(ownerCookie).toContain('sc-owner=my-secret');
    expect(ownerCookie).toContain('HttpOnly');
    expect(ownerCookie).toContain('SameSite=Strict');
    expect(ownerCookie).toContain('Secure');
    expect(ownerCookie).toContain('Max-Age=604800');
    // Should return HTML
    expect(res._headers['Content-Type']).toBe('text/html');
    expect(res._body).toContain('Authenticated');
  });

  it('omits Secure flag for localhost APP_URL', async () => {
    process.env.OWNER_SECRET = 'my-secret';
    process.env.APP_URL = 'http://localhost:3000';
    vi.mocked(storeInitialTokens).mockResolvedValue({ success: true });

    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'auth-code-123', state: 'valid-state' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const cookies = res._headers['Set-Cookie'] as unknown as string[];
    const ownerCookie = cookies.find((c: string) => c.startsWith('sc-owner='));
    expect(ownerCookie).not.toContain('Secure');
  });

  it('passes correct redirect URI to storeInitialTokens', async () => {
    process.env.OWNER_SECRET = 'secret';
    process.env.APP_URL = 'https://myapp.vercel.app';
    vi.mocked(storeInitialTokens).mockResolvedValue({ success: true });

    const res = mockResponse();
    await handler(
      mockRequest({
        query: { code: 'my-code', state: 'valid-state' },
      }),
      res,
    );

    expect(storeInitialTokens).toHaveBeenCalledWith(
      'my-code',
      'https://myapp.vercel.app/api/auth/callback',
    );
  });
});
