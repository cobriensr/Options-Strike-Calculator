// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/schwab.js', () => ({
  getAuthUrl: vi.fn(),
}));

import handler from '../auth/init.js';
import { getAuthUrl } from '../_lib/schwab.js';

describe('GET /api/auth/init', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 500 when getAuthUrl returns null (missing creds)', () => {
    vi.mocked(getAuthUrl).mockReturnValue(null);
    const res = mockResponse();
    handler(mockRequest({ headers: { host: 'example.com' } }), res);
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toContain(
      'SCHWAB_CLIENT_ID',
    );
  });

  it('redirects to Schwab OAuth URL', () => {
    vi.mocked(getAuthUrl).mockReturnValue(
      'https://api.schwabapi.com/v1/oauth/authorize?client_id=test',
    );
    const res = mockResponse();
    handler(mockRequest({ headers: { host: 'myapp.vercel.app' } }), res);
    expect(res._redirectStatus).toBe(302);
    expect(res._redirectUrl).toContain('schwabapi.com');
  });

  it('uses https for non-localhost hosts', () => {
    vi.mocked(getAuthUrl).mockImplementation((redirectUri: string) => {
      // Verify the redirect URI uses https
      expect(redirectUri.startsWith('https://')).toBe(true);
      return 'https://api.schwabapi.com/v1/oauth/authorize';
    });
    const res = mockResponse();
    handler(mockRequest({ headers: { host: 'myapp.vercel.app' } }), res);
    expect(getAuthUrl).toHaveBeenCalledWith(
      'https://myapp.vercel.app/api/auth/callback',
    );
  });

  it('uses http for localhost', () => {
    vi.mocked(getAuthUrl).mockReturnValue(
      'https://api.schwabapi.com/v1/oauth/authorize',
    );
    const res = mockResponse();
    handler(mockRequest({ headers: { host: 'localhost:3000' } }), res);
    expect(getAuthUrl).toHaveBeenCalledWith(
      'http://localhost:3000/api/auth/callback',
    );
  });
});
