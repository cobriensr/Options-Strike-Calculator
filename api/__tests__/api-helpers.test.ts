// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetEnvCache } from '../_lib/env.js';
import { mockRequest, mockResponse } from './helpers';

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

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    rateLimited: vi.fn(),
    tokenRefresh: vi.fn(),
    schwabCall: vi.fn(() => vi.fn()),
  },
  Sentry: { setTag: vi.fn(), captureMessage: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  isOwner,
  rejectIfNotOwner,
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  rejectIfRateLimited,
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
  sendError,
  withRetry,
  uwFetch,
  roundTo5Min,
  cronGuard,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import { getAccessToken } from '../_lib/schwab.js';

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
});
