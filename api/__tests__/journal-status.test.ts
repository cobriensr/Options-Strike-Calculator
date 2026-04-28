// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import handler from '../journal/status.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

describe('GET /api/journal/status', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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
  });

  it('returns connection status and table counts', async () => {
    process.env.DATABASE_URL = 'postgres://test';

    const now = new Date().toISOString();
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ now }]) // SELECT NOW()
      .mockResolvedValueOnce([
        { name: 'analyses', count: 5 },
        { name: 'market_snapshots', count: 10 },
        { name: 'outcomes', count: 2 },
        { name: 'positions', count: 0 },
      ]) // pg_stat_user_tables
      .mockResolvedValueOnce([{ latest: 18 }]); // MAX(id) from schema_migrations
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.connected).toBe(true);
    expect(json.serverTime).toBe(now);
    expect(json.latestMigration).toBe(18);
    expect(json.tables).toEqual({
      analyses: 5,
      market_snapshots: 10,
      outcomes: 2,
      positions: 0,
    });
    expect((json.envVarsFound as string[]).includes('DATABASE_URL')).toBe(true);
  });

  it('filters pg_stat rows to the diagnostic allowlist', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const now = new Date().toISOString();
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ now }])
      .mockResolvedValueOnce([
        { name: 'analyses', count: 5 },
        // Pretend Postgres also has internal tables a guest shouldn't see
        { name: 'pg_internal_secret_table', count: 999 },
        { name: 'futures_trade_ticks', count: 12345 }, // not on allowlist
        { name: 'spx_candles_1m', count: 80 },
      ])
      .mockResolvedValueOnce([{ latest: 18 }]);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Allowlisted rows present
    expect((json.tables as Record<string, number>).analyses).toBe(5);
    expect((json.tables as Record<string, number>).spx_candles_1m).toBe(80);
    // Non-allowlisted rows must NOT appear
    expect(
      (json.tables as Record<string, unknown>).pg_internal_secret_table,
    ).toBeUndefined();
    expect(
      (json.tables as Record<string, unknown>).futures_trade_ticks,
    ).toBeUndefined();
  });

  it('reports which env vars are set', async () => {
    process.env.DATABASE_URL = 'x';
    process.env.NEON_DATABASE_URL = 'y';
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PRISMA_URL;
    delete process.env.POSTGRES_URL_NON_POOLING;

    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ now: '' }]) // SELECT NOW()
      .mockResolvedValueOnce([]) // pg_stat_user_tables (empty)
      .mockResolvedValueOnce([{ latest: null }]); // schema_migrations
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as { envVarsFound: string[] };
    expect(json.envVarsFound).toContain('DATABASE_URL');
    expect(json.envVarsFound).toContain('NEON_DATABASE_URL');
    expect(json.envVarsFound).not.toContain('POSTGRES_URL');
  });

  it('returns 500 with error on database failure', async () => {
    process.env.DATABASE_URL = 'postgres://test';

    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('Connection refused');
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    expect(json.connected).toBe(false);
    expect(json.error).toBe('Database connection failed');
  });

  it('returns generic error for non-Error throws', async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw 'weird error'; // NOSONAR -- intentionally testing non-Error throw
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe(
      'Database connection failed',
    );
  });
});
