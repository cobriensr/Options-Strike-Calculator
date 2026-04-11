// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/schwab.js', () => ({
  redis: { get: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  setCacheHeaders: vi.fn(),
}));

import handler from '../vix1d-daily.js';
import { redis } from '../_lib/schwab.js';
import { setCacheHeaders } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const SAMPLE_MAP = {
  '2026-04-10': { o: 9.85, h: 20.38, l: 9.61, c: 19.07 },
  '2026-04-09': { o: 10.89, h: 14.59, l: 10.17, c: 14.07 },
};

beforeEach(() => {
  vi.mocked(redis.get).mockResolvedValue(SAMPLE_MAP);
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
