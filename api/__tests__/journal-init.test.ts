// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/db.js', () => ({
  initDb: vi.fn(),
  migrateDb: vi.fn(),
}));

import handler from '../journal/init.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { initDb, migrateDb } from '../_lib/db.js';

describe('POST /api/journal/init', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
  });

  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(401);
  });

  it('creates tables and returns success', async () => {
    vi.mocked(initDb).mockResolvedValue(undefined);
    vi.mocked(migrateDb).mockResolvedValue(['vix_term_shape', 'rv_iv_ratio']);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      success: true,
      tables: ['market_snapshots', 'analyses', 'outcomes'],
      migrated: ['vix_term_shape', 'rv_iv_ratio'],
      message: 'All tables created and migrations applied',
    });
    expect(initDb).toHaveBeenCalled();
    expect(migrateDb).toHaveBeenCalled();
  });

  it('returns 500 with generic error on failure (no leaked details)', async () => {
    vi.mocked(initDb).mockRejectedValue(new Error('Connection refused'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });

  it('returns generic error for non-Error throws', async () => {
    vi.mocked(initDb).mockRejectedValue('string error');

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });
});
