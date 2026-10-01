// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';

// Use vi.hoisted so these are available when vi.mock factory runs (hoisted above imports)
const { mockRedisGet, mockRedisSet, mockRedisDel, mockRedisEval } = vi.hoisted(
  () => ({
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn(),
    mockRedisDel: vi.fn(),
    mockRedisEval: vi.fn(),
  }),
);

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockSentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: { increment: vi.fn() },
}));

vi.mock('@upstash/redis', () => {
  return {
    Redis: class MockRedis {
      get = mockRedisGet;
      set = mockRedisSet;
      del = mockRedisDel;
      eval = mockRedisEval;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 400 body Schwab actually returned in prod (2026-09-21 → 09-28) for a
 * dead refresh token: the real `invalid_grant` is double-encoded inside an
 * outer `unsupported_token_type` error.
 */
const INVALID_GRANT_BODY =
  '{"error":"unsupported_token_type","error_description":"400 Bad Request: \\"{\\"error_description\\":\\"Refresh token is invalid, expired or revoked\\",\\"error\\":\\"invalid_grant\\"}\\""}';

/** Stored tokens whose access token is inside the 60 s refresh buffer. */
function staleTokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'old-tok',
    refreshToken: 'ref-tok',
    expiresAt: Date.now() + 30_000,
    refreshExpiresAt: Date.now() + 3 * DAY_MS,
    ...overrides,
  };
}

/** A successful Schwab token-endpoint response. */
function tokenResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'api',
        id_token: '',
        ...body,
      }),
  };
}

/** A failed Schwab token-endpoint response. */
function tokenFailure(status: number, body: string) {
  return { ok: false, status, text: () => Promise.resolve(body) };
}

