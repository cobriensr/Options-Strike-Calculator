// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';

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

const { mockCaptureException, mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

// `redis.ts` (loaded for real here — only `@upstash/redis` is mocked) pulls
// `metrics` from this module, so the mock has to carry it too.
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: mockCaptureException,
    captureMessage: mockCaptureMessage,
  },
  metrics: {
    increment: vi.fn(),
    tokenRefresh: vi.fn(),
    schwabCall: vi.fn(() => vi.fn()),
  },
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
  isSchwabConfigured,
  invalidateSchwabTokenCache,
  _resetSchwabWarnLatchesForTests,
} from '../_lib/schwab.js';

describe('schwab', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetEnvCache();
    vi.restoreAllMocks();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockCaptureException.mockReset();
    mockCaptureMessage.mockReset();
    // The module-scoped access-token cache would otherwise leak a token
    // cached by one test into the next and mask the Redis read under test.
    invalidateSchwabTokenCache();
    // Same for the once-per-process warn latches: without a reset the first
    // test to trip one would silence every later assertion on them.
    _resetSchwabWarnLatchesForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // isSchwabConfigured
  // ============================================================

  describe('isSchwabConfigured', () => {
    it('returns false when both credentials are missing', () => {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(isSchwabConfigured()).toBe(false);
    });

    it('returns false when only one credential is set', () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      delete process.env.SCHWAB_CLIENT_SECRET;
      expect(isSchwabConfigured()).toBe(false);
    });

    it('returns false when a credential is an empty string', () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = '';
      expect(isSchwabConfigured()).toBe(false);
    });

    it('returns true when both credentials are set', () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      expect(isSchwabConfigured()).toBe(true);
    });
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
      // Cold start (the in-memory cache is reset in beforeEach) + Redis
      // failing → no token anywhere → expired_refresh, not a throw. The
      // warm-instance case (cached token served through a Redis outage)
      // is covered in the "in-memory token cache" block below.
      expect('error' in result).toBe(true);
      if ('error' in result) {
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

    it('retries lock acquisition when wait yields stale tokens (BE-CRON-001)', async () => {
      // Scenario: a previous winner either crashed or had its lock TTL
      // expire before it could write fresh tokens. A losing instance
      // waits for lock release, finds the tokens are still stale, and
      // must re-acquire the lock itself rather than falling through to
      // an unlocked refresh (which would re-create the thundering herd
      // the lock was designed to prevent).
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
        // getStoredTokens after lock release: still stale (winner crashed)
        .mockResolvedValueOnce({
          accessToken: 'still-old',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

      // Lock NOT acquired on first attempt, acquired on second.
      // (mockResolvedValue supplies all subsequent calls, including
      // the storeTokens write that happens after Schwab succeeds.)
      mockRedisSet.mockResolvedValueOnce(null).mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);

      const fetchMock = vi.fn().mockResolvedValue({
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
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();
      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(result.token).toBe('finally-fresh');
      }

      // Schwab's token endpoint should have been called exactly ONCE —
      // not once per waiting instance. This is the BE-CRON-001
      // thundering-herd guarantee: only a lock holder ever issues the
      // refresh request. If the retry loop ever fell through to an
      // unlocked refresh, a fix regression would show up as ≥2 fetch
      // calls here.
      const tokenCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/oauth/token'),
      );
      expect(tokenCalls).toHaveLength(1);

      // releaseLock must have been called after the successful retry,
      // so the next instance can proceed.
      expect(mockRedisDel).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('throws token_error after exhausting lock attempts (BE-CRON-001)', async () => {
      // Scenario: lock is contended and every time we wait for
      // release + check stored tokens, they're still stale. After
      // LOCK_MAX_ATTEMPTS (3) failed attempts, the function must
      // throw rather than silently fall through to an unlocked
      // refresh. The outer getAccessToken wraps the throw into a
      // token_error so the caller gets a loud failure.
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      const stale = {
        accessToken: 'stale',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000, // < BUFFER_MS (60_000) → treated as expired
        refreshExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      mockRedisGet
        // getStoredTokens (initial)
        .mockResolvedValueOnce(stale)
        // waitForLockRelease poll 1 (attempt 1)
        .mockResolvedValueOnce(null)
        // getStoredTokens post-wait (attempt 1): still stale
        .mockResolvedValueOnce(stale)
        // waitForLockRelease poll 1 (attempt 2)
        .mockResolvedValueOnce(null)
        // getStoredTokens post-wait (attempt 2): still stale
        .mockResolvedValueOnce(stale)
        // waitForLockRelease poll 1 (attempt 3)
        .mockResolvedValueOnce(null)
        // getStoredTokens post-wait (attempt 3): still stale
        .mockResolvedValueOnce(stale);

      // Lock NEVER acquired — every set(NX) returns null.
      mockRedisSet.mockResolvedValue(null);
      mockRedisDel.mockResolvedValue(1);

      // fetch should NEVER be called — we never acquire the lock, so
      // we never issue a Schwab refresh request.
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.type).toBe('token_error');
        expect(result.error.message).toContain('exhausted');
      }

      // The critical assertion: Schwab's OAuth endpoint was NEVER
      // called. If the loop ever fell through to an unlocked refresh,
      // this count would be ≥1.
      expect(fetchMock).not.toHaveBeenCalled();

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
  // getAccessToken — in-memory token cache (Redis cost control)
  // ============================================================

  describe('getAccessToken (in-memory token cache)', () => {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    function setCreds() {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
    }

    function tokenResponse(access: string) {
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: access,
            refresh_token: 'ref-new',
            expires_in: 1800,
            token_type: 'Bearer',
            scope: 'api',
            id_token: '',
          }),
      };
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('reads Redis once, then serves repeat calls from memory with ZERO Redis reads', async () => {
      setCreds();
      mockRedisGet.mockResolvedValue({
        accessToken: 'cached-tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
      });

      const first = await getAccessToken();
      expect(first).toEqual({ token: 'cached-tok' });
      expect(mockRedisGet).toHaveBeenCalledTimes(1);

      // A warm lambda serving fetch-market-internals (1/min × 4 symbols)
      // must not touch Redis between refreshes.
      for (let i = 0; i < 4; i++) {
        expect(await getAccessToken()).toEqual({ token: 'cached-tok' });
      }
      expect(mockRedisGet).toHaveBeenCalledTimes(1);
    });

    it('stops serving from memory inside the 60s pre-expiry buffer and re-reads Redis', async () => {
      vi.useFakeTimers({ now: new Date('2026-08-19T14:00:00Z') });
      setCreds();
      const now = Date.now();
      mockRedisGet.mockResolvedValue({
        accessToken: 'short-tok',
        refreshToken: 'ref',
        expiresAt: now + 120_000, // valid for 2 min
        refreshExpiresAt: now + WEEK_MS,
      });

      expect(await getAccessToken()).toEqual({ token: 'short-tok' });
      expect(mockRedisGet).toHaveBeenCalledTimes(1);

      // 59s later: still > 60s before expiry → memory hit.
      vi.setSystemTime(now + 59_000);
      expect(await getAccessToken()).toEqual({ token: 'short-tok' });
      expect(mockRedisGet).toHaveBeenCalledTimes(1);

      // 61s later: inside the buffer → cache is stale → Redis is consulted
      // again (and, here, Redis holds a freshly refreshed token written by
      // another lambda instance).
      vi.setSystemTime(now + 61_000);
      mockRedisGet.mockResolvedValue({
        accessToken: 'other-lambda-tok',
        refreshToken: 'ref',
        expiresAt: now + 61_000 + 1_800_000,
        refreshExpiresAt: now + WEEK_MS,
      });
      expect(await getAccessToken()).toEqual({ token: 'other-lambda-tok' });
      expect(mockRedisGet).toHaveBeenCalledTimes(2);
    });

    it('a refresh repopulates the cache with the NEW token', async () => {
      setCreds();
      mockRedisGet.mockResolvedValue({
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000, // inside buffer → refresh
        refreshExpiresAt: Date.now() + WEEK_MS,
      });
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse('refreshed'));
      vi.stubGlobal('fetch', fetchMock);

      expect(await getAccessToken()).toEqual({ token: 'refreshed' });
      const redisReadsAfterRefresh = mockRedisGet.mock.calls.length;

      // Next call: memory hit on the refreshed token — no Redis read, and
      // Schwab is not called again.
      expect(await getAccessToken()).toEqual({ token: 'refreshed' });
      expect(mockRedisGet).toHaveBeenCalledTimes(redisReadsAfterRefresh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('storeInitialTokens replaces a previously cached token', async () => {
      setCreds();
      mockRedisGet.mockResolvedValue({
        accessToken: 'pre-login-tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
      });
      expect(await getAccessToken()).toEqual({ token: 'pre-login-tok' });

      mockRedisSet.mockResolvedValue('OK');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse('post-login-tok')),
      );
      expect(await storeInitialTokens('code', 'http://x/cb')).toEqual({
        success: true,
      });

      // The stale pre-login token must NOT be served from memory.
      mockRedisGet.mockClear();
      expect(await getAccessToken()).toEqual({ token: 'post-login-tok' });
      expect(mockRedisGet).not.toHaveBeenCalled();
    });

    it('invalidateSchwabTokenCache forces the next call back to Redis', async () => {
      setCreds();
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok-a',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
      });
      expect(await getAccessToken()).toEqual({ token: 'tok-a' });
      expect(mockRedisGet).toHaveBeenCalledTimes(1);

      invalidateSchwabTokenCache();
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok-b',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
      });
      expect(await getAccessToken()).toEqual({ token: 'tok-b' });
      expect(mockRedisGet).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache an error outcome (no tokens / expired refresh)', async () => {
      setCreds();
      mockRedisGet.mockResolvedValue(null);
      expect('error' in (await getAccessToken())).toBe(true);
      expect('error' in (await getAccessToken())).toBe(true);
      // Both calls went to Redis — nothing was memoized.
      expect(mockRedisGet).toHaveBeenCalledTimes(2);
    });

    it('serves a cached token even when Redis is down (the old in-memory fallback)', async () => {
      setCreds();
      mockRedisGet.mockResolvedValueOnce({
        accessToken: 'resilient-tok',
        refreshToken: 'ref',
        expiresAt: Date.now() + 600_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
      });
      expect(await getAccessToken()).toEqual({ token: 'resilient-tok' });

      mockRedisGet.mockRejectedValue(
        new Error('ERR max requests limit exceeded. Limit: 500000'),
      );
      expect(await getAccessToken()).toEqual({ token: 'resilient-tok' });
    });

    it('lost-race path caches the fresh token read after the lock is released', async () => {
      setCreds();
      mockRedisGet
        // getStoredTokens: stale
        .mockResolvedValueOnce({
          accessToken: 'old-tok',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 30_000,
          refreshExpiresAt: Date.now() + WEEK_MS,
        })
        // waitForLockRelease: released
        .mockResolvedValueOnce(null)
        // getStoredTokens after release: fresh (written by the winner)
        .mockResolvedValueOnce({
          accessToken: 'winner-tok',
          refreshToken: 'ref-tok',
          expiresAt: Date.now() + 1_800_000,
          refreshExpiresAt: Date.now() + WEEK_MS,
        });
      mockRedisSet.mockResolvedValue(null); // lock NOT acquired
      mockRedisDel.mockResolvedValue(1);
      vi.stubGlobal('fetch', vi.fn());

      expect(await getAccessToken()).toEqual({ token: 'winner-tok' });
      const reads = mockRedisGet.mock.calls.length;
      expect(await getAccessToken()).toEqual({ token: 'winner-tok' });
      expect(mockRedisGet).toHaveBeenCalledTimes(reads);
    });
  });

  // ============================================================
  // Refresh-token deadline carry-forward + expiry warning
  // ============================================================

  /**
   * Schwab's Trader API does NOT mint a new 7-day refresh token when you
   * exchange a refresh token for an access token — the refresh token keeps
   * the lifetime it was granted at the original OAuth login. The old code
   * recomputed `refreshExpiresAt = now + 7d` on EVERY ~30-minute refresh,
   * so the recorded deadline (and the Redis TTL derived from it) walked
   * forward forever and the token never appeared to expire. Live proof: the
   * `schwab:tokens` TTL read 690,768s on 2026-08-19 and 691,154s on
   * 2026-08-20 — it went UP over a day.
   */
  describe('refresh-token deadline (carry-forward)', () => {
    const DAY_MS = 86_400_000;
    const WEEK_MS = 7 * DAY_MS;
    const NOW = new Date('2026-08-20T15:00:00Z').getTime();

    interface StoredBlob {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      refreshExpiresAt: number;
    }

    function setCreds() {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
    }

    /** A stored blob whose access token is inside the 60s refresh buffer. */
    function staleAccess(overrides: Partial<StoredBlob> = {}) {
      return {
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 30_000,
        refreshExpiresAt: Date.now() + WEEK_MS,
        ...overrides,
      };
    }

    function mockRefreshOk(access = 'new-access', refresh = 'new-ref') {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: access,
            refresh_token: refresh,
            expires_in: 1800,
            token_type: 'Bearer',
            scope: 'api',
            id_token: '',
          }),
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    /** The last `SET schwab:tokens` payload (lock writes use a different key). */
    function lastTokenWrite(): { tokens: StoredBlob; ttlSec: number } | null {
      const call = mockRedisSet.mock.calls
        .filter((c) => c[0] === 'schwab:tokens')
        .at(-1);
      if (!call) return null;
      return {
        tokens: call[1] as StoredBlob,
        ttlSec: (call[2] as { ex: number }).ex,
      };
    }

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(NOW) });
      setCreds();
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockLogger.warn.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('preserves the stored deadline instead of minting a new 7-day window', async () => {
      // Login was 5 days ago → the refresh token really dies in 2 days.
      const realDeadline = NOW + 2 * DAY_MS;
      mockRedisGet.mockResolvedValue(
        staleAccess({ refreshExpiresAt: realDeadline }),
      );
      mockRefreshOk();

      expect(await getAccessToken()).toEqual({ token: 'new-access' });

      const write = lastTokenWrite();
      expect(write).not.toBeNull();
      expect(write!.tokens.refreshExpiresAt).toBe(realDeadline);
      // The bug this test exists for:
      expect(write!.tokens.refreshExpiresAt).not.toBe(NOW + WEEK_MS);
    });

    it('does not let the Redis TTL creep upward across successive refreshes', async () => {
      const realDeadline = NOW + 3 * DAY_MS;
      mockRedisGet.mockResolvedValue(
        staleAccess({ refreshExpiresAt: realDeadline }),
      );
      mockRefreshOk();
      await getAccessToken();
      const first = lastTokenWrite()!;

      // 30 minutes later, the next refresh reads back what we just wrote.
      vi.setSystemTime(NOW + 1_800_000);
      invalidateSchwabTokenCache();
      mockRedisGet.mockResolvedValue({
        ...first.tokens,
        expiresAt: Date.now() + 30_000,
      });
      mockRefreshOk('newer-access');
      await getAccessToken();
      const second = lastTokenWrite()!;

      expect(second.tokens.refreshExpiresAt).toBe(realDeadline);
      // TTL = deadline − now + 1 day buffer, so it must SHRINK as the
      // deadline approaches. Under the bug it grew by the elapsed time.
      expect(second.ttlSec).toBeLessThan(first.ttlSec);
      expect(first.ttlSec).toBe(Math.floor((3 * DAY_MS + DAY_MS) / 1000));
    });

    it('clamps a stored deadline further out than 7 days to now + 7d (Math.min)', async () => {
      // An inflated blob written by the old code (or a corrupted value):
      // never believe we have MORE time than Schwab could possibly grant.
      mockRedisGet.mockResolvedValue(
        staleAccess({ refreshExpiresAt: NOW + 30 * DAY_MS }),
      );
      mockRefreshOk();

      await getAccessToken();

      expect(lastTokenWrite()!.tokens.refreshExpiresAt).toBe(NOW + WEEK_MS);
    });

    it('falls back to now + 7d when the stored deadline is missing', async () => {
      const legacy = {
        accessToken: 'old-tok',
        refreshToken: 'ref-tok',
        expiresAt: NOW + 30_000,
      };
      mockRedisGet.mockResolvedValue(legacy);
      mockRefreshOk();

      expect(await getAccessToken()).toEqual({ token: 'new-access' });
      expect(lastTokenWrite()!.tokens.refreshExpiresAt).toBe(NOW + WEEK_MS);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ storedRefreshExpiresAt: undefined }),
        expect.stringContaining('refreshExpiresAt'),
      );
    });

    it('falls back safely (and logs once) when the stored deadline is garbage', async () => {
      mockRedisGet.mockResolvedValue(
        staleAccess({ refreshExpiresAt: 'not-a-number' as unknown as number }),
      );
      mockRefreshOk();
      await getAccessToken();
      expect(lastTokenWrite()!.tokens.refreshExpiresAt).toBe(NOW + WEEK_MS);

      // A second refresh must not re-log — a per-minute cron would spam.
      invalidateSchwabTokenCache();
      mockRedisGet.mockResolvedValue(
        staleAccess({ refreshExpiresAt: Number.NaN }),
      );
      mockRefreshOk('second-access');
      await getAccessToken();

      const fallbackWarns = mockLogger.warn.mock.calls.filter((c) =>
        String(c[1]).includes('refreshExpiresAt'),
      );
      expect(fallbackWarns).toHaveLength(1);
    });

    it('keeps the stored refresh token when Schwab omits refresh_token', async () => {
      mockRedisGet.mockResolvedValue(staleAccess({ refreshToken: 'keep-me' }));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'new-access',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );

      await getAccessToken();

      expect(lastTokenWrite()!.tokens.refreshToken).toBe('keep-me');
    });
  });

  // ============================================================
  // Proactive refresh-token expiry warning
  // ============================================================

  describe('refresh-token expiry warning', () => {
    const DAY_MS = 86_400_000;
    const WEEK_MS = 7 * DAY_MS;
    const NOW = new Date('2026-08-26T06:00:00Z').getTime();
    const WARN_MSG =
      'schwab refresh token expires soon — re-auth at /api/auth/init';

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(NOW) });
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      mockLogger.warn.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('warns once when the refresh token is within 24h of expiry', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 600_000, // access token still fresh
        refreshExpiresAt: NOW + 6 * 60 * 60 * 1000, // 6h left
      });

      expect(await getAccessToken()).toEqual({ token: 'tok' });

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(WARN_MSG, {
        level: 'warning',
        extra: {
          expiresAt: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
          hoursRemaining: 6,
        },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hoursRemaining: 6 }),
        WARN_MSG,
      );
    });

    it('does NOT re-warn on later calls or refreshes (per-process latch)', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 600_000,
        refreshExpiresAt: NOW + 6 * 60 * 60 * 1000,
      });
      await getAccessToken();
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      // Repeated reads (a per-minute cron) must not fan out into Sentry.
      for (let i = 0; i < 3; i++) {
        invalidateSchwabTokenCache();
        await getAccessToken();
      }

      // ...nor a refresh, which observes the same deadline.
      invalidateSchwabTokenCache();
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 30_000,
        refreshExpiresAt: NOW + 6 * 60 * 60 * 1000,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'refreshed',
              refresh_token: 'ref',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );
      await getAccessToken();

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it('does NOT warn when the deadline is comfortably far out', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 600_000,
        refreshExpiresAt: NOW + 6 * DAY_MS,
      });

      expect(await getAccessToken()).toEqual({ token: 'tok' });
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('warns when a refresh lands inside the 24h window', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'old',
        refreshToken: 'ref',
        expiresAt: NOW + 30_000, // inside the buffer → refresh
        refreshExpiresAt: NOW + 12 * 60 * 60 * 1000,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'refreshed',
              refresh_token: 'ref',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );

      expect(await getAccessToken()).toEqual({ token: 'refreshed' });
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage.mock.calls[0]![1]).toMatchObject({
        extra: { hoursRemaining: 12 },
      });
    });

    it('warns when the deadline crosses the 24h line DURING the refresh', async () => {
      // Read time: 24h + 30s left → nothing to say yet. The refresh then
      // takes 60s (lock wait + network), by which point it is 24h − 30s.
      // Only the check inside refreshAccessToken can catch this.
      mockRedisGet.mockResolvedValue({
        accessToken: 'old',
        refreshToken: 'ref',
        expiresAt: NOW + 30_000,
        refreshExpiresAt: NOW + DAY_MS + 30_000,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          vi.setSystemTime(Date.now() + 60_000);
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: 'refreshed',
                refresh_token: 'ref',
                expires_in: 1800,
                token_type: 'Bearer',
                scope: 'api',
                id_token: '',
              }),
          });
        }),
      );

      expect(await getAccessToken()).toEqual({ token: 'refreshed' });
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the stored deadline is unparseable', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 600_000,
        refreshExpiresAt: Number.NaN,
      });

      expect(await getAccessToken()).toEqual({ token: 'tok' });
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('re-arms the latch after a successful re-auth', async () => {
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: NOW + 600_000,
        refreshExpiresAt: NOW + 6 * 60 * 60 * 1000,
      });
      await getAccessToken();
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'post-login',
              refresh_token: 'fresh-ref',
              expires_in: 1800,
              token_type: 'Bearer',
              scope: 'api',
              id_token: '',
            }),
        }),
      );
      expect(await storeInitialTokens('code', 'http://x/cb')).toEqual({
        success: true,
      });

      // A fresh 7-day window: nothing to warn about yet...
      invalidateSchwabTokenCache();
      mockRedisGet.mockResolvedValue({
        accessToken: 'tok2',
        refreshToken: 'fresh-ref',
        expiresAt: NOW + 600_000,
        refreshExpiresAt: NOW + WEEK_MS,
      });
      await getAccessToken();
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      // ...but six days later the new window is closing, and the owner
      // must be told again.
      vi.setSystemTime(NOW + 6 * DAY_MS + 12 * 60 * 60 * 1000);
      invalidateSchwabTokenCache();
      await getAccessToken();
      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // storeInitialTokens
  // ============================================================

  describe('storeInitialTokens', () => {
    it('grants a full 7-day refresh window on a real OAuth login', async () => {
      vi.useFakeTimers({ now: new Date('2026-08-19T18:24:00Z') });
      const now = Date.now();
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

      expect(await storeInitialTokens('code', 'http://x/cb')).toEqual({
        success: true,
      });

      const call = mockRedisSet.mock.calls
        .filter((c) => c[0] === 'schwab:tokens')
        .at(-1)!;
      const tokens = call[1] as { refreshExpiresAt: number };
      expect(tokens.refreshExpiresAt).toBe(now + 7 * 86_400_000);
      // TTL = 7-day refresh lifetime + the 1-day buffer.
      expect((call[2] as { ex: number }).ex).toBe(8 * 86_400);

      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

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
