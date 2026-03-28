// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
}));

const mockPing = vi.fn();
const mockGetAccessToken = vi.fn();
vi.mock('../_lib/schwab.js', () => ({
  redis: { ping: (...args: unknown[]) => mockPing(...args) },
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
}));

import handler from '../health.js';

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/health', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    mockPing.mockReset();
    mockGetAccessToken.mockReset();
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
        postgres: { status: 'error', error: 'connection refused' },
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
        redis: { status: 'error', error: 'ECONNREFUSED' },
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
        schwab: { status: 'error', error: 'Refresh token expired' },
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
        schwab: { status: 'error', error: 'Network failure' },
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
        postgres: { status: 'error', error: 'DB down' },
        redis: { status: 'error', error: 'Redis down' },
        schwab: { status: 'error', error: 'Schwab down' },
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
      services: Record<string, { latencyMs?: number }>;
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

  it('handles non-Error throws gracefully', async () => {
    mockDbFn.mockRejectedValueOnce('string error');
    mockPing.mockRejectedValueOnce(42);
    mockGetAccessToken.mockRejectedValueOnce(null);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    const json = res._json as {
      services: Record<string, { error?: string }>;
    };
    expect(json.services.postgres.error).toBe('Unknown error');
    expect(json.services.redis.error).toBe('Unknown error');
    expect(json.services.schwab.error).toBe('Unknown error');
  });
});
