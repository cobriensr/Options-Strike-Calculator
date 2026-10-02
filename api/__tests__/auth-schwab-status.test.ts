// @vitest-environment node

/**
 * GET /api/auth/schwab-status — owner-only, read-only view of the Schwab
 * refresh-token expiry that drives the header countdown badge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse, isolationScopeStub } from './helpers';

// withDbReader runs the owner guard itself (from auth-helpers.js), so the
// reject case mocks that module.
vi.mock('../_lib/auth-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn(),
}));

vi.mock('../_lib/schwab.js', () => ({
  getSchwabAuthStatus: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb(isolationScopeStub())),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

import handler from '../auth/schwab-status.js';
import { guardOwnerEndpoint } from '../_lib/auth-helpers.js';
import { getSchwabAuthStatus } from '../_lib/schwab.js';
import { Sentry } from '../_lib/sentry.js';

const EXPIRES_AT = Date.parse('2026-10-04T20:00:00Z');

describe('GET /api/auth/schwab-status', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerEndpoint).mockReset().mockResolvedValue(false);
    vi.mocked(getSchwabAuthStatus).mockReset();
    vi.mocked(Sentry.captureException).mockClear();
  });

  it('returns 405 for non-GET methods without reading the status', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(getSchwabAuthStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-owner before reading the status', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(getSchwabAuthStatus).not.toHaveBeenCalled();
  });

  it('returns the status with Cache-Control: no-store', async () => {
    vi.mocked(getSchwabAuthStatus).mockResolvedValueOnce({
      state: 'expiring',
      refreshExpiresAt: EXPIRES_AT,
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      state: 'expiring',
      refreshExpiresAt: EXPIRES_AT,
    });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it.each([{ state: 'logged_out' }, { state: 'unknown' }] as const)(
    'passes $state through as a 200',
    async (status) => {
      vi.mocked(getSchwabAuthStatus).mockResolvedValueOnce(status);
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual(status);
    },
  );

  it('returns 500 and captures when the status read throws', async () => {
    const err = new Error('boom');
    vi.mocked(getSchwabAuthStatus).mockRejectedValueOnce(err);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });
});
