// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  initDb: vi.fn(),
  migrateDb: vi.fn(),
}));

import handler from '../journal/init.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { initDb, migrateDb } from '../_lib/db.js';

describe('POST /api/journal/init', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(401);
  });

  it('creates tables and returns success', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
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

  it('returns 500 with error message on failure', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(initDb).mockRejectedValue(new Error('Connection refused'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Connection refused' });
  });

  it('returns generic error for non-Error throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(initDb).mockRejectedValue('string error');

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to init database' });
  });
});
