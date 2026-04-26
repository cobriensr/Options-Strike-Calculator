// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../trace-live-list.js';

beforeEach(() => {
  mockSql.mockReset();
});

describe('GET /api/trace-live-list', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 400 when neither ?date nor ?dates=true is supplied', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/Provide \?date/);
  });

  it('returns 400 when ?date is malformed', async () => {
    const req = mockRequest({ method: 'GET', query: { date: '04-23-2026' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns the list of dates when ?dates=true', async () => {
    mockSql.mockResolvedValueOnce([
      { et_date: '2026-04-23', total: '76' },
      { et_date: '2026-04-22', total: '74' },
    ]);
    const req = mockRequest({ method: 'GET', query: { dates: 'true' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      dates: [
        { date: '2026-04-23', total: 76 },
        { date: '2026-04-22', total: 74 },
      ],
    });
  });

  it('returns rows for a valid ET date', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '101',
        captured_at: '2026-04-23T13:35:00Z',
        spot: '6610.50',
        stability_pct: '67.3',
        regime: 'range_bound_positive_gamma',
        predicted_close: '6605.00',
        confidence: 'high',
        override_applied: true,
        headline: 'Pin at 6605, override fires',
        has_images: true,
      },
      {
        id: '102',
        captured_at: '2026-04-23T13:40:00Z',
        spot: '6611.20',
        stability_pct: null,
        regime: 'range_bound_positive_gamma',
        predicted_close: '6605.00',
        confidence: 'high',
        override_applied: true,
        headline: 'Pin holds',
        has_images: false,
      },
    ]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-23' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      count: number;
      analyses: Array<Record<string, unknown>>;
    };
    expect(body.date).toBe('2026-04-23');
    expect(body.count).toBe(2);
    expect(body.analyses[0]).toMatchObject({
      id: 101,
      capturedAt: '2026-04-23T13:35:00Z',
      spot: 6610.5,
      stabilityPct: 67.3,
      overrideApplied: true,
      hasImages: true,
    });
    expect(body.analyses[1]!.stabilityPct).toBeNull();
    expect(body.analyses[1]!.hasImages).toBe(false);
  });

  it('queries with ET market-hours UTC bounds (DST-aware)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-23' }, // EDT — 9:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC
    });
    const res = mockResponse();
    await handler(req, res);
    // The 2nd and 3rd substitution values are the start/end UTC bounds.
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain('2026-04-23T13:30:00.000Z');
    expect(values).toContain('2026-04-23T20:00:00.000Z');
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-23' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
