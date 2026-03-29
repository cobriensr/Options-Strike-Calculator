// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so these are available when vi.mock factory runs (hoisted above imports)
const { mockRedisGet, mockRedisSet, mockRedisDel } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

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
    it('returns null when credentials are missing', async () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(await getAuthUrl('http://localhost/callback')).toBeNull();
    });

    it('returns auth URL with client_id, redirect_uri, and state', async () => {
      process.env.SCHWAB_CLIENT_ID = 'my-client-id';
      process.env.SCHWAB_CLIENT_SECRET = 'my-secret';
      mockRedisSet.mockResolvedValue('OK');
      const result = await getAuthUrl('https://example.com/callback');
      expect(result).not.toBeNull();
      expect(result!.url).toContain('api.schwabapi.com/v1/oauth/authorize');
      expect(result!.url).toContain('client_id=my-client-id');
      expect(result!.url).toContain('redirect_uri=');
      expect(result!.url).toContain('response_type=code');
      expect(result!.url).toContain('state=');
      expect(result!.state).toBeTruthy();
      expect(result!.state).toHaveLength(64); // 32 bytes hex
      // Verify state was stored in Redis with 10 min TTL
      expect(mockRedisSet).toHaveBeenCalledWith(
        `oauth:state:${result!.state}`,
        '1',
        { ex: 600 },
      );
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

    it('returns token_error when token refresh fetch times out (AbortError)', async () => {
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
        vi
          .fn()
          .mockRejectedValue(
            new DOMException('The operation was aborted.', 'AbortError'),
          ),
      );

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('token_error');
      }

      vi.unstubAllGlobals();
    });

    it('handles Redis get failure gracefully', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockRejectedValue(new Error('redis down'));

      const result = await getAccessToken();
      // After earlier tests refresh tokens, the in-memory cache may
      // be populated — getAccessToken falls back to it. Either outcome
      // is valid: in-memory fallback returns { token }, or cold start
      // returns { error: expired_refresh }.
      if ('token' in result) {
        expect(result.token).toBeTruthy();
      } else {
        expect(result.error.type).toBe('expired_refresh');
      }
    });

    it('handles Redis store failure gracefully during refresh', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockLogger.error.mockReset();

      // Return expired access token so refresh is triggered
      mockRedisGet.mockResolvedValue({
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000,
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      // Lock acquisition succeeds
      let setCallCount = 0;
      mockRedisSet.mockImplementation(() => {
        setCallCount++;
        // First call is lock acquisition (succeeds)
        if (setCallCount === 1) return Promise.resolve('OK');
        // Second call is storeTokens (fails)
        return Promise.reject(new Error('Redis write failed'));
      });
      mockRedisDel.mockResolvedValue(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-tok',
              refresh_token: 'new-ref',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );

      const result = await getAccessToken();
      // Should still return the token even though storage failed
      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(result.token).toBe('new-tok');
      }
      // storeTokens retries 3 times, logging each failure + final exhaustion
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), attempt: 0 }),
        'storeTokens: Redis write failed',
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'storeTokens: all attempts exhausted, tokens NOT persisted',
      );

      vi.unstubAllGlobals();
    });

    it('falls back when lock acquisition fails (Redis error)', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet.mockResolvedValue({
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000,
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      // Lock acquisition throws (Redis error) → acquireLock returns true (proceed anyway)
      let setCallCount = 0;
      mockRedisSet.mockImplementation(() => {
        setCallCount++;
        if (setCallCount === 1) return Promise.reject(new Error('Redis down'));
        return Promise.resolve('OK');
      });
      mockRedisDel.mockResolvedValue(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'fallback-tok',
              refresh_token: 'new-ref',
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
        expect(result.token).toBe('fallback-tok');
      }

      vi.unstubAllGlobals();
    });

    it('waits for lock release when another invocation is refreshing', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet
        // First call: getStoredTokens (expired access token)
        .mockResolvedValueOnce({
          accessToken: 'old-tok',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        })
        // Second call: acquireLock check — lock is held (returns non-null)
        // Actually acquireLock uses set with NX, not get. Let me reconsider.
        // waitForLockRelease calls redis.get(LOCK_KEY)
        // First get in waitForLockRelease: lock still held
        .mockResolvedValueOnce('1')
        // Second get in waitForLockRelease: lock released
        .mockResolvedValueOnce(null)
        // Third call: getStoredTokens after lock release — fresh tokens
        .mockResolvedValueOnce({
          accessToken: 'fresh-tok',
          refreshToken: 'fresh-ref',
          expiresAt: Date.now() + 1_800_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

      // Lock NOT acquired (NX fails — another process holds it)
      mockRedisSet.mockResolvedValue(null);
      mockRedisDel.mockResolvedValue(1);

      // fetch should NOT be called since we read fresh tokens after lock release
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const result = await getAccessToken();
      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(result.token).toBe('fresh-tok');
      }
      // Should not have called Schwab token endpoint
      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('proceeds with refresh when lock wait yields stale tokens', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet
        // getStoredTokens: expired access token
        .mockResolvedValueOnce({
          accessToken: 'old-tok',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        })
        // waitForLockRelease: lock released immediately
        .mockResolvedValueOnce(null)
        // getStoredTokens after lock release: still stale
        .mockResolvedValueOnce({
          accessToken: 'still-old',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

      // Lock NOT acquired
      mockRedisSet.mockResolvedValueOnce(null).mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'finally-fresh',
              refresh_token: 'new-ref',
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
        expect(result.token).toBe('finally-fresh');
      }

      vi.unstubAllGlobals();
    });

    it('handles waitForLockRelease Redis error gracefully', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet
        // getStoredTokens: expired access token
        .mockResolvedValueOnce({
          accessToken: 'old-tok',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        })
        // waitForLockRelease: Redis throws → returns early
        .mockRejectedValueOnce(new Error('Redis down'))
        // getStoredTokens after lock wait: returns null (stale)
        .mockResolvedValueOnce(null);

      // Lock NOT acquired
      mockRedisSet.mockResolvedValueOnce(null).mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'recovered-tok',
              refresh_token: 'new-ref',
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
        expect(result.token).toBe('recovered-tok');
      }

      vi.unstubAllGlobals();
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

    it('returns token_error when fetch times out (AbortError)', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new DOMException('The operation was aborted.', 'AbortError'),
          ),
      );

      const result = await storeInitialTokens(
        'auth-code',
        'http://example.com',
      );
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('token_error');
      }

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
