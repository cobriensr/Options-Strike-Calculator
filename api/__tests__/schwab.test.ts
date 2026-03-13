// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so these are available when vi.mock factory runs (hoisted above imports)
const { mockRedisGet, mockRedisSet, mockRedisDel } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
}));

vi.mock('@upstash/redis', () => {
  return {
    Redis: class MockRedis {
      get = mockRedisGet;
      set = mockRedisSet;
      del = mockRedisDel;
    },
  };
});

import {
  getAccessToken,
  storeInitialTokens,
  getAuthUrl,
} from '../_lib/schwab.js';

describe('schwab', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // getAuthUrl
  // ============================================================

  describe('getAuthUrl', () => {
    it('returns null when credentials are missing', () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(getAuthUrl('http://localhost/callback')).toBeNull();
    });

    it('returns auth URL with client_id and redirect_uri', () => {
      process.env.SCHWAB_CLIENT_ID = 'my-client-id';
      process.env.SCHWAB_CLIENT_SECRET = 'my-secret';
      const url = getAuthUrl('https://example.com/callback');
      expect(url).not.toBeNull();
      expect(url).toContain('api.schwabapi.com/v1/oauth/authorize');
      expect(url).toContain('client_id=my-client-id');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain('response_type=code');
    });
  });

  // ============================================================
  // getAccessToken
  // ============================================================

  describe('getAccessToken', () => {
    it('returns missing_config error when credentials are not set', async () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('missing_config');
      }
    });

    it('returns expired_refresh error when no tokens in Redis', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue(null);

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('expired_refresh');
        expect(result.error.message).toContain('No tokens found');
      }
    });

    it('returns expired_refresh error when refresh token is expired', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() - 1000, // expired
      });

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('expired_refresh');
        expect(result.error.message).toContain('re-authenticate');
      }
    });

    it('returns valid token when access token is still fresh', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue({
        accessToken: 'valid-tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000, // 10 min from now (> 1 min buffer)
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      const result = await getAccessToken();
      expect('error' in result).toBe(false);
      if ('token' in result) {
        expect(result.token).toBe('valid-tok');
      }
    });

    it('refreshes token when access token is about to expire', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      // Token expires in 30 seconds (within 60s buffer)
      mockRedisGet.mockResolvedValue({
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000,
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      // Mock the lock acquisition
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      // Mock the token refresh fetch
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-access-tok',
              refresh_token: 'new-refresh-tok',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );

      const result = await getAccessToken();
      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(result.token).toBe('new-access-tok');
      }

      vi.unstubAllGlobals();
    });

    it('returns token_error when refresh fails', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet.mockResolvedValue({
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000,
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('Invalid grant'),
        }),
      );

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('token_error');
        expect(result.error.message).toContain('400');
      }

      vi.unstubAllGlobals();
    });

    it('handles Redis get failure gracefully (returns null tokens)', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockRejectedValue(new Error('redis down'));

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('expired_refresh');
      }
    });
  });

  // ============================================================
  // storeInitialTokens
  // ============================================================

  describe('storeInitialTokens', () => {
    it('returns missing_config error when credentials are not set', async () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      const result = await storeInitialTokens('code', 'http://example.com');
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('missing_config');
      }
    });

    it('returns token_error when Schwab returns non-ok', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        }),
      );

      const result = await storeInitialTokens('bad-code', 'http://example.com');
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('token_error');
        expect(result.error.message).toContain('401');
      }

      vi.unstubAllGlobals();
    });

    it('stores tokens and returns success on valid exchange', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'access-tok',
              refresh_token: 'refresh-tok',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );

      const result = await storeInitialTokens(
        'good-code',
        'http://example.com',
      );
      expect(result).toEqual({ success: true });
      // Should have stored tokens in Redis
      expect(mockRedisSet).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('sends correct auth header and body', async () => {
      process.env.SCHWAB_CLIENT_ID = 'my-id';
      process.env.SCHWAB_CLIENT_SECRET = 'my-secret';
      mockRedisSet.mockResolvedValue('OK');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'tok',
            refresh_token: 'ref',
            expires_in: 1800,
            token_type: 'Bearer',
            scope: 'api',
            id_token: '',
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await storeInitialTokens('auth-code', 'https://example.com/callback');

      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.schwabapi.com/v1/oauth/token');
      expect(opts.method).toBe('POST');

      // Check basic auth header
      const expectedAuth = `Basic ${Buffer.from('my-id:my-secret').toString('base64')}`;
      expect(opts.headers.Authorization).toBe(expectedAuth);

      // Check body params
      const body = opts.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe('https://example.com/callback');

      vi.unstubAllGlobals();
    });
  });
});
