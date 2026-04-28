// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn(),
  setCacheHeaders: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../analyses.js';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';

describe('GET /api/analyses', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
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

  describe('?id=N', () => {
    it('returns a single analysis by ID', async () => {
      const row = {
        id: 42,
        date: '2026-03-17',
        entry_time: '10:00 AM',
        mode: 'entry',
        structure: 'IRON CONDOR',
        confidence: 'HIGH',
        suggested_delta: 8,
        spx: 5700,
        vix: 18,
        vix1d: 15,
        hedge: null,
        full_response: '{"mode":"entry"}',
        created_at: '2026-03-17T10:00:00Z',
      };
      mockSql.mockResolvedValue([row]);
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: { id: '42' } }), res);
      expect(res._status).toBe(200);
      expect((res._json as Record<string, unknown>).id).toBe(42);
      expect((res._json as Record<string, unknown>).analysis).toEqual({
        mode: 'entry',
      });
    });

    it('returns 404 when ID not found', async () => {
      mockSql.mockResolvedValue([]);
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: { id: '999' } }), res);
      expect(res._status).toBe(404);
      expect(res._json).toEqual({ error: 'Analysis not found' });
    });
  });

  describe('?dates=true', () => {
    it('returns aggregated date list', async () => {
      mockSql.mockResolvedValue([
        {
          date: '2026-03-17',
          total: 3,
          entries: 2,
          middays: 1,
          reviews: 0,
        },
      ]);
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { dates: 'true' } }),
        res,
      );
      expect(res._status).toBe(200);
      const json = res._json as { dates: unknown[] };
      expect(json.dates).toHaveLength(1);
      expect(json.dates[0]).toEqual({
        date: '2026-03-17',
        total: 3,
        entries: 2,
        middays: 1,
        reviews: 0,
      });
    });
  });

  describe('?date=YYYY-MM-DD', () => {
    it('returns all analyses for a date', async () => {
      const row = {
        id: 1,
        date: '2026-03-17',
        entry_time: '10:00 AM',
        mode: 'entry',
        structure: 'IRON CONDOR',
        confidence: 'HIGH',
        suggested_delta: 8,
        spx: 5700,
        vix: 18,
        vix1d: 15,
        hedge: null,
        full_response: { mode: 'entry' },
        created_at: '2026-03-17T10:00:00Z',
      };
      mockSql.mockResolvedValue([row]);
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { date: '2026-03-17' } }),
        res,
      );
      expect(res._status).toBe(200);
      const json = res._json as { date: string; analyses: unknown[] };
      expect(json.date).toBe('2026-03-17');
      expect(json.analyses).toHaveLength(1);
    });

    it('returns specific analysis by date + entryTime + mode', async () => {
      const row = {
        id: 1,
        date: '2026-03-17',
        entry_time: '10:00 AM',
        mode: 'entry',
        structure: 'IRON CONDOR',
        confidence: 'HIGH',
        suggested_delta: 8,
        spx: 5700,
        vix: 18,
        vix1d: null,
        hedge: null,
        full_response: '{"mode":"entry"}',
        created_at: '2026-03-17T10:00:00Z',
      };
      mockSql.mockResolvedValue([row]);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-03-17',
            entryTime: '10:00 AM',
            mode: 'entry',
          },
        }),
        res,
      );
      expect(res._status).toBe(200);
      expect((res._json as Record<string, unknown>).id).toBe(1);
    });

    it('returns 404 for specific query with no results', async () => {
      mockSql.mockResolvedValue([]);
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            date: '2026-03-17',
            entryTime: '10:00 AM',
            mode: 'entry',
          },
        }),
        res,
      );
      expect(res._status).toBe(404);
    });
  });

  it('returns 400 when no query params provided', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('Provide');
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValue(new Error('DB connection failed'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { dates: 'true' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe('Internal error');
  });

  it('returns generic error message for non-Error throws', async () => {
    mockSql.mockRejectedValue('string error');
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { dates: 'true' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe('Internal error');
  });

  describe('parseRow', () => {
    it('parses full_response as JSON string', async () => {
      mockSql.mockResolvedValue([
        {
          id: 1,
          date: '2026-03-17',
          entry_time: '10:00 AM',
          mode: 'entry',
          structure: 'IRON CONDOR',
          confidence: 'HIGH',
          suggested_delta: 8,
          spx: null,
          vix: null,
          vix1d: null,
          hedge: 'long put',
          full_response: '{"structure":"IC"}',
          created_at: '2026-03-17T10:00:00Z',
        },
      ]);
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: { id: '1' } }), res);
      expect((res._json as Record<string, unknown>).analysis).toEqual({
        structure: 'IC',
      });
      expect((res._json as Record<string, unknown>).hedge).toBe('long put');
    });

    it('passes through full_response when already an object', async () => {
      mockSql.mockResolvedValue([
        {
          id: 2,
          date: '2026-03-17',
          entry_time: '10:00 AM',
          mode: 'midday',
          structure: 'PUT CREDIT SPREAD',
          confidence: 'MODERATE',
          suggested_delta: 10,
          spx: 5700,
          vix: 20,
          vix1d: 17,
          hedge: null,
          full_response: { already: 'parsed' },
          created_at: '2026-03-17T12:00:00Z',
        },
      ]);
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: { id: '2' } }), res);
      expect((res._json as Record<string, unknown>).analysis).toEqual({
        already: 'parsed',
      });
    });
  });
});
