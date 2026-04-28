// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from '../helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

vi.mock('../../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../../push/vapid-public-key.js';
import { guardOwnerEndpoint } from '../../_lib/api-helpers.js';
import logger from '../../_lib/logger.js';

describe('GET /api/push/vapid-public-key', () => {
  const originalPublicKey = process.env.VAPID_PUBLIC_KEY;

  beforeEach(() => {
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(logger.error).mockClear();
    process.env.VAPID_PUBLIC_KEY = 'test-public-key-abc123';
  });

  afterEach(() => {
    if (originalPublicKey == null) {
      delete process.env.VAPID_PUBLIC_KEY;
    } else {
      process.env.VAPID_PUBLIC_KEY = originalPublicKey;
    }
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when guard detects a bot', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(403).json({ error: 'Access denied' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 500 when VAPID_PUBLIC_KEY is missing', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Push not configured' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns the VAPID public key on happy path', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ publicKey: 'test-public-key-abc123' });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });
});
