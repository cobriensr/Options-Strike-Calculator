// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockRedis = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue('valid'),
  del: vi.fn().mockResolvedValue(1),
}));

vi.mock('../_lib/schwab.js', () => ({
  storeInitialTokens: vi.fn(),
  redis: mockRedis,
}));

vi.mock('../_lib/api-helpers.js', () => ({
  OWNER_COOKIE: 'sc-owner',
  OWNER_COOKIE_MAX_AGE: 604800,
}));

import handler from '../auth/callback.js';
import { storeInitialTokens } from '../_lib/schwab.js';

describe('GET /api/auth/callback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.APP_URL = 'https://example.com';
    vi.restoreAllMocks();
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

  it('returns 500 when OWNER_SECRET is not set', async () => {
    delete process.env.OWNER_SECRET;
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
  });

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
    mockRedis.get.mockResolvedValueOnce(null);
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
    // Nonce must not be consumed on rejection
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

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

  it('returns 500 when token exchange fails', async () => {
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
    expect((res._json as { error: string }).error).toBe('Exchange failed');
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
