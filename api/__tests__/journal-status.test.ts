// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import handler from '../journal/status.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

describe('GET /api/journal/status', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns connection status and table counts', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    process.env.DATABASE_URL = 'postgres://test';

    const now = new Date().toISOString();
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ now }]) // SELECT NOW()
      .mockResolvedValueOnce([{ count: 10 }]) // snapshots
      .mockResolvedValueOnce([{ count: 5 }]) // analyses
      .mockResolvedValueOnce([{ count: 2 }]) // outcomes
      .mockResolvedValueOnce([{ count: 0 }]); // positions
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.connected).toBe(true);
    expect(json.serverTime).toBe(now);
    expect(json.tables).toEqual({
      market_snapshots: 10,
      analyses: 5,
      outcomes: 2,
      positions: 0,
    });
    expect((json.envVarsFound as string[]).includes('DATABASE_URL')).toBe(true);
  });

  it('reports which env vars are set', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    process.env.DATABASE_URL = 'x';
    process.env.NEON_DATABASE_URL = 'y';
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PRISMA_URL;
    delete process.env.POSTGRES_URL_NON_POOLING;

    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ now: '' }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }]);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as { envVarsFound: string[] };
    expect(json.envVarsFound).toContain('DATABASE_URL');
    expect(json.envVarsFound).toContain('NEON_DATABASE_URL');
    expect(json.envVarsFound).not.toContain('POSTGRES_URL');
  });

  it('returns 500 with error on database failure', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    process.env.DATABASE_URL = 'postgres://test';

    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('Connection refused');
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    expect(json.connected).toBe(false);
    expect(json.error).toBe('Connection refused');
  });

  it('returns generic error for non-Error throws', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);

    vi.mocked(getDb).mockImplementation(() => {
      throw 'weird error';
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe('Unknown error');
  });
});
