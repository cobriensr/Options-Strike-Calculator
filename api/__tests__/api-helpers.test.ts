// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import {
  isOwner,
  rejectIfNotOwner,
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  isRateLimited,
  getRateLimitKey,
  rejectIfRateLimited,
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
} from '../_lib/api-helpers.js';
import { getAccessToken } from '../_lib/schwab.js';

describe('api-helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
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
      expect(res._json).toEqual({ error: 'Not authenticated' });
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

  describe('getRateLimitKey', () => {
    it('uses x-forwarded-for IP', () => {
      const req = mockRequest({
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      });
      expect(getRateLimitKey(req, 'auth')).toBe('auth:1.2.3.4');
    });

    it('uses unknown when no forwarded header', () => {
      const req = mockRequest({ headers: {} });
      expect(getRateLimitKey(req, 'test')).toBe('test:unknown');
    });

    it('uses unknown when x-forwarded-for is an array', () => {
      const req = mockRequest({
        headers: { 'x-forwarded-for': ['1.2.3.4'] as unknown as string },
      });
      expect(getRateLimitKey(req, 'test')).toBe('test:unknown');
    });
  });

  describe('isRateLimited', () => {
    it('returns false when count is within limit', async () => {
      mockPipeline.exec.mockResolvedValue([3]);
      const result = await isRateLimited('key', 5);
      expect(result).toBe(false);
    });

    it('returns true when count exceeds limit', async () => {
      mockPipeline.exec.mockResolvedValue([6]);
      const result = await isRateLimited('key', 5);
      expect(result).toBe(true);
    });

    it('calls incr and expire on the pipeline', async () => {
      mockPipeline.incr.mockClear();
      mockPipeline.expire.mockClear();
      mockPipeline.exec.mockResolvedValue([1]);
      await isRateLimited('key', 5);
      expect(mockPipeline.incr).toHaveBeenCalledWith('ratelimit:key');
      expect(mockPipeline.expire).toHaveBeenCalledWith('ratelimit:key', 60);
    });

    it('fails open when Redis throws', async () => {
      mockPipeline.exec.mockRejectedValue(new Error('redis down'));
      const result = await isRateLimited('key', 5);
      expect(result).toBe(false);
    });
  });

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
      expect(result).toEqual({ error: 'Token expired', status: 401 });
    });

    it('returns error with status 500 for non-refresh errors', async () => {
      vi.mocked(getAccessToken).mockResolvedValue({
        error: { type: 'token_error', message: 'Something broke' },
      });
      const result = await schwabFetch('/quotes');
      expect(result).toEqual({ error: 'Something broke', status: 500 });
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
      expect(result).toEqual({ data: mockData });
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
        error: 'Schwab API error (403): Forbidden',
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
        error: 'Schwab API error (401): Unauthorized',
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
});
