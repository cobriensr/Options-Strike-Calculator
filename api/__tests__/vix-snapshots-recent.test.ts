// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/db.js', () => ({
  getRecentVixSnapshots: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../vix-snapshots-recent.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getRecentVixSnapshots } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

describe('GET /api/vix-snapshots-recent', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(getRecentVixSnapshots).mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(getRecentVixSnapshots).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(getRecentVixSnapshots).not.toHaveBeenCalled();
  });

  it('returns snapshots for today', async () => {
    const rows = [
      {
        entryTime: '9:35 AM',
        vix: 17.2,
        vix1d: 11.03,
        vix9d: 16.4,
        spx: 6908.25,
      },
      {
        entryTime: '11:45 AM',
        vix: 17.47,
        vix1d: 10.48,
        vix9d: 16.42,
        spx: 6960.59,
      },
    ];
    vi.mocked(getRecentVixSnapshots).mockResolvedValue(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect((res._json as { snapshots: unknown[] }).snapshots).toEqual(rows);
    expect(getRecentVixSnapshots).toHaveBeenCalledTimes(1);
    const [dateArg] = vi.mocked(getRecentVixSnapshots).mock.calls[0]!;
    expect(dateArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty snapshot array when no data exists', async () => {
    vi.mocked(getRecentVixSnapshots).mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect((res._json as { snapshots: unknown[] }).snapshots).toEqual([]);
  });

  it('sets Cache-Control: no-store', async () => {
    vi.mocked(getRecentVixSnapshots).mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    vi.mocked(getRecentVixSnapshots).mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });
});
