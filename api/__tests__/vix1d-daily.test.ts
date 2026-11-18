// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockDone } = vi.hoisted(() => ({ mockDone: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => mockDone) },
}));

// Keep the rest of auth-helpers real (the owner-cookie check runs for real)
// and spy on the limiter, to pin the limit this route sets.
vi.mock('../_lib/auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/auth-helpers.js')>()),
  rejectIfRateLimited: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  redis: { get: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  setCacheHeaders: vi.fn(),
}));

import handler from '../vix1d-daily.js';
import { redis } from '../_lib/redis.js';
import { setCacheHeaders } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import { rejectIfRateLimited } from '../_lib/auth-helpers.js';

const SAMPLE_MAP = {
  '2026-04-10': { o: 9.85, h: 20.38, l: 9.61, c: 19.07 },
  '2026-04-09': { o: 10.89, h: 14.59, l: 10.17, c: 14.07 },
};

beforeEach(() => {
  vi.mocked(redis.get).mockReset();
  vi.mocked(redis.get).mockResolvedValue(SAMPLE_MAP);
  vi.mocked(rejectIfRateLimited).mockReset();
  vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  mockDone.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/vix1d-daily per-IP request limit', () => {
  const OWNER_SECRET = 'vix1d-limit-test-owner-secret-0123456789';

  beforeEach(() => {
    vi.stubEnv('OWNER_SECRET', OWNER_SECRET);
  });

  it.each([
    ['a wrong owner cookie', { cookie: 'sc-owner=not-the-owner-secret' }],
    ['no cookie', {}],
  ])(
    '%s is limited at 30 a minute under the route name',
    async (_name, headers) => {
      const req = mockRequest({ method: 'GET', headers });
      const res = mockResponse();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual(SAMPLE_MAP);
      expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
      expect(rejectIfRateLimited).toHaveBeenCalledWith(
        req,
        res,
        'vix1d-daily',
        30,
      );
    },
  );

  it('answers 429, records it once and reads no Redis key when the limiter rejects', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementationOnce(async (_r, res) => {
      res
        .status(429)
        .json({ error: 'Too many requests. Try again in 30 seconds.' });
      return true;
    });
    const res = mockResponse();

    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(429);
    expect(res._json).toEqual({
      error: 'Too many requests. Try again in 30 seconds.',
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledWith({ status: 429 });
  });

  it('a request carrying the owner cookie never reaches the limiter', async () => {
    const res = mockResponse();

    await handler(
      mockRequest({
        method: 'GET',
        headers: { cookie: `sc-owner=${OWNER_SECRET}` },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual(SAMPLE_MAP);
    expect(rejectIfRateLimited).not.toHaveBeenCalled();
  });

  it('a limiter that throws returns 500, captures the error and reads no Redis key', async () => {
    const boom = new Error('limiter blew up');
    vi.mocked(rejectIfRateLimited).mockRejectedValueOnce(boom);
    const res = mockResponse();

    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(redis.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/vix1d-daily', () => {
  it('returns the daily map from Redis', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual(SAMPLE_MAP);
  });

  it('sets cache headers on success', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(vi.mocked(setCacheHeaders)).toHaveBeenCalled();
  });

  it('sets X-Day-Count header', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._headers['X-Day-Count']).toBe('2');
  });

  it('returns 404 when Redis has no data', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it('returns 404 when Redis returns empty map', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce({});
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it('returns 500 and captures exception on Redis error', async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('Redis timeout'));
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });
});