/** A successful token-endpoint response with EXACTLY this JSON body. */
function okJson(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

/** Calls to the Redis SET mock that wrote the token record (not the lock). */
function tokenWrites() {
  return mockRedisSet.mock.calls.filter((c) => c[0] === 'schwab:tokens');
}

/** SET NX calls against the refresh lock. */
function lockAcquires() {
  return mockRedisSet.mock.calls.filter((c) => c[0] === 'schwab:refresh_lock');
}

/**
 * EVAL calls against the token record: the rejected-token
 * compare-and-delete and the refreshed-token compare-and-set.
 */
function tokenEvals() {
  return mockRedisEval.mock.calls.filter((c) => c[1][0] === 'schwab:tokens');
}

/** The refreshed-token compare-and-set EVAL calls. */
function storeEvals() {
  return tokenEvals().filter(([script]) => String(script).includes("'SET'"));
}

/** Refreshed records written via compare-and-set, as Redis would hold them. */
function refreshStores() {
  return storeEvals().map(([, , args]) => ({
    needle: args[0] as string,
    tokens: JSON.parse(args[1] as string) as Record<string, unknown>,
    ttlSec: Number(args[2]),
  }));
}

/** EVAL calls against the refresh lock (the fenced release). */
function lockReleases() {
  return mockRedisEval.mock.calls.filter(
    (c) => c[1][0] === 'schwab:refresh_lock',
  );
}

/**
 * Answer every token-record EVAL (compare-and-delete / compare-and-set) with
 * `tokenResult` (0 absent / 1 done / 2 record holds a different token) and
 * the fenced lock release with `lockResult` (1 released / 0 not ours).
 */
function evalAnswers(tokenResult: number, lockResult = 1) {
  mockRedisEval.mockImplementation((_script: string, keys: string[]) =>
    Promise.resolve(keys[0] === 'schwab:tokens' ? tokenResult : lockResult),
  );
}

import {
  getAccessToken,
  storeInitialTokens,
  getAuthUrl,
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
    mockRedisEval.mockReset();
    // Default: the refreshed-token compare-and-set writes, the release frees.
    evalAnswers(1);
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    it('serves the warm in-memory token when the Redis read fails', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      // Warm this instance's in-memory cache with a successful refresh
      // (initial read + the lock holder's re-read).
      mockRedisGet
        .mockResolvedValueOnce(staleTokens())
        .mockResolvedValueOnce(staleTokens());
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            tokenResponse({ access_token: 'warm-tok', refresh_token: 'r' }),
          ),
      );
      expect(await getAccessToken()).toEqual({ token: 'warm-tok' });

      // Upstash blip: the read throws, the warm access token still works.
      mockRedisGet.mockRejectedValueOnce(new Error('upstash down'));
      expect(await getAccessToken()).toEqual({ token: 'warm-tok' });
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('reports a Redis read error as token_error, not "No tokens found"', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      // Push the clock a day forward so any in-memory token warmed by an
      // earlier test is expired and the fallback cannot mask the error.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + DAY_MS);
      const redisErr = new Error('upstash down');
      mockRedisGet.mockRejectedValue(redisErr);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'token_error',
          message: expect.stringContaining('upstash down'),
        },
      });
      if ('error' in result) {
        expect(result.error.message).not.toContain('No tokens found');
      }
      // Loud: the read failure is captured, not silently mapped to "logged out".
      expect(mockSentry.captureException).toHaveBeenCalledWith(redisErr);
    });

    it('reports an absent token key as expired_refresh even with a warm in-memory token', async () => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';

      mockRedisGet
        .mockResolvedValueOnce(staleTokens())
        .mockResolvedValueOnce(staleTokens());
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            tokenResponse({ access_token: 'warm-tok', refresh_token: 'r' }),
          ),
      );
      expect(await getAccessToken()).toEqual({ token: 'warm-tok' });

      // The key is genuinely gone (TTL or a cleared rejection) — that is
      // "logged out", and the in-memory fallback is only for read errors.
      mockRedisGet.mockResolvedValueOnce(null);
      const result = await getAccessToken();
      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('No tokens found'),
        },
      });
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

      // Lock acquisition succeeds; the refreshed-token compare-and-set fails.
      mockRedisSet.mockResolvedValue('OK');
      mockRedisEval.mockImplementation((_script: string, keys: string[]) =>
        keys[0] === 'schwab:tokens'
          ? Promise.reject(new Error('Redis write failed'))
          : Promise.resolve(1),
      );

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
      expect(storeEvals()).toHaveLength(3);
      expect(mockSentry.captureException).toHaveBeenCalledTimes(1);

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
        })
        // our re-read once we hold the lock: still stale → refresh
        .mockResolvedValueOnce(staleTokens());

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
      expect(lockReleases()).toHaveLength(1);

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
        // getStoredTokens after lock wait: still stale → retry the lock
        .mockResolvedValueOnce(staleTokens())
        // our re-read once we hold the lock: still stale → refresh
        .mockResolvedValueOnce(staleTokens());

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
  // Refresh-token lifetime + rejection (2026-09-29 logout incident)
  // ============================================================

  describe('refresh-token lifetime', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
    });

    it('keeps the stored refreshExpiresAt fixed across an access-token refresh', async () => {
      const refreshExpiresAt = Date.now() + 2 * DAY_MS;
      mockRedisGet.mockResolvedValue(staleTokens({ refreshExpiresAt }));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          tokenResponse({
            access_token: 'new-access',
            refresh_token: 'ref-tok',
          }),
        ),
      );

      expect(await getAccessToken()).toEqual({ token: 'new-access' });

      // Written by compare-and-set only — never an unconditional SET.
      expect(tokenWrites()).toHaveLength(0);
      const stores = refreshStores();
      expect(stores).toHaveLength(1);
      const { tokens: written, ttlSec } = stores[0]!;
      expect(written.accessToken).toBe('new-access');
      // The refresh token's 7 days run from the ORIGINAL login — a refresh
      // must not slide the expiry forward.
      expect(written.refreshExpiresAt).toBe(refreshExpiresAt);
      // TTL = remaining refresh lifetime + 1 day buffer (≈ 3 days), not 8.
      const expectedTtlSec = Math.floor((2 * DAY_MS + DAY_MS) / 1000);
      expect(ttlSec).toBeGreaterThan(expectedTtlSec - 5);
      expect(ttlSec).toBeLessThanOrEqual(expectedTtlSec);
    });

    it('keeps the stored refresh token when Schwab omits refresh_token on refresh', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(tokenResponse({ access_token: 'new-access' })),
      );

      expect(await getAccessToken()).toEqual({ token: 'new-access' });

      const { tokens: written } = refreshStores()[0]!;
      expect(written.refreshToken).toBe('ref-tok');
    });

    it('stores a rotated refresh token when Schwab returns one', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          tokenResponse({
            access_token: 'new-access',
            refresh_token: 'rotated-ref',
          }),
        ),
      );

      await getAccessToken();

      const { tokens: written } = refreshStores()[0]!;
      expect(written.refreshToken).toBe('rotated-ref');
    });

    it('sets a fresh 7-day refresh expiry only on the authorization-code exchange', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          tokenResponse({
            access_token: 'a',
            refresh_token: 'r',
          }),
        ),
      );
      const before = Date.now();

      await storeInitialTokens('code', 'https://example.com/cb');

      const [, written] = tokenWrites()[0]!;
      expect(written.refreshExpiresAt).toBeGreaterThanOrEqual(
        before + 7 * DAY_MS,
      );
      expect(written.refreshExpiresAt).toBeLessThanOrEqual(
        Date.now() + 7 * DAY_MS,
      );
    });
  });

  describe('rejected refresh token (invalid_grant)', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK'); // refresh lock acquired
      mockRedisDel.mockResolvedValue(1);
    });

    it('clears the tokens, captures ONE refresh_rejected warning, and returns expired_refresh', async () => {
      const record = staleTokens();
      mockRedisGet.mockResolvedValue(record);
      evalAnswers(1); // compare-and-delete: deleted
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('re-authenticate'),
        },
      });
      // One compare-and-delete, keyed on the refresh token that FAILED. The
      // needle must be a fragment of the record exactly as @upstash/redis
      // serializes it (JSON.stringify), fenced by the JSON quotes so it
      // cannot prefix-match a longer token.
      expect(tokenEvals()).toHaveLength(1);
      const [script, keys, [needle]] = tokenEvals()[0]!;
      expect(script).toContain("redis.call('DEL', KEYS[1])");
      expect(keys).toEqual(['schwab:tokens']);
      expect(JSON.stringify(record)).toContain(needle);
      expect(
        JSON.stringify({ ...record, refreshToken: `${record.refreshToken}2` }),
      ).not.toContain(needle);
      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.auth.refresh_rejected',
        expect.objectContaining({
          level: 'warning',
          fingerprint: ['schwab.auth.refresh_rejected'],
        }),
      );
      // A rejection is a state transition, not an exception.
      expect(mockSentry.captureException).not.toHaveBeenCalled();
      // Nothing re-persisted the dead tokens; the lock was released.
      expect(tokenWrites()).toHaveLength(0);
      expect(lockReleases()).toHaveLength(1);
    });

    it('matches a token full of Lua pattern characters literally (plain find on the real serialization)', async () => {
      // Every Lua magic character: without plain find these would be read
      // as a pattern and could miss the stored token or match another.
      const magic = 'a-b.c%d+e*f?g[h]i(j)k^l$m';
      const record = staleTokens({ refreshToken: magic });
      mockRedisGet.mockResolvedValue(record);
      evalAnswers(1);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY)),
      );

      await getAccessToken();

      const [script, , [needle]] = tokenEvals()[0]!;
      // Plain find (4th arg true) disables Lua patterns → a substring test.
      expect(script).toContain('string.find(raw, ARGV[1], 1, true)');
      // …so JS `includes` on the JSON.stringify'd record is its exact model.
      expect(JSON.stringify(record).includes(needle)).toBe(true);
      expect(
        JSON.stringify({ ...record, refreshToken: `${magic}x` }).includes(
          needle,
        ),
      ).toBe(false);
      expect(
        JSON.stringify({
          ...record,
          accessToken: magic,
          refreshToken: 'other',
        }).includes(needle),
      ).toBe(false);
    });

    it('stops at the local guard on the next call without calling Schwab again', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens()) // initial read
        .mockResolvedValueOnce(staleTokens()); // lock holder's re-read
      evalAnswers(1);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY));
      vi.stubGlobal('fetch', fetchMock);
      await getAccessToken();

      // The compare-and-delete removed the key.
      mockRedisGet.mockResolvedValueOnce(null);
      const second = await getAccessToken();

      expect(second).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('No tokens found'),
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tokenEvals()).toHaveLength(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('treats a 401 invalid_grant the same as a 400', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      evalAnswers(1);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(tokenFailure(401, '{"error":"invalid_grant"}')),
      );

      const result = await getAccessToken();

      expect('error' in result && result.error.type).toBe('expired_refresh');
      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('parallel callers sharing one rejected refresh produce exactly one capture', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      evalAnswers(1);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY));
      vi.stubGlobal('fetch', fetchMock);

      const results = await Promise.all([
        getAccessToken(),
        getAccessToken(),
        getAccessToken(),
      ]);

      for (const r of results) {
        expect('error' in r && r.error.type).toBe('expired_refresh');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tokenEvals()).toHaveLength(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('does NOT wipe tokens a concurrent re-auth wrote mid-flight; uses them instead', async () => {
      mockRedisGet
        // initial read: the old, soon-to-be-rejected tokens
        .mockResolvedValueOnce(staleTokens())
        // lock holder's re-read: still the old tokens
        .mockResolvedValueOnce(staleTokens())
        // re-read after the compare-and-delete reported "replaced"
        .mockResolvedValueOnce({
          accessToken: 'reauth-access',
          refreshToken: 'reauth-ref',
          expiresAt: Date.now() + 1_800_000,
          refreshExpiresAt: Date.now() + 7 * DAY_MS,
        });
      evalAnswers(2); // key holds a DIFFERENT refresh token
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({ token: 'reauth-access' });
      expect(mockRedisDel).not.toHaveBeenCalledWith('schwab:tokens');
      expect(tokenWrites()).toHaveLength(0);
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
      // The re-read found a fresh access token — no second Schwab call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-reads at most once: a second replace in the same call is a token_error', async () => {
      // Pathological: every read returns stale tokens and every
      // compare-and-delete says a different token is stored.
      mockRedisGet.mockResolvedValue(staleTokens());
      evalAnswers(2);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'token_error',
          message: expect.stringContaining('replaced twice'),
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    });

    it('returns expired_refresh without a capture when the key was already cleared', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      evalAnswers(0); // key absent — someone else cleared it
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY)),
      );

      const result = await getAccessToken();

      expect('error' in result && result.error.type).toBe('expired_refresh');
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('surfaces a failed compare-and-delete loudly but still reports expired_refresh', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      const evalErr = new Error('EVAL failed');
      mockRedisEval.mockRejectedValue(evalErr);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenFailure(400, INVALID_GRANT_BODY)),
      );

      const result = await getAccessToken();

      // Auth state is still "rejected" — the caller must re-auth either way.
      expect('error' in result && result.error.type).toBe('expired_refresh');
      // The dead state was NOT persisted, so this is an error, not the
      // one-shot transition warning.
      expect(mockSentry.captureException).toHaveBeenCalledWith(evalErr);
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    });

    it('a lock loser that finds the tokens cleared while waiting stops without calling Schwab', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens()) // initial read
        .mockResolvedValueOnce(null) // waitForLockRelease: lock released
        .mockResolvedValueOnce(null); // post-wait read: winner cleared the tokens
      mockRedisSet.mockResolvedValue(null); // lock NOT acquired
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('No tokens found'),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('refresh failures that are NOT a rejection', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');
      mockRedisDel.mockResolvedValue(1);
    });

    it.each([
      [
        'a 400 without invalid_grant',
        tokenFailure(400, '{"error":"invalid_request"}'),
      ],
      [
        'a 5xx that mentions invalid_grant',
        tokenFailure(502, 'upstream invalid_grant proxy page'),
      ],
      ['a 503', tokenFailure(503, 'Service Unavailable')],
    ])(
      '%s stays a captured token_error and keeps the tokens',
      async (_label, response) => {
        mockRedisGet.mockResolvedValue(staleTokens());
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

        const result = await getAccessToken();

        expect('error' in result && result.error.type).toBe('token_error');
        expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
        expect(mockSentry.captureMessage).not.toHaveBeenCalled();
        expect(tokenEvals()).toHaveLength(0);
        expect(mockRedisDel).not.toHaveBeenCalledWith('schwab:tokens');
      },
    );

    it('a timeout stays a captured token_error and keeps the tokens', async () => {
      mockRedisGet.mockResolvedValue(staleTokens());
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new DOMException('The operation timed out.', 'TimeoutError'),
          ),
      );

      const result = await getAccessToken();

      expect('error' in result && result.error.type).toBe('token_error');
      expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
      expect(tokenEvals()).toHaveLength(0);
    });
  });

  describe('refresh lock (R6)', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue(staleTokens());
      mockRedisSet.mockResolvedValue('OK');
      evalAnswers(1);
    });

    it('holds the lock with a random token for longer than the refresh fetch can take', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'a' })),
      );

      await getAccessToken();

      const refreshTimeoutMs = timeoutSpy.mock.calls[0]![0];
      const [, lockToken, opts] = lockAcquires()[0]!;
      expect(lockToken).toMatch(/^[0-9a-f]{32}$/);
      expect(opts).toMatchObject({ nx: true });
      // TTL must cover the whole hold: the fetch (bounded by its abort
      // timeout) + storeTokens' retry backoff + Redis round-trips.
      expect(opts.ex * 1000).toBeGreaterThanOrEqual(refreshTimeoutMs + 10_000);
    });

    it('uses a fresh lock token per acquisition', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'a' })),
      );

      await getAccessToken();
      await getAccessToken();

      const [first, second] = lockAcquires();
      expect(first![1]).not.toBe(second![1]);
    });

    it('releases with a fenced compare-and-delete of its own token, never a bare DEL', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'a' })),
      );

      await getAccessToken();

      const [, lockToken] = lockAcquires()[0]!;
      expect(lockReleases()).toHaveLength(1);
      const [script, keys, args] = lockReleases()[0]!;
      expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
      expect(keys).toEqual(['schwab:refresh_lock']);
      expect(args).toEqual([lockToken]);
      expect(mockRedisDel).not.toHaveBeenCalled();
    });

    it('leaves a lock it no longer owns alone (expired, re-acquired by another instance)', async () => {
      // The fenced release reports 0: the key holds someone else's token.
      evalAnswers(1, 0);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'a' })),
      );

      const result = await getAccessToken();

      expect(result).toEqual({ token: 'a' });
      expect(mockRedisDel).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('lock no longer held'),
      );
    });

    it('fails open when Redis errors on every lock attempt', async () => {
      mockRedisSet.mockImplementation((key: string) =>
        key === 'schwab:refresh_lock'
          ? Promise.reject(new Error('upstash down'))
          : Promise.resolve('OK'),
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenResponse({ access_token: 'unlocked' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      // A Redis outage must not block every Schwab call.
      expect(result).toEqual({ token: 'unlocked' });
      expect(lockAcquires()).toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('WITHOUT the lock'),
      );
    });

    it('a lock loser whose post-wait read throws treats it as stale and retries the lock', async () => {
      mockRedisGet
        .mockReset()
        .mockResolvedValueOnce(staleTokens()) // initial read
        .mockResolvedValueOnce(null) // lock poll: released
        .mockRejectedValueOnce(new Error('upstash blip')) // post-wait read
        .mockResolvedValueOnce(staleTokens()); // our re-read under the lock
      mockRedisSet.mockResolvedValueOnce(null).mockResolvedValue('OK');
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenResponse({ access_token: 'second-try' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({ token: 'second-try' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lockAcquires()).toHaveLength(2);
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });
  });

  describe('lock holder re-reads under the lock', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');
      evalAnswers(1);
    });

    it('stops without calling Schwab when the tokens were cleared before it got the lock', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens()) // pre-lock snapshot
        .mockResolvedValueOnce(null); // cleared by the previous holder
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('No tokens found'),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lockReleases()).toHaveLength(1);
    });

    it('returns the tokens another holder already refreshed, without calling Schwab', async () => {
      mockRedisGet.mockResolvedValueOnce(staleTokens()).mockResolvedValueOnce({
        accessToken: 'theirs',
        refreshToken: 'ref-tok',
        expiresAt: Date.now() + 1_800_000,
        refreshExpiresAt: Date.now() + 3 * DAY_MS,
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({ token: 'theirs' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(tokenWrites()).toHaveLength(0);
      expect(tokenEvals()).toHaveLength(0);
    });

    it('stops when the refresh token expired by the time it holds the lock', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens())
        .mockResolvedValueOnce(
          staleTokens({ refreshExpiresAt: Date.now() - 1000 }),
        );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('Refresh token expired'),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes from the re-read record, not the pre-lock snapshot', async () => {
      const reread = staleTokens({
        refreshToken: 'newer-ref',
        refreshExpiresAt: Date.now() + DAY_MS,
      });
      mockRedisGet
        .mockResolvedValueOnce(staleTokens({ refreshToken: 'old-ref' }))
        .mockResolvedValueOnce(reread);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenResponse({ access_token: 'new-access' }));
      vi.stubGlobal('fetch', fetchMock);

      expect(await getAccessToken()).toEqual({ token: 'new-access' });

      const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
      expect(body.get('refresh_token')).toBe('newer-ref');
      const { needle, tokens: written } = refreshStores()[0]!;
      // The write is conditioned on the record we actually refreshed from.
      expect(JSON.stringify(reread)).toContain(needle);
      expect(written.refreshToken).toBe('newer-ref');
      expect(written.refreshExpiresAt).toBe(reread.refreshExpiresAt);
    });

    it('falls back to the pre-lock snapshot when the re-read fails', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens())
        .mockRejectedValueOnce(new Error('upstash blip'));
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenResponse({ access_token: 'from-snapshot' }));
      vi.stubGlobal('fetch', fetchMock);

      expect(await getAccessToken()).toEqual({ token: 'from-snapshot' });

      const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
      expect(body.get('refresh_token')).toBe('ref-tok');
    });
  });

  describe('refreshed-token write (compare-and-set)', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisSet.mockResolvedValue('OK');
    });

    it('writes only if the record still holds the refresh token it refreshed with', async () => {
      const record = staleTokens();
      mockRedisGet.mockResolvedValue(record);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'new-a' })),
      );

      expect(await getAccessToken()).toEqual({ token: 'new-a' });

      expect(storeEvals()).toHaveLength(1);
      const [script, keys] = storeEvals()[0]!;
      expect(keys).toEqual(['schwab:tokens']);
      expect(script).toContain('string.find(raw, ARGV[1], 1, true)');
      expect(script).toContain(
        "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
      );
      const { needle, tokens } = refreshStores()[0]!;
      // Needle = the refresh-token fragment of the record as @upstash/redis
      // serializes it; it must not match a different refresh token.
      expect(JSON.stringify(record)).toContain(needle);
      expect(
        JSON.stringify({ ...record, refreshToken: 'reauth-ref' }),
      ).not.toContain(needle);
      expect(tokens).toMatchObject({
        accessToken: 'new-a',
        refreshToken: 'ref-tok',
        refreshExpiresAt: record.refreshExpiresAt,
      });
      expect(tokenWrites()).toHaveLength(0);
    });

    it('a re-auth that lands mid-refresh survives: the stale result is discarded', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens()) // initial read
        .mockResolvedValueOnce(staleTokens()) // lock holder's re-read
        .mockResolvedValueOnce({
          // re-read after the write was refused: the new login
          accessToken: 'reauth-access',
          refreshToken: 'reauth-ref',
          expiresAt: Date.now() + 1_800_000,
          refreshExpiresAt: Date.now() + 7 * DAY_MS,
        });
      evalAnswers(2); // compare-and-set: record holds a DIFFERENT token
      const fetchMock = vi
        .fn()
        .mockResolvedValue(tokenResponse({ access_token: 'stale-result' }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await getAccessToken();

      expect(result).toEqual({ token: 'reauth-access' });
      expect(storeEvals()).toHaveLength(1); // refused, not retried
      expect(tokenWrites()).toHaveLength(0); // nothing overwrote the login
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('does not resurrect a record that was cleared mid-refresh', async () => {
      mockRedisGet
        .mockResolvedValueOnce(staleTokens())
        .mockResolvedValueOnce(staleTokens())
        .mockResolvedValueOnce(null); // re-read after the refused write
      evalAnswers(0); // compare-and-set: key absent
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(tokenResponse({ access_token: 'orphan' })),
      );

      const result = await getAccessToken();

      expect(result).toEqual({
        error: {
          type: 'expired_refresh',
          message: expect.stringContaining('No tokens found'),
        },
      });
      expect(tokenWrites()).toHaveLength(0);
    });
  });

  describe('upstream error bodies are redacted', () => {
    // JWT-shaped secret: must never appear verbatim in an error, Sentry, or logs.
    const LEAKY =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0b2tlbiJ9.c2lnbmF0dXJlLXNlY3JldA';

    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue(staleTokens());
      mockRedisSet.mockResolvedValue('OK');
    });

    it('a non-2xx refresh body is redacted in the error and the Sentry capture', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            tokenFailure(503, `{"error":"server_error","trace":"${LEAKY}"}`),
          ),
      );

      const result = await getAccessToken();

      expect('error' in result && result.error.type).toBe('token_error');
      if ('error' in result) {
        expect(result.error.message).not.toContain(LEAKY);
        expect(result.error.message).toContain('server_error');
      }
      const captured = mockSentry.captureException.mock.calls[0]![0] as Error;
      expect(captured.message).not.toContain(LEAKY);
    });

    it('the refresh_rejected warning carries a redacted detail', async () => {
      evalAnswers(1);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            tokenFailure(
              400,
              `{"error":"invalid_grant","refresh_token":"${LEAKY}"}`,
            ),
          ),
      );

      await getAccessToken();

      const [, context] = mockSentry.captureMessage.mock.calls[0]!;
      const detail = String(context.extra.detail);
      expect(detail).toContain('invalid_grant');
      expect(detail).not.toContain(LEAKY);
    });

    it('a failed code exchange returns a redacted message', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            tokenFailure(400, `{"error":"invalid_client","echo":"${LEAKY}"}`),
          ),
      );

      const result = await storeInitialTokens('code', 'https://e.x/cb');

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.message).toContain('invalid_client');
        expect(result.error.message).not.toContain(LEAKY);
      }
    });
  });

  describe('malformed token-endpoint responses', () => {
    beforeEach(() => {
      process.env.SCHWAB_CLIENT_ID = 'id';
      process.env.SCHWAB_CLIENT_SECRET = 'secret';
      mockRedisGet.mockResolvedValue(staleTokens());
      mockRedisSet.mockResolvedValue('OK');
      evalAnswers(1);
    });

    it.each([
      ['an empty body {}', okJson({})],
      ['an empty access_token', okJson({ access_token: '', expires_in: 1800 })],
      ['a missing expires_in', okJson({ access_token: 'a' })],
      [
        'a string expires_in',
        okJson({ access_token: 'a', expires_in: '1800' }),
      ],
      [
        'a non-JSON body',
        {
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        },
      ],
    ])(
      'refresh: %s is a captured token_error that keeps the stored tokens',
      async (_label, response) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

        const result = await getAccessToken();

        expect('error' in result && result.error.type).toBe('token_error');
        expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
        expect(tokenWrites()).toHaveLength(0);
        expect(tokenEvals()).toHaveLength(0);
      },
    );

    it('names the bad fields without echoing token values', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          okJson({
            access_token: '',
            refresh_token: 'secret-ref-value',
            expires_in: 'soon',
          }),
        ),
      );

      const result = await getAccessToken();

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.message).toContain('access_token');
        expect(result.error.message).toContain('expires_in');
        expect(result.error.message).not.toContain('secret-ref-value');
      }
    });

    it.each([
      ['an empty body {}', okJson({})],
      [
        'a missing refresh_token',
        okJson({ access_token: 'a', expires_in: 1800 }),
      ],
    ])(
      'code exchange: %s is a token_error and nothing is stored',
      async (_label, response) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

        const result = await storeInitialTokens('code', 'https://e.x/cb');

        expect('error' in result && result.error.type).toBe('token_error');
        expect(tokenWrites()).toHaveLength(0);
      },
    );
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
