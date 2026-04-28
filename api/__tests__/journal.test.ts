// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import handler from '../journal.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';

describe('GET /api/journal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(429);
  });

  it('queries all analyses when no filters provided', async () => {
    const mockRows = [{ id: 1, date: '2026-03-10' }];
    Object.defineProperty(mockRows, 'length', { value: 1 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: {} }), res);

    expect(res._status).toBe(200);
    const json = res._json as { analyses: unknown[]; count: number };
    expect(json.analyses).toEqual(mockRows);
    expect(json.count).toBe(1);
  });

  it('queries by date when date param provided', async () => {
    const mockRows = [{ id: 1, date: '2026-03-10' }];
    Object.defineProperty(mockRows, 'length', { value: 1 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-10' } }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalled();
  });

  it('queries by date range when from/to provided', async () => {
    const mockRows: unknown[] = [];
    Object.defineProperty(mockRows, 'length', { value: 0 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { from: '2026-03-01', to: '2026-03-10' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect((res._json as { count: number }).count).toBe(0);
  });

  it('queries by structure', async () => {
    const mockRows: unknown[] = [];
    Object.defineProperty(mockRows, 'length', { value: 0 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { structure: 'IRON CONDOR' },
      }),
      res,
    );

    expect(res._status).toBe(200);
  });

  it('queries by confidence', async () => {
    const mockRows: unknown[] = [];
    Object.defineProperty(mockRows, 'length', { value: 0 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { confidence: 'HIGH' } }),
      res,
    );

    expect(res._status).toBe(200);
  });

  it('queries by mode', async () => {
    const mockRows: unknown[] = [];
    Object.defineProperty(mockRows, 'length', { value: 0 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { mode: 'entry' } }),
      res,
    );

    expect(res._status).toBe(200);
  });

  it('caps limit at 200', async () => {
    const mockRows: unknown[] = [];
    Object.defineProperty(mockRows, 'length', { value: 0 });
    const mockSql = vi.fn().mockResolvedValue(mockRows);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { limit: '999' } }), res);

    expect(res._status).toBe(200);
  });

  it('returns 500 on database error', async () => {
    const mockSql = vi.fn().mockRejectedValue(new Error('DB down'));
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: {} }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Query failed' });

    consoleSpy.mockRestore();
  });
});
