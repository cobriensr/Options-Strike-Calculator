// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/schwab.js', () => ({
  getAuthUrl: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfRateLimited: vi.fn(),
}));

import handler from '../auth/init.js';
import { getAuthUrl } from '../_lib/schwab.js';
import { rejectIfRateLimited } from '../_lib/api-helpers.js';

describe('GET /api/auth/init', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.APP_URL = 'https://example.com';
    vi.restoreAllMocks();
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 500 when APP_URL is not configured', async () => {
    delete process.env.APP_URL;
    vi.mocked(getAuthUrl).mockResolvedValue({
      url: 'https://api.schwabapi.com/v1/oauth/authorize',
      state: 'abc123',
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toContain('APP_URL');
  });

  it('returns 500 when getAuthUrl returns null (missing creds)', async () => {
    vi.mocked(getAuthUrl).mockResolvedValue(null);
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toContain(
      'OAuth credentials not configured',
    );
  });

  it('redirects to Schwab OAuth URL', async () => {
    process.env.APP_URL = 'https://myapp.vercel.app';
    vi.mocked(getAuthUrl).mockResolvedValue({
      url: 'https://api.schwabapi.com/v1/oauth/authorize?client_id=test',
      state: 'abc123',
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._redirectStatus).toBe(302);
    expect(res._redirectUrl).toContain('schwabapi.com');
  });

  it('uses APP_URL directly for the redirect URI', async () => {
    process.env.APP_URL = 'https://myapp.vercel.app';
    vi.mocked(getAuthUrl).mockResolvedValue({
      url: 'https://api.schwabapi.com/v1/oauth/authorize',
      state: 'abc123',
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(getAuthUrl).toHaveBeenCalledWith(
      'https://myapp.vercel.app/api/auth/callback',
    );
  });

  it('returns 500 when handler throws unexpected error', async () => {
    vi.mocked(getAuthUrl).mockRejectedValue(new Error('Crash'));

    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
  });

  it('uses http for localhost APP_URL', async () => {
    process.env.APP_URL = 'http://localhost:3000';
    vi.mocked(getAuthUrl).mockResolvedValue({
      url: 'https://api.schwabapi.com/v1/oauth/authorize',
      state: 'abc123',
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(getAuthUrl).toHaveBeenCalledWith(
      'http://localhost:3000/api/auth/callback',
    );
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockResolvedValue(true);
    const res = mockResponse();
    await handler(mockRequest(), res);
    // Rate limiting is handled by rejectIfRateLimited itself
    // (it sets the response), so we just verify it was called
    expect(rejectIfRateLimited).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'auth-init',
      5,
    );
  });
});
