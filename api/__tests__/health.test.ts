// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
// Keep the rest of auth-helpers real (the owner-cookie check runs for real)
// and spy on the limiter, to pin the limit this route sets.
vi.mock('../_lib/auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/auth-helpers.js')>()),
  rejectIfRateLimited: vi.fn(),
}));

const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const mockPing = vi.fn();
const mockGetAccessToken = vi.fn();
vi.mock('../_lib/redis.js', () => ({
  redis: { ping: (...args: unknown[]) => mockPing(...args) },
}));

vi.mock('../_lib/schwab.js', () => ({
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: (...args: unknown[]) => mockCaptureException(...args),
  },
}));

import handler from '../health.js';
import { rejectIfRateLimited } from '../_lib/auth-helpers.js';

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/health', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    mockPing.mockReset();
    mockGetAccessToken.mockReset();
    mockCaptureException.mockReset();
    vi.mocked(rejectIfRateLimited).mockReset();
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('per-IP request limit', () => {
    const OWNER_SECRET = 'health-limit-test-owner-secret-0123456789';

    beforeEach(() => {
      vi.stubEnv('OWNER_SECRET', OWNER_SECRET);
      mockDbFn.mockResolvedValue([{ '?column?': 1 }]);
      mockPing.mockResolvedValue('PONG');
      mockGetAccessToken.mockResolvedValue({ token: 'tok_123' });
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
        expect(res._json).toMatchObject({ status: 'healthy' });
        expect(rejectIfRateLimited).toHaveBeenCalledTimes(1);
        expect(rejectIfRateLimited).toHaveBeenCalledWith(
          req,
          res,
          'health',
          30,
        );
      },
    );

    it('answers 429 and checks no service when the limiter rejects', async () => {
      vi.mocked(rejectIfRateLimited).mockImplementationOnce(
        async (_req, res) => {
          res
            .status(429)
            .json({ error: 'Too many requests. Try again in 30 seconds.' });
          return true;
        },
      );
      const res = mockResponse();

      await handler(mockRequest({ method: 'GET' }), res);

      expect(res._status).toBe(429);
      expect(res._json).toEqual({
        error: 'Too many requests. Try again in 30 seconds.',
      });
      expect(mockDbFn).not.toHaveBeenCalled();
      expect(mockPing).not.toHaveBeenCalled();
      expect(mockGetAccessToken).not.toHaveBeenCalled();
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
      expect(res._json).toMatchObject({ status: 'healthy' });
      expect(rejectIfRateLimited).not.toHaveBeenCalled();
    });
  });

  it('returns 200 healthy when all services are up', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'healthy',
      services: {
        postgres: { status: 'ok' },
        redis: { status: 'ok' },
        schwab: { status: 'ok' },
      },
    });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 503 degraded when Postgres is down', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('connection refused'));
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        postgres: { status: 'error' },
        redis: { status: 'ok' },
        schwab: { status: 'ok' },
      },
    });
  });

  it('returns 503 degraded when Redis is down', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        postgres: { status: 'ok' },
        redis: { status: 'error' },
        schwab: { status: 'ok' },
      },
    });
  });

  it('returns 503 degraded when Schwab token is expired', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({
      error: { type: 'expired_refresh', message: 'Refresh token expired' },
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        postgres: { status: 'ok' },
        redis: { status: 'ok' },
        schwab: { status: 'error' },
      },
    });
  });

  it('returns 503 when Schwab getAccessToken throws', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockRejectedValueOnce(new Error('Network failure'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        schwab: { status: 'error' },
      },
    });
  });

  it('returns 503 when all services are down', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('DB down'));
    mockPing.mockRejectedValueOnce(new Error('Redis down'));
    mockGetAccessToken.mockRejectedValueOnce(new Error('Schwab down'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        postgres: { status: 'error' },
        redis: { status: 'error' },
        schwab: { status: 'error' },
      },
    });
  });

  it('includes latencyMs for each service', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      services: {
        postgres: { latencyMs?: number };
        redis: { latencyMs?: number };
        schwab: { latencyMs?: number };
      };
    };
    expect(json.services.postgres.latencyMs).toBeTypeOf('number');
    expect(json.services.redis.latencyMs).toBeTypeOf('number');
    expect(json.services.schwab.latencyMs).toBeTypeOf('number');
  });

  it('includes a timestamp in the response', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as { timestamp: string };
    expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles non-Error throws without leaking the value into the response', async () => {
    mockDbFn.mockRejectedValueOnce('string error');
    mockPing.mockRejectedValueOnce(42);
    mockGetAccessToken.mockRejectedValueOnce(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    const json = res._json as {
      services: {
        postgres: Record<string, unknown>;
        redis: Record<string, unknown>;
        schwab: Record<string, unknown>;
      };
    };
    // Public response surfaces only status/latencyMs — no error field
    // (would leak Schwab token state, DB connection info, etc.).
    expect(json.services.postgres).not.toHaveProperty('error');
    expect(json.services.redis).not.toHaveProperty('error');
    expect(json.services.schwab).not.toHaveProperty('error');
    expect(json.services.postgres.status).toBe('error');
    expect(json.services.redis.status).toBe('error');
    expect(json.services.schwab.status).toBe('error');
    // The actual errors are captured to Sentry for internal triage
    expect(mockCaptureException).toHaveBeenCalledTimes(3);
  });
});
