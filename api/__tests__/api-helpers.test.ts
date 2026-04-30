// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

// Mock botid/server so checkBot and guardOwnerEndpoint are testable
vi.mock('botid/server', () => ({
  checkBotId: vi.fn().mockResolvedValue({ isBot: false }),
}));

// Mock schwab module before importing api-helpers
const mockPipeline = {
  incr: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([0]),
};
vi.mock('../_lib/schwab.js', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    pipeline: vi.fn(() => mockPipeline),
  },
  getAccessToken: vi.fn(),
}));

// uwFetch wraps the request in acquire/release of a concurrency slot.
// Mock the semaphore module so we don't need a Redis stub for it; we
// also assert release-on-error in dedicated tests below.
// `vi.hoisted` is required because vi.mock factories run before any
// other top-level statement, so these vars must exist before the mock.
const { mockAcquireConcurrencySlot, mockReleaseConcurrencySlot } = vi.hoisted(
  () => ({
    mockAcquireConcurrencySlot: vi.fn().mockResolvedValue('test-slot'),
    mockReleaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: mockAcquireConcurrencySlot,
  releaseConcurrencySlot: mockReleaseConcurrencySlot,
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    rateLimited: vi.fn(),
    uwRateLimit: vi.fn(),
    tokenRefresh: vi.fn(),
    schwabCall: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
  Sentry: {
    setTag: vi.fn(),
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock timezone + marketHours so isMarketHours/isMarketOpen branches are reachable
vi.mock('../../src/utils/timezone.js', () => ({
  getETDayOfWeek: vi.fn().mockReturnValue(1), // Monday by default
  getETDateStr: vi.fn().mockReturnValue('2026-04-13'),
  getETTime: vi.fn().mockReturnValue({ hour: 10, minute: 30 }),
}));

vi.mock('../../src/data/marketHours.js', () => ({
  getMarketCloseHourET: vi.fn().mockReturnValue(16), // normal close at 4 PM
}));

import {
  isOwner,
  rejectIfNotOwner,
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  rejectIfRateLimited,
  schwabFetch,
  schwabTraderFetch,
  setCacheHeaders,
  isMarketOpen,
  isMarketHours,
  sendError,
  withRetry,
  uwFetch,
  roundTo5Min,
  cronGuard,
  checkDataQuality,
  checkBot,
  guardOwnerEndpoint,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { z } from 'zod';
import { getAccessToken } from '../_lib/schwab.js';
import { checkBotId } from 'botid/server';
import { getETDayOfWeek } from '../../src/utils/timezone.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';

/** Build a minimal botid result shape for mocking checkBotId. */
function makeBotResult(isBot: boolean): Awaited<ReturnType<typeof checkBotId>> {
  return {
    isBot,
    isHuman: !isBot,
    isVerifiedBot: false,
    bypassed: false,
  } as Awaited<ReturnType<typeof checkBotId>>;
}

describe('api-helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetEnvCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============================================================
  // OWNER VERIFICATION
  // ============================================================

  describe('isOwner', () => {
    it('returns false when OWNER_SECRET is not set', () => {
      delete process.env.OWNER_SECRET;
      const req = mockRequest({
        headers: { cookie: `${OWNER_COOKIE}=secret123` },
      });
      expect(isOwner(req)).toBe(false);
    });

    it('returns false when cookie is missing', () => {
      process.env.OWNER_SECRET = 'secret123';
      const req = mockRequest({ headers: {} });
      expect(isOwner(req)).toBe(false);
    });

    it('returns false when cookie does not match', () => {
      process.env.OWNER_SECRET = 'secret123';
      const req = mockRequest({ headers: { cookie: `${OWNER_COOKIE}=wrong` } });
      expect(isOwner(req)).toBe(false);
    });

    it('returns true when cookie matches OWNER_SECRET', () => {
      process.env.OWNER_SECRET = 'secret123';
      const req = mockRequest({
        headers: { cookie: `${OWNER_COOKIE}=secret123` },
      });
      expect(isOwner(req)).toBe(true);
    });

    it('parses multiple cookies correctly', () => {
      process.env.OWNER_SECRET = 'secret123';
      const req = mockRequest({
        headers: { cookie: `other=val; ${OWNER_COOKIE}=secret123; another=x` },
      });
      expect(isOwner(req)).toBe(true);
    });
  });

  describe('rejectIfNotOwner', () => {
    it('sends 401 and returns true for non-owner', () => {
      delete process.env.OWNER_SECRET;
      const req = mockRequest();
      const res = mockResponse();
      const rejected = rejectIfNotOwner(req, res);
      expect(rejected).toBe(true);
      expect(res._status).toBe(401);
      expect(res._json).toEqual({
        error: 'Not authenticated',
        code: 'no_secret',
      });
      expect(res._headers['Cache-Control']).toBe('no-store');
    });

    it('returns false for owner', () => {
      process.env.OWNER_SECRET = 'secret123';
      const req = mockRequest({
        headers: { cookie: `${OWNER_COOKIE}=secret123` },
      });
      const res = mockResponse();
      const rejected = rejectIfNotOwner(req, res);
      expect(rejected).toBe(false);
    });
  });

  // ============================================================
  // CONSTANTS
  // ============================================================

  describe('constants', () => {
    it('OWNER_COOKIE is sc-owner', () => {
      expect(OWNER_COOKIE).toBe('sc-owner');
    });

    it('OWNER_COOKIE_MAX_AGE is 7 days', () => {
      expect(OWNER_COOKIE_MAX_AGE).toBe(7 * 24 * 60 * 60);
    });
  });

  // ============================================================
  // RATE LIMITING
  // ============================================================

  describe('rejectIfRateLimited', () => {
    it('sends 429 when rate limited', async () => {
      mockPipeline.exec.mockResolvedValue([100]);
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      const rejected = await rejectIfRateLimited(req, res, 'test', 5);
      expect(rejected).toBe(true);
      expect(res._status).toBe(429);
      expect(res._headers['Retry-After']).toBe('60');
    });

    it('returns false when not rate limited', async () => {
      mockPipeline.exec.mockResolvedValue([1]);
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      const rejected = await rejectIfRateLimited(req, res, 'test', 5);
      expect(rejected).toBe(false);
    });
  });

  // ============================================================
  // SCHWAB FETCH
  // ============================================================

  describe('schwabFetch', () => {
    it('returns error when getAccessToken fails with expired_refresh', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({
        error: { type: 'expired_refresh', message: 'Token expired' },
      });
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_TOKEN_EXPIRED] Token expired',
        status: 401,
      });
    });

    it('returns error with status 500 for non-refresh errors', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({
        error: { type: 'token_error', message: 'Something broke' },
      });
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_TOKEN_ERROR] Something broke',
        status: 500,
      });
    });

    it('returns data on successful fetch', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok123' });
      const mockData = { SPY: { quote: { lastPrice: 500 } } };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockData),
        }),
      );
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({ ok: true, data: mockData });
      vi.unstubAllGlobals();
    });

    it('returns error on non-ok Schwab response', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok123' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: () => Promise.resolve('Forbidden'),
        }),
      );
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_API_403] Schwab API error (403): Forbidden',
        status: 502,
      });
      vi.unstubAllGlobals();
    });

    it('returns 401 status when Schwab returns 401', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok123' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        }),
      );
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_API_REJECTED] Schwab API error (401): Unauthorized',
        status: 401,
      });
      vi.unstubAllGlobals();
    });
  });

  // ============================================================
  // CACHE HEADERS
  // ============================================================

  describe('setCacheHeaders', () => {
    it('sets s-maxage and stale-while-revalidate', () => {
      const res = mockResponse();
      setCacheHeaders(res, 60, 30);
      expect(res._headers['Cache-Control']).toBe(
        's-maxage=60, stale-while-revalidate=30',
      );
      expect(res._headers['Vary']).toBe('Cookie');
    });

    it('defaults SWR to 60', () => {
      const res = mockResponse();
      setCacheHeaders(res, 120);
      expect(res._headers['Cache-Control']).toBe(
        's-maxage=120, stale-while-revalidate=60',
      );
    });
  });

  // ============================================================
  // MARKET HOURS
  // ============================================================

  describe('isMarketOpen', () => {
    it('returns a boolean', () => {
      expect(typeof isMarketOpen()).toBe('boolean');
    });
  });

  // ============================================================
  // SEND ERROR
  // ============================================================

  describe('sendError', () => {
    it('sends error JSON with status and no-store cache', () => {
      const res = mockResponse();
      sendError(res, 400, 'Bad request');
      expect(res._status).toBe(400);
      expect(res._json).toEqual({ error: 'Bad request' });
      expect(res._headers['Cache-Control']).toBe('no-store');
    });

    it('includes code when provided', () => {
      const res = mockResponse();
      sendError(res, 500, 'Server error', 'INTERNAL');
      expect(res._json).toEqual({
        error: 'Server error',
        code: 'INTERNAL',
      });
    });

    it('omits code when not provided', () => {
      const res = mockResponse();
      sendError(res, 404, 'Not found');
      expect(res._json).toEqual({ error: 'Not found' });
    });
  });

  // ============================================================
  // WITH RETRY
  // ============================================================

  describe('withRetry', () => {
    it('returns value on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient error and succeeds', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('ok');
      const result = await withRetry(fn, 2);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on non-transient error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('syntax error in SQL'));
      await expect(withRetry(fn, 2)).rejects.toThrow('syntax error in SQL');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting retries on transient error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('timeout'));
      await expect(withRetry(fn, 1)).rejects.toThrow('timeout');
      expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
    });

    it('retries on fetch failed error', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue('recovered');
      const result = await withRetry(fn, 1);
      expect(result).toBe('recovered');
    });

    it('retries on socket hang up error', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue('recovered');
      const result = await withRetry(fn, 1);
      expect(result).toBe('recovered');
    });

    it('retries on 502 error', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValue('recovered');
      const result = await withRetry(fn, 1);
      expect(result).toBe('recovered');
    });

    it('does not retry non-Error throws', async () => {
      const fn = vi.fn().mockRejectedValue('string error');
      await expect(withRetry(fn, 2)).rejects.toBe('string error');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // UW FETCH
  // ============================================================

  describe('uwFetch', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns body.data on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ data: [{ a: 1 }] }),
        }),
      );
      const result = await uwFetch('key123', '/market/SPY/etf-tide');
      expect(result).toEqual([{ a: 1 }]);
    });

    it('returns empty array when body.data is missing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      );
      const result = await uwFetch('key123', '/some-endpoint');
      expect(result).toEqual([]);
    });

    it('uses custom extract function when provided', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ data: [{ nested: [1, 2, 3] }] }),
        }),
      );
      const extract = (body: Record<string, unknown>) => {
        const data = body.data as Array<{ nested: number[] }>;
        return data[0]!.nested;
      };
      const result = await uwFetch('key123', '/path', extract);
      expect(result).toEqual([1, 2, 3]);
    });

    it('throws on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: () => Promise.resolve('Rate limited'),
        }),
      );
      await expect(uwFetch('key123', '/path')).rejects.toThrow(
        'UW API 429: Rate limited',
      );
    });

    it('handles text() failure gracefully on error response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.reject(new Error('body consumed')),
        }),
      );
      await expect(uwFetch('key123', '/path')).rejects.toThrow('UW API 500: ');
    });

    it('uses full URL when path starts with http', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);
      await uwFetch('key123', 'https://custom.api.com/data');
      expect(mockFetch.mock.calls[0]![0]).toBe('https://custom.api.com/data');
    });

    // ── BE-CRON-002 follow-up: 429 observability ────────────
    // We're at ~8% of UW's 120/min budget steady-state, so 429s should
    // never fire. But if they ever do, we want immediate visibility —
    // these tests pin the Sentry emission path.

    it('emits uwRateLimit metric with stripped endpoint on 429', async () => {
      const { metrics: mockedMetrics } = await import('../_lib/sentry.js');
      vi.mocked(mockedMetrics.uwRateLimit).mockClear();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h === 'retry-after' ? '30' : null) },
          text: () => Promise.resolve('Rate limited'),
        }),
      );

      await expect(
        uwFetch('key123', '/stock/SPX/strike-greeks?date=2026-04-08'),
      ).rejects.toThrow('UW API 429');

      expect(mockedMetrics.uwRateLimit).toHaveBeenCalledTimes(1);
      // Query string stripped so identical endpoints group together
      expect(mockedMetrics.uwRateLimit).toHaveBeenCalledWith(
        '/stock/SPX/strike-greeks',
        '30',
      );
    });

    it('passes retryAfter=null when the header is absent on 429', async () => {
      const { metrics: mockedMetrics } = await import('../_lib/sentry.js');
      vi.mocked(mockedMetrics.uwRateLimit).mockClear();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: () => Promise.resolve(''),
        }),
      );

      await expect(uwFetch('key123', '/some/path')).rejects.toThrow(
        'UW API 429',
      );
      expect(mockedMetrics.uwRateLimit).toHaveBeenCalledWith(
        '/some/path',
        null,
      );
    });

    it('does NOT emit uwRateLimit on non-429 errors', async () => {
      const { metrics: mockedMetrics } = await import('../_lib/sentry.js');
      vi.mocked(mockedMetrics.uwRateLimit).mockClear();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal error'),
        }),
      );

      await expect(uwFetch('key123', '/path')).rejects.toThrow('UW API 500');
      expect(mockedMetrics.uwRateLimit).not.toHaveBeenCalled();
    });

    // ── Concurrency semaphore: must release on every code path ────
    // A leaked slot is the most dangerous failure for this design, so
    // pin both the success and error release paths explicitly.

    it('releases the concurrency slot after a successful fetch', async () => {
      mockAcquireConcurrencySlot.mockClear();
      mockReleaseConcurrencySlot.mockClear();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ data: [1] }),
        }),
      );

      await uwFetch('key123', '/path');

      expect(mockAcquireConcurrencySlot).toHaveBeenCalledTimes(1);
      expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('test-slot');
    });

    it('releases the concurrency slot when the fetch throws', async () => {
      mockAcquireConcurrencySlot.mockClear();
      mockReleaseConcurrencySlot.mockClear();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          headers: { get: () => null },
          text: () => Promise.resolve('upstream'),
        }),
      );

      await expect(uwFetch('key123', '/path')).rejects.toThrow('UW API 503');

      expect(mockAcquireConcurrencySlot).toHaveBeenCalledTimes(1);
      expect(mockReleaseConcurrencySlot).toHaveBeenCalledWith('test-slot');
    });
  });

  // ============================================================
  // ROUND TO 5 MIN
  // ============================================================

  describe('roundTo5Min', () => {
    it('floors 10:37 to 10:35', () => {
      const dt = new Date('2026-04-01T10:37:42.123Z');
      const result = roundTo5Min(dt);
      expect(result.getMinutes()).toBe(35);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
    });

    it('keeps 10:35 unchanged', () => {
      const dt = new Date('2026-04-01T10:35:00.000Z');
      const result = roundTo5Min(dt);
      expect(result.getMinutes()).toBe(35);
    });

    it('floors 10:00 to 10:00', () => {
      const dt = new Date('2026-04-01T10:00:30.000Z');
      const result = roundTo5Min(dt);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
    });

    it('floors 10:59 to 10:55', () => {
      const dt = new Date('2026-04-01T10:59:59.999Z');
      const result = roundTo5Min(dt);
      expect(result.getMinutes()).toBe(55);
    });

    it('does not mutate the input', () => {
      const dt = new Date('2026-04-01T10:37:42.123Z');
      const original = dt.getTime();
      roundTo5Min(dt);
      expect(dt.getTime()).toBe(original);
    });
  });

  // ============================================================
  // CRON GUARD
  // ============================================================

  describe('cronGuard', () => {
    it('rejects non-GET methods with 405', () => {
      process.env.CRON_SECRET = 'secret';
      const req = mockRequest({ method: 'POST' });
      const res = mockResponse();
      expect(cronGuard(req, res)).toBeNull();
      expect(res._status).toBe(405);
    });

    it('rejects missing CRON_SECRET with 401', () => {
      delete process.env.CRON_SECRET;
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong' },
      });
      const res = mockResponse();
      expect(cronGuard(req, res)).toBeNull();
      expect(res._status).toBe(401);
    });

    it('rejects wrong CRON_SECRET with 401', () => {
      process.env.CRON_SECRET = 'correct';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong' },
      });
      const res = mockResponse();
      expect(cronGuard(req, res)).toBeNull();
      expect(res._status).toBe(401);
    });

    it('skips when outside time window (custom timeCheck)', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        timeCheck: () => false,
      });
      expect(result).toBeNull();
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        skipped: true,
        reason: 'Outside time window',
      });
    });

    it('rejects when UW_API_KEY is missing', () => {
      process.env.CRON_SECRET = 'secret';
      delete process.env.UW_API_KEY;
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        marketHours: false,
        requireApiKey: true,
      });
      expect(result).toBeNull();
      expect(res._status).toBe(500);
    });

    it('returns apiKey and today on success', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        marketHours: false,
      });
      expect(result).not.toBeNull();
      expect(result!.apiKey).toBe('uw_key');
      expect(result!.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('passes when marketHours is false', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, { marketHours: false });
      expect(result).not.toBeNull();
    });

    it('returns empty apiKey when requireApiKey is false', () => {
      process.env.CRON_SECRET = 'secret';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        marketHours: false,
        requireApiKey: false,
      });
      expect(result).not.toBeNull();
      expect(result!.apiKey).toBe('');
    });

    it('passes when custom timeCheck returns true', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        timeCheck: () => true,
      });
      expect(result).not.toBeNull();
    });

    it('bypasses the time-window check when ?force=1', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
        query: { force: '1' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, {
        timeCheck: () => false,
      });
      expect(result).not.toBeNull();
      expect(result!.apiKey).toBe('uw_key');
    });

    it('?force=1 does NOT bypass CRON_SECRET (still 401 on bad auth)', () => {
      process.env.CRON_SECRET = 'correct';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong' },
        query: { force: '1' },
      });
      const res = mockResponse();
      expect(cronGuard(req, res, { timeCheck: () => false })).toBeNull();
      expect(res._status).toBe(401);
    });

    it('?force values other than "1" do NOT bypass the time gate', () => {
      process.env.CRON_SECRET = 'secret';
      process.env.UW_API_KEY = 'uw_key';
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
        query: { force: 'true' },
      });
      const res = mockResponse();
      const result = cronGuard(req, res, { timeCheck: () => false });
      expect(result).toBeNull();
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        skipped: true,
        reason: 'Outside time window',
      });
    });
  });

  // ============================================================
  // CHECK DATA QUALITY
  // ============================================================

  describe('checkDataQuality', () => {
    it('fires Sentry warning when all values are zero', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      await checkDataQuality({
        job: 'test-job',
        table: 'test_table',
        date: '2026-04-01',
        total: 50,
        nonzero: 0,
      });
      expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'test-job');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          'test_table has 50 rows but ALL values are zero',
        ),
        'warning',
      );
    });

    it('uses sourceFilter as label when provided', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      vi.mocked(Sentry.captureMessage).mockClear();
      await checkDataQuality({
        job: 'test-job',
        table: 'test_table',
        date: '2026-04-01',
        sourceFilter: "source = 'spy_etf_tide'",
        total: 20,
        nonzero: 0,
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("source = 'spy_etf_tide'"),
        'warning',
      );
    });

    it('does nothing when nonzero > 0', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      vi.mocked(Sentry.captureMessage).mockClear();
      await checkDataQuality({
        job: 'test-job',
        table: 'test_table',
        date: '2026-04-01',
        total: 50,
        nonzero: 10,
      });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('does nothing when total <= minRows', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      vi.mocked(Sentry.captureMessage).mockClear();
      await checkDataQuality({
        job: 'test-job',
        table: 'test_table',
        date: '2026-04-01',
        total: 5,
        nonzero: 0,
      });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('respects custom minRows threshold', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      vi.mocked(Sentry.captureMessage).mockClear();
      await checkDataQuality({
        job: 'test-job',
        table: 'test_table',
        date: '2026-04-01',
        total: 15,
        nonzero: 0,
        minRows: 20,
      });
      // total (15) <= minRows (20), so no alert
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // CHECK BOT
  // ============================================================

  describe('checkBot', () => {
    afterEach(() => {
      vi.mocked(checkBotId).mockResolvedValue(makeBotResult(false));
    });

    it('returns { isBot: false } when VERCEL is not set', async () => {
      delete process.env.VERCEL;
      const req = mockRequest();
      const result = await checkBot(req);
      expect(result).toEqual({ isBot: false });
      // checkBotId should NOT be called in local dev
      expect(checkBotId).not.toHaveBeenCalled();
    });

    it('calls checkBotId and returns its result when VERCEL is set', async () => {
      process.env.VERCEL = '1';
      vi.mocked(checkBotId).mockResolvedValue(makeBotResult(true));
      const req = mockRequest({ headers: { 'x-real-ip': '1.2.3.4' } });
      const result = await checkBot(req);
      expect(result).toEqual(expect.objectContaining({ isBot: true }));
      expect(checkBotId).toHaveBeenCalledWith({
        advancedOptions: { headers: req.headers },
      });
    });

    it('returns { isBot: false } when checkBotId says so', async () => {
      process.env.VERCEL = '1';
      vi.mocked(checkBotId).mockResolvedValue(makeBotResult(false));
      const req = mockRequest();
      const result = await checkBot(req);
      expect(result).toEqual(expect.objectContaining({ isBot: false }));
    });
  });

  // ============================================================
  // GUARD OWNER ENDPOINT
  // ============================================================

  describe('guardOwnerEndpoint', () => {
    const done = vi.fn();

    beforeEach(() => {
      done.mockReset();
      vi.mocked(checkBotId).mockResolvedValue(makeBotResult(false));
    });

    afterEach(() => {
      delete process.env.VERCEL;
    });

    it('rejects bot requests with 403 and returns true', async () => {
      process.env.VERCEL = '1';
      vi.mocked(checkBotId).mockResolvedValue(makeBotResult(true));
      const req = mockRequest();
      const res = mockResponse();
      const rejected = await guardOwnerEndpoint(req, res, done);
      expect(rejected).toBe(true);
      expect(res._status).toBe(403);
      expect(res._json).toEqual({ error: 'Access denied' });
      expect(done).toHaveBeenCalledWith({ status: 403 });
    });

    it('rejects non-owner (no bot) with 401 and returns true', async () => {
      delete process.env.VERCEL;
      delete process.env.OWNER_SECRET;
      const req = mockRequest();
      const res = mockResponse();
      const rejected = await guardOwnerEndpoint(req, res, done);
      expect(rejected).toBe(true);
      expect(res._status).toBe(401);
      expect(done).toHaveBeenCalledWith({ status: 401 });
    });

    it('returns false when bot check passes and owner is valid', async () => {
      delete process.env.VERCEL;
      process.env.OWNER_SECRET = 'mysecret';
      const req = mockRequest({
        headers: { cookie: `${OWNER_COOKIE}=mysecret` },
      });
      const res = mockResponse();
      const rejected = await guardOwnerEndpoint(req, res, done);
      expect(rejected).toBe(false);
      expect(done).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // RESPOND IF INVALID
  // ============================================================

  describe('respondIfInvalid', () => {
    it('sends 400 and returns true when parse fails', () => {
      const schema = z.object({ name: z.string() });
      const parsed = schema.safeParse({ name: 123 });
      const res = mockResponse();
      const done = vi.fn();
      const result = respondIfInvalid(parsed, res, done);
      expect(result).toBe(true);
      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({ error: expect.any(String) });
      expect(done).toHaveBeenCalledWith({ status: 400 });
    });

    it('returns false when parse succeeds', () => {
      const schema = z.object({ name: z.string() });
      const parsed = schema.safeParse({ name: 'hello' });
      const res = mockResponse();
      const result = respondIfInvalid(parsed, res);
      expect(result).toBe(false);
      expect(res._status).toBe(200); // unchanged
    });

    it('works without a done callback', () => {
      const schema = z.object({ count: z.number() });
      const parsed = schema.safeParse({ count: 'not-a-number' });
      const res = mockResponse();
      // Should not throw even with no done callback
      expect(() => respondIfInvalid(parsed, res)).not.toThrow();
      expect(res._status).toBe(400);
    });

    it('uses fallback message when issues array is empty', () => {
      // Construct a synthetic failed parse result with no issues
      const failedParse = {
        success: false as const,
        error: { issues: [] } as unknown as import('zod').ZodError,
      };
      const res = mockResponse();
      respondIfInvalid(failedParse, res);
      expect(res._json).toEqual({ error: 'Invalid request body' });
    });
  });

  // ============================================================
  // SCHWAB TRADER FETCH
  // ============================================================

  describe('schwabTraderFetch', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns error when getAccessToken fails', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({
        error: { type: 'expired_refresh', message: 'Token expired' },
      });
      const result = await schwabTraderFetch('/accounts');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_TOKEN_EXPIRED] Token expired',
        status: 401,
      });
    });

    it('returns data on successful fetch to trader base URL', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-trader' });
      const mockData = { accounts: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockData),
        }),
      );
      const result = await schwabTraderFetch('/accounts');
      expect(result).toEqual({ ok: true, data: mockData });
      // Verify it used the trader base URL
      const fetchArg = (fetch as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as string;
      expect(fetchArg).toContain('schwabapi.com/trader/v1');
    });

    it('returns 429 status when Schwab trader returns 429', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok-trader' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          text: () => Promise.resolve('Rate limited'),
        }),
      );
      const result = await schwabTraderFetch('/accounts');
      expect(result).toEqual({
        ok: false,
        error: '[SCHWAB_API_429] Schwab API error (429): Rate limited',
        status: 429,
      });
    });
  });

  // ============================================================
  // IS MARKET HOURS
  // ============================================================

  describe('isMarketHours', () => {
    afterEach(() => {
      vi.mocked(getETDayOfWeek).mockReturnValue(1);
      vi.mocked(getMarketCloseHourET).mockReturnValue(16);
    });

    it('returns false on weekend (day === 0)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(0);
      expect(isMarketHours()).toBe(false);
    });

    it('returns false on weekend (day === 6)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(6);
      expect(isMarketHours()).toBe(false);
    });

    it('returns false on a holiday (closeHour is null)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(3);
      vi.mocked(getMarketCloseHourET).mockReturnValue(null);
      expect(isMarketHours()).toBe(false);
    });

    it('returns a boolean on a normal weekday', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(2);
      vi.mocked(getMarketCloseHourET).mockReturnValue(16);
      expect(typeof isMarketHours()).toBe('boolean');
    });
  });

  // ============================================================
  // IS MARKET OPEN — ADDITIONAL BRANCHES
  // ============================================================

  describe('isMarketOpen (weekend and holiday branches)', () => {
    afterEach(() => {
      vi.mocked(getETDayOfWeek).mockReturnValue(1);
      vi.mocked(getMarketCloseHourET).mockReturnValue(16);
    });

    it('returns false on Sunday (day === 0)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(0);
      expect(isMarketOpen()).toBe(false);
    });

    it('returns false on Saturday (day === 6)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(6);
      expect(isMarketOpen()).toBe(false);
    });

    it('returns false on a holiday (closeHour is null)', () => {
      vi.mocked(getETDayOfWeek).mockReturnValue(4);
      vi.mocked(getMarketCloseHourET).mockReturnValue(null);
      expect(isMarketOpen()).toBe(false);
    });
  });

  // ============================================================
  // SCHWAB FETCH — RETRY PATH (500 transient → success)
  // ============================================================

  describe('schwabFetch (retry on 500)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('retries on 500 and succeeds on second attempt', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({ token: 'tok123' });
      const mockData = { result: 'ok' };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve('Service Unavailable'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockData),
        });
      vi.stubGlobal('fetch', mockFetch);
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({ ok: true, data: mockData });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  // ============================================================
  // IS RATE LIMITED — REDIS ERROR PATH
  // ============================================================

  describe('rejectIfRateLimited (Redis error path)', () => {
    it('fails open when Redis pipeline throws', async () => {
      mockPipeline.exec.mockRejectedValueOnce(
        new Error('Redis connection refused'),
      );
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      // Fails open — should not block the request
      const rejected = await rejectIfRateLimited(req, res, 'test', 5);
      expect(rejected).toBe(false);
    });
  });

  // ============================================================
  // IS OWNER — VERCEL warning branch
  // ============================================================

  describe('isOwner (VERCEL env warning)', () => {
    it('logs a warning once when OWNER_SECRET is absent and VERCEL is set', () => {
      delete process.env.OWNER_SECRET;
      process.env.VERCEL = '1';
      const req = mockRequest({
        headers: { cookie: `${OWNER_COOKIE}=anything` },
      });
      // First call should trigger the one-time warning
      const result = isOwner(req);
      expect(result).toBe(false);
    });
  });

  // ============================================================
  // UW FETCH — 429 with full http URL (IIFE pathname extraction)
  // ============================================================

  describe('uwFetch (429 with full http URL)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('extracts pathname from full http URL on 429', async () => {
      const { metrics: mockedMetrics } = await import('../_lib/sentry.js');
      vi.mocked(mockedMetrics.uwRateLimit).mockClear();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h === 'retry-after' ? '60' : null) },
          text: () => Promise.resolve('Too many requests'),
        }),
      );

      await expect(
        uwFetch(
          'key123',
          'https://api.unusualwhales.com/api/stock/SPX/flow?date=2026-04-13',
        ),
      ).rejects.toThrow('UW API 429');

      expect(mockedMetrics.uwRateLimit).toHaveBeenCalledWith(
        '/api/stock/SPX/flow',
        '60',
      );
    });

    it('falls back to raw path when URL parsing fails on 429', async () => {
      const { metrics: mockedMetrics } = await import('../_lib/sentry.js');
      vi.mocked(mockedMetrics.uwRateLimit).mockClear();

      // Temporarily make URL constructor throw for this test
      const OrigURL = global.URL;
      vi.stubGlobal(
        'URL',
        class {
          constructor() {
            throw new Error('bad url');
          }
        },
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: () => Promise.resolve('Rate limited'),
        }),
      );

      await expect(
        uwFetch('key123', 'https://bad-url-for-test'),
      ).rejects.toThrow('UW API 429');

      // Restore URL before assertions
      vi.stubGlobal('URL', OrigURL);

      expect(mockedMetrics.uwRateLimit).toHaveBeenCalledWith(
        'https://bad-url-for-test',
        null,
      );
    });
  });
});
